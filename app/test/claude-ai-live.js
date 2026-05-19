'use strict';

// Headless equivalent of the in-browser page snippet. Reads claude.ai cookies
// from ~/.claude/claudeai-session.json (same format lm-assist uses), connects
// to the lm-voice local bridge as role=page, and on `_bridge:open` opens the
// real wss://claude.ai/api/ws/voice/... and pipes frames both ways.
//
// Usage:
//   node test/claude-ai-live.js                                # idle, wait for control
//   node test/claude-ai-live.js --conv <uuid> --org <uuid>     # auto-attach on connect
//
// Cookie file format:
//   {
//     "cookie": "anthropic-device-id=...; sessionKey=...; __cf_bm=...; ...",
//     "userAgent": "Mozilla/5.0 ...",
//     "orgUuid": "..."
//   }
// The userAgent field is optional and defaults to a recent Chrome on Linux.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require('ws');

const BRIDGE = 'ws://127.0.0.1:8765/?role=page';
const COOKIE_FILE = path.join(os.homedir(), '.claude', 'claudeai-session.json');
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`cookie file missing: ${COOKIE_FILE}\nCapture from a logged-in claude.ai tab (DevTools → Network → any /api/... request → Copy as cURL → grab the Cookie header) and save as {"cookie":"..."}`);
  }
  const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  if (!raw.cookie) throw new Error('cookie file is missing the "cookie" field');
  return raw;
}

function parseCookieHeader(cookie) {
  const map = {};
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    map[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return map;
}

function getArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : fallback;
}

const opts = {
  autoConv: getArg('--conv', null),
  autoOrg: getArg('--org', null),
  voice: getArg('--voice', 'airy'),
  language: getArg('--language', 'en-US'),
};

const session = loadCookies();
const ua = session.userAgent || DEFAULT_UA;
const cookieMap = parseCookieHeader(session.cookie);
const orgIdFromCookie = cookieMap.lastActiveOrg || session.orgUuid || null;

const log = (...a) => console.log('[live]', new Date().toISOString().slice(11, 19), ...a);
log('starting headless page bridge');
log(`  cookie file: ${COOKIE_FILE}`);
log(`  cookie keys: ${Object.keys(cookieMap).slice(0, 8).join(', ')}${Object.keys(cookieMap).length > 8 ? ` ...(+${Object.keys(cookieMap).length - 8})` : ''}`);
log(`  ua: ${ua.slice(0, 60)}...`);
log(`  lastActiveOrg cookie: ${orgIdFromCookie || '(none)'}`);

let local = null;
let upstream = null;

function buildUpstreamUrl(orgId, convId, voice, language, timezone) {
  const params = new URLSearchParams({
    input_encoding: 'opus',
    input_sample_rate: '16000',
    input_channels: '1',
    output_format: 'pcm_16000',
    language,
    timezone,
    voice,
    server_interrupt_enabled: 'true',
    client_platform: 'web_claude_ai',
  });
  return `wss://claude.ai/api/ws/voice/organizations/${orgId}/chat_conversations/${convId}?${params}`;
}

function sendLocal(data) {
  if (local && local.readyState === WebSocket.OPEN) {
    try { local.send(data); } catch (e) { log('local send err', e.message); }
  }
}

function openUpstream({ convId, orgId, voice, language, timezone }) {
  orgId = orgId || orgIdFromCookie;
  if (!orgId) {
    sendLocal(JSON.stringify({ _bridge: 'upstream_error', message: 'orgId unavailable (set lastActiveOrg cookie or pass --org)' }));
    return;
  }
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const url = buildUpstreamUrl(orgId, convId, voice || 'airy', language || 'en-US', tz);
  log('opening upstream', url);
  // Header set mirrors what Chrome sends on the captured WS upgrade.
  const headers = {
    'Origin': 'https://claude.ai',
    'User-Agent': ua,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'websocket',
    'Sec-Fetch-Site': 'same-origin',
    Cookie: session.cookie,
  };
  if (upstream) { try { upstream.close(1000); } catch {} upstream = null; }
  upstream = new WebSocket(url, { headers, perMessageDeflate: true, origin: 'https://claude.ai' });
  upstream.binaryType = 'nodebuffer';
  upstream.on('open', () => {
    log('upstream OPEN');
    sendLocal(JSON.stringify({ _bridge: 'upstream_open', url }));
  });
  upstream.on('unexpected-response', (_req, res) => {
    const cfRay = res.headers['cf-ray'];
    const cfMit = res.headers['cf-mitigated'];
    log(`upstream upgrade REJECTED ${res.statusCode}${cfMit ? ' cf-mitigated=' + cfMit : ''}${cfRay ? ' cf-ray=' + cfRay : ''}`);
    sendLocal(JSON.stringify({
      _bridge: 'upstream_error',
      message: `http ${res.statusCode}`,
      cfMitigated: cfMit || null,
      cfRay: cfRay || null,
    }));
    res.resume();
  });
  upstream.on('message', (data, isBinary) => {
    if (isBinary) {
      log(`< server BIN ${data.length}B`);
      sendLocal(data);
    } else {
      const text = data.toString('utf8');
      log(`< server TXT ${text.slice(0, 200)}`);
      sendLocal(text);
    }
  });
  upstream.on('close', (code, reason) => {
    log(`upstream CLOSE ${code} ${reason || ''}`);
    sendLocal(JSON.stringify({ _bridge: 'upstream_close', code, reason: reason?.toString?.() || '' }));
    if (upstream) upstream = null;
  });
  upstream.on('error', (err) => {
    log('upstream ERR', err.message);
  });
}

function closeUpstream() {
  if (upstream) {
    try { upstream.close(1000); } catch {}
    upstream = null;
  }
}

function connectLocal() {
  log('connecting to local bridge');
  local = new WebSocket(BRIDGE, { origin: 'https://claude.ai' });
  local.binaryType = 'nodebuffer';
  local.on('open', () => {
    log('local OPEN');
    sendLocal(JSON.stringify({
      _bridge: 'hello',
      convId: opts.autoConv,
      orgId: opts.autoOrg || orgIdFromCookie,
      mode: 'headless',
    }));
    if (opts.autoConv) {
      log('auto-attach: opening upstream now');
      openUpstream({
        convId: opts.autoConv,
        orgId: opts.autoOrg || orgIdFromCookie,
        voice: opts.voice,
        language: opts.language,
      });
    }
  });
  local.on('message', (data, isBinary) => {
    if (isBinary) {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: true });
      }
      return;
    }
    const text = data.toString('utf8');
    let msg = null;
    try { msg = JSON.parse(text); } catch {}
    if (msg && msg._bridge) {
      if (msg._bridge === 'open') {
        openUpstream({
          convId: msg.convId,
          orgId: msg.orgId,
          voice: msg.voice,
          language: msg.language,
          timezone: msg.timezone,
        });
      } else if (msg._bridge === 'close') {
        closeUpstream();
      }
      return;
    }
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.send(text);
    }
  });
  local.on('close', () => {
    log('local CLOSE — retrying in 2s');
    local = null;
    closeUpstream();
    setTimeout(connectLocal, 2000);
  });
  local.on('error', (err) => log('local ERR', err.message));
}

connectLocal();

process.on('SIGINT', () => {
  log('SIGINT — exiting');
  closeUpstream();
  try { local?.close(1000); } catch {}
  setTimeout(() => process.exit(0), 200);
});
