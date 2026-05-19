'use strict';

const http = require('node:http');

// Tiny HTTP server that wraps the voice pipeline. Routes:
//
//   POST /api/stt     audio/wav → { transcript }
//   POST /api/tts     {text}    → audio/wav
//   POST /api/intent  {transcript} → { intent, target?, value? }
//   POST /api/agent   {transcript} → { reply, source, intent?, sessionId? }
//   POST /api/run     audio/wav → { transcript, reply, source, audioBase64 }
//   GET  /api/state   →           { session, voiceAgent, tts, ambient }
//   POST /api/session/reset → reset held voice-agent session for current endpoint
//
// All bodies are JSON unless noted. Bind to 127.0.0.1 by default so the
// API isn't exposed to the network.
class VoiceApiServer {
  constructor({ port = 3199, host = '127.0.0.1', handlers }) {
    this.port = port;
    this.host = host;
    this.handlers = handlers;
    this.server = null;
  }

  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((req, res) => this._route(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
  }

  async _route(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.port}`);
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/api/state') {
        return sendJson(res, 200, await this.handlers.state());
      }
      if (req.method === 'POST' && p === '/api/stt') {
        const buf = await readBody(req);
        if (!buf.length) return sendJson(res, 400, { error: 'empty body — POST audio/wav bytes' });
        const transcript = await this.handlers.stt(buf);
        return sendJson(res, 200, { transcript });
      }
      if (req.method === 'POST' && p === '/api/tts') {
        const body = await readJson(req);
        if (!body.text) return sendJson(res, 400, { error: 'text is required' });
        const wav = await this.handlers.tts(body.text);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        return res.end(wav);
      }
      if (req.method === 'POST' && p === '/api/intent') {
        const body = await readJson(req);
        const transcript = body.transcript ?? body.text ?? '';
        const result = await this.handlers.intent(transcript);
        return sendJson(res, 200, result ?? { intent: null });
      }
      if (req.method === 'POST' && p === '/api/agent') {
        const body = await readJson(req);
        const transcript = body.transcript ?? body.text ?? '';
        if (!transcript) return sendJson(res, 400, { error: 'transcript is required' });
        const result = await this.handlers.agent(transcript);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/run') {
        const buf = await readBody(req);
        if (!buf.length) return sendJson(res, 400, { error: 'empty body — POST audio/wav bytes' });
        const result = await this.handlers.run(buf);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/session/reset') {
        const result = await this.handlers.resetSession();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/discover-hosts') {
        const result = await this.handlers.discoverHosts();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/popup/show') {
        const result = await this.handlers.showPopup();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/popup/capture') {
        const body = await readJson(req).catch(() => ({}));
        const result = await this.handlers.capturePopup(body || {});
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && p === '/api/popup/dom') {
        const result = await this.handlers.dumpDom();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/hosts-window/open') {
        const result = await this.handlers.openHostsWindow();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/hosts-window/capture') {
        const body = await readJson(req).catch(() => ({}));
        const result = await this.handlers.captureHostsWindow(body || {});
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && p === '/api/claude-ai/status') {
        return sendJson(res, 200, await this.handlers.claudeAiStatus());
      }
      if (req.method === 'GET' && p === '/api/claude-ai/snippet') {
        const text = await this.handlers.claudeAiSnippet();
        if (!text) return sendJson(res, 500, { error: 'snippet not available' });
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
        return res.end(text);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/window/open') {
        const result = await this.handlers.claudeAiWindowOpen();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/window/close') {
        const result = await this.handlers.claudeAiWindowClose();
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && p === '/api/claude-ai/window/log') {
        const result = await this.handlers.claudeAiWindowCaptureLog();
        return sendJson(res, result?.ok ? 200 : 500, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/browser/open') {
        const body = await readJson(req).catch(() => ({}));
        const result = await this.handlers.claudeAiBrowserOpen(body || {});
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/browser/close') {
        const result = await this.handlers.claudeAiBrowserClose();
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && p === '/api/claude-ai/browser/status') {
        const result = await this.handlers.claudeAiBrowserStatus();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/browser/navigate') {
        const body = await readJson(req);
        const result = await this.handlers.claudeAiBrowserNavigate(body || {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'GET' && p === '/api/claude-ai/browser/conversations') {
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const result = await this.handlers.claudeAiBrowserListConversations({ limit });
        return sendJson(res, result.ok ? 200 : 500, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/browser/conversations') {
        const body = await readJson(req).catch(() => ({}));
        const result = await this.handlers.claudeAiBrowserCreateConversation(body || {});
        return sendJson(res, result.ok ? 200 : 500, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/browser/completion') {
        const body = await readJson(req);
        const result = await this.handlers.claudeAiBrowserSendCompletion(body || {});
        return sendJson(res, result?.ok ? 200 : (result?.status || 500), result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/session/start') {
        const body = await readJson(req).catch(() => ({}));
        const result = await this.handlers.claudeAiSessionStart(body || {});
        return sendJson(res, result?.ok ? 200 : 500, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/upstream/open') {
        const body = await readJson(req);
        if (!body.convId) return sendJson(res, 400, { error: 'convId is required' });
        const result = await this.handlers.claudeAiUpstreamOpen(body);
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/upstream/close') {
        const result = await this.handlers.claudeAiUpstreamClose();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/mic/start') {
        const result = await this.handlers.claudeAiMicStart();
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/mic/stop') {
        const result = await this.handlers.claudeAiMicStop();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/playback') {
        const body = await readJson(req);
        const result = await this.handlers.claudeAiPlaybackSet({ enabled: body.enabled !== false });
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/audio/send') {
        const buf = await readBody(req);
        if (!buf.length) return sendJson(res, 400, { error: 'empty body — POST raw audio bytes (Opus packet)' });
        const result = await this.handlers.claudeAiSendAudio(buf);
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'POST' && p === '/api/claude-ai/text/send') {
        const body = await readJson(req);
        if (typeof body.text !== 'string' || body.text === '') {
          return sendJson(res, 400, { error: 'text is required (raw string forwarded to upstream)' });
        }
        const result = await this.handlers.claudeAiSendText(body.text);
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (req.method === 'GET' && p === '/api/claude-ai/events') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const events = await this.handlers.claudeAiEvents(limit);
        return sendJson(res, 200, { events });
      }
      if (req.method === 'GET' && p === '/') {
        return sendJson(res, 200, {
          name: 'lm-voice API',
          routes: [
            'GET  /api/state',
            'POST /api/stt   (audio/wav)',
            'POST /api/tts   ({text})',
            'POST /api/intent ({transcript})',
            'POST /api/agent  ({transcript})',
            'POST /api/run   (audio/wav)',
            'POST /api/session/reset',
            'GET  /api/claude-ai/status',
            'GET  /api/claude-ai/snippet',
            'POST /api/claude-ai/window/open',
            'POST /api/claude-ai/window/close',
            'POST /api/claude-ai/browser/open       ({url?})  — embedded Chromium logged into claude.ai',
            'POST /api/claude-ai/browser/close',
            'GET  /api/claude-ai/browser/status',
            'POST /api/claude-ai/browser/navigate   ({url})',
            'POST /api/claude-ai/upstream/open   ({convId, voice?, language?, timezone?})',
            'POST /api/claude-ai/upstream/close',
            'POST /api/claude-ai/mic/start       — capture mic in embedded browser, encode Opus, push to upstream',
            'POST /api/claude-ai/mic/stop',
            'POST /api/claude-ai/playback         ({enabled})  — toggle TTS audio output in embedded browser',
            'POST /api/claude-ai/audio/send      (raw Opus packet bytes)',
            'POST /api/claude-ai/text/send       ({text})',
            'GET  /api/claude-ai/events?limit=N',
            'POST /api/claude-ai/browser/completion  ({convId, prompt, model?, locale?, timezone?})',
            'POST /api/claude-ai/session/start       ({context?, convId?, name?, voice?, language?, contextModel?})',
          ],
        });
      }
      sendJson(res, 404, { error: `route not found: ${req.method} ${p}` });
    } catch (err) {
      sendJson(res, 500, { error: err.message, stack: err.stack?.split('\n').slice(0, 4) });
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('invalid JSON body'); }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

module.exports = { VoiceApiServer };
