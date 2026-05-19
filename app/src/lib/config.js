'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

const DEFAULTS = {
  lmAssist: {
    endpoint: 'http://localhost:3100',
    servers: [
      { url: 'http://localhost:3100', label: 'local' },
    ],
  },
  session: {
    id: null,
    cwd: null,
    label: null,
  },
  recentSessions: [],
  stt: {
    provider: 'anthropic',
    language: 'en',
    keyterms: [
      'lm-assist', 'lm-voice', 'Claude Code', 'session', 'agent',
      'opportunity', 'distribution', 'trigger', 'analysis', 'portfolio',
      'brent oil', 'natural gas', 'gold', 'nasdaq', 'us30',
    ],
  },
  tts: {
    provider: 'supertonic',
    voiceStyle: 'M1',
    speed: 1.05,
    lang: 'en',
  },
  hotkey: {
    pushToTalk: 'LEFT CTRL',
    mode: 'hold',
  },
  agent: {
    model: 'haiku',
    maxReplyChars: 350,
    effort: 'low',
  },
  audio: {
    inputDeviceId: null,
    outputDeviceId: null,
  },
  ui: {
    showPopup: true,
    popupFadeMs: 2500,
  },
  // Voice-agent session continuity — a single Claude Code session is held
  // per lm-assist endpoint and resumed on every turn so the model context
  // stays warm and we skip the 10–15s fresh-spawn cost.
  voiceAgent: {
    sessions: {}, // { "<lmAssist-endpoint>": "<claude-session-id>" } — currently held session per endpoint
    allSessions: [], // Every Claude Code session id this app has ever created. Used to filter the ambient watcher so we don't loop on our own past sessions. Capped at 200.
    // Context budget — reset the held session when input context approaches
    // the model's window so we don't hit a truncation/break.
    contextLimit: 200000,    // Haiku 4.5 / Sonnet 4.6 / Opus 4.7 all ≥ 200K
    contextThreshold: 0.75,  // trigger reset at 75% of limit (50K headroom)
  },
  // HTTP API — exposes the recording pipeline (STT/TTS/agent/run) for
  // programmatic testing. Bound to 127.0.0.1 so it isn't exposed to the network.
  api: {
    enabled: true,
    port: 3199,
    host: '127.0.0.1',
  },
  // Ambient awareness — background polling of session conversations and
  // (optionally) screen OCR. Deltas are buffered locally and prepended to
  // the next user turn so the agent is aware of what's going on without
  // burning tokens during idle time.
  awareness: {
    sessionDelta: {
      enabled: true,
      intervalMs: 30000,        // poll /sessions every 30s
      activeWindowMs: 600000,   // only watch sessions modified in the last 10 min
      maxNewMsgsPerSession: 6,
    },
    screenOcr: {
      enabled: false,           // opt-in: needs `npm install tesseract.js`
      intervalMs: 25000,        // capture + OCR every 25s
      minDeltaChars: 60,        // ignore deltas shorter than this — reduces OCR noise
      lang: 'eng',
    },
  },
};

function deepMerge(base, override) {
  if (override === null || typeof override !== 'object') return override ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override)) {
    if (override[k] !== null && typeof override[k] === 'object' && !Array.isArray(override[k])) {
      out[k] = deepMerge(base?.[k] ?? {}, override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

function configDir() {
  return path.join(os.homedir(), '.lm-voice');
}

function configPath() {
  return path.join(configDir(), 'config.yaml');
}

function load() {
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, YAML.stringify(DEFAULTS), 'utf8');
    return structuredClone(DEFAULTS);
  }
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = YAML.parse(text) ?? {};
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }
  return deepMerge(structuredClone(DEFAULTS), parsed);
}

function save(cfg) {
  fs.writeFileSync(configPath(), YAML.stringify(cfg), 'utf8');
}

function update(patch) {
  const current = load();
  const next = deepMerge(current, patch);
  save(next);
  return next;
}

module.exports = { load, save, update, configPath, configDir, DEFAULTS };
