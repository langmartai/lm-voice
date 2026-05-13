'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

const DEFAULTS = {
  lmAssist: {
    endpoint: 'http://localhost:3100',
  },
  session: {
    id: null,
    cwd: null,
    label: null,
  },
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
    pushToTalk: 'RIGHT CTRL',
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
