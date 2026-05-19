'use strict';

// End-to-end smoke test for the new claude.ai voice bridge.
//
// Strategy: lm-voice must already be running. We connect a mock "page" client
// to the bridge that pretends to be the in-page JS in claude.ai (it forwards
// nothing to a real upstream, just records what lm-voice sends it). Then we
// exercise every /api/claude-ai/* route and verify the frame-relay direction.
//
// Optional: if reachable, /api/tts is used to generate a real WAV that we then
// chop and send via /api/claude-ai/audio/send to confirm the upload path.

const http = require('node:http');
const WebSocket = require('ws');

const API = 'http://127.0.0.1:3199';
const BRIDGE = 'ws://127.0.0.1:8765';
const ORIGIN = 'https://claude.ai';

const log = (...a) => console.log('[test]', ...a);

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; log('  ✓', label); }
  else { fail++; log('  ✗', label); }
}

function httpReq(method, p, { body, headers, expectBinary } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, API);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': body && !Buffer.isBuffer(body) ? 'application/json' : 'application/octet-stream',
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (expectBinary) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
        const text = buf.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}

function connectMockPage() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BRIDGE}/?role=page`, { origin: ORIGIN });
    ws.binaryType = 'nodebuffer';
    ws.received = { text: [], binary: [] };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.received.binary.push(data);
      else ws.received.text.push(data.toString('utf8'));
    });
  });
}

function connectMockRenderer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BRIDGE}/?role=renderer`, { origin: 'file://' });
    ws.binaryType = 'nodebuffer';
    ws.received = { text: [], binary: [] };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.received.binary.push(data);
      else ws.received.text.push(data.toString('utf8'));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('=== Phase 1: API surface reachable ===');
  const root = await httpReq('GET', '/');
  assert(root.json?.name === 'lm-voice API', 'root /  → name=lm-voice API');
  assert((root.json?.routes || []).some((r) => r.includes('/api/claude-ai/')), 'root advertises claude-ai routes');

  const statusBefore = await httpReq('GET', '/api/claude-ai/status');
  assert(statusBefore.json?.bridge?.listening === true, 'bridge listening');
  assert(statusBefore.json?.bridge?.pageAttached === false, 'page not yet attached');

  const snippet = await httpReq('GET', '/api/claude-ai/snippet');
  assert(snippet.status === 200, 'GET /api/claude-ai/snippet → 200');
  assert(typeof snippet.text === 'string' && snippet.text.includes('__lmVoiceBridge'), 'snippet contains __lmVoiceBridge');
  assert(snippet.text.includes('ws://127.0.0.1:8765'), 'snippet points at local bridge URL');

  log('=== Phase 2: origin gating ===');
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`${BRIDGE}/?role=page`, { origin: 'https://evil.example' });
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on('error', (e) => resolve(`error ${e.message}`));
  });
  assert(/403|error|Unexpected server response/i.test(rejected) || rejected === 'http 403',
         `cross-origin upgrade rejected (${rejected})`);

  log('=== Phase 3: mock page + renderer attach ===');
  const page = await connectMockPage();
  const renderer = await connectMockRenderer();
  await sleep(150);

  const statusAttached = await httpReq('GET', '/api/claude-ai/status');
  assert(statusAttached.json?.bridge?.pageAttached === true, 'page attached after mock-page connect');
  assert(statusAttached.json?.bridge?.renderers === 1, 'one renderer attached');

  // page sends hello as the userscript would
  page.send(JSON.stringify({ _bridge: 'hello', convId: 'fake-conv-uuid', orgId: 'fake-org-uuid' }));
  await sleep(100);

  // renderer should have received page_attached notification
  const rendererMsgs = renderer.received.text.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  assert(rendererMsgs.some((m) => m._bridge === 'page_attached'), 'renderer got page_attached');

  log('=== Phase 4: upstream open relay ===');
  page.received.text.length = 0;
  const openRes = await httpReq('POST', '/api/claude-ai/upstream/open', {
    body: { convId: 'fake-conv-uuid', voice: 'airy' },
  });
  assert(openRes.status === 200 && openRes.json?.ok === true, 'POST upstream/open → ok');
  await sleep(80);
  const opened = page.received.text.map((s) => { try { return JSON.parse(s); } catch { return null; } }).find((m) => m?._bridge === 'open');
  assert(opened?.convId === 'fake-conv-uuid', 'page received _bridge:open with convId');
  assert(opened?.voice === 'airy', 'page received voice=airy');

  log('=== Phase 5: audio binary relay (page upload path) ===');
  const fakeOpus = Buffer.from([0x78, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const audioRes = await httpReq('POST', '/api/claude-ai/audio/send', {
    body: fakeOpus, headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert(audioRes.json?.ok === true && audioRes.json?.bytes === 6, 'POST audio/send → ok, 6 bytes');
  await sleep(80);
  assert(page.received.binary.some((b) => b.equals(fakeOpus)), 'mock page received exact same Opus bytes');

  log('=== Phase 6: page → renderer downlink relay (simulate server frames) ===');
  renderer.received.text.length = 0;
  renderer.received.binary.length = 0;
  // simulate server sending a JSON text event
  page.send(JSON.stringify({ type: 'transcript', text: 'hello from server' }));
  // simulate server sending PCM binary
  const fakePcm = Buffer.alloc(320); // 10ms @ 16kHz mono
  for (let i = 0; i < fakePcm.length; i += 2) fakePcm.writeInt16LE(((i * 7) & 0xffff) - 0x8000, i);
  page.send(fakePcm, { binary: true });
  await sleep(80);
  assert(renderer.received.text.some((s) => s.includes('hello from server')), 'renderer got JSON event from page');
  assert(renderer.received.binary.some((b) => b.equals(fakePcm)), 'renderer got PCM binary from page');

  log('=== Phase 7: event ring buffer ===');
  const events = await httpReq('GET', '/api/claude-ai/events?limit=20');
  const evs = events.json?.events || [];
  assert(Array.isArray(evs) && evs.length > 0, `events buffer populated (${evs.length} entries)`);
  assert(evs.some((e) => e.dir === 'page' && e.kind === 'bridge'), 'buffer contains bridge events');
  assert(evs.some((e) => e.dir === 'server' && e.kind === 'text'), 'buffer contains server text');
  assert(evs.some((e) => e.dir === 'server' && e.kind === 'binary'), 'buffer contains server binary');

  log('=== Phase 8: TTS → bridge upload bytes (real audio) ===');
  // /api/tts may take ~10s for first-run model download — give it room.
  let ttsBuf = null;
  try {
    const tts = await httpReq('POST', '/api/tts', {
      body: { text: 'Hello, this is a synthesised test phrase.' },
      expectBinary: true,
    });
    if (tts.status === 200 && tts.body && tts.body.length > 1000) {
      ttsBuf = tts.body;
      log(`  TTS produced ${ttsBuf.length} bytes`);
    } else {
      log(`  TTS skipped or not ready (status=${tts.status}, bytes=${tts.body?.length || 0})`);
    }
  } catch (e) {
    log('  TTS request errored:', e.message);
  }

  if (ttsBuf) {
    page.received.binary.length = 0;
    // Send the WAV payload in 1 KB chunks to validate streamed upload path.
    const CHUNK = 1024;
    let total = 0;
    for (let off = 0; off < ttsBuf.length; off += CHUNK) {
      const slice = ttsBuf.subarray(off, Math.min(ttsBuf.length, off + CHUNK));
      const r = await httpReq('POST', '/api/claude-ai/audio/send', {
        body: slice, headers: { 'Content-Type': 'application/octet-stream' },
      });
      total += r.json?.bytes || 0;
      if (!r.json?.ok) { log('  upload failed at offset', off); break; }
    }
    assert(total === ttsBuf.length, `streamed full TTS WAV through bridge (${total}/${ttsBuf.length})`);
    await sleep(150);
    const got = page.received.binary.reduce((s, b) => s + b.length, 0);
    assert(got === ttsBuf.length, `mock page received the exact byte count (${got})`);
  }

  log('=== Phase 9: cleanup ===');
  await httpReq('POST', '/api/claude-ai/upstream/close', {});
  await sleep(60);
  const closeMsg = page.received.text.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean).find((m) => m?._bridge === 'close');
  assert(!!closeMsg, 'page received _bridge:close');

  page.close();
  renderer.close();
  await sleep(120);
  const finalStatus = await httpReq('GET', '/api/claude-ai/status');
  assert(finalStatus.json?.bridge?.pageAttached === false, 'page detached after mock close');
  assert(finalStatus.json?.bridge?.renderers === 0, 'renderers drained');

  log('');
  log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  log('FATAL', err.stack || err.message);
  process.exit(2);
});
