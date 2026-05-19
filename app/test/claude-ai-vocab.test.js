'use strict';

// End-to-end live conversation against claude.ai's voice WS.
// Drives:
//   1. spawn test/claude-ai-live.js (headless page connecting to real upstream)
//   2. poll lm-voice /api/claude-ai/status until pageAttached:true
//   3. POST upstream/open with a real convId
//   4. wait briefly for hello/welcome frames
//   5. (optional) stream a TTS WAV as binary frames
//   6. wait, drain /api/claude-ai/events
//   7. dump the decoded server vocabulary to stdout + JSON file
//
// Prerequisites:
//   - lm-voice running (npm start in app/, ports 3199 + 8765 listening)
//   - ~/.claude/claudeai-session.json exists with a fresh Cookie header
//   - a real claude.ai conversation UUID passed as --conv
//
// Usage:
//   node test/claude-ai-vocab.test.js --conv <uuid> [--org <uuid>] \
//       [--voice airy] [--language en-US] [--send-tts] [--seconds 20]
//
// Output:
//   prints a deduped event-type histogram + writes test/out/vocab-{ts}.json

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const API = 'http://127.0.0.1:3199';

function getArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : fallback;
}
function hasFlag(name) { return process.argv.indexOf(name) !== -1; }

const args = {
  convId:  getArg('--conv', null),
  orgId:   getArg('--org', null),
  voice:   getArg('--voice', 'airy'),
  language:getArg('--language', 'en-US'),
  sendTts: hasFlag('--send-tts'),
  seconds: Number(getArg('--seconds', '20')),
};

if (!args.convId) {
  console.error('--conv <uuid> is required');
  console.error('See top of file for full usage.');
  process.exit(2);
}

const COOKIE_FILE = path.join(os.homedir(), '.claude', 'claudeai-session.json');
if (!fs.existsSync(COOKIE_FILE)) {
  console.error(`cookie file missing: ${COOKIE_FILE}`);
  console.error('Capture it from a logged-in claude.ai tab and save as {"cookie":"..."}');
  process.exit(2);
}

const log = (...a) => console.log('[vocab]', new Date().toISOString().slice(11, 19), ...a);

function httpReq(method, p, { body, expectBinary } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, API);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': body && !Buffer.isBuffer(body) ? 'application/json' : 'application/octet-stream',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (expectBinary) return resolve({ status: res.statusCode, body: buf });
        const text = buf.toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('preflight: probe lm-voice API');
  const root = await httpReq('GET', '/');
  if (root.json?.name !== 'lm-voice API') {
    log('lm-voice API not reachable on', API); process.exit(2);
  }

  log('spawning headless page bridge: test/claude-ai-live.js');
  const live = spawn(process.execPath, [
    path.join(__dirname, 'claude-ai-live.js'),
  ], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const liveLog = path.join(__dirname, 'out', `live-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(liveLog), { recursive: true });
  const liveStream = fs.createWriteStream(liveLog);
  live.stdout.pipe(liveStream);
  live.stderr.pipe(liveStream);
  log('  live.js stdout/stderr →', liveLog);

  process.on('exit', () => { try { live.kill(); } catch {} });
  process.on('SIGINT', () => { try { live.kill(); } catch {} process.exit(130); });

  log('waiting up to 6s for page to attach...');
  let attached = false;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const s = await httpReq('GET', '/api/claude-ai/status');
    if (s.json?.bridge?.pageAttached) { attached = true; break; }
  }
  if (!attached) {
    log('page did not attach within 6s — check', liveLog);
    process.exit(3);
  }
  log('  page attached');

  log(`opening upstream: convId=${args.convId.slice(0,8)}…, voice=${args.voice}, lang=${args.language}`);
  const openRes = await httpReq('POST', '/api/claude-ai/upstream/open', {
    body: { convId: args.convId, orgId: args.orgId, voice: args.voice, language: args.language },
  });
  if (!openRes.json?.ok) {
    log('  upstream/open failed:', JSON.stringify(openRes.json));
    process.exit(3);
  }
  log('  control message dispatched to page');

  log(`collecting events for ${args.seconds}s ...`);
  const start = Date.now();
  const seenTypes = new Map();
  const allEvents = [];
  let lastIdx = 0;
  let upstreamOpen = false;
  let upstreamCloseCode = null;
  let cfHint = null;

  while (Date.now() - start < args.seconds * 1000) {
    await sleep(500);
    const r = await httpReq('GET', `/api/claude-ai/events?limit=200`);
    const evs = r.json?.events || [];
    for (const e of evs.slice(lastIdx)) {
      allEvents.push(e);
      const tag = e.dir === 'server' ? (e.kind === 'binary' ? 'server:binary' : `server:${e.payload?.type || 'unknown'}`)
                : e.dir === 'page' ? `page:${e.payload?._bridge || 'msg'}` : `${e.dir}:${e.kind}`;
      seenTypes.set(tag, (seenTypes.get(tag) || 0) + 1);
      if (e.payload?._bridge === 'upstream_open') upstreamOpen = true;
      if (e.payload?._bridge === 'upstream_close') upstreamCloseCode = e.payload?.code;
      if (e.payload?._bridge === 'upstream_error') cfHint = e.payload;
    }
    lastIdx = evs.length;
    if (upstreamCloseCode != null && Date.now() - start > 2000) {
      log('  upstream closed early — stopping collection');
      break;
    }
  }

  if (args.sendTts && upstreamOpen) {
    log('upstream is open — generating TTS WAV and streaming as upload bytes');
    const tts = await httpReq('POST', '/api/tts', {
      body: { text: 'Hello Claude. Please introduce yourself briefly.' },
      expectBinary: true,
    });
    if (tts.status === 200 && tts.body?.length > 1000) {
      log(`  TTS bytes: ${tts.body.length}`);
      // Stream in 32 ms slices (typical Opus frame interval); raw WAV bytes are wrong format
      // for what server expects (it wants raw Opus packets), so this is a wire-test only.
      const CHUNK = 56; // mimic captured Opus frame size
      for (let off = 0; off < tts.body.length; off += CHUNK) {
        const slice = tts.body.subarray(off, Math.min(tts.body.length, off + CHUNK));
        await httpReq('POST', '/api/claude-ai/audio/send', { body: slice });
        await sleep(20);
      }
      log('  TTS WAV streamed (expect protocol errors — wrong audio format)');
      // collect a few more seconds to capture any error frames
      const extra = 6;
      log(`  waiting ${extra}s to catch reply/error events`);
      const t0 = Date.now();
      while (Date.now() - t0 < extra * 1000) {
        await sleep(500);
        const r = await httpReq('GET', `/api/claude-ai/events?limit=400`);
        const evs = r.json?.events || [];
        for (const e of evs.slice(lastIdx)) {
          allEvents.push(e);
          const tag = e.dir === 'server' ? (e.kind === 'binary' ? 'server:binary' : `server:${e.payload?.type || 'unknown'}`)
                    : e.dir === 'page' ? `page:${e.payload?._bridge || 'msg'}` : `${e.dir}:${e.kind}`;
          seenTypes.set(tag, (seenTypes.get(tag) || 0) + 1);
        }
        lastIdx = evs.length;
      }
    } else {
      log('  TTS unavailable; skipping');
    }
  }

  log('closing upstream');
  await httpReq('POST', '/api/claude-ai/upstream/close', {});
  await sleep(500);

  const tsStr = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, 'out', `vocab-${tsStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    args,
    upstreamOpen,
    upstreamCloseCode,
    cfHint,
    typeCounts: Object.fromEntries(seenTypes),
    events: allEvents,
  }, null, 2));

  log('=== RESULT ===');
  log(`  upstream opened   : ${upstreamOpen}`);
  log(`  upstream close    : ${upstreamCloseCode ?? '(still open at end)'}`);
  if (cfHint) log(`  cf-mitigated      : ${JSON.stringify(cfHint)}`);
  log(`  total events kept : ${allEvents.length}`);
  log('  type histogram    :');
  for (const [k, v] of [...seenTypes.entries()].sort((a, b) => b[1] - a[1])) {
    log(`    ${v.toString().padStart(4)}  ${k}`);
  }
  log(`  detail dump       : ${outPath}`);

  try { live.kill(); } catch {}
  process.exit(upstreamOpen ? 0 : 1);
}

main().catch((err) => {
  log('FATAL', err.stack || err.message);
  process.exit(2);
});
