'use strict';

const { ipcRenderer } = require('electron');

const els = {
  statusDot:    document.getElementById('status-dot'),
  statusText:   document.getElementById('status-text'),
  statusDetail: document.getElementById('status-detail'),
  btnNew:       document.getElementById('btn-new'),
  btnSwitch:    document.getElementById('btn-switch'),
  btnStop:      document.getElementById('btn-stop'),
  toggleDebug:  document.getElementById('toggle-debug'),
  log:          document.getElementById('log'),
  debugPanel:   document.getElementById('debug-panel'),
  events:       document.getElementById('events'),
  clearEvents:  document.getElementById('clear-events'),
  picker:       document.getElementById('picker'),
  pickerBody:   document.getElementById('picker-body'),
  pickerClose:  document.getElementById('picker-close'),
  composerInput: document.getElementById('composer-input'),
  composerSend:  document.getElementById('composer-send'),
};

const API_BASE = 'http://127.0.0.1:3199';

const BRIDGE_URL = 'ws://127.0.0.1:8765/?role=renderer';

const state = {
  bridge: null,
  pageAttached: false,
  upstreamOpen: false,
  micRunning: false,
  speaking: false,
};

const turn = {
  interim: null,
  assistant: null,
  assistantText: '',
  speakingBubble: null,
  speakingWordIdx: 0,
  // Where the highlight currently sits inside speakingBubble's word spans.
  // tts_word events advance this by searching forward for a fuzzy text match
  // (handles cases like TTS splitting "twenty-six" → two spoken words while
  // the bubble has it as one span).
  highlightSpanIdx: -1,
  ttsTimeOffset: null,
  pendingWordTimers: [],
  ttsQueue: [],
  ttsPaused: false,
  ttsPausedAt: 0,
  // True from cancel until the next playback_start, so any tts_word events
  // still arriving on the wire don't re-highlight on the cancelled bubble.
  playbackCancelled: false,
};

let placeholderEl = null;

function setStatus(level, text, detail) {
  els.statusDot.classList.remove('idle', 'listening', 'thinking', 'speaking', 'err');
  if (level) els.statusDot.classList.add(level);
  els.statusText.textContent = text;
  els.statusDetail.textContent = detail || '';
}

function updateStatus() {
  if (!state.bridge || state.bridge.readyState !== 1) {
    setStatus('err', 'Bridge disconnected', 'reconnecting…');
  } else if (!state.pageAttached) {
    setStatus('err', 'Page bridge not attached', 'open the Claude.ai tab');
  } else if (state.speaking) {
    setStatus('speaking', 'Claude is speaking', '');
  } else if (state.upstreamOpen && state.micRunning) {
    setStatus('listening', 'Listening', 'speak any time');
  } else if (state.upstreamOpen) {
    setStatus('thinking', 'Voice session open', 'mic off');
  } else {
    setStatus('idle', 'Idle', 'no voice session');
  }
  // Buttons reflect the action available right now.
  const canStart = state.pageAttached && !state.upstreamOpen;
  els.btnNew.disabled = !canStart;
  els.btnSwitch.disabled = !canStart;
  els.btnStop.disabled = !state.upstreamOpen;
  // Composer enabled only when a voice session is open.
  const canInject = state.upstreamOpen;
  els.composerInput.disabled = !canInject;
  els.composerSend.disabled = !canInject;
}

function ensurePlaceholder() {
  if (placeholderEl) return;
  placeholderEl = document.createElement('div');
  placeholderEl.className = 'placeholder';
  placeholderEl.innerHTML = `<span class="big">🎙</span>Voice conversation will appear here.<br/>Start a session from the API or the Claude.ai tab to begin.`;
  els.log.appendChild(placeholderEl);
}

function dropPlaceholder() {
  if (placeholderEl) { placeholderEl.remove(); placeholderEl = null; }
}

function addRow(kind, text) {
  dropPlaceholder();
  const div = document.createElement('div');
  div.className = `row ${kind}`;
  div.textContent = text;
  els.log.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  requestAnimationFrame(() => { els.log.scrollTop = els.log.scrollHeight; });
}

function lifecyclePulse(label) {
  dropPlaceholder();
  const div = document.createElement('div');
  div.className = 'row system';
  div.textContent = label;
  els.log.appendChild(div);
  scrollToBottom();
}

function logRawEvent(obj) {
  const line = JSON.stringify(obj);
  els.events.textContent += (els.events.textContent ? '\n' : '') + line.slice(0, 500);
  if (els.events.textContent.length > 12000) els.events.textContent = els.events.textContent.slice(-9000);
  els.events.scrollTop = els.events.scrollHeight;
}

// --- Bridge socket -----------------------------------------------------------

function openBridge() {
  const ws = new WebSocket(BRIDGE_URL);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => updateStatus();
  ws.onclose = () => {
    state.bridge = null;
    state.pageAttached = false;
    state.upstreamOpen = false;
    state.micRunning = false;
    state.speaking = false;
    // Stop any in-flight highlight timers — they'd fire against stale bubbles
    // with no way for new events to update them until reconnect.
    endPlaybackHighlight();
    updateStatus();
    setTimeout(openBridge, 1500);
  };
  ws.onerror = () => updateStatus();
  ws.onmessage = (e) => handleBridgeMessage(e.data);
  state.bridge = ws;
}

function handleBridgeMessage(data) {
  if (typeof data === 'string') {
    let msg = null;
    try { msg = JSON.parse(data); } catch {}
    if (msg && msg._bridge) { handleBridgeControl(msg); return; }
    if (msg) { logRawEvent(msg); handleUpstreamEvent(msg); return; }
    return;
  }
  // Binary PCM frames are played by the embedded claude.ai BrowserView (the
  // page snippet's playPcm16). The renderer ignores them — playing here too
  // would produce double audio AND the page-side AudioContext.suspend() on
  // pause wouldn't silence the renderer's separate AudioContext.
}

function handleBridgeControl(msg) {
  if (msg._bridge === 'page_attached') {
    state.pageAttached = true;
  } else if (msg._bridge === 'page_detached') {
    state.pageAttached = false;
    state.upstreamOpen = false;
    state.micRunning = false;
    state.speaking = false;
  } else if (msg._bridge === 'upstream_open') {
    state.upstreamOpen = true;
  } else if (msg._bridge === 'upstream_close') {
    state.upstreamOpen = false;
    state.micRunning = false;
    state.speaking = false;
    finalizeAssistant();
    endPlaybackHighlight();
  } else if (msg._bridge === 'upstream_error') {
    state.upstreamOpen = false;
    state.speaking = false;
    finalizeAssistant();
    endPlaybackHighlight();
  } else if (msg._bridge === 'mic_started') {
    state.micRunning = true;
  } else if (msg._bridge === 'mic_stopped') {
    state.micRunning = false;
  } else if (msg._bridge === 'mic_error') {
    addRow('error', `Mic error: ${msg.message || ''}`);
  }
  logRawEvent(msg);
  updateStatus();
}

// --- Conversation streaming logic -------------------------------------------

function ensureInterimBubble() {
  if (turn.interim) return turn.interim;
  dropPlaceholder();
  turn.interim = document.createElement('div');
  turn.interim.className = 'row user interim';
  els.log.appendChild(turn.interim);
  scrollToBottom();
  return turn.interim;
}

function finalizeInterim(finalText) {
  if (!turn.interim) return;
  if (typeof finalText === 'string' && finalText) turn.interim.textContent = finalText;
  turn.interim.classList.remove('interim');
  turn.interim = null;
}

function ensureAssistantBubble() {
  if (turn.assistant) return turn.assistant;
  dropPlaceholder();
  turn.assistant = document.createElement('div');
  turn.assistant.className = 'row assistant streaming';
  els.log.appendChild(turn.assistant);
  turn.assistantText = '';
  scrollToBottom();
  return turn.assistant;
}

// Rebuild the bubble's HTML as word spans + whitespace text nodes from the
// full accumulated text. This is called on every delta so spans always reflect
// the current text — necessary because playback_start can fire BEFORE all
// content_block_deltas have arrived (e.g. when Claude does a tool call mid-
// response). We preserve which span was highlighted so the rebuild doesn't
// drop the user-visible "speaking" state mid-word.
function appendAssistantDelta(text) {
  if (!text) return;
  const b = ensureAssistantBubble();
  turn.assistantText += text;
  rebuildAssistantSpans(b, turn.assistantText);
  scrollToBottom();
}

function rebuildAssistantSpans(bubble, fullText) {
  // Preserve which word index was highlighted before the rebuild.
  let speakingIdx = -1;
  const oldSpans = bubble.querySelectorAll('.word');
  for (let i = 0; i < oldSpans.length; i++) {
    if (oldSpans[i].classList.contains('speaking')) { speakingIdx = i; break; }
  }
  bubble.innerHTML = '';
  for (const part of fullText.split(/(\s+)/)) {
    if (!part.length) continue;
    if (/^\s+$/.test(part)) bubble.appendChild(document.createTextNode(part));
    else {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = part;
      bubble.appendChild(span);
    }
  }
  if (speakingIdx >= 0) {
    const newSpans = bubble.querySelectorAll('.word');
    const target = newSpans[speakingIdx];
    if (target) target.classList.add('speaking');
  }
}

function finalizeAssistant() {
  if (!turn.assistant) return;
  turn.assistant.classList.remove('streaming');
  splitIntoWordSpans(turn.assistant);
  turn.assistant = null;
  turn.assistantText = '';
}

function splitIntoWordSpans(bubble) {
  const text = bubble.textContent || '';
  if (!text) return;
  bubble.innerHTML = '';
  for (const part of text.split(/(\s+)/)) {
    if (!part.length) continue;
    if (/^\s+$/.test(part)) bubble.appendChild(document.createTextNode(part));
    else {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = part;
      bubble.appendChild(span);
    }
  }
}

function findAssistantBubbleForPlayback() {
  if (turn.assistant) { splitIntoWordSpans(turn.assistant); return turn.assistant; }
  for (let i = els.log.children.length - 1; i >= 0; i--) {
    const el = els.log.children[i];
    if (el.classList?.contains('assistant') && el.querySelector('.word')) return el;
  }
  return null;
}

// Schedule a word highlight to fire at the server's playback time. tts_word
// events arrive in bursts well before the audio actually plays — pts_ms tells
// us when each word is spoken relative to the start of TTS playback. We use
// performance.now() captured at playback_start as the local audio-clock zero,
// then setTimeout each highlight to fire at (zero + pts_ms).
function scheduleWordHighlight(text, ptsMs) {
  // User pressed Enter to cancel — drop any tts_word events that arrive
  // before the next playback_start.
  if (turn.playbackCancelled) return;
  if (!turn.speakingBubble) {
    if (turn.assistant) finalizeAssistant();
    turn.speakingBubble = findAssistantBubbleForPlayback();
    turn.speakingWordIdx = 0;
    turn.highlightSpanIdx = -1;
  }
  if (!turn.speakingBubble) return;
  const pts = Math.max(0, ptsMs ?? 0);
  if (turn.ttsTimeOffset == null) {
    turn.ttsTimeOffset = performance.now() - pts;
  }
  const seq = turn.speakingWordIdx++;
  turn.ttsQueue.push({ seq, text, ptsMs: pts });
  if (!turn.ttsPaused) scheduleQueuedHighlight(seq, text, pts);
}

function scheduleQueuedHighlight(seq, text, pts) {
  const bubble = turn.speakingBubble;
  if (!bubble) return;
  const targetTime = turn.ttsTimeOffset + pts;
  const delay = Math.max(0, targetTime - performance.now());
  const id = setTimeout(() => {
    const qi = turn.ttsQueue.findIndex((w) => w.seq === seq);
    if (qi >= 0) turn.ttsQueue.splice(qi, 1);
    if (!bubble.isConnected) return;
    advanceHighlight(bubble, text);
  }, delay);
  turn.pendingWordTimers.push(id);
}

// Move the .speaking class forward to the span that matches `ttsText`. Search
// from the current highlight position + 1 within a small look-ahead window;
// if no match, just step forward by one. This tolerates the common case
// where TTS pronounces a hyphenated/compound word as two spoken words but
// the bubble has it as one span ("twenty-six" → "twenty", "six").
const FUZZY_LOOKAHEAD = 5;
function advanceHighlight(bubble, ttsText) {
  const spans = bubble.querySelectorAll('.word');
  if (!spans.length) return;
  const startFrom = (turn.highlightSpanIdx ?? -1) + 1;
  if (startFrom >= spans.length) return;       // ran out of spans
  let target = -1;
  const end = Math.min(spans.length, startFrom + FUZZY_LOOKAHEAD);
  for (let i = startFrom; i < end; i++) {
    if (wordsLooseEqual(spans[i].textContent, ttsText)) { target = i; break; }
  }
  if (target < 0) target = startFrom;          // best-effort: advance by 1
  spans.forEach((s) => s.classList.remove('speaking'));
  spans[target].classList.add('speaking');
  spans[target].scrollIntoView({ block: 'nearest' });
  turn.highlightSpanIdx = target;
}

function wordsLooseEqual(spanText, ttsText) {
  const a = String(spanText || '').replace(/[^a-z0-9']/gi, '').toLowerCase();
  const b = String(ttsText || '').replace(/[^a-z0-9']/gi, '').toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  // "twenty-six" span vs "twenty" tts → a starts with b
  return a.startsWith(b) || b.startsWith(a);
}

function pauseHighlighting() {
  if (turn.ttsPaused) return;
  turn.ttsPaused = true;
  turn.ttsPausedAt = performance.now();
  cancelPendingHighlights();        // timers are wall-clock; cancel them
}

function resumeHighlighting() {
  if (!turn.ttsPaused) return;
  const pauseDuration = performance.now() - turn.ttsPausedAt;
  turn.ttsPaused = false;
  if (turn.ttsTimeOffset != null) turn.ttsTimeOffset += pauseDuration;
  // Re-schedule everything still in the queue.
  for (const w of turn.ttsQueue) scheduleQueuedHighlight(w.seq, w.text, w.ptsMs);
}

function cancelHighlighting() {
  cancelPendingHighlights();
  turn.ttsQueue.length = 0;
  turn.ttsPaused = false;
  turn.playbackCancelled = true;
  if (turn.speakingBubble) {
    turn.speakingBubble.querySelectorAll('.word.speaking').forEach((s) => s.classList.remove('speaking'));
  }
}

function endPlaybackHighlight() {
  cancelPendingHighlights();
  turn.ttsQueue.length = 0;
  turn.ttsPaused = false;
  if (turn.speakingBubble) {
    turn.speakingBubble.querySelectorAll('.word.speaking').forEach((s) => s.classList.remove('speaking'));
  }
  turn.speakingBubble = null;
  turn.speakingWordIdx = 0;
  turn.highlightSpanIdx = -1;
  turn.ttsTimeOffset = null;
  state.speaking = false;
  updateStatus();
}

function handleSseInner(inner) {
  const t = inner?.type;
  if (!t) return;
  const data = inner.data || {};
  if (t === 'conversation_ready') lifecyclePulse('— conversation ready —');
  else if (t === 'message_start') {
    finalizeInterim();
    ensureAssistantBubble();
  }
  else if (t === 'content_block_delta') appendAssistantDelta(data?.delta?.text || '');
}

function handleUpstreamEvent(msg) {
  // Persisted history record — no top-level type.
  if (!msg.type && msg.data?.sender && Array.isArray(msg.data.content)) {
    const text = msg.data.content.map((c) => c.text || '').join('').trim();
    if (msg.data.sender === 'human') finalizeInterim(text);
    else if (msg.data.sender === 'assistant') {
      if (turn.assistant) { turn.assistant.textContent = text; finalizeAssistant(); }
      else if (text) addRow('assistant', text);
    }
    return;
  }
  const t = msg.type;
  if (!t) return;

  if (t === 'message_sse' && msg.event) { handleSseInner(msg.event); return; }

  // transcript_interim carries the FULL cumulative transcript for the current
  // user utterance. utterance_seq resets are internal Deepgram batch
  // boundaries, NOT new user turns — always update the same bubble. It
  // finalizes when (a) the human history-record arrives with canonical text,
  // or (b) message_start fires (assistant begins replying).
  if (t === 'transcript_interim' && typeof msg.text === 'string') {
    const b = ensureInterimBubble();
    b.textContent = msg.text;
    scrollToBottom();
    return;
  }
  if (t === 'transcript_empty') {
    if (turn.interim) { turn.interim.remove(); turn.interim = null; }
    return;
  }
  if (t === 'transcription_start') return;     // Deepgram batch boundary; silent
  if (t === 'user_input_end') return;          // VAD batch boundary, fires repeatedly; silent
  if (t === 'playback_start') {
    cancelPendingHighlights();
    // Don't finalize — content_block_deltas may still arrive after this
    // (Claude does tool calls mid-response and the rest of the text streams
    // AFTER playback_start). The bubble keeps growing; appendAssistantDelta
    // rebuilds spans incrementally, so highlights can always find the right
    // span as the text grows.
    let activeBubble = turn.assistant;
    if (!activeBubble) activeBubble = findAssistantBubbleForPlayback();
    // Make sure the bubble has at least its current text as spans, so the
    // first few tts_words have something to land on.
    if (activeBubble && !activeBubble.querySelector('.word') && activeBubble.textContent) {
      rebuildAssistantSpans(activeBubble, activeBubble.textContent);
    }
    turn.speakingBubble = activeBubble;
    turn.speakingWordIdx = 0;
    turn.highlightSpanIdx = -1;
    turn.ttsTimeOffset = null;
    turn.playbackCancelled = false;     // new playback, allow highlights again
    state.speaking = !!activeBubble;
    updateStatus();
    return;
  }
  if (t === 'playback_end') { endPlaybackHighlight(); return; }
  if (t === 'tts_word') {
    if (typeof msg.text === 'string') scheduleWordHighlight(msg.text, msg.pts_ms);
    return;
  }
  if (t === 'tts_segment_end') return;
  if (t === 'server_interrupt') { endPlaybackHighlight(); return; }
  if (t === 'message_complete') { finalizeAssistant(); return; }
  if (t === 'session_server_initialized') return;
  if (t === 'error') { addRow('error', JSON.stringify(msg)); return; }
}

// --- API helpers (the renderer talks directly to lm-voice's local HTTP API) -

async function api(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  const init = {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const r = await fetch(url, init);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: r.ok, status: r.status, raw: text }; }
}

function clearLog() {
  els.log.innerHTML = '';
  placeholderEl = null;
  cancelPendingHighlights();
  turn.ttsQueue.length = 0;
  turn.ttsPaused = false;
  turn.interim = null;
  turn.assistant = null;
  turn.assistantText = '';
  turn.speakingBubble = null;
  turn.speakingWordIdx = 0;
  turn.highlightSpanIdx = -1;
  turn.ttsTimeOffset = null;
}

function cancelPendingHighlights() {
  for (const id of turn.pendingWordTimers) clearTimeout(id);
  turn.pendingWordTimers.length = 0;
}

async function startNewSession() {
  els.btnNew.disabled = true;
  els.btnSwitch.disabled = true;
  clearLog();
  setStatus('thinking', 'Starting new session…', '');
  try {
    const r = await api('/api/claude-ai/session/start', {
      method: 'POST',
      body: { voice: 'airy', autoStartMic: true },
    });
    if (!r?.ok) {
      addRow('error', `Could not start: ${r?.error || JSON.stringify(r)}`);
    } else {
      lifecyclePulse(`new conversation · ${r.convId?.slice(0, 8) || ''}`);
    }
  } catch (e) {
    addRow('error', `Could not start: ${e.message}`);
  } finally {
    updateStatus();
  }
}

async function stopSession() {
  els.btnStop.disabled = true;
  try {
    await api('/api/claude-ai/upstream/close', { method: 'POST' });
  } catch (e) {
    addRow('error', `Could not stop: ${e.message}`);
  } finally {
    updateStatus();
  }
}

async function openPicker() {
  els.picker.classList.remove('hidden');
  els.pickerBody.innerHTML = '<div class="picker-loading">loading…</div>';
  try {
    const r = await api('/api/claude-ai/browser/conversations?limit=15');
    let list = r?.conversations;
    if (Array.isArray(list?.data)) list = list.data;
    if (!Array.isArray(list) || list.length === 0) {
      els.pickerBody.innerHTML = '<div class="picker-item empty">No conversations found</div>';
      return;
    }
    els.pickerBody.innerHTML = '';
    for (const c of list) {
      const div = document.createElement('div');
      div.className = 'picker-item';
      const updated = c.updated_at ? new Date(c.updated_at).toLocaleString() : '';
      const platform = c.platform === 'VOICE' ? ' · voice' : '';
      div.innerHTML = `<div>${escapeHtml(c.name || '(untitled)')}</div><div class="meta">${updated}${platform} · ${c.uuid?.slice(0, 8) || ''}</div>`;
      div.addEventListener('click', () => pickConversation(c.uuid));
      els.pickerBody.appendChild(div);
    }
  } catch (e) {
    els.pickerBody.innerHTML = `<div class="picker-item empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function pickConversation(convId) {
  if (!convId) return;
  els.picker.classList.add('hidden');
  els.btnNew.disabled = true;
  els.btnSwitch.disabled = true;
  clearLog();
  setStatus('thinking', 'Switching conversation…', convId.slice(0, 8));
  try {
    const r = await api('/api/claude-ai/upstream/open', {
      method: 'POST',
      body: { convId, voice: 'airy', autoStartMic: true },
    });
    if (!r?.ok) addRow('error', `Could not switch: ${r?.error || JSON.stringify(r)}`);
    else lifecyclePulse(`switched · ${convId.slice(0, 8)}`);
  } catch (e) {
    addRow('error', `Could not switch: ${e.message}`);
  } finally {
    updateStatus();
  }
}

// --- UI wiring ---------------------------------------------------------------

els.btnNew.addEventListener('click', () => startNewSession());
els.btnSwitch.addEventListener('click', () => openPicker());
els.btnStop.addEventListener('click', () => stopSession());

async function injectComposerText() {
  const text = els.composerInput.value.trim();
  if (!text) return;
  els.composerInput.disabled = true;
  els.composerSend.disabled = true;
  // Optimistically show the user's text in the log so they get immediate
  // feedback. The voice-WS history record (if relayed) will arrive later.
  addRow('user', text);
  els.composerInput.value = '';
  try {
    const r = await api('/api/claude-ai/voice/inject-text', {
      method: 'POST',
      body: { text },
    });
    if (!r?.ok) addRow('error', `Inject failed: ${r?.error || r?.body || JSON.stringify(r)}`);
    else if (r?.text) addRow('assistant', r.text);
  } catch (e) {
    addRow('error', `Inject failed: ${e.message}`);
  } finally {
    updateStatus();
    els.composerInput.focus();
  }
}

els.composerSend.addEventListener('click', injectComposerText);
els.composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    injectComposerText();
  }
});

function sendBridge(obj) {
  if (state.bridge && state.bridge.readyState === 1) {
    state.bridge.send(JSON.stringify(obj));
  }
}

function togglePausePlayback() {
  if (!state.speaking && !turn.ttsPaused) return;   // nothing to pause
  if (turn.ttsPaused) {
    resumeHighlighting();
    sendBridge({ _bridge: 'playback_resume' });
    setStatus('speaking', 'Claude is speaking', '');
  } else {
    pauseHighlighting();
    sendBridge({ _bridge: 'playback_pause' });
    setStatus('thinking', 'Paused', 'press space to resume');
  }
}

function cancelPlaybackHere() {
  cancelHighlighting();
  sendBridge({ _bridge: 'playback_cancel' });
  state.speaking = false;
  setStatus('idle', 'Playback cancelled', 'press space or talk to continue');
}

document.addEventListener('keydown', (e) => {
  // Don't hijack typing inside form controls.
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  if (e.code === 'Space') {
    // While Claude is speaking (or paused) → toggle pause/resume.
    // Otherwise, if a new session can be started (no upstream open and page
    // attached) → start one. Falls through quietly when neither applies.
    if (state.speaking || turn.ttsPaused) {
      e.preventDefault();
      togglePausePlayback();
    } else if (state.pageAttached && !state.upstreamOpen) {
      e.preventDefault();
      startNewSession();
    }
  } else if (e.code === 'Enter' || e.key === 'Enter') {
    // Enter cancels the current playback (lets the user keep talking).
    if (state.speaking || turn.ttsPaused) {
      e.preventDefault();
      cancelPlaybackHere();
    }
  } else if (e.code === 'Escape' || e.key === 'Escape') {
    // Esc stops the upstream entirely (ends the voice session).
    if (state.upstreamOpen) {
      e.preventDefault();
      stopSession();
    }
  }
});
els.pickerClose.addEventListener('click', () => els.picker.classList.add('hidden'));
document.addEventListener('click', (e) => {
  if (els.picker.classList.contains('hidden')) return;
  if (e.target === els.btnSwitch || els.picker.contains(e.target)) return;
  els.picker.classList.add('hidden');
});

els.toggleDebug.addEventListener('click', () => {
  els.debugPanel.classList.toggle('hidden');
  els.toggleDebug.textContent = els.debugPanel.classList.contains('hidden') ? 'debug' : 'hide debug';
});
els.clearEvents.addEventListener('click', () => { els.events.textContent = ''; });

ipcRenderer.on('claude-ai:hydrate', () => { /* placeholder hook for future preferences */ });

ensurePlaceholder();
setStatus('idle', 'Connecting…', '');
openBridge();
