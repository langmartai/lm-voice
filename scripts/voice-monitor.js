#!/usr/bin/env node
'use strict';

/**
 * lm-voice voice-session monitor (Phase A: context loader on session start).
 *
 * A long-running controller process. It polls lm-voice's bridge status and
 * watches for a new voice session opening. When one does, it asks lm-assist
 * for the user's recent local Claude Code activity, formats a compact
 * reference summary, and injects it as a text-mode user turn into the
 * conversation so the voice-mode model has context for whatever the user
 * is about to discuss.
 *
 * Phases not yet built:
 *   B) TTS-as-user-uplink primitive (POST /api/claude-ai/voice/speak-as-user)
 *   C) Live capability monitor — reasoning via lm-assist /agent/execute
 *
 * Usage:
 *   node scripts/voice-monitor.js
 *
 * Env / config (sensible defaults; override via env vars):
 *   LM_VOICE_URL   default http://127.0.0.1:3199
 *   LM_ASSIST_URL  default http://127.0.0.1:3100
 *   POLL_INTERVAL_MS  default 1000
 *   SESSION_LIMIT  default 8
 *   MAX_SUMMARY_AGE_HOURS  default 48
 */

const http = require('node:http');

// ws lives in app/node_modules — fall back if a top-level install is missing.
let WebSocket;
try { WebSocket = require('ws'); }
catch { WebSocket = require('../app/node_modules/ws'); }

const config = {
  lmVoiceUrl:   process.env.LM_VOICE_URL   || 'http://127.0.0.1:3199',
  lmAssistUrl:  process.env.LM_ASSIST_URL  || 'http://127.0.0.1:3100',
  bridgeUrl:    process.env.BRIDGE_URL     || 'ws://127.0.0.1:8765/?role=renderer',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  sessionLimit: Number(process.env.SESSION_LIMIT || 8),
  maxSummaryAgeHours: Number(process.env.MAX_SUMMARY_AGE_HOURS || 48),
  bridgeAgentEnabled: process.env.BRIDGE_AGENT_DISABLED !== '1',
  bridgeAgentModel: process.env.BRIDGE_AGENT_MODEL || 'haiku',
  bridgeAgentCwd: process.env.BRIDGE_AGENT_CWD || process.cwd(),
};

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

function httpReq(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getBridgeStatus() {
  const r = await httpReq('GET', `${config.lmVoiceUrl}/api/claude-ai/status`);
  return r.json?.bridge ?? null;
}

async function fetchRecentSessions(limit) {
  const r = await httpReq('GET', `${config.lmAssistUrl}/sessions?limit=${limit}`);
  return r.json?.data?.sessions ?? [];
}

function summarizeSessions(sessions, maxAgeHours) {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const fresh = sessions.filter((s) => Date.parse(s.lastModified) >= cutoff);
  if (fresh.length === 0) return null;
  const lines = [];
  for (const s of fresh) {
    const project = (s.projectPath || '').split(/[\\/]/).filter(Boolean).pop() || s.projectPath || '?';
    const summary = (s.sessionSummary || '(no summary)').replace(/\s+/g, ' ').slice(0, 220);
    const lastTouched = new Date(s.lastModified).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`- [${project}] ${s.numTurns}T · last ${lastTouched} UTC · ${summary}`);
  }
  return lines.join('\n');
}

function buildContextPrompt(summary) {
  return [
    'REFERENCE CONTEXT — recent Claude Code session activity on the user\'s machine.',
    'This is background context for the conversation about to start; you do not need to act on it now.',
    '',
    summary,
    '',
    'Acknowledge with a single dot character (".") only — no further text.',
  ].join('\n');
}

async function injectContext(text) {
  const r = await httpReq('POST', `${config.lmVoiceUrl}/api/claude-ai/voice/inject-text`, { text });
  return r.json;
}

const state = {
  lastSessionId: null,    // convId of the last session we already loaded context into
  lastUpstreamOpen: false,
};

async function tick() {
  let status;
  try { status = await getBridgeStatus(); }
  catch (e) { log('status err', e.message); return; }
  if (!status) return;

  const open = !!status.upstreamOpen;
  const conv = status.lastConvId || null;

  // Edge: false → true OR same true but new convId we haven't loaded yet
  const fired = (open && !state.lastUpstreamOpen) ||
                (open && conv && conv !== state.lastSessionId);
  state.lastUpstreamOpen = open;

  if (!fired) return;
  if (!conv) { log('upstream open but no lastConvId yet — waiting next tick'); return; }
  if (conv === state.lastSessionId) return;   // already loaded

  log(`new voice session detected: conv=${conv}`);
  state.lastSessionId = conv;

  let sessions;
  try { sessions = await fetchRecentSessions(config.sessionLimit); }
  catch (e) { log('fetchRecentSessions err', e.message); return; }
  const summary = summarizeSessions(sessions, config.maxSummaryAgeHours);
  if (!summary) {
    log(`no recent sessions in last ${config.maxSummaryAgeHours}h — skipping context inject`);
    return;
  }
  const prompt = buildContextPrompt(summary);
  log(`injecting context (${prompt.length} chars, ${(prompt.split('\n').length - 1)} lines)`);
  try {
    const r = await injectContext(prompt);
    log(`inject result: ok=${r?.ok} status=${r?.status} reply=${(r?.text || '').slice(0, 60).replace(/\s+/g, ' ')}`);
  } catch (e) {
    log('inject err', e.message);
  }
}

// ----- Phase C: live bridge subscriber + capability-gap agent ---------------

const REFUSAL_PATTERNS = [
  /can'?t (use|access|call|invoke|read|search|do|pull|fetch|get|connect|reach)/i,
  /not (available|active|loaded|enabled) (in|for|this|here)/i,
  /(don'?t|do not) have access/i,
  /tools? (aren'?t|isn'?t|haven'?t been) (active|loaded|available|enabled)/i,
  /(can'?t|cannot) (help|do) (with|that)/i,
  /isn'?t loaded into this/i,
  /aren'?t currently active/i,
];

function looksLikeRefusal(text) {
  if (!text || text.length < 20) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

// Per-turn accumulator. The bridge stream gives us message_sse pieces; we
// stitch them back into whole assistant turns so we can pattern-match on the
// full reply text rather than individual deltas.
const liveTurn = {
  currentAssistantText: '',
  lastUserTranscript: '',
  inAssistantTurn: false,
  recentRefusalAt: 0,    // dedupe: ignore back-to-back refusals firing the agent twice
};

function subscribeBridge() {
  log(`subscribing to bridge ${config.bridgeUrl}`);
  const ws = new WebSocket(config.bridgeUrl, { origin: 'http://localhost' });
  ws.binaryType = 'nodebuffer';
  ws.on('open', () => log('bridge subscribed'));
  ws.on('close', () => { log('bridge socket closed; reconnecting in 2s'); setTimeout(subscribeBridge, 2000); });
  ws.on('error', (e) => log('bridge err', e.message));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    handleBridgeFrame(msg);
  });
}

function handleBridgeFrame(msg) {
  if (msg._bridge) {
    if (msg._bridge === 'upstream_close' || msg._bridge === 'upstream_error') {
      // new turn boundary — reset accumulator
      liveTurn.currentAssistantText = '';
      liveTurn.inAssistantTurn = false;
    }
    return;
  }
  const t = msg.type;
  // History records — these are the canonical persisted messages.
  if (!t && msg.data?.sender && Array.isArray(msg.data.content)) {
    const text = msg.data.content.map((c) => c.text || '').join('').trim();
    if (msg.data.sender === 'human' && text) liveTurn.lastUserTranscript = text;
    return;
  }
  if (t === 'transcript_interim' && typeof msg.text === 'string') {
    // Keep the most recent interim — overwritten until final history record
    liveTurn.lastUserTranscript = msg.text;
    return;
  }
  if (t === 'message_sse' && msg.event) {
    const inner = msg.event;
    if (inner.type === 'message_start') {
      liveTurn.currentAssistantText = '';
      liveTurn.inAssistantTurn = true;
    } else if (inner.type === 'content_block_delta') {
      const txt = inner.data?.delta?.text || '';
      if (txt) liveTurn.currentAssistantText += txt;
    }
    return;
  }
  if (t === 'message_complete' && liveTurn.inAssistantTurn) {
    const userText = liveTurn.lastUserTranscript.trim();
    const asst = liveTurn.currentAssistantText.trim();
    liveTurn.inAssistantTurn = false;
    if (!asst) return;
    if (!looksLikeRefusal(asst)) return;
    // dedupe: ignore if we already fired in the last 30s
    if (Date.now() - liveTurn.recentRefusalAt < 30000) {
      log('refusal detected but agent fired <30s ago — skipping');
      return;
    }
    liveTurn.recentRefusalAt = Date.now();
    log(`[REFUSAL] user=${JSON.stringify(userText.slice(0, 120))}`);
    log(`         claude=${JSON.stringify(asst.slice(0, 120))}`);
    fireBridgeAgent(userText, asst).catch((e) => log('agent err', e.message));
  }
}

async function fireBridgeAgent(userText, refusalText) {
  if (!config.bridgeAgentEnabled) { log('bridge agent disabled — skipping'); return; }
  const prompt = [
    'You are the capability-bridge agent for an lm-voice conversation.',
    '',
    'The user is in a CLAUDE.AI VOICE session (Haiku model, restricted toolset — no MCP, no Gmail, no Drive).',
    'Voice mode just refused to fulfill a request. Decide whether TEXT MODE (Opus, full MCP tools)',
    'can fulfill it and, if so, route the answer back into the voice conversation.',
    '',
    '=== last user transcript ===',
    userText || '(none captured)',
    '',
    '=== voice-mode assistant reply (the refusal) ===',
    refusalText,
    '',
    '=== available tools (curl these from Bash) ===',
    '',
    '* POST http://127.0.0.1:3199/api/claude-ai/voice/inject-text { "text": "..." }',
    '  Inserts a text turn into the SAME conversation (uses Opus + full MCP).',
    '  Returns { "ok": true, "text": "<assistant reply>" } with the text-mode answer.',
    '',
    '* POST http://127.0.0.1:3199/api/claude-ai/voice/speak-as-user { "text": "..." }',
    '  Synthesizes text and feeds it into the voice WS as if the user spoke it.',
    '  The user then HEARS Claude voice mode\'s response.',
    '',
    '=== procedure ===',
    '1. Decide: can text mode plausibly answer the user\'s request? (e.g. Gmail/Drive/web search).',
    '   If NO, do nothing and exit.',
    '2. If YES, call inject-text with a query that asks text-mode Claude to actually do the task.',
    '   Use phrasing like: "Please use the available tools to answer this for me: <user request>"',
    '3. Read the response text. Extract just the user-facing answer (concise, conversational).',
    '4. Call speak-as-user with that answer, phrased naturally as if you (the user) are saying it,',
    '   e.g. "Got it, my latest email is from npm about token expiry — should I rotate the token?"',
    '   This makes voice-mode Claude respond in voice with the context already in hand.',
    '',
    'Keep your work tight. Do not chain multiple tools — one inject + one speak should be enough.',
    'If anything errors, abort silently. Output a one-line summary of what you did at the end.',
  ].join('\n');

  log(`spawning bridge agent (model=${config.bridgeAgentModel})…`);
  const r = await httpReq('POST', `${config.lmAssistUrl}/agent/execute`, {
    prompt,
    cwd: config.bridgeAgentCwd,
    background: false,
    model: config.bridgeAgentModel,
    permissionMode: 'bypassPermissions',
    settingSources: ['user'],
    outputConfig: { effort: 'medium' },
  });
  const result = (r.json?.result || r.json?.text || '').slice(0, 400);
  log(`agent done: ${result.replace(/\s+/g, ' ').slice(0, 300)}`);
}

async function main() {
  log('voice-monitor starting');
  log(`  lm-voice  ${config.lmVoiceUrl}`);
  log(`  lm-assist ${config.lmAssistUrl}`);
  log(`  poll      every ${config.pollIntervalMs}ms`);
  log(`  sessions  last ${config.sessionLimit} (cutoff ${config.maxSummaryAgeHours}h)`);
  log(`  bridge-agent ${config.bridgeAgentEnabled ? 'enabled' : 'disabled'} (model ${config.bridgeAgentModel})`);
  // start the bridge subscriber for Phase C in parallel with the polling loop
  subscribeBridge();
  // run forever
  while (true) {
    await tick();
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

process.on('SIGINT', () => { log('SIGINT — exiting'); process.exit(0); });
main().catch((e) => { log('FATAL', e.stack || e.message); process.exit(2); });
