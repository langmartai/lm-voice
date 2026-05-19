'use strict';

// End-to-end TTS → STT loopback test.
// Synthesises a known phrase with Supertonic, streams the PCM directly
// (resampled to 16 kHz linear16) into Anthropic's voice_stream WS,
// prints the recovered transcript, and exits with code 0 on success.

const fs = require('node:fs');
const path = require('node:path');
const { SupertonicTTS } = require('../src/lib/tts-client');
const { STTClient } = require('../src/lib/stt-client');
const { readClaudeOAuthToken } = require('../src/lib/oauth');

const PHRASE = 'Hello, this is a test of the lm-voice round trip from synthesis to recognition.';

function resampleFloat32(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIdx - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function floatToInt16(input) {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    out.writeInt16LE(s | 0, i * 2);
  }
  return out;
}

function floatPcmToWav(float32Audio, sampleRate) {
  const numFrames = float32Audio.length;
  const dataSize = numFrames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    let s = Math.max(-1, Math.min(1, float32Audio[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    buf.writeInt16LE(s | 0, off);
    off += 2;
  }
  return buf;
}

(async () => {
  console.log('[1] Phrase:', JSON.stringify(PHRASE));

  console.log('[2] Loading Supertonic TTS (may download assets on first run, ~hundreds of MB)…');
  const t0 = Date.now();
  const tts = new SupertonicTTS({ voiceStyle: 'M1', speed: 1.0 });
  const { wav: floatPcm, sampleRate } = await tts.synthesize(PHRASE, { lang: 'en' });
  console.log(`[2] Synthesised ${floatPcm.length} samples @ ${sampleRate} Hz in ${Date.now() - t0} ms`);

  // Save native-rate WAV for inspection
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const nativeWavPath = path.join(outDir, 'tts-native.wav');
  fs.writeFileSync(nativeWavPath, floatPcmToWav(floatPcm, sampleRate));
  console.log(`[3] Saved native-rate WAV: ${nativeWavPath} (${fs.statSync(nativeWavPath).size} bytes)`);

  // Resample to 16 kHz for STT
  const pcm16k = resampleFloat32(floatPcm, sampleRate, 16000);
  const resampledWavPath = path.join(outDir, 'tts-16k.wav');
  fs.writeFileSync(resampledWavPath, floatPcmToWav(pcm16k, 16000));
  console.log(`[4] Resampled to 16000 Hz → ${pcm16k.length} samples; saved ${resampledWavPath}`);

  const pcmInt16 = floatToInt16(pcm16k);

  console.log('[5] Connecting to STT WebSocket…');
  const token = readClaudeOAuthToken();
  const stt = new STTClient({ token, language: 'en', keyterms: ['lm-voice', 'round trip', 'recognition'] });
  let lastTranscript = '';
  const transcripts = [];
  stt.on('transcript', (text, isFinal) => {
    if (isFinal && text) {
      transcripts.push(text);
      lastTranscript = text;
      console.log('   final:', text);
    }
  });
  stt.on('error', (err) => {
    console.error('STT error:', err.message);
  });

  await stt.connect();
  console.log('[6] Streaming PCM…');

  // 16 kHz mono linear16 → 16000 samples = 32000 bytes per second.
  // Send ~20 ms chunks (640 bytes) every 20 ms to simulate real-time arrival.
  const CHUNK = 640;
  let i = 0;
  const start = Date.now();
  await new Promise((resolve) => {
    const tick = () => {
      const end = Math.min(i + CHUNK, pcmInt16.length);
      if (end <= i) return resolve();
      stt.sendAudio(pcmInt16.subarray(i, end));
      i = end;
      if (i >= pcmInt16.length) return resolve();
      setTimeout(tick, 20);
    };
    tick();
  });
  const streamMs = Date.now() - start;
  console.log(`[7] Sent ${pcmInt16.length} bytes in ${streamMs} ms; finalising…`);

  const reason = await stt.finalize();
  console.log('[8] finalize reason:', reason);
  stt.close();

  const expectedWords = ['hello', 'test', 'voice', 'round', 'trip'];
  const got = lastTranscript.toLowerCase();
  const hits = expectedWords.filter((w) => got.includes(w));
  console.log('\n=== RESULT ===');
  console.log('Expected phrase :', PHRASE);
  console.log('STT transcript  :', lastTranscript || '(none)');
  console.log(`Word hits       : ${hits.length}/${expectedWords.length}  (${hits.join(', ')})`);
  console.log('Native WAV      :', nativeWavPath);
  console.log('Resampled WAV   :', resampledWavPath);

  if (hits.length < 3) {
    console.error('FAIL: round-trip recognition too weak');
    process.exit(2);
  }
  console.log('PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
