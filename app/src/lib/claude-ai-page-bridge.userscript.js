// ==UserScript==
// @name         LM Voice — claude.ai bridge
// @namespace    https://github.com/langmartai/lm-voice
// @match        https://claude.ai/*
// @run-at       document_idle
// @grant        none
// @version      0.1
// ==/UserScript==
//
// In-page relay for the claude.ai voice WebSocket.
//
// Paste this into the devtools console of any open https://claude.ai/* tab,
// OR install it as a Tampermonkey userscript with the metadata block above.
//
// Once installed, the page exposes:
//   window.__lmVoiceBridge.attach({ convId, orgId?, language?, voice?, timezone? })
//     → opens both upstream (wss://claude.ai/api/ws/voice/...) and local
//       (ws://127.0.0.1:8765/?role=page) sockets and pipes frames between them.
//   window.__lmVoiceBridge.detach()
//     → closes both.
//   window.__lmVoiceBridge.status()
//     → { upstream, local, convId, orgId }
//
// If the local helper is up before this is loaded, attach() will autodetect
// orgId from the lastActiveOrg cookie when omitted.

(() => {
  if (window.__lmVoiceBridge) return;

  const LOCAL_URL = 'ws://127.0.0.1:8765/?role=page';

  const state = {
    upstream: null,
    local: null,
    convId: null,
    orgId: null,
    reconnectLocalTimer: null,
    mic: { stream: null, encoder: null, reader: null, framesSent: 0, bytesSent: 0, running: false },
  };

  const readOrgFromCookie = () => {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const buildUpstreamUrl = (orgId, convId, opts) => {
    const tz = opts.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const params = new URLSearchParams({
      input_encoding: 'opus',
      input_sample_rate: '16000',
      input_channels: '1',
      output_format: 'pcm_16000',
      language: opts.language || 'en-US',
      timezone: tz,
      voice: opts.voice || 'airy',
      server_interrupt_enabled: 'true',
      client_platform: 'web_claude_ai',
    });
    return `wss://claude.ai/api/ws/voice/organizations/${orgId}/chat_conversations/${convId}?${params}`;
  };

  const sendLocal = (data) => {
    if (state.local && state.local.readyState === 1) {
      try { state.local.send(data); } catch (e) { /* swallow */ }
    }
  };

  const sendUpstream = (data) => {
    if (state.upstream && state.upstream.readyState === 1) {
      try { state.upstream.send(data); } catch (e) { /* swallow */ }
    }
  };

  const TARGET_RATE = 16000;

  const resampleFloat32 = (input, fromRate) => {
    if (fromRate === TARGET_RATE) return input;
    const ratio = fromRate / TARGET_RATE;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = i * ratio;
      const i0 = Math.floor(s);
      const i1 = i0 + 1 < input.length ? i0 + 1 : i0;
      const f = s - i0;
      out[i] = input[i0] * (1 - f) + input[i1] * f;
    }
    return out;
  };

  const startMic = async () => {
    if (state.mic.running) return { ok: true, alreadyRunning: true };
    if (!state.upstream || state.upstream.readyState !== 1) {
      return { ok: false, error: 'upstream not open' };
    }
    if (!window.MediaStreamTrackProcessor || !window.AudioEncoder || !window.AudioData) {
      return { ok: false, error: 'WebCodecs (MediaStreamTrackProcessor / AudioEncoder / AudioData) not available' };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      state.mic.stream = stream;
      const track = stream.getAudioTracks()[0];
      const processor = new MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();
      state.mic.reader = reader;

      const encoder = new AudioEncoder({
        output: (chunk) => {
          if (!state.upstream || state.upstream.readyState !== 1) return;
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);
          try {
            state.upstream.send(buf);
            state.mic.framesSent++;
            state.mic.bytesSent += buf.byteLength;
          } catch (e) { /* swallow */ }
        },
        error: (e) => {
          console.warn('[lm-voice-bridge] AudioEncoder error', e);
          sendLocal(JSON.stringify({ _bridge: 'mic_error', message: String(e.message || e) }));
        },
      });
      encoder.configure({ codec: 'opus', sampleRate: TARGET_RATE, numberOfChannels: 1, bitrate: 24000 });
      state.mic.encoder = encoder;
      state.mic.running = true;
      let nextTimestamp = 0;  // microseconds, monotonically increasing
      sendLocal(JSON.stringify({ _bridge: 'mic_started' }));

      (async () => {
        while (state.mic.running) {
          let result;
          try { result = await reader.read(); } catch { break; }
          if (result.done) break;
          const ad = result.value;
          const srcRate = ad.sampleRate;
          const srcFrames = ad.numberOfFrames;
          const planeBuf = new Float32Array(srcFrames);
          try {
            ad.copyTo(planeBuf, { planeIndex: 0, format: 'f32-planar' });
          } catch (e) {
            ad.close();
            continue;
          }
          ad.close();
          const resampled = resampleFloat32(planeBuf, srcRate);
          if (resampled.length === 0) continue;
          const out = new AudioData({
            format: 'f32-planar',
            sampleRate: TARGET_RATE,
            numberOfFrames: resampled.length,
            numberOfChannels: 1,
            timestamp: nextTimestamp,
            data: resampled,
          });
          nextTimestamp += Math.round((resampled.length / TARGET_RATE) * 1e6);
          if (encoder.state === 'configured') {
            try { encoder.encode(out); } catch (e) { console.warn('encode err', e); }
          }
          out.close();
        }
      })();
      return { ok: true };
    } catch (err) {
      sendLocal(JSON.stringify({ _bridge: 'mic_error', message: String(err.message || err) }));
      return { ok: false, error: String(err.message || err) };
    }
  };

  const stopMic = async ({ silent = false } = {}) => {
    state.mic.running = false;
    try { state.mic.reader?.cancel(); } catch {}
    if (state.mic.encoder && state.mic.encoder.state === 'configured') {
      try { await state.mic.encoder.flush(); } catch {}
      try { state.mic.encoder.close(); } catch {}
    }
    for (const t of state.mic.stream?.getTracks?.() ?? []) { try { t.stop(); } catch {} }
    state.mic.stream = null;
    state.mic.encoder = null;
    state.mic.reader = null;
    if (!silent) {
      sendLocal(JSON.stringify({ _bridge: 'mic_stopped', framesSent: state.mic.framesSent, bytesSent: state.mic.bytesSent }));
    }
    state.mic.framesSent = 0;
    state.mic.bytesSent = 0;
    return { ok: true };
  };

  const handleLocalControl = (msg) => {
    if (msg._bridge === 'open') {
      try {
        const convId = msg.convId;
        if (!convId) throw new Error('open: convId missing');
        state.convId = convId;
        if (msg.orgId) state.orgId = msg.orgId;
        if (!state.orgId) state.orgId = readOrgFromCookie();
        if (!state.orgId) throw new Error('open: orgId unavailable');
        // Reopen: detach the old upstream's event handlers so it dies silently
        // (no upstream_close event that would race with the new session's
        // upstream_open). Also stop the old mic silently for the same reason.
        if (state.upstream) {
          const old = state.upstream;
          state.upstream = null;
          try { old.onopen = old.onmessage = old.onclose = old.onerror = null; } catch {}
          try { old.close(1000, 'reopen'); } catch {}
        }
        if (state.mic.running) {
          stopMic({ silent: true }).catch(() => {});
        }
        openUpstream({
          language: msg.language,
          voice: msg.voice,
          timezone: msg.timezone,
          autoStartMic: !!msg.autoStartMic,
        });
      } catch (err) {
        sendLocal(JSON.stringify({ _bridge: 'upstream_error', message: String(err.message || err) }));
      }
    } else if (msg._bridge === 'close') {
      if (state.upstream) {
        try { state.upstream.close(1000, 'requested'); } catch {}
        state.upstream = null;
      }
      stopMic().catch(() => {});
    } else if (msg._bridge === 'mic_start') {
      startMic();
    } else if (msg._bridge === 'mic_stop') {
      stopMic();
    } else if (msg._bridge === 'playback_set') {
      playback.enabled = !!msg.enabled;
      sendLocal(JSON.stringify({ _bridge: 'playback_state', enabled: playback.enabled }));
    } else if (msg._bridge === 'playback_pause') {
      pausePlayback();
    } else if (msg._bridge === 'playback_resume') {
      resumePlayback();
    } else if (msg._bridge === 'playback_cancel') {
      cancelPlayback();
    }
  };

  const openLocal = () => {
    if (state.local && state.local.readyState <= 1) return;
    const ws = new WebSocket(LOCAL_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      console.info('[lm-voice-bridge] local connected');
      sendLocal(JSON.stringify({
        _bridge: 'hello',
        convId: state.convId,
        orgId: state.orgId,
        pageUrl: location.href,
      }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch {}
        if (msg && msg._bridge) {
          handleLocalControl(msg);
          return;
        }
        sendUpstream(e.data);
      } else {
        sendUpstream(e.data);
      }
    };
    ws.onclose = () => {
      console.warn('[lm-voice-bridge] local closed; will retry in 2s');
      state.local = null;
      if (state.reconnectLocalTimer) clearTimeout(state.reconnectLocalTimer);
      state.reconnectLocalTimer = setTimeout(openLocal, 2000);
    };
    ws.onerror = (e) => console.warn('[lm-voice-bridge] local error', e);
    state.local = ws;
  };

  const playback = {
    ctx: null,
    nextStart: 0,
    enabled: true,
    paused: false,
    dropping: false,        // true after cancel until next playback_start
    activeSources: new Set(),
    framesPlayed: 0,
    bytesPlayed: 0,
  };

  const ensurePlaybackCtx = () => {
    if (playback.ctx) return playback.ctx;
    playback.ctx = new AudioContext({ sampleRate: 16000 });
    playback.nextStart = playback.ctx.currentTime;
    return playback.ctx;
  };

  const playPcm16 = (arrayBuffer) => {
    if (!playback.enabled || playback.dropping) return;
    const ctx = ensurePlaybackCtx();
    const samples = arrayBuffer.byteLength >>> 1;
    if (!samples) return;
    const view = new DataView(arrayBuffer);
    const buf = ctx.createBuffer(1, samples, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const start = Math.max(playback.nextStart, ctx.currentTime);
    src.start(start);
    playback.activeSources.add(src);
    src.onended = () => playback.activeSources.delete(src);
    playback.nextStart = start + buf.duration;
    playback.framesPlayed++;
    playback.bytesPlayed += arrayBuffer.byteLength;
  };

  const pausePlayback = async () => {
    if (!playback.ctx || playback.paused) return { ok: true, alreadyPaused: playback.paused };
    try { await playback.ctx.suspend(); } catch {}
    playback.paused = true;
    sendLocal(JSON.stringify({ _bridge: 'playback_paused' }));
    return { ok: true };
  };

  const resumePlayback = async () => {
    if (!playback.ctx || !playback.paused) return { ok: true, alreadyRunning: !playback.paused };
    try { await playback.ctx.resume(); } catch {}
    playback.paused = false;
    sendLocal(JSON.stringify({ _bridge: 'playback_resumed' }));
    return { ok: true };
  };

  const cancelPlayback = () => {
    // Stop all currently-queued audio sources and start dropping incoming
    // PCM until the next playback_start. AudioContext stays alive.
    for (const src of playback.activeSources) {
      try { src.stop(); } catch {}
    }
    playback.activeSources.clear();
    if (playback.ctx) playback.nextStart = playback.ctx.currentTime;
    playback.dropping = true;
    if (playback.paused) {
      try { playback.ctx?.resume(); } catch {}
      playback.paused = false;
    }
    sendLocal(JSON.stringify({ _bridge: 'playback_cancelled' }));
    return { ok: true };
  };

  const openUpstream = (opts) => {
    if (!state.orgId || !state.convId) throw new Error('orgId and convId required');
    const url = buildUpstreamUrl(state.orgId, state.convId, opts);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      console.info('[lm-voice-bridge] upstream connected', url);
      sendLocal(JSON.stringify({ _bridge: 'upstream_open', url }));
      if (opts.autoStartMic) {
        startMic().then((r) => {
          if (!r?.ok) sendLocal(JSON.stringify({ _bridge: 'mic_error', message: r?.error || 'auto-start failed' }));
        });
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        // Detect playback_start from the server and clear the post-cancel
        // drop state so the next TTS turn plays normally again.
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === 'playback_start') playback.dropping = false;
        } catch {}
        sendLocal(e.data);
      } else {
        if (playback.enabled) {
          try { playPcm16(e.data); } catch (err) { console.warn('[lm-voice-bridge] playback err', err); }
        }
        sendLocal(e.data);
      }
    };
    ws.onclose = (e) => {
      console.info('[lm-voice-bridge] upstream closed', e.code, e.reason);
      sendLocal(JSON.stringify({ _bridge: 'upstream_close', code: e.code, reason: e.reason }));
      if (state.upstream === ws) state.upstream = null;
      // Mic has nowhere to send to — stop it instead of wasting CPU on Opus
      // encoding into a dead socket.
      if (state.mic.running) stopMic().catch(() => {});
    };
    ws.onerror = (e) => {
      console.warn('[lm-voice-bridge] upstream error', e);
      sendLocal(JSON.stringify({ _bridge: 'upstream_error' }));
    };
    state.upstream = ws;
  };

  window.__lmVoiceBridge = {
    attach({ convId, orgId, language, voice, timezone } = {}) {
      if (!convId) throw new Error('convId is required');
      state.convId = convId;
      state.orgId = orgId || readOrgFromCookie();
      if (!state.orgId) throw new Error('orgId not found in cookies; pass it explicitly');
      openLocal();
      openUpstream({ language, voice, timezone });
      return { convId: state.convId, orgId: state.orgId };
    },
    connectLocal() { openLocal(); return true; },
    startMic, stopMic,
    micStatus() {
      return {
        running: state.mic.running,
        framesSent: state.mic.framesSent,
        bytesSent: state.mic.bytesSent,
      };
    },
    setPlayback(on) {
      playback.enabled = !!on;
      sendLocal(JSON.stringify({ _bridge: 'playback_state', enabled: playback.enabled }));
      return playback.enabled;
    },
    pausePlayback, resumePlayback, cancelPlayback,
    playbackStatus() {
      return {
        enabled: playback.enabled,
        paused: playback.paused,
        dropping: playback.dropping,
        framesPlayed: playback.framesPlayed,
        bytesPlayed: playback.bytesPlayed,
      };
    },
    detach() {
      if (state.upstream) {
        try { state.upstream.close(1000); } catch {}
        state.upstream = null;
      }
      if (state.local) {
        try { state.local.close(1000); } catch {}
        state.local = null;
      }
      if (state.reconnectLocalTimer) {
        clearTimeout(state.reconnectLocalTimer);
        state.reconnectLocalTimer = null;
      }
    },
    status() {
      const map = (ws) => ws ? ws.readyState : -1;
      return {
        upstream: map(state.upstream),
        local: map(state.local),
        convId: state.convId,
        orgId: state.orgId,
      };
    },
  };

  console.info('[lm-voice-bridge] installed; call window.__lmVoiceBridge.attach({ convId })');
  // Auto-connect to the local bridge so lm-voice immediately sees pageAttached=true.
  // Upstream stays closed until attach() or a `_bridge:open` control message arrives.
  state.orgId = readOrgFromCookie();
  openLocal();
})();
