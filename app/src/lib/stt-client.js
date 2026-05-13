'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

const PATH = '/api/ws/speech_to_text/voice_stream';
const KEEPALIVE_MS = 8000;
const FINALIZE_TIMEOUTS = { safety: 5000, noData: 1500 };

const TEXT_KEEPALIVE = '{"type":"KeepAlive"}';
const TEXT_CLOSE_STREAM = '{"type":"CloseStream"}';

function buildUrl({ baseUrl, language, keyterms }) {
  const base = (baseUrl ?? 'wss://api.anthropic.com')
    .replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: language ?? 'en',
    use_conversation_engine: 'true',
    stt_provider: 'deepgram-nova3',
  });
  for (const k of keyterms ?? []) params.append('keyterms', k);
  return `${base}${PATH}?${params.toString()}`;
}

/**
 * Streaming STT client for Anthropic's voice_stream WebSocket.
 *
 * Events:
 *   'open'                       — ws upgraded
 *   'transcript' (text, isFinal) — interim or final transcript
 *   'error' (err)                — error message
 *   'close' (code, reason)       — connection closed
 *
 * Methods:
 *   sendAudio(buf: Buffer)       — push a linear16 PCM chunk
 *   finalize()                   — Promise<resolutionReason>
 *   close()                      — abort
 */
class STTClient extends EventEmitter {
  constructor({ token, baseUrl, language, keyterms, userAgent }) {
    super();
    if (!token) throw new Error('STTClient requires OAuth token');
    this.url = buildUrl({ baseUrl, language, keyterms });
    this.headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent ?? 'lm-voice/0.1.0 (external, cli)',
      'x-app': 'cli',
      'anthropic-client-platform': 'claude_code_cli',
    };
    this.ws = null;
    this.keepaliveTimer = null;
    this.closeStreamSent = false;
    this.finalizeStarted = false;
    this.upgradeRejected = false;
    this.lastInterim = '';
    this._finalizeResolve = null;
    this._noDataResetter = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, {
        headers: this.headers,
        perMessageDeflate: true,
      });

      this.ws.once('open', () => {
        try {
          this.ws.send(TEXT_KEEPALIVE);
          this.keepaliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(TEXT_KEEPALIVE);
            }
          }, KEEPALIVE_MS);
          this.emit('open');
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('unexpected-response', (req, res) => {
        if (res.statusCode === 101) return;
        this.upgradeRejected = true;
        const cfMitigated = res.headers['cf-mitigated'];
        const cfRay = res.headers['cf-ray'];
        const err = new Error(
          `WebSocket upgrade rejected: HTTP ${res.statusCode}` +
          (cfMitigated ? ` cf-mitigated=${cfMitigated}` : '') +
          (cfRay ? ` cf-ray=${cfRay}` : '')
        );
        err.fatal = res.statusCode >= 400 && res.statusCode < 500;
        this.emit('error', err);
        res.resume();
        try { req.destroy(); } catch {}
        reject(err);
      });

      this.ws.on('message', (data) => this._handleMessage(data));

      this.ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString() ?? '';
        if (this.keepaliveTimer) {
          clearInterval(this.keepaliveTimer);
          this.keepaliveTimer = null;
        }
        if (this.lastInterim) {
          const text = this.lastInterim;
          this.lastInterim = '';
          this.emit('transcript', text, true);
        }
        if (this._finalizeResolve) this._finalizeResolve('ws_close');
        if (
          !this.finalizeStarted &&
          !this.upgradeRejected &&
          code !== 1000 &&
          code !== 1005
        ) {
          this.emit('error', new Error(`Connection closed: code ${code}${reason ? ` — ${reason}` : ''}`));
        }
        this.emit('close', code, reason);
      });

      this.ws.on('error', (err) => {
        if (!this.finalizeStarted) this.emit('error', err);
      });
    });
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'TranscriptText': {
        const text = msg.data ?? '';
        if (this.closeStreamSent && this._noDataResetter) this._noDataResetter();
        if (text) {
          this.lastInterim = text;
          this.emit('transcript', text, false);
        }
        break;
      }
      case 'TranscriptEndpoint': {
        const text = this.lastInterim;
        this.lastInterim = '';
        if (text) this.emit('transcript', text, true);
        if (this.closeStreamSent && this._finalizeResolve) {
          this._finalizeResolve('post_closestream_endpoint');
        }
        break;
      }
      case 'TranscriptError': {
        const m = msg.description ?? msg.error_code ?? 'unknown transcription error';
        if (!this.finalizeStarted) this.emit('error', new Error(m));
        break;
      }
      case 'error': {
        const m = msg.message ?? JSON.stringify(msg);
        if (!this.finalizeStarted) this.emit('error', new Error(m));
        break;
      }
      default:
        break;
    }
  }

  sendAudio(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.closeStreamSent) return;
    this.ws.send(buf);
  }

  finalize() {
    if (this.finalizeStarted || this.closeStreamSent) {
      return Promise.resolve('ws_already_closed');
    }
    this.finalizeStarted = true;

    return new Promise((resolve) => {
      let safety = null;
      let noData = null;
      this._finalizeResolve = (reason) => {
        if (safety) clearTimeout(safety);
        if (noData) clearTimeout(noData);
        this._finalizeResolve = null;
        this._noDataResetter = null;
        if (this.lastInterim) {
          const text = this.lastInterim;
          this.lastInterim = '';
          this.emit('transcript', text, true);
        }
        resolve(reason);
      };
      this._noDataResetter = () => {
        if (noData) clearTimeout(noData);
        noData = setTimeout(() => this._finalizeResolve?.('no_data_timeout'), FINALIZE_TIMEOUTS.noData);
      };

      safety = setTimeout(() => this._finalizeResolve?.('safety_timeout'), FINALIZE_TIMEOUTS.safety);
      noData = setTimeout(() => this._finalizeResolve?.('no_data_timeout'), FINALIZE_TIMEOUTS.noData);

      if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
        this._finalizeResolve?.('ws_already_closed');
        return;
      }

      setTimeout(() => {
        this.closeStreamSent = true;
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(TEXT_CLOSE_STREAM);
        }
      }, 0);
    });
  }

  close() {
    this.closeStreamSent = true;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(1000);
    }
  }
}

module.exports = { STTClient, buildUrl, FINALIZE_TIMEOUTS };
