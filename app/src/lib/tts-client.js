'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

const HF_REPO = 'Supertone/supertonic-3';
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;

// Files required for inference. Names taken from the Supertonic-3 HF repo.
const ONNX_FILES = [
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
];

const VOICE_STYLE_FILES = ['M1', 'M2', 'M3', 'F1', 'F2', 'F3'].map((v) => `voice_styles/${v}.json`);

function defaultAssetsDir() {
  return path.join(os.homedir(), '.lm-voice', 'assets');
}

async function downloadOne(url, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const tryGet = (u, redirects = 5) => {
      https.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return tryGet(next, redirects - 1);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    tryGet(url);
  });
}

async function ensureAssets({ assetsDir = defaultAssetsDir(), onProgress = () => {} } = {}) {
  const files = [...ONNX_FILES, ...VOICE_STYLE_FILES];
  const missing = [];
  for (const f of files) {
    const dest = path.join(assetsDir, f);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) missing.push(f);
  }
  if (missing.length === 0) return { assetsDir, downloaded: 0 };

  onProgress({ stage: 'start', total: missing.length });
  let done = 0;
  for (const f of missing) {
    const url = `${HF_BASE}/${f}`;
    const dest = path.join(assetsDir, f);
    onProgress({ stage: 'file', file: f, done, total: missing.length });
    await downloadOne(url, dest);
    done++;
  }
  onProgress({ stage: 'done', downloaded: done });
  return { assetsDir, downloaded: done };
}

class SupertonicTTS {
  constructor({ assetsDir, voiceStyle = 'M1', speed = 1.05, totalStep = 8, useGpu = false } = {}) {
    this.assetsDir = assetsDir ?? defaultAssetsDir();
    this.voiceStyleName = voiceStyle;
    this.speed = speed;
    this.totalStep = totalStep;
    this.useGpu = useGpu;
    this._tts = null;        // TextToSpeech instance from vendor helper
    this._style = null;      // Loaded voice style
    this._loadingPromise = null;
    this._helper = null;     // Lazy-loaded ESM module
  }

  async _loadHelper() {
    if (!this._helper) {
      const helperPath = path.join(__dirname, 'supertonic', 'helper.mjs');
      // Dynamic ESM import from CommonJS — convert path to file URL
      const url = require('url').pathToFileURL(helperPath).href;
      this._helper = await import(url);
    }
    return this._helper;
  }

  async load() {
    if (this._tts) return;
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = (async () => {
      await ensureAssets({ assetsDir: this.assetsDir });
      const helper = await this._loadHelper();
      const onnxDir = path.join(this.assetsDir, 'onnx');
      this._tts = await helper.loadTextToSpeech(onnxDir, this.useGpu);
      const stylePath = path.join(this.assetsDir, 'voice_styles', `${this.voiceStyleName}.json`);
      this._style = helper.loadVoiceStyle([stylePath], false);
    })();
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  isLoaded() {
    return this._tts != null && this._style != null;
  }

  /**
   * Synthesize text → PCM float32 array + sampleRate.
   */
  async synthesize(text, { lang = 'en' } = {}) {
    if (!this._tts) await this.load();
    const { wav, duration } = await this._tts.call(text, lang, this._style, this.totalStep, this.speed);
    return {
      wav: Float32Array.from(wav),
      sampleRate: this._tts.sampleRate,
      duration: duration?.[0] ?? null,
    };
  }

  /**
   * Synthesize and return 16-bit PCM WAV bytes (Buffer) ready to pipe to an audio sink.
   */
  async synthesizeWav(text, { lang = 'en' } = {}) {
    const { wav, sampleRate } = await this.synthesize(text, { lang });
    return floatPcmToWav(wav, sampleRate);
  }
}

/**
 * Convert Float32 PCM (range ~[-1, 1]) to a 16-bit PCM WAV file Buffer.
 */
function floatPcmToWav(float32Audio, sampleRate, { channels = 1, bitDepth = 16 } = {}) {
  const numFrames = float32Audio.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);              // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20);               // audio format = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    let s = Math.max(-1, Math.min(1, float32Audio[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    buffer.writeInt16LE(s | 0, offset);
    offset += 2;
  }
  return buffer;
}

module.exports = { SupertonicTTS, ensureAssets, defaultAssetsDir, floatPcmToWav };
