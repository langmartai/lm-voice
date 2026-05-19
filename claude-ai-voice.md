# Claude.ai web — voice mode endpoint

The voice mode in the **Claude.ai web app** is **fully conversational**: the user speaks, the model speaks back, and either side can interrupt the other. This is a different endpoint family from Claude Code's dictation, on a different host with a different transport profile.

Captured: web app traffic on 2026-05-09 (claude.ai browser session). Wire-level protocol vocabulary captured 2026-05-19 by driving an end-to-end session through `lm-voice/app/`'s embedded BrowserWindow bridge — see [§5 Protocol vocabulary](#5-protocol-vocabulary).

## 1. Endpoints

### Voice WebSocket (STT + TTS, bidirectional)

```
wss://claude.ai/api/ws/voice/organizations/{orgId}/chat_conversations/{convId}
```

Bound to a specific organization and a specific conversation — the voice stream is **attached to an existing chat thread**, not a free-standing session. The same `convId` can be voice-resumed across multiple WS connections (we observed the same `convId` reconnected ~7 times over a 20-minute window).

### Sound effects (static HTTP)

```
GET https://claude.ai/audio/voice/sfx/enter_voice_mode.mp3      (~10 KB)
GET https://claude.ai/audio/voice/sfx/exit_voice_mode.mp3       (~10 KB)
GET https://claude.ai/audio/voice/sfx/disconnected.mp3          (~10 KB)
```

These are plain MP3 file assets, served via normal HTTPS GET. Not part of the realtime audio path — they're UI feedback (enter/exit voice mode chime + disconnection alert).

## 2. Query parameters (voice WS)

Observed full URL:

```
/api/ws/voice/organizations/{orgId}/chat_conversations/{convId}
  ?input_encoding=opus
  &input_sample_rate=16000
  &input_channels=1
  &output_format=pcm_16000
  &language=en-US
  &timezone=Asia%2FJakarta
  &voice=airy
  &server_interrupt_enabled=true
  &client_platform=web_claude_ai
```

| param | observed value | notes |
|---|---|---|
| `input_encoding` | `opus` | client mic uplink uses Opus (compressed, much smaller than linear16) |
| `input_sample_rate` | `16000` | 16 kHz |
| `input_channels` | `1` | mono |
| `output_format` | `pcm_16000` | server returns **uncompressed PCM @ 16 kHz** (client-side decoded in WebAudio) |
| `language` | `en-US` | full BCP-47 locale, not just `en` |
| `timezone` | `Asia/Jakarta` | IANA tz, sent so the assistant can answer time-of-day questions |
| `voice` | `airy` | TTS voice name — others almost certainly exist (UI has a voice picker) |
| `server_interrupt_enabled` | `true` | the server may stop its own TTS when it hears the user start speaking |
| `client_platform` | `web_claude_ai` | analogue of CLI's `anthropic-client-platform: claude_code_cli` |

### Codec contrast vs. CLI

| | Claude Code CLI | Claude.ai web |
|---|---|---|
| Uplink (mic → server) | linear16 PCM (32 KB/s) | Opus (highly compressed; observed binary frames 8–88 bytes, avg 56 bytes) |
| Downlink (server → speakers) | n/a (no TTS) | `pcm_16000` (raw 16-bit PCM @ 16 kHz) |

Opus uplink makes sense for browsers — the platform has a hardware Opus encoder via `MediaRecorder`/`WebCodecs`, and traffic is dramatically smaller (~10–50× less than linear16). PCM downlink keeps client-side decoding trivial.

## 3. Request headers

```
Host: claude.ai
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits
Origin: https://claude.ai
User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
Cache-Control: no-cache
Pragma: no-cache
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: en-US,en;q=0.9
Cookie: anthropic-device-id=...; __cf_bm=...; _cfuvid=...; (session cookies)
```

### Auth model — completely different from CLI

| | Claude Code CLI | Claude.ai web |
|---|---|---|
| Auth method | OAuth Bearer in `Authorization` header | **Browser session cookies** (`anthropic-device-id`, `__cf_bm`, `_cfuvid`, plus your claude.ai session cookie) |
| Origin check | none observed | `Origin: https://claude.ai` enforced (CORS / WS origin) |
| Front-end | Cloudflare | Cloudflare (cookies suggest Cloudflare bot management + session pinning) |

So you can't easily reproduce a claude.ai voice session by copy-pasting a token the way you can with the CLI's OAuth Bearer — you need a valid logged-in browser cookie jar.

Server responds `101 Switching Protocols`. Cloudflare-fronted (`Server: cloudflare`, `CF-RAY`, sets `__cf_bm` and `_cfuvid` on the upgrade response).

## 4. WS framing

`permessage-deflate` is **negotiated and active** (`sec-websocket-extensions: permessage-deflate; client_max_window_bits=15` in the 101 response). This means **all text frames are zlib-compressed on the wire** and need to be inflated before they become readable JSON. The lm-proxy MITM captured the raw compressed bytes; we did not decompress them in this round of analysis.

### Captured session stats (one biggest session)

```
Duration                  : ~17 minutes captured (single WS stream)
Client uplink total       : 2,097,152 bytes (2 MB; capture was truncated at 2 MB)
  - Text frames (compressed JSON): 177
  - Binary frames (Opus packets) : 34,033
  - Opus frame sizes            : min 8B, max 88B, avg 56B
Server downlink total     : (response body not captured — proxy limitation)
```

The Opus frame size distribution (avg 56 bytes per frame, 34,000 frames over ~17 minutes ≈ 33 frames/sec) is consistent with **20 ms Opus frames @ ~22 kbps** — standard WebRTC voice profile.

## 5. Protocol vocabulary

Captured live 2026-05-19 by driving an end-to-end session via the lm-voice embedded-browser bridge. We injected a relay snippet into a real `https://claude.ai/` page running inside an Electron `BrowserWindow` (persistent partition `persist:lm-voice-claudeai`), so the browser handled TLS / cookies / `permessage-deflate` inflation transparently. Captured dumps in `lm-voice/app/test/out/vocab-*.json`.

### 5.1 Server text frames (JSON, after inflate)

All text frames are JSON objects. The server emits a small fixed vocabulary plus a wrapper (`type: "message_sse"`) that re-uses the same SSE event stream `POST /completion` returns.

#### Lifecycle frames

| `type` | Payload | When |
|---|---|---|
| `session_server_initialized` | `{}` | first frame after WS upgrade |
| `transcription_start` | `{}` | server STT (Deepgram or equivalent) started listening for the user's next utterance |
| `transcript_interim` | `{ text, utterance_seq }` | streaming STT result; `utterance_seq` resets per utterance |
| `transcript_empty` | `{}` | VAD heard no speech in the captured audio window |
| `user_input_end` | `{}` | server-side VAD detected end of user's turn |
| `playback_start` | `{}` | server is about to stream TTS PCM frames |
| `tts_segment_end` | `{}` | TTS chunk boundary |
| `playback_end` | `{}` | full assistant turn TTS finished |
| `server_interrupt` | `{}` | server stopped its own TTS (likely because user began speaking again) |
| `tts_word` | `{ text, pts_ms }` | **word-level TTS timing** — emitted per-word during playback; `text` is the word, `pts_ms` is presentation timestamp in milliseconds relative to playback start (monotonically increasing). Useful for karaoke-style highlight in a UI |
| `message_complete` | `{}` | full assistant turn finished and persisted |

#### History records (no `type`)

The server also emits **full message records** with no top-level `type` — these are the records persisted to the conversation history:

```json
{
  "data": {
    "message_uuid": "019e3f8b-0bcc-733d-a480-55987bfd9a5c",
    "sender": "human" | "assistant",
    "content": [
      { "type": "text", "text": "...", "start_timestamp": null, "stop_timestamp": null, "flags": null, "citations": [] }
    ]
  }
}
```

`sender: "human"` is emitted once the user's utterance is finalized into the transcript; `sender: "assistant"` is emitted at the end of the model's turn (paired with `message_complete`). These are the same record shape served by `GET /api/.../chat_conversations/{uuid}?tree=true` for the conversation history.

#### `message_sse` wrapper — re-using the completion SSE stream

The server multiplexes the **same SSE event stream `POST /completion` already returns** through the voice WS, just wrapped:

```json
{ "type": "message_sse", "event": { "type": "<inner>", "data": { ... } } }
```

Inner event types observed (all match the documented `POST /completion` vocabulary from `lm-assist/docs/claude-ai-routes.md`):

| inner `event.type` | inner `event.data` highlights |
|---|---|
| `conversation_ready` | `{ type: "conversation_ready" }` — emitted immediately after `session_server_initialized` |
| `message_start` | `{ message: { id: "msg_...", type: "message", role: "assistant", model: "claude-haiku-4-5", parent_message_uuid, ... } }` |
| `content_block_start` | `{ index: 0, content_block: { start_timestamp, stop_timestamp: null, flags, ... } }` |
| `content_block_delta` | `{ index: 0, delta: { type: "text_delta", text: "..." } }` — token stream |
| `content_block_stop` | `{ index: 0, stop_timestamp }` |
| `message_delta` | `{ delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null } }` |
| `message_stop` | `{ type: "message_stop" }` |

So the voice surface is structurally **not a new protocol** — it's the existing HTTP completion event stream piped over WS, plus a small set of voice-specific lifecycle frames (transcripts, playback, VAD, interrupt).

### 5.2 Server binary frames — TTS audio

| Property | Value |
|---|---|
| Opcode | binary |
| Frame size | **320 bytes** each (exactly) |
| Format | 16-bit signed PCM, **little-endian**, mono, 16 kHz |
| Frame duration | 10 ms (160 samples × 2 bytes) |
| Cadence during `playback` | tightly bunched ~50–100 frames per ~350 ms window — server batches |
| Total downlink rate | ~32 KB/s when streaming, near zero otherwise |

Decode is trivial — `new Int16Array(buf)` then divide by 32768 for Float32 samples directly playable by an `AudioContext({ sampleRate: 16000 })`. lm-voice's page-side snippet does this in ~15 lines.

### 5.3 Client uplink — confirmed wire format

Captured by encoding mic input via `MediaStreamTrackProcessor → AudioEncoder({codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 24000})`. Each `EncodedAudioChunk` payload IS a raw Opus packet — exactly what the server expects, no container.

| Metric | Captured | Original capture from §4 | Match |
|---|---|---|---|
| Frame size range | 8–88 bytes | 8–88 bytes | ✓ |
| Frame avg | ~48 bytes | 56 bytes | ✓ close |
| Frame rate | ~50 fps (20 ms) | ~33 fps | ✓ close (small variation from encoder settings) |
| Bitrate | ~20 kbps | ~22 kbps | ✓ |

`MediaRecorder(audio/webm;codecs=opus)` does **not** work — it wraps Opus in a WebM container, and the server rejects it (silently times out at ~20 s). Use `AudioEncoder` directly.

### 5.4 Server-side timeouts and keep-alive

- **Idle no-frame timeout:** server cleanly closes the WS with code `1000` reason `""` after ~19–23 s if **no frames** arrive at all. No error frame, no warning.
- **Malformed uplink:** sending text frames like `{"type":"KeepAlive"}` (the CLI convention) or arbitrary bytes through the audio path triggers no server response and **does not** reset the idle timer.
- **Conclusion:** there's no client-keepalive protocol — the only way to hold the connection open is to keep streaming Opus packets.
- **Silence counts as "frames".** The mic doesn't need to capture *speech* to keep the connection alive — it only needs to capture *audio*. Quiet input encodes to very small Opus packets (~8–15 B each) at the encoder's normal ~50 fps cadence. The server sees a steady stream and never times out. lm-voice's `autoStartMic` option (passed via `_bridge:open`) starts the mic the moment `upstream.onopen` fires, so the connection is never silent on the wire even when the user is silent in the room.
- **Practical keep-alive recipe:** always pass `autoStartMic: true` in the `_bridge:open` control message (or use `POST /api/claude-ai/session/start` which defaults it to `true`). The mic remains on for the lifetime of the upstream WS; server-side VAD on the other end decides when the user's speech turn begins/ends regardless.

### 5.5 Conversation persistence

Voice turns ARE persisted to the chat thread. After a captured exchange (`"Are you able to hear me?"` → `"Yeah, I can hear you loud and clear! What's on your mind?"`), the conversation became visible in the regular claude.ai web UI with both messages — same `message_uuid`s the WS emitted.

### 5.6 Models

- Voice-mode assistant turns use `model: "claude-haiku-4-5"` regardless of the conversation's configured model — observed even on a conversation set to `claude-opus-4-7`. Voice is a Haiku-only product surface.
- STT backend is not exposed in any captured field. Behaviour (interim/final, `utterance_seq` cadence, VAD) is consistent with Deepgram Nova streaming, same as the Claude Code CLI dictation endpoint.
- TTS backend is not exposed. `voice=airy` is the only voice we've captured; the UI implies others exist.

### 5.7 Remaining unknowns

- **Other `voice=` names** — `airy` is the only one captured. The UI has a voice picker.
- **Error frames** — we've never seen one. Auth fails happen at the upgrade (HTTP 4xx), and malformed uplink silently times out. There may be `type: "error"` frames the server emits in other edge cases we haven't triggered.
- **Tool-use frames** — voice mode might or might not allow Claude to call tools. The captured exchange was conversational and didn't trigger any. The `message_sse` wrapper has the bandwidth to carry `tool_use` deltas (the same as `POST /completion` does) but we have no live evidence.
- **`server_interrupt_enabled=false`** — we always sent `true`. The `false` path likely just makes the server ignore user speech during its own TTS.

## 6. Reference implementation — lm-voice

A complete client-side implementation lives at `lm-voice/app/`. Architecture overview:

```
[ user mic ]                                                   [ user speakers ]
     │                                                               ▲
     │   ┌──────────────────  Electron BrowserWindow  ──────────────┐│
     │   │ persist:lm-voice-claudeai partition                       ││
     │   │   ↳ https://claude.ai/* (logged in, persistent cookies)   ││
     │   │   ↳ Auto-injected page snippet (claude-ai-page-bridge.js) ││
     │   │       · MediaStreamTrackProcessor → AudioEncoder(opus)    ││
     │   │       · binaryType=arraybuffer; permessage-deflate done   ││
     │   │         by browser before delivering to JS                ││
     │   │       · AudioContext({sampleRate:16000}) plays PCM frames ││
     │   └───────────────────┬─────────────────┬─────────────────────┘│
     │                       │ wss             │ wss
     ▼                       ▼ (uplink)        ▼ (downlink)
     ws://127.0.0.1:8765/?role=page (Opus packets + JSON events)
                             │
                             ▼
            [ lm-voice main: ClaudeAiBridge ]
                             │
              ┌──────────────┼───────────────────────────┐
              │              │                           │
              ▼              ▼                           ▼
       /api/claude-ai/*   text/binary event       ws://127.0.0.1:8765
       HTTP API           ring buffers            /?role=renderer
       (orchestrator)                              (UI window, optional)
```

### 6.1 Key HTTP API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/claude-ai/browser/open` | Open the embedded `claude.ai` BrowserWindow (login persists across restarts) |
| `POST /api/claude-ai/browser/conversations` | Create a new claude.ai conversation via the embedded session |
| `GET  /api/claude-ai/browser/conversations` | List recent conversations |
| `POST /api/claude-ai/browser/completion` | Send a text-mode turn via `POST /completion` and drain the SSE stream — same surface as lm-assist's `/claude-ai/conversations/:uuid/completion` |
| `POST /api/claude-ai/session/start` | **Orchestrator**: optionally create-or-resume conv → optionally post a context message → open voice WS (with `autoStartMic` default-on) |
| `POST /api/claude-ai/upstream/open` | Just open the voice WS for a given convId (optional `autoStartMic`) |
| `POST /api/claude-ai/mic/start` / `/stop` | Manual mic control |
| `POST /api/claude-ai/playback` | Toggle in-browser TTS audio output |
| `GET  /api/claude-ai/events?limit=N` | Drain the bridge's event buffer (text + binary metadata) |

### 6.2 Tested workflows

The end-to-end flow that has been wire-validated (2026-05-19):

1. `POST /api/claude-ai/browser/open` — launches the embedded `claude.ai` window
2. User logs in once (or session persists from a prior run)
3. `POST /api/claude-ai/session/start` with a `context` string — orchestrator creates a fresh conv, posts the context (Opus 4.7 replies in text), then opens the voice WS with `autoStartMic` on
4. User speaks; Claude transcribes via Deepgram-equivalent STT, replies via Haiku 4.5, synthesises TTS (`voice=airy`), and the embedded browser plays the audio
5. lm-voice's renderer log (separate BrowserWindow at `claude-ai.html`) shows:
   - Streaming assistant text (one `content_block_delta` at a time)
   - User transcripts (interim → final)
   - Word-by-word highlight during TTS playback via `tts_word` events

### 6.3 Files

| File | Role |
|---|---|
| `app/src/lib/claude-ai-bridge.js` | Local WS server at `ws://127.0.0.1:8765`. Origin-gated. Splits text and binary into separate ring buffers. |
| `app/src/lib/claude-ai-page-bridge.userscript.js` | The page snippet that gets injected into every claude.ai page. Implements `__lmVoiceBridge.{attach, startMic, stopMic, setPlayback, ...}`. |
| `app/src/main.js → openClaudeAiBrowser()` | Embedded BrowserWindow with `persist:lm-voice-claudeai` partition and auto-grant mic permission for claude.ai. |
| `app/src/lib/api-server.js` | HTTP API routes documented above. |
| `app/src/renderer/claude-ai.{html,css,js}` | Optional UI window: dot status, conversation log with word highlight, raw event panel. |
| `app/test/claude-ai-bridge.test.js` | 27-check smoke test (mock page + mock renderer + every API route). |
| `app/test/out/vocab-*.json` | Captured event dumps from live sessions; primary source for the vocabulary in §5. |

## 6. Lifecycle observation

Within a 20-minute window the proxy captured:

```
15:03:23  WS open  convId=202f1245...  (1st attempt; closed quickly)
15:03:32  WS open  convId=202f1245...
15:07:30  WS open  convId=202f1245...
15:07:40  WS open  convId=202f1245...
15:07:56  WS open  convId=202f1245...
15:09:19  WS open  convId=202f1245...
15:12:53  GET  /audio/voice/sfx/exit_voice_mode.mp3      ← UI confirms voice mode exited
15:15:59  GET  /audio/voice/sfx/enter_voice_mode.mp3     ← UI confirms voice mode re-entered
15:15:59  GET  /audio/voice/sfx/disconnected.mp3
15:20:47  WS open  convId=202f1245...
15:39:34  WS open  convId=c8422b61...   ← new conversation; biggest session, ~3 MB uplink
15:41:47  WS open  convId=f4f13e6c...   ← another new conversation
15:53:49  WS open  convId=c8422b61...   ← reconnect to earlier convId
```

The pattern of **many short reconnections to the same `convId`** suggests the client tears down and re-establishes the WS at every turn boundary (or every TTS playback completion), keeping the chat thread state on the server side and using the WS as a single-turn transport.

## 7. Open questions / next-round captures

To complete this picture we'd need:

1. **Decompress text frames** (run permessage-deflate inflater on the captured stream).
2. **Capture the server→client direction** — requires either modifying lm-proxy to keep buffering WS responses post-upgrade, or running a different MITM (e.g. mitmproxy with WS extension).
3. **Enumerate voices** — open Claude.ai voice settings and capture the URL the picker hits.
4. **Find the equivalent in the Claude.ai mobile app** — likely the same WS but different `client_platform`.

## 8. Claude Code CLI does NOT have TTS

Worth restating: the CLI's voice feature is **dictation only**. It uses `api.anthropic.com/api/ws/speech_to_text/voice_stream`, the response messages are `TranscriptText` / `TranscriptEndpoint` (text), and there is no audio output path in the binary's voice-stream code. The native audio module does include `startNativePlayback` / `stopNativePlayback` / `writeNativePlaybackData` exports, but these are not wired into a TTS endpoint — they're presumably for future use or sound effects.
