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
};

const API_BASE = 'http://127.0.0.1:3199';

const BRIDGE_URL = 'ws://127.0.0.1:8765/?role=renderer';

const state = {
  bridge: null,
  pageAttached: false,
  upstreamOpen: false,
  micRunning: false,
  speaking: false,
  pcmCtx: null,
  pcmNextStart: 0,
};

const turn = {
  interim: null,
  assistant: null,
  assistantText: '',
  speakingBubble: null,
  speakingWordIdx: 0,
  // Offset that maps server pts_ms to local performance.now(). Locked in on
  // the FIRST tts_word of each turn (the server's pts_ms isn't 0-based at
  // playback_start — it's relative to a session-wide reference around 5-6s).
  ttsTimeOffset: null,
  pendingWordTimers: [],       // active setTimeout IDs for scheduled highlights
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
  // Binary frame = server PCM. The embedded browser plays it natively; we
  // queue here too so this UI surface stays usable on its own.
  playPcm(data);
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

function appendAssistantDelta(text) {
  if (!text) return;
  const b = ensureAssistantBubble();
  turn.assistantText += text;
  b.textContent = turn.assistantText;
  scrollToBottom();
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
  if (!turn.speakingBubble) {
    // Defensive: if there's still a streaming assistant bubble (e.g. tts_word
    // arrived before playback_start finalized it), finalize it now so it has
    // word spans we can target. Otherwise findAssistantBubbleForPlayback
    // would skip it and lock onto the PREVIOUS turn's bubble.
    if (turn.assistant) finalizeAssistant();
    turn.speakingBubble = findAssistantBubbleForPlayback();
    turn.speakingWordIdx = 0;
  }
  if (!turn.speakingBubble) return;
  const pts = Math.max(0, ptsMs ?? 0);
  // Anchor on the FIRST tts_word event of each playback turn. The server's
  // pts_ms isn't 0-based — it's session/upstream-relative (~5000 ms for the
  // first word), so we can't compute target time from playback_start alone.
  // Instead, when the first word arrives, capture `local_now - pts` as the
  // offset; every subsequent word in the same turn schedules at offset+pts.
  if (turn.ttsTimeOffset == null) {
    turn.ttsTimeOffset = performance.now() - pts;
  }
  // Capture both the index AND the bubble in the closure so a stale timer
  // from a prior turn never lights up a span in the current one.
  const idx = turn.speakingWordIdx++;
  const bubble = turn.speakingBubble;
  const targetTime = turn.ttsTimeOffset + pts;
  const delay = Math.max(0, targetTime - performance.now());
  const id = setTimeout(() => {
    if (!bubble.isConnected) return;
    const spans = bubble.querySelectorAll('.word');
    spans.forEach((s) => s.classList.remove('speaking'));
    const span = spans[idx];
    if (span) {
      span.classList.add('speaking');
      span.scrollIntoView({ block: 'nearest' });
    }
  }, delay);
  turn.pendingWordTimers.push(id);
}

function endPlaybackHighlight() {
  cancelPendingHighlights();
  if (turn.speakingBubble) {
    turn.speakingBubble.querySelectorAll('.word.speaking').forEach((s) => s.classList.remove('speaking'));
  }
  turn.speakingBubble = null;
  turn.speakingWordIdx = 0;
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
    finalizeInterim();           // lock the user transcript before assistant starts
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
    // A new TTS playback is starting. Cancel any pending highlight timers
    // from the previous playback so they can't fire against the new bubble,
    // then capture THIS playback's bubble directly (don't search the log —
    // that picks the wrong bubble when multiple finalized bubbles exist).
    cancelPendingHighlights();
    let activeBubble = null;
    if (turn.assistant) {
      activeBubble = turn.assistant;
      finalizeAssistant();           // splits bubble into word spans
    } else {
      // No live bubble (message_complete already finalized it, or playback_start
      // fired without a prior message_start). Fall back to most recent finalized
      // assistant bubble.
      activeBubble = findAssistantBubbleForPlayback();
    }
    turn.speakingBubble = activeBubble;
    turn.speakingWordIdx = 0;
    turn.ttsTimeOffset = null;        // re-anchor on first tts_word of this playback
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

// --- PCM playback (best effort — embedded browser already plays it) ----------

function playPcm(arrayBuffer) {
  if (!state.pcmCtx) {
    state.pcmCtx = new AudioContext({ sampleRate: 16000 });
    state.pcmNextStart = state.pcmCtx.currentTime;
  }
  const view = new DataView(arrayBuffer);
  const samples = arrayBuffer.byteLength >>> 1;
  if (!samples) return;
  const buf = state.pcmCtx.createBuffer(1, samples, 16000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
  const src = state.pcmCtx.createBufferSource();
  src.buffer = buf;
  src.connect(state.pcmCtx.destination);
  const start = Math.max(state.pcmNextStart, state.pcmCtx.currentTime);
  src.start(start);
  state.pcmNextStart = start + buf.duration;
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
  turn.interim = null;
  turn.assistant = null;
  turn.assistantText = '';
  turn.speakingBubble = null;
  turn.speakingWordIdx = 0;
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
