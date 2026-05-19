'use strict';

const { ipcRenderer } = require('electron');

const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const sessionNameEl = document.getElementById('session-name');
const convEl = document.getElementById('conv');

const MAX_BUBBLES = 40;
let interimBubble = null;

let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;

function setStatus(s, klass) {
  statusEl.textContent = s;
  if (klass) {
    dotEl.classList.remove('idle', 'listening', 'thinking', 'speaking', 'error', 'notify');
    dotEl.classList.add(klass);
  }
}

// Electron clipboard module — more reliable than navigator.clipboard inside
// the Electron renderer.
const { clipboard } = require('electron');

function append(role, text, extraClass) {
  const div = document.createElement('div');
  div.className = `bubble ${role}` + (extraClass ? ` ${extraClass}` : '');
  div.textContent = text;
  div.title = 'Click to copy';
  // Click-to-copy with a brief visual flash so the user gets feedback.
  div.addEventListener('click', () => {
    try {
      clipboard.writeText(div.textContent || '');
      div.classList.add('copied');
      setTimeout(() => div.classList.remove('copied'), 700);
    } catch (e) {
      // fall back to the web API if Electron clipboard is unavailable
      try { navigator.clipboard.writeText(div.textContent || ''); } catch {}
    }
  });
  convEl.appendChild(div);
  while (convEl.children.length > MAX_BUBBLES) convEl.removeChild(convEl.firstChild);
  requestAnimationFrame(() => { convEl.scrollTop = convEl.scrollHeight; });
  return div;
}

ipcRenderer.on('session-update', (_, info) => {
  sessionNameEl.textContent = info?.label || info?.id || 'none';
});

ipcRenderer.on('status', (_, payload) => {
  setStatus(payload.text, payload.class);
});

ipcRenderer.on('transcript', (_, payload) => {
  const text = payload?.text ?? '';
  if (!payload?.isFinal) {
    // Interim — keep updating a single in-progress bubble.
    if (!interimBubble) interimBubble = append('user', '', 'interim');
    interimBubble.textContent = text ? `${text} …` : '…';
    requestAnimationFrame(() => { convEl.scrollTop = convEl.scrollHeight; });
    return;
  }
  // Final — commit the interim bubble (or create one if STT never sent interim).
  if (interimBubble) {
    if (text) {
      interimBubble.textContent = text;
      interimBubble.classList.remove('interim');
    } else {
      // Final with empty text — STT heard nothing, drop the placeholder.
      interimBubble.remove();
    }
    interimBubble = null;
  } else if (text) {
    append('user', text);
  }
});

ipcRenderer.on('reply', (_, text) => {
  if (!text) return;
  append('assistant', text);
});

ipcRenderer.on('notify', (_, payload) => {
  const msg = payload?.msg || '';
  if (!msg) return;
  append('system', msg, 'small');
});

ipcRenderer.on('start-recording', async () => {
  try {
    await startMic();
    setStatus('Listening', 'listening');
  } catch (err) {
    setStatus(`Mic error: ${err.message}`, 'error');
    ipcRenderer.send('mic-error', err.message);
  }
});

ipcRenderer.on('stop-recording', async () => {
  await stopMic();
});

ipcRenderer.on('play-wav', async (_, payload) => {
  try {
    setStatus('Speaking', 'speaking');
    // payload can be a plain ArrayBuffer (legacy) or
    // { buffer, duration, text } for synced word highlighting.
    if (payload && typeof payload === 'object' && !ArrayBuffer.isView(payload) && payload.buffer) {
      await playWav(payload.buffer, payload.duration, payload.text);
    } else {
      await playWav(payload);
    }
    setStatus('Idle', 'idle');
  } catch (err) {
    setStatus(`Playback error: ${err.message}`, 'error');
  }
});

async function startMic() {
  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('mic-worklet.js');
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'mic-downsampler');
  workletNode.port.onmessage = (ev) => {
    const buf = ev.data;
    if (!(buf instanceof ArrayBuffer)) return;
    ipcRenderer.send('mic-chunk', buf);
  };
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silent);
  silent.connect(audioCtx.destination);
}

async function stopMic() {
  try {
    if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (audioCtx) { await audioCtx.close(); audioCtx = null; }
  } catch {}
}

let currentAudioSrc = null;
let currentAudioCtx = null;

ipcRenderer.on('stop-wav', async () => {
  try { currentAudioSrc?.stop(); } catch {}
  try { await currentAudioCtx?.close(); } catch {}
  currentAudioSrc = null;
  currentAudioCtx = null;
});

// Pause/resume of the live AudioContext. Suspending freezes audio output AND
// `ctx.currentTime`, but our karaoke runs off `performance.now()`, so we also
// track wall-clock pause windows and feed them to the tick() via _ttsPauseState.
let _ttsPauseState = { paused: false, pausedAt: 0, totalPausedMs: 0 };
ipcRenderer.on('tts-pause', async () => {
  if (!currentAudioCtx || _ttsPauseState.paused) return;
  try { await currentAudioCtx.suspend(); } catch {}
  _ttsPauseState.paused = true;
  _ttsPauseState.pausedAt = performance.now();
});
ipcRenderer.on('tts-resume', async () => {
  if (!currentAudioCtx || !_ttsPauseState.paused) return;
  try { await currentAudioCtx.resume(); } catch {}
  _ttsPauseState.totalPausedMs += performance.now() - _ttsPauseState.pausedAt;
  _ttsPauseState.pausedAt = 0;
  _ttsPauseState.paused = false;
});

// Wrap each whitespace-delimited word in `bubble` in a span with predicted
// start/end times. Pacing is weighted by character count + a small pause
// after sentence/clause-ending punctuation, which matches typical English
// TTS speech rhythm much better than uniform per-word slots.
function wrapWordsForHighlight(bubble, totalDuration) {
  const original = bubble.textContent;
  bubble.innerHTML = '';
  const parts = original.split(/(\s+)/);
  const wordParts = parts.filter((p) => p.trim().length > 0);

  // Weight: alphanumeric chars per word + a punctuation-pause bonus.
  // (Punctuation chars don't add to the body weight but do force a pause.)
  const weights = wordParts.map((w) => {
    const body = (w.match(/[a-zA-Z0-9]/g) || []).length;
    let weight = Math.max(1, body);
    if (/[.!?]['")\]]?$/.test(w)) weight += 6;   // end-of-sentence pause
    else if (/[,;:]['")\]]?$/.test(w)) weight += 3; // comma/colon pause
    return weight;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const secPerWeight = totalDuration / totalWeight;

  let cursor = 0;
  let i = 0;
  for (const part of parts) {
    if (part.trim().length === 0) {
      bubble.appendChild(document.createTextNode(part));
    } else {
      const start = cursor;
      const dur = weights[i] * secPerWeight;
      const end = start + dur;
      cursor = end;
      const span = document.createElement('span');
      span.className = 'tts-word';
      span.textContent = part;
      span.dataset.s = start.toFixed(3);
      span.dataset.e = end.toFixed(3);
      bubble.appendChild(span);
      i++;
    }
  }
  return bubble.querySelectorAll('.tts-word');
}

function findAssistantBubbleByText(text) {
  if (!text) return null;
  const target = text.replace(/\s+/g, ' ').trim();
  const bubbles = convEl.querySelectorAll('.bubble.assistant');
  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].textContent.replace(/\s+/g, ' ').trim() === target) return bubbles[i];
  }
  // Fall back to the most recent assistant bubble — covers cases where the
  // bubble was created with a slightly longer (un-truncated) text but the
  // TTS got a truncated version. Highlight covers as much as we can match.
  return bubbles.length ? bubbles[bubbles.length - 1] : null;
}

async function playWav(arrayBuffer, durationSec, text) {
  // Stop any prior playback first so a new utterance always supersedes.
  try { currentAudioSrc?.stop(); } catch {}
  try { await currentAudioCtx?.close(); } catch {}

  // If we have a duration + the spoken text, set up word-level highlighting
  // on the matching bubble. Uniform pacing is a rough estimate but feels
  // very close-to-natural on 2-3-sentence replies.
  let spans = null;
  let bubble = null;
  if (durationSec && text) {
    bubble = findAssistantBubbleByText(text);
    if (bubble) spans = wrapWordsForHighlight(bubble, durationSec);
  }

  const ctx = new AudioContext();
  currentAudioCtx = ctx;
  // Reset pause-state for the new utterance.
  _ttsPauseState = { paused: false, pausedAt: 0, totalPausedMs: 0 };
  let animFrame = 0;
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const src = ctx.createBufferSource();
    currentAudioSrc = src;
    src.buffer = buf;
    src.connect(ctx.destination);
    const startedAt = performance.now();
    src.start();
    if (spans && spans.length) {
      const tick = () => {
        // Stop animating if playback was superseded or context died.
        if (currentAudioSrc !== src) return;
        // Pause-aware elapsed: subtract completed pause windows and the
        // currently-open one (if any). Both clocks are wall-clock based.
        const liveOffset = _ttsPauseState.paused
          ? performance.now() - _ttsPauseState.pausedAt
          : 0;
        const elapsed = (performance.now() - startedAt - _ttsPauseState.totalPausedMs - liveOffset) / 1000;
        let activeIdx = -1;
        for (let i = 0; i < spans.length; i++) {
          const s = parseFloat(spans[i].dataset.s);
          const e = parseFloat(spans[i].dataset.e);
          if (elapsed >= s && elapsed < e) { activeIdx = i; break; }
        }
        for (let i = 0; i < spans.length; i++) {
          spans[i].classList.toggle('tts-current', i === activeIdx);
          // Mark already-read words a touch dimmer so the eye tracks forward.
          spans[i].classList.toggle('tts-past', i < activeIdx);
        }
        if (elapsed > (durationSec + 0.5)) {
          for (const s of spans) s.classList.remove('tts-current');
          return;
        }
        animFrame = requestAnimationFrame(tick);
      };
      animFrame = requestAnimationFrame(tick);
    }
    await new Promise((resolve) => {
      src.onended = resolve;
    });
  } finally {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (spans) {
      for (const s of spans) {
        s.classList.remove('tts-current');
        s.classList.remove('tts-past');
      }
    }
    if (currentAudioCtx === ctx) {
      try { await ctx.close(); } catch {}
      currentAudioCtx = null;
      currentAudioSrc = null;
      _ttsPauseState = { paused: false, pausedAt: 0, totalPausedMs: 0 };
      // Tell main (→ hosts window) playback finished so karaoke state +
      // ESC-pause arming both clear together.
      try { ipcRenderer.send('tts-ended'); } catch {}
    }
  }
}

// --- header buttons --- //
const hideBtn = document.getElementById('hide-btn');
const pinBtn = document.getElementById('pin-btn');
const pickerBtn = document.getElementById('picker-btn');

if (pickerBtn) pickerBtn.addEventListener('click', () => ipcRenderer.send('popup-open-picker'));
if (hideBtn) hideBtn.addEventListener('click', () => ipcRenderer.send('popup-hide'));
if (pinBtn) {
  pinBtn.addEventListener('click', () => ipcRenderer.send('popup-toggle-pin'));
  // Sync initial pinned state from main.
  ipcRenderer.invoke('popup-get-pin-state').then((s) => {
    pinBtn.classList.toggle('active', !!s?.pinned);
  }).catch(() => {});
}
ipcRenderer.on('popup-pin-state', (_, payload) => {
  if (pinBtn) pinBtn.classList.toggle('active', !!payload?.pinned);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('popup-hide');
});

// --- world-state strip ---
// Poll /api/state on a slow tick so the user sees what the agent sees:
// active session, project, and how many hosts / sessions are out there.
const worldProject = document.getElementById('world-project');
const worldActive  = document.getElementById('world-active');
const worldHosts   = document.getElementById('world-hosts');

// Chip clicks: project & active-session open the session picker; the hosts
// chip opens the dedicated Hosts & Sessions window.
if (worldProject) {
  worldProject.classList.add('clickable');
  worldProject.addEventListener('click', () => ipcRenderer.send('popup-open-picker'));
}
if (worldActive) {
  worldActive.classList.add('clickable');
  worldActive.addEventListener('click', () => ipcRenderer.send('popup-open-picker'));
}
if (worldHosts) {
  worldHosts.classList.add('clickable');
  worldHosts.addEventListener('click', () => ipcRenderer.send('popup-open-hosts'));
}

let _lastWorldSnapshot = null;

function classifyHost(h) {
  // Returns one of: 'direct', 'via-ssh', 'proxy', 'ssh-only', 'failed'.
  if (h.sshOnly) return h.sshVerifiedAt ? 'ssh-only' : 'failed';
  if (h.viaSsh) return 'via-ssh';
  // Plain http://...:3100 is direct lm-assist; any other port is "proxy" (or other service).
  const m = String(h.url || '').match(/:(\d+)$/);
  const port = m ? m[1] : null;
  if (port && port !== '3100') return 'proxy';
  return 'direct';
}

function hostKey(h) {
  // Group same-machine entries. Prefer the discovered hostname; fall back to IP.
  const name = h.hostname || h.remoteHostname;
  if (name) return `name:${name}`;
  const ip = ipOfEntry(h);
  return ip ? `ip:${ip}` : `url:${h.url}`;
}

function ipOfEntry(h) {
  // Strip http:// or ssh:// and trailing :port, keep just the host.
  const u = String(h.url || '');
  const m = u.match(/^[a-z]+:\/\/([^/:]+)/i);
  return m ? m[1] : null;
}

function describeAccess(a) {
  if (!a) return null;
  const parts = ['ssh'];
  if (a.keyFile) parts.push(`-i ${a.keyFile}`);
  if (a.port) parts.push(`-p ${a.port}`);
  parts.push(`${a.user ? a.user + '@' : ''}${a.host}`);
  return parts.join(' ');
}

const CAT_RANK = { 'direct': 0, 'via-ssh': 1, 'proxy': 2, 'ssh-only': 3, 'failed': 4 };
const CAT_LABEL = {
  'direct':   'lm-assist',
  'via-ssh':  'via SSH',
  'proxy':    'proxy',
  'ssh-only': 'SSH only',
  'failed':   'unreachable',
};

// Host management lives in a dedicated window now. Helpers below (classifyHost,
// hostKey, etc.) stay because applyWorldState uses classifyHost to compute
// the "11 hosts · 4 ssh-only" chip summary.

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}

function fmtAgo(iso) {
  if (!iso) return '?';
  const t = Date.parse(iso) || 0;
  if (!t) return '?';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return 'now';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function applyWorldState(d) {
  try {
    _lastWorldSnapshot = d || null;
    if (hostsPanel && !hostsPanel.hidden) renderHostsPanel();
    const w = (d && d.world) || {};
    const a = w.activeSession;
    const proj = w.project || '—';
    if (worldProject) {
      worldProject.textContent = proj;
      worldProject.title = `Project (current host's active session cwd)\nHost: ${w?.host?.endpoint ?? '?'}`;
    }
    if (worldActive) {
      if (a) {
        worldActive.textContent = `${a.label} · ${a.numTurns}T · ${fmtAgo(a.lastModified)}`;
        worldActive.title = `Active session\nsid: ${a.sid}\ncwd: ${a.cwd}\nlast activity: ${a.lastModified}`;
        worldActive.classList.toggle('running', !!a.runningExec);
      } else {
        worldActive.textContent = '—';
        worldActive.classList.remove('running');
      }
    }
    if (worldHosts) {
      const others = (d && d.otherHosts) || {};
      const all = (d && d.allHosts) || [];
      // Bucket the discovered hosts so the chip can summarise direct vs ssh.
      let direct = 0, viaSsh = 0, sshOnly = 0, failed = 0;
      for (const h of all) {
        const cls = classifyHost(h, others);
        if (cls === 'direct' || cls === 'proxy') direct++;
        else if (cls === 'via-ssh') viaSsh++;
        else if (cls === 'ssh-only') sshOnly++;
        else if (cls === 'failed') failed++;
      }
      const total = all.length || (Object.keys(others).length + 1);
      let otherSessions = 0;
      let downCount = 0;
      for (const snap of Object.values(others)) {
        otherSessions += (snap.sessions || []).length;
        if (snap.error) downCount++;
      }
      const related = (w.relatedSessions || []).length;
      const parts = [`${total} host${total === 1 ? '' : 's'}`];
      if (sshOnly) parts.push(`${sshOnly} ssh-only`);
      worldHosts.textContent = `${parts.join(' · ')} · ${related + otherSessions} session${(related + otherSessions) === 1 ? '' : 's'}`;
      worldHosts.title = (() => {
        const lines = [`Hosts: ${total} (${direct} direct, ${viaSsh} via SSH, ${sshOnly} SSH-only, ${failed} failed)`];
        lines.push('Click to expand the full list with access details.');
        return lines.join('\n');
      })();
      worldHosts.classList.toggle('warn', downCount > 0 || failed > 0);
    }
  } catch {}
}

// Main process pushes a 'world-state' event every few seconds.
ipcRenderer.on('world-state', (_, payload) => applyWorldState(payload));

// --- text input ---
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');

function submitText() {
  if (!textInput || textInput.disabled) return;
  const v = (textInput.value || '').trim();
  if (!v) return;
  textInput.value = '';
  // Echo into the conversation immediately so the user sees their own input
  // even before main responds (the actual processing pushes 'transcript' too,
  // but adding it here makes typing feel instant).
  append('user', v);
  ipcRenderer.send('text-input', v);
}

if (textInput) {
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitText();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      textInput.blur();
    }
  });
}
if (sendBtn) sendBtn.addEventListener('click', submitText);

// Main process can ask us to disable the input (e.g. while a turn is processing)
ipcRenderer.on('input-busy', (_, busy) => {
  if (textInput) textInput.disabled = !!busy;
  if (sendBtn) sendBtn.disabled = !!busy;
});

setStatus('Idle', 'idle');
