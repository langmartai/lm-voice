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
  // Keep this short and honest — Claude pushed back on a previous version
  // that asked it to pretend a background worker exists in its toolset. We
  // just load reference context; the monitor handles delegation proactively
  // on the user side (sees user transcripts, does local work, injects results
  // back via speak-as-user — Claude doesn't need to know how it arrived).
  return [
    'Reference context — recent Claude Code session activity on the user\'s machine.',
    'This is background info for the conversation about to start. Do not act on it.',
    '',
    summary,
    '',
    'Heads-up: some user messages later in this chat may contain data that I gathered',
    'locally with my own tooling (file contents, lm-assist session state, output of',
    'shell commands, etc) — when that happens just treat it as me providing context',
    'and respond naturally.',
    '',
    'Acknowledge with a single "." and nothing else.',
  ].join('\n');
}

async function injectContext(text) {
  // Retry on 429 — context-loader runs right after a fresh conversation create
  // which sometimes hits a per-org rate limit. Two attempts is enough in practice.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await httpReq('POST', `${config.lmVoiceUrl}/api/claude-ai/voice/inject-text`, { text });
    if (r.json?.ok) return r.json;
    if (r.json?.status === 429 || r.status === 429) {
      const delay = 1500 * (attempt + 1);
      log(`inject 429 — retrying in ${delay}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return r.json;   // some other error — return as-is
  }
  return { ok: false, error: 'gave up after 3 retries on 429' };
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

// User-transcript patterns that mean "I want something local-only". The
// monitor proactively fires the agent when these match — doesn't wait to
// see if Claude refuses, because (a) Claude can't be made to delegate
// reliably, and (b) acting earlier means the user sees a faster reply.
const LOCAL_INTENT_PATTERNS = [
  /lm[-\s]?assist/i,
  /lm[-\s]?voice/i,
  /(my|the|this) (local|machine|computer|laptop|desktop|filesystem|files?|session)/i,
  /(check|read|run|list|show) (the|my|this) (\w+\s+){0,4}(file|directory|folder|script|log|repo|session|process)/i,
  /(claude[-\s]?code|trade[-\s]?engine|trading|server|process|daemon) (status|state|log|output|sessions?)/i,
  /(running|active) (session|process|task|execution)s?/i,
  /(any|what|which|list|show) (\w+\s+){0,3}sessions?( running)?( on)?( my)?( machine| computer)?/i,
  /(what|how is|status of) (my|the) (\w+\s+){0,3}(session|service|daemon|process|engine)/i,
];

// Fallback: legacy refusal patterns — if Claude DOES refuse before we got a
// chance to act on the user's intent, still fire the agent.
const FALLBACK_REFUSAL_PATTERNS = [
  /can'?t (use|access|call|invoke|read|search|do|pull|fetch|get|connect|reach|see|find)/i,
  /(don'?t|do not) have access/i,
  /no access to (your|the user'?s) (local|machine|filesystem|files|sessions|computer)/i,
];

function looksLikeLocalIntent(text) {
  if (!text || text.length < 5) return false;
  return LOCAL_INTENT_PATTERNS.some((re) => re.test(text));
}

function looksLikeRefusal(text) {
  if (!text || text.length < 20) return false;
  return FALLBACK_REFUSAL_PATTERNS.some((re) => re.test(text));
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
    if (msg.data.sender === 'human' && text) {
      liveTurn.lastUserTranscript = text;
      // PROACTIVE: human history record is the FINAL user transcript. Check
      // it now for local intent and fire the agent in parallel with Claude's
      // upcoming response. The user will hear an answer sooner.
      maybeFireAgent(text, '', 'LOCAL_INTENT');
    }
    return;
  }
  if (t === 'transcript_interim' && typeof msg.text === 'string') {
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
    // Reactive fallback: only fire if user-intent didn't catch this earlier
    maybeFireAgent(userText, asst, 'REFUSAL');
  }
}

function maybeFireAgent(userText, assistantText, channel) {
  if (!userText) return;
  if (channel === 'LOCAL_INTENT' && !looksLikeLocalIntent(userText)) return;
  if (channel === 'REFUSAL' && !looksLikeRefusal(assistantText)) return;
  // dedupe: ignore if we already fired in the last 30s for any reason
  if (Date.now() - liveTurn.recentRefusalAt < 30000) {
    log(`${channel} matched but agent fired <30s ago — skipping`);
    return;
  }
  liveTurn.recentRefusalAt = Date.now();
  log(`[${channel}] user=${JSON.stringify(userText.slice(0, 120))}`);
  if (assistantText) log(`         claude=${JSON.stringify(assistantText.slice(0, 120))}`);
  fireBridgeAgent(userText, assistantText, channel).catch((e) => log('agent err', e.message));
}

async function fireBridgeAgent(userText, refusalText, trigger) {
  if (!config.bridgeAgentEnabled) { log('bridge agent disabled — skipping'); return; }
  const prompt = [
    'You are the LOCAL-CAPABILITIES agent for an lm-voice conversation.',
    '',
    'A user is in a CLAUDE.AI VOICE session (Haiku, conversational only, limited tools). The cloud',
    'Claude (voice or text mode) can do things like web search, Gmail, Drive — but it CANNOT reach',
    'anything local to the user\'s machine. You run AS A SEPARATE PROCESS on the user\'s machine, so',
    'you have access to things cloud Claude does not:',
    '',
    '  * lm-assist HTTP API at http://127.0.0.1:3100/ — Claude Code sessions, project state,',
    '    /agent/execute for sub-agent runs, /sessions, /projects, claude-ai conversation reads, etc.',
    '  * The user\'s filesystem (Bash, Read, etc.) — anything on disk.',
    '  * Local processes / daemons — lm-voice (port 3199), lm-assist (3100), any project services.',
    '  * Local Claude Code session histories under ~/.claude/projects/',
    '  * Git status of local repos.',
    '',
    'Your job: when the conversation hits something the cloud can\'t do but you CAN, pick it up,',
    'do it, and report back into the conversation through two channels described below.',
    '',
    '=== last user transcript ===',
    userText || '(none captured)',
    '',
    '=== voice-mode assistant reply ===',
    refusalText,
    '',
    `=== trigger reason: ${trigger} ===`,
    trigger === 'LOCAL_INTENT'
      ? [
          'The user just asked something that pattern-matched "local task" (lm-assist, local sessions,',
          'local files, machine state, etc). You fired BEFORE the cloud Claude replied — your goal is',
          'to get the answer in front of the user FAST by speaking it as the user, so cloud Claude\'s',
          'spoken reply already has the data. If the request turns out to NOT be local, just skip.',
        ].join('\n')
      : [
          'The cloud Claude refused the user\'s request. Decide: can YOU do this locally? If yes,',
          'do it and report via speak-as-user so cloud Claude can speak the answer back. If no, also',
          'report so the user knows the request was actually attempted.',
        ].join('\n'),
    '',
    '=== how to talk back to the conversation ===',
    '',
    'You have TWO output channels into the claude.ai conversation:',
    '',
    '1. inject-text: writes a TEXT-MODE user turn into the conversation history.',
    '   POST http://127.0.0.1:3199/api/claude-ai/voice/inject-text { "text": "..." }',
    '   Use this for: detailed findings, structured data, things that should be in history but',
    '   are too long to speak naturally. The cloud Claude (Opus) replies in text (no TTS).',
    '',
    '2. speak-as-user: synthesizes audio and feeds it into the voice WS as user mic input.',
    '   POST http://127.0.0.1:3199/api/claude-ai/voice/speak-as-user { "text": "..." }',
    '   Voice Claude (Haiku) treats it as the user speaking and REPLIES IN VOICE — the user hears',
    '   audio. Keep under 25 words; Supertonic+Deepgram round-trip loses fidelity on long text.',
    '',
    'Use BOTH for important results — speak-as-user for the short verbal summary so user hears it,',
    'inject-text for the detailed record so it\'s queryable later.',
    '',
    '=== required pattern: announce, work, report ===',
    '',
    'A. ANNOUNCE — first thing you do, BEFORE any local work:',
    '   speak-as-user with a single short phrase telling the user you\'re on it, e.g.',
    '     "Hold on, let me check that locally."',
    '     "Got it, pulling that up now."',
    '   This makes voice Claude respond ("ok, take your time") so the user knows something is happening.',
    '',
    'B. WORK — do the actual local task. Use Bash, curl lm-assist, read files, whatever it takes.',
    '   Be thorough but bounded — don\'t spend 5 minutes on a tangent.',
    '',
    'C. REPORT — when done:',
    '   1. inject-text with a structured detailed answer (multi-line ok, can include data).',
    '   2. speak-as-user with a 1-2 sentence verbal summary so voice Claude can speak it to the user.',
    '',
    '=== if you genuinely cannot fulfill the task ===',
    '',
    'Even then, you MUST still report back via speak-as-user so voice Claude can tell the user.',
    'The user is waiting for an answer. Phrase it like:',
    '    "Actually, the helper checked and that\'s not something it can do either."',
    '    "Helper here — turns out I don\'t have access to that on this machine. Try [alternative]."',
    'Keep it under 25 words. Do NOT just silently abort — the user would hear nothing back.',
    '',
    '=== examples of things you SHOULD pick up ===',
    '* "what\'s lm-assist doing right now" → curl lm-assist /sessions and /agent/execution',
    '* "any running Claude Code sessions" → curl lm-assist',
    '* "what did I work on yesterday" → list recent Claude Code session summaries',
    '* "check my trade engine status" → curl localhost ports, read project state',
    '* "what\'s in my CLAUDE.md" → Bash, cat the file',
    '* "is the deploy running" → ps / netstat / curl local service',
    '',
    '=== examples to SKIP ===',
    '* email / calendar (claude.ai handles those via connectors; user can click "Use Gmail" themselves)',
    '* general knowledge questions (cloud Claude already answered or refused appropriately)',
    '* code Claude already answered correctly',
    '',
    'Output a one-line summary of what you did at the end. If you abort, say so.',
  ].join('\n');

  log(`spawning bridge agent (model=${config.bridgeAgentModel})…`);
  const t0 = Date.now();
  const r = await httpReq('POST', `${config.lmAssistUrl}/agent/execute`, {
    prompt,
    cwd: config.bridgeAgentCwd,
    background: false,
    model: config.bridgeAgentModel,
    permissionMode: 'bypassPermissions',
    settingSources: ['user'],
    outputConfig: { effort: 'medium' },
  });
  // lm-assist wraps the agent payload: { success, data: { success, result, sessionId, durationMs, numTurns, ... } }
  const inner = r.json?.data ?? r.json ?? {};
  const result = (inner.result || inner.text || r.text || '').toString();
  const dt = Math.round((Date.now() - t0) / 1000);
  log(`agent done in ${dt}s · turns=${inner.numTurns ?? '?'} · cost=$${inner.totalCostUsd ?? '?'}`);
  log(`  session: ${inner.sessionId || '?'}`);
  log(`  result : ${result.replace(/\s+/g, ' ').slice(0, 400)}`);
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
