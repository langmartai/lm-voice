'use strict';

const { ipcRenderer } = require('electron');

const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const sessionNameEl = document.getElementById('session-name');
const transcriptEl = document.getElementById('transcript');
const replyEl = document.getElementById('reply');

let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;

function setStatus(s, klass) {
  statusEl.textContent = s;
  if (klass) {
    dotEl.classList.remove('idle', 'listening', 'thinking', 'speaking', 'error');
    dotEl.classList.add(klass);
  }
}

ipcRenderer.on('session-update', (_, info) => {
  sessionNameEl.textContent = info?.label || info?.id || 'none';
});

ipcRenderer.on('status', (_, payload) => {
  setStatus(payload.text, payload.class);
});

ipcRenderer.on('transcript', (_, payload) => {
  if (payload.isFinal) transcriptEl.textContent = payload.text;
  else transcriptEl.textContent = payload.text + ' …';
});

ipcRenderer.on('reply', (_, text) => {
  replyEl.textContent = text;
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

ipcRenderer.on('play-wav', async (_, wavBufferAsArrayBuffer) => {
  try {
    setStatus('Speaking', 'speaking');
    await playWav(wavBufferAsArrayBuffer);
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
  // Route mic → worklet → muted gain → destination (worklet runs regardless of
  // downstream connection, but Chromium requires a chain to destination to keep
  // the graph alive).
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

async function playWav(arrayBuffer) {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
    });
  } finally {
    try { await ctx.close(); } catch {}
  }
}

setStatus('Idle', 'idle');
