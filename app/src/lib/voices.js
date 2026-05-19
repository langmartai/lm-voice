'use strict';

// Friendly catalogue for the six Supertonic voice styles bundled with lm-voice.
// Names are chosen for easy speech: each is two syllables, distinct from the
// others, and starts with a recognisable initial. Tone notes are subjective
// hints to help the user pick — actual character depends on phrase + speed.
const VOICES = [
  { id: 'M1', name: 'Marcus', gender: 'male',   tone: 'deep, measured' },
  { id: 'M2', name: 'Dylan',  gender: 'male',   tone: 'warm, conversational' },
  { id: 'M3', name: 'Theo',   gender: 'male',   tone: 'bright, youthful' },
  { id: 'F1', name: 'Aria',   gender: 'female', tone: 'clear, professional' },
  { id: 'F2', name: 'Luna',   gender: 'female', tone: 'soft, warm' },
  { id: 'F3', name: 'Nova',   gender: 'female', tone: 'bright, energetic' },
];

const _byId = Object.fromEntries(VOICES.map((v) => [v.id, v]));
const _byNameLower = Object.fromEntries(VOICES.map((v) => [v.name.toLowerCase(), v]));

// Resolve any user-supplied string (id, name, or close variant) → canonical id.
// Returns null if no plausible match.
function resolveVoiceId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Normalise: drop whitespace inside (so "F 2" → "F2"), uppercase for id check.
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (_byId[compact]) return compact;

  // Try id with spelled-out digit ("F two" → "F2")
  const numWords = { ONE: '1', TWO: '2', THREE: '3' };
  const m = raw.toUpperCase().match(/^([MF])\s+(ONE|TWO|THREE)$/);
  if (m && numWords[m[2]]) {
    const id = m[1] + numWords[m[2]];
    if (_byId[id]) return id;
  }

  // Try by friendly name (case-insensitive)
  const lower = raw.toLowerCase();
  if (_byNameLower[lower]) return _byNameLower[lower].id;
  // Allow STT phonetic look-alikes that drop trailing letters / punctuation
  const stripped = lower.replace(/[^a-z]/g, '');
  if (_byNameLower[stripped]) return _byNameLower[stripped].id;

  return null;
}

function describeVoice(id) {
  return _byId[id] || null;
}

function listForSpeech() {
  // "Three male voices: Marcus, Dylan, Theo. Three female: Aria, Luna, Nova."
  const males = VOICES.filter((v) => v.gender === 'male').map((v) => v.name);
  const females = VOICES.filter((v) => v.gender === 'female').map((v) => v.name);
  return `Three male voices: ${males.join(', ')}. Three female: ${females.join(', ')}.`;
}

module.exports = { VOICES, resolveVoiceId, describeVoice, listForSpeech };
