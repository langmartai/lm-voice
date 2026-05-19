'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { EventEmitter } = require('node:events');

const DEFAULT_PORT = 8765;
const ALLOWED_ORIGINS = new Set(['https://claude.ai', 'http://localhost']);

/**
 * Local relay server bridging:
 *   page  — an in-page JS snippet running inside a https://claude.ai tab,
 *           holding the upstream wss://claude.ai/api/ws/voice/... socket.
 *   renderer — lm-voice's own renderer (mic capture + PCM playback).
 *
 * Both connect to ws://127.0.0.1:{port} with role= in the query string.
 * Every frame received from one role is forwarded verbatim to the other.
 * Text frames carrying { _bridge: ... } are control messages, not relayed.
 */
class ClaudeAiBridge extends EventEmitter {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', log = () => {}, textBufferSize = 5000, binaryBufferSize = 8000 } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.log = log;
    this.wss = null;
    this.page = null;       // exactly one page connection at a time
    this.renderers = new Set();
    this.textBufferSize = textBufferSize;
    this.binaryBufferSize = binaryBufferSize;
    this.textEvents = [];     // ring buffer of text + bridge events
    this.binaryEvents = [];   // ring buffer of binary frame metadata
    this.lastConvId = null;
    this.lastOrgId = null;
    this.upstreamOpen = false;
  }

  _pushEvent(dir, kind, payload) {
    const ev = { t: Date.now(), dir, kind, payload };
    if (kind === 'binary') {
      this.binaryEvents.push(ev);
      while (this.binaryEvents.length > this.binaryBufferSize) this.binaryEvents.shift();
    } else {
      this.textEvents.push(ev);
      while (this.textEvents.length > this.textBufferSize) this.textEvents.shift();
    }
  }

  recentEvents(limit = 50) {
    const merged = [...this.textEvents, ...this.binaryEvents].sort((a, b) => a.t - b.t);
    if (limit <= 0 || limit >= merged.length) return merged;
    return merged.slice(-limit);
  }

  sendToPageText(text) {
    if (!this.page || this.page.readyState !== WebSocket.OPEN) return false;
    try { this.page.send(text); return true; } catch { return false; }
  }

  sendToPageBinary(buf) {
    if (!this.page || this.page.readyState !== WebSocket.OPEN) return false;
    try { this.page.send(buf, { binary: true }); return true; } catch { return false; }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        host: this.host,
        port: this.port,
        verifyClient: (info, done) => {
          const origin = info.req.headers.origin || '';
          if (origin === '' || ALLOWED_ORIGINS.has(origin) || origin.startsWith('file://')) {
            return done(true);
          }
          this.log('bridge reject origin', origin);
          done(false, 403, 'origin not allowed');
        },
      });
      this.wss.on('listening', () => {
        this.log('bridge listening', `ws://${this.host}:${this.port}`);
        resolve();
      });
      this.wss.on('error', reject);
      this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      for (const ws of this.wss.clients) {
        try { ws.close(1001); } catch {}
      }
      this.wss.close(() => resolve());
      this.wss = null;
    });
  }

  _onConnection(ws, req) {
    const url = new URL(req.url, 'http://x');
    const role = url.searchParams.get('role') || 'page';
    ws.binaryType = 'nodebuffer';

    if (role === 'page') {
      if (this.page && this.page.readyState === WebSocket.OPEN) {
        try { this.page.close(1000, 'replaced'); } catch {}
      }
      this.page = ws;
      this.log('bridge page connected');
      this._notifyRenderers({ _bridge: 'page_attached' });
      this.emit('page-attached');
    } else if (role === 'renderer') {
      this.renderers.add(ws);
      this.log('bridge renderer connected', this.renderers.size);
      if (this.page && this.page.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ _bridge: 'page_attached' })); } catch {}
      }
    } else {
      try { ws.close(1008, 'unknown role'); } catch {}
      return;
    }

    ws.on('message', (data, isBinary) => this._relay(role, ws, data, isBinary));
    ws.on('close', () => {
      if (role === 'page' && this.page === ws) {
        this.page = null;
        this.upstreamOpen = false;
        this.log('bridge page disconnected');
        this._notifyRenderers({ _bridge: 'page_detached' });
        this.emit('page-detached');
      } else if (role === 'renderer') {
        this.renderers.delete(ws);
      }
    });
    ws.on('error', (err) => this.log('bridge ws error', role, err.message));
  }

  _relay(fromRole, fromWs, data, isBinary) {
    if (fromRole === 'page') {
      if (!isBinary) {
        const text = data.toString();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (parsed && parsed._bridge) {
          if (parsed.convId) this.lastConvId = parsed.convId;
          if (parsed.orgId) this.lastOrgId = parsed.orgId;
          if (parsed._bridge === 'upstream_open') this.upstreamOpen = true;
          if (parsed._bridge === 'upstream_close' || parsed._bridge === 'upstream_error') this.upstreamOpen = false;
          this._pushEvent('page', 'bridge', parsed);
          this.emit('page-event', parsed);
          this._notifyRenderers(parsed);
          return;
        }
        this._pushEvent('server', 'text', parsed ?? { raw: text.slice(0, 400) });
        this.emit('server-text', text);
      } else {
        this._pushEvent('server', 'binary', { bytes: data.length });
        this.emit('server-binary', data);
      }
      for (const r of this.renderers) {
        if (r.readyState === WebSocket.OPEN) {
          try { r.send(data, { binary: isBinary }); } catch {}
        }
      }
    } else if (fromRole === 'renderer') {
      if (!isBinary) {
        const text = data.toString();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (parsed && parsed._bridge) {
          this._handleRendererControl(parsed);
          return;
        }
      }
      if (this.page && this.page.readyState === WebSocket.OPEN) {
        try { this.page.send(data, { binary: isBinary }); } catch {}
      }
    }
  }

  _handleRendererControl(msg) {
    // Forward every renderer-issued _bridge:* control to the page. The page
    // snippet has its own switch that decides which ones to act on (open,
    // close, mic_start, mic_stop, playback_pause, playback_resume,
    // playback_cancel, playback_set, ...) — the bridge stays transparent.
    if (this.page && this.page.readyState === WebSocket.OPEN) {
      try { this.page.send(JSON.stringify(msg)); } catch {}
    }
  }

  _notifyRenderers(obj) {
    const text = JSON.stringify(obj);
    for (const r of this.renderers) {
      if (r.readyState === WebSocket.OPEN) {
        try { r.send(text); } catch {}
      }
    }
  }

  status() {
    return {
      listening: !!this.wss,
      url: `ws://${this.host}:${this.port}`,
      pageAttached: !!(this.page && this.page.readyState === WebSocket.OPEN),
      upstreamOpen: this.upstreamOpen,
      renderers: this.renderers.size,
      lastConvId: this.lastConvId,
      lastOrgId: this.lastOrgId,
      textBuffer: { size: this.textEvents.length, capacity: this.textBufferSize },
      binaryBuffer: { size: this.binaryEvents.length, capacity: this.binaryBufferSize },
    };
  }
}

module.exports = { ClaudeAiBridge, DEFAULT_PORT };
