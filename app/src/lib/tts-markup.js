'use strict';

// Lightweight TTS markup so the LLM can shape its delivery without a full
// SSML stack. Supertonic accepts plain text + (voiceStyle, speed) per call,
// so we synthesise the reply as a sequence of chunks at different speeds,
// insert silent PCM where the agent wanted a pause, and concatenate.
//
// Markup vocabulary (small on purpose):
//   [pause]                  300 ms silence
//   [pause 500]              500 ms silence
//   [slow]...[/slow]         × 0.75 base speed
//   [fast]...[/fast]         × 1.30 base speed
//   [emph]...[/emph]         × 0.85 base speed + ~120 ms breath before & after
//
// Tags never nest. Unknown / malformed tags are left in the text and stripped
// at the display layer so they never reach the user.

const { floatPcmToWav } = require('./tts-client');

const SPEED_MOD = { slow: 0.75, fast: 1.30, emph: 0.85 };
const EMPH_PAUSE_MS = 120;

// Parse `text` into a flat array of chunks:
//   { type: 'text', value: string, modifier: 'slow'|'fast'|'emph'|null }
//   { type: 'pause', ms: number }
function parseMarkup(text) {
  const chunks = [];
  const TAG = /\[(?:pause(?:\s+(\d+))?|(\/?)(slow|fast|emph))\]/g;
  let cursor = 0;
  let modifier = null;
  let buf = '';
  const flush = () => {
    if (buf) {
      chunks.push({ type: 'text', value: buf, modifier });
      buf = '';
    }
  };
  let m;
  while ((m = TAG.exec(text)) !== null) {
    buf += text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const isPause = m[0].startsWith('[pause');
    const isClose = m[2] === '/';
    const tagName = m[3];
    if (isPause) {
      flush();
      chunks.push({ type: 'pause', ms: parseInt(m[1] || '300', 10) });
    } else if (isClose) {
      flush();
      modifier = null;
    } else {
      flush();
      modifier = tagName;
    }
  }
  buf += text.slice(cursor);
  flush();
  return chunks;
}

// Strip markup, returning the plain text the user should see in the bubble
// and the karaoke layer should highlight. Whitespace is preserved.
function stripMarkup(text) {
  return String(text || '').replace(
    /\[(?:pause(?:\s+\d+)?|\/?(?:slow|fast|emph))\]/g,
    ''
  );
}

// Synthesise a marked-up reply into a single WAV Buffer. Reuses the passed
// SupertonicTTS instance (must already be configured with a voiceStyle —
// we only mutate its `speed` per chunk and reset it at the end).
async function synthesizeMarkupToWav(text, tts, baseSpeed, { lang = 'en' } = {}) {
  if (!tts) throw new Error('synthesizeMarkupToWav requires a TTS instance');
  if (!tts.isLoaded()) await tts.load();
  const sampleRate = tts._tts.sampleRate;

  const chunks = parseMarkup(text);
  const parts = []; // Float32Array pieces in playback order

  const silenceSamples = (ms) => new Float32Array(Math.max(0, Math.round((ms / 1000) * sampleRate)));

  try {
    for (const chunk of chunks) {
      if (chunk.type === 'pause') {
        if (chunk.ms > 0) parts.push(silenceSamples(chunk.ms));
        continue;
      }
      const txt = (chunk.value || '').trim();
      if (!txt) continue;

      const mod = chunk.modifier;
      const speed = mod && SPEED_MOD[mod] ? baseSpeed * SPEED_MOD[mod] : baseSpeed;
      if (mod === 'emph') parts.push(silenceSamples(EMPH_PAUSE_MS));

      tts.speed = speed;
      const { wav } = await tts.synthesize(chunk.value, { lang });
      parts.push(wav);

      if (mod === 'emph') parts.push(silenceSamples(EMPH_PAUSE_MS));
    }
  } finally {
    tts.speed = baseSpeed; // always restore
  }

  // Concat all Float32 pieces, then wrap as a single WAV.
  let total = 0;
  for (const p of parts) total += p.length;
  const combined = new Float32Array(total);
  let off = 0;
  for (const p of parts) { combined.set(p, off); off += p.length; }

  return floatPcmToWav(combined, sampleRate);
}

module.exports = { parseMarkup, stripMarkup, synthesizeMarkupToWav };
