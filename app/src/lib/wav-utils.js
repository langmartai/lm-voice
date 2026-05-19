'use strict';

// Minimal WAV (RIFF/PCM) reader + a simple linear-interpolation resampler.
// Just enough to accept arbitrary input WAVs from the API and feed
// 16 kHz mono 16-bit PCM into the STT WebSocket.

function parseWav(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 44) throw new Error('WAV too small');
  if (buf.slice(0, 4).toString() !== 'RIFF') throw new Error('Not a RIFF file');
  if (buf.slice(8, 12).toString() !== 'WAVE') throw new Error('Not a WAVE file');

  // Walk chunks to find fmt and data.
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    const body = buf.slice(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    off += 8 + size + (size & 1); // chunks are word-aligned
    if (fmt && data) break;
  }
  if (!fmt) throw new Error('Missing fmt chunk');
  if (!data) throw new Error('Missing data chunk');

  const audioFormat = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bitDepth = fmt.readUInt16LE(14);

  if (audioFormat !== 1) throw new Error(`Unsupported WAV format ${audioFormat} (need 1=PCM)`);
  if (bitDepth !== 16) throw new Error(`Unsupported bit depth ${bitDepth} (need 16)`);

  return { audioFormat, channels, sampleRate, bitDepth, pcm: data };
}

// Down-mix a multi-channel int16 buffer to mono (average channels).
function toMono(pcm, channels) {
  if (channels === 1) return pcm;
  const n = pcm.length / 2 / channels;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcm.readInt16LE(i * 2 * channels + c * 2);
    }
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

// Windowed-sinc FIR resampler — band-limited reconstruction with anti-alias
// protection. Replaces linear interpolation so downsampling synthetic TTS
// audio (e.g. 44.1 kHz → 16 kHz) doesn't fall apart.
//
//   y[i] = sum_{j=-N+1..N}  x[c+j] * h(p - (c+j)) * w(p - (c+j))
//
// where p is the source-time position of output sample i, c = floor(p),
// h is a normalised sinc with cutoff = min(srcRate, dstRate) / 2 (relative
// to srcRate so the coefficient indexing stays integer), and w is a Hann
// window over ±N taps. Coefficients are re-normalised per output sample
// so DC gain is exactly 1 even with finite truncation.
//
// N = 16 (32 taps total) gives transition ≈ 1/N * cutoff and ≥ 60 dB
// stopband — plenty for 16 kHz STT input. Latency is N/srcRate seconds.
function resample(monoPcm, srcRate, dstRate, { taps = 16 } = {}) {
  if (srcRate === dstRate) return monoPcm;
  const srcSamples = monoPcm.length / 2;
  const dstSamples = Math.floor((srcSamples * dstRate) / srcRate);
  const out = Buffer.alloc(dstSamples * 2);
  const ratio = srcRate / dstRate;
  // Cutoff is in cycles per source sample. For downsampling, limit to the
  // destination Nyquist; for upsampling, full source Nyquist is fine.
  const cutoff = ratio > 1 ? 0.5 / ratio : 0.5;
  const TWO_PI_FC = 2 * Math.PI * cutoff;
  const PI_OVER_N = Math.PI / taps;

  for (let i = 0; i < dstSamples; i++) {
    const p = i * ratio;
    const center = Math.floor(p);
    let sum = 0;
    let norm = 0;
    for (let j = -taps + 1; j <= taps; j++) {
      const n = center + j;
      if (n < 0 || n >= srcSamples) continue;
      const x = p - n;
      let h;
      if (x === 0) {
        h = 2 * cutoff;
      } else {
        h = Math.sin(TWO_PI_FC * x) / (Math.PI * x);
      }
      // Hann window — falls to 0 at x = ±N
      const w = 0.5 + 0.5 * Math.cos(PI_OVER_N * x);
      const c = h * w;
      sum += monoPcm.readInt16LE(n * 2) * c;
      norm += c;
    }
    let v = norm > 0 ? sum / norm : 0;
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(Math.round(v), i * 2);
  }
  return out;
}

// Full pipeline: WAV bytes → 16 kHz mono linear16 PCM Buffer.
function wavTo16kMonoPcm(wavBuf) {
  const { channels, sampleRate, pcm } = parseWav(wavBuf);
  const mono = toMono(pcm, channels);
  return resample(mono, sampleRate, 16000);
}

module.exports = { parseWav, toMono, resample, wavTo16kMonoPcm };
