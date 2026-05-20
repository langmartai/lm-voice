'use strict';

// Send candidate text frames on the voice WS and watch for any server
// response. Goal: find out what the server accepts as "the user said X"
// without an actual audio uplink.

const http = require('node:http');

const API = 'http://127.0.0.1:3199';

function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, API);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getBaselineEventCount() {
  const r = await httpReq('GET', '/api/claude-ai/events?limit=2000');
  return r.json?.events?.length || 0;
}

async function probeOne(label, frame, baselineCount) {
  const before = await getBaselineEventCount();
  await httpReq('POST', '/api/claude-ai/text/send', { text: JSON.stringify(frame) });
  await sleep(2500);
  const r = await httpReq('GET', '/api/claude-ai/events?limit=2000');
  const evs = r.json?.events || [];
  const newEvs = evs.slice(before);
  const serverTypes = newEvs
    .filter((e) => e.dir === 'server' && e.kind === 'text')
    .map((e) => e.payload?.type || '(history)');
  const tally = {};
  for (const t of serverTypes) tally[t] = (tally[t] || 0) + 1;
  const triggeredMessageStart = newEvs.some((e) =>
    e.payload?.type === 'message_sse' && e.payload?.event?.type === 'message_start'
  );
  const marker = triggeredMessageStart ? '🎯 RESPONSE' : '   ·';
  const summary = Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(', ') || '(no server text)';
  console.log(`  ${marker}  ${label.padEnd(50)} → ${summary}`);
  return triggeredMessageStart;
}

async function main() {
  // Need a live voice session before we can probe.
  const status = await httpReq('GET', '/api/claude-ai/status');
  if (!status.json?.bridge?.upstreamOpen) {
    console.error('No active upstream — start a voice session first.');
    process.exit(2);
  }
  console.log('upstream open, lastConvId:', status.json.bridge.lastConvId);

  // Stop the mic so silence doesn't get auto-transcribed and trigger a turn.
  console.log('\nStopping mic to isolate the text-frame effect...');
  await httpReq('POST', '/api/claude-ai/mic/stop');
  await sleep(1500);

  console.log('\n=== probing candidate text frames ===');
  const candidates = [
    ['user_text',                  { type: 'user_text', text: 'hello' }],
    ['user_message',               { type: 'user_message', text: 'hello' }],
    ['user_input',                 { type: 'user_input', text: 'hello' }],
    ['client_input',               { type: 'client_input', text: 'hello' }],
    ['text',                       { type: 'text', text: 'hello' }],
    ['transcript',                 { type: 'transcript', text: 'hello' }],
    ['transcript_final',           { type: 'transcript_final', text: 'hello' }],
    ['transcript_text',            { type: 'transcript_text', text: 'hello' }],
    ['final_transcript',           { type: 'final_transcript', text: 'hello' }],
    ['user_input_text',            { type: 'user_input_text', text: 'hello' }],
    ['input_text',                 { type: 'input_text', text: 'hello' }],
    ['message',                    { type: 'message', text: 'hello' }],
    ['user_input_end (no text)',   { type: 'user_input_end' }],
    ['end_of_speech',              { type: 'end_of_speech' }],
    ['speech_end',                 { type: 'speech_end' }],
    ['force_response',             { type: 'force_response' }],
    ['skip_user_input',            { type: 'skip_user_input' }],
  ];

  let anyTriggered = false;
  for (const [label, frame] of candidates) {
    const hit = await probeOne(label, frame);
    if (hit) anyTriggered = true;
  }
  console.log('\n' + (anyTriggered ? '✓ found at least one trigger' : '✗ none of the candidates triggered a model response'));
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
