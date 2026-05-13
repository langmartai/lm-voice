# Claude Code CLI — Speech-to-Text endpoint

The CLI's `/voice` slash command opens a WebSocket to Anthropic's STT service. Push-to-talk (hold Space by default); transcribed text is inserted into the prompt buffer. **No TTS** — the CLI never speaks back, this endpoint is one-directional dictation only.

Captured: **CLI v2.1.137** on 2026-05-09.

## 1. Endpoint

```
wss://api.anthropic.com/api/ws/speech_to_text/voice_stream
```

Base URL is computed at runtime:

```js
let base = process.env.VOICE_STREAM_BASE_URL
        || BASE_API_URL.replace("https://", "wss://").replace("http://", "ws://");
let path = "/api/ws/speech_to_text/voice_stream";
```

The `VOICE_STREAM_BASE_URL` env var overrides the host. Useful for self-hosting, interception, or pointing at a mock for tests.

## 2. Query parameters

All except `language` and `keyterms` are hardcoded:

| param | value | source | notes |
|---|---|---|---|
| `encoding` | `linear16` | hardcoded | 16-bit signed little-endian PCM |
| `sample_rate` | `16000` | hardcoded | 16 kHz |
| `channels` | `1` | hardcoded | mono |
| `endpointing_ms` | `300` | hardcoded | Deepgram VAD pause-to-finalize |
| `utterance_end_ms` | `1000` | hardcoded | Deepgram utterance-end signal |
| `language` | `en` (default) | user (`/config`) | BCP-47 |
| `use_conversation_engine` | `true` | hardcoded | Deepgram Conversation Engine layer |
| `stt_provider` | `deepgram-nova3` | hardcoded | only provider observed |
| `keyterms` | repeated 15–30× | session-derived | bias terms for Deepgram Nova-3 keyterm prompting |

### Keyterms biasing

The CLI builds a dynamic list of technical terms each session and appends them as repeated `keyterms=` query params. Observed values include:

```
keyterms=MCP keyterms=symlink keyterms=grep keyterms=regex
keyterms=localhost keyterms=codebase keyterms=TypeScript keyterms=JSON
keyterms=OAuth keyterms=webhook keyterms=gRPC keyterms=dotfiles
keyterms=subagent keyterms=worktree keyterms=HEAD
+ session/project-specific terms (e.g. keyterms=lm-proxy)
```

The static set looks like a baked-in "developer vocabulary" list; the rest come from the cwd / open project context.

## 3. Request headers

```
Host: api.anthropic.com
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits
Authorization: Bearer sk-ant-oat01-...   ← OAuth access token (claude login)
User-Agent: claude-cli/<version> (external, cli)
anthropic-client-platform: claude_code_cli
x-app: cli
```

**Auth is OAuth, not API key.** The OAuth token comes from `claude login` (`getOAuthAccount().accessToken`). API keys are not accepted for this endpoint.

Server responds `101 Switching Protocols`. Cloudflare-fronted (`Server: cloudflare`, `CF-RAY`, `cf-cache-status: DYNAMIC`).

## 4. Backend model — Deepgram Nova-3

Every parameter the client sets is straight from Deepgram's streaming API vocabulary:

| param | Deepgram concept |
|---|---|
| `encoding=linear16` | Deepgram audio encoding identifier |
| `endpointing_ms` | Deepgram VAD endpointing |
| `utterance_end_ms` | Deepgram utterance finalization |
| `keyterms` | **Keyterm Prompting** — Nova-3-exclusive feature (max ~100 terms per session) |
| `use_conversation_engine` | Deepgram's Conversation Engine (better turn-taking) |
| `stt_provider=deepgram-nova3` | explicit model selection |

The `stt_provider` URL parameter suggests Anthropic's server is designed to allow swapping providers, but `deepgram-nova3` is the only string baked into the CLI binary. (No `whisper`, `gladia`, `assemblyai`, or other Deepgram model names appear in the STT code path.)

## 5. Client → Server protocol

```
WS open
  ↓
send TEXT  '{"type":"KeepAlive"}'           ← initial KA
  ↓
[every 8 s] send TEXT  '{"type":"KeepAlive"}'   ← periodic KA
[mic on]    send BIN   <linear16 PCM chunk>     ← ~2.6–3.3 KB ≈ 80–100 ms each
            send BIN   <linear16 PCM chunk>
            ...
[finalize() called]
  set D=true (close flag, drop further audio)
  send TEXT  '{"type":"CloseStream"}'
  start safety_timeout    (5000 ms hard cap)
  start no_data_timeout   (1500 ms; reset on each TranscriptText)
  ↓
WS close, code 1000
```

Constants in the bundled JS:

```js
const WP4 = '{"type":"KeepAlive"}';
const w05 = '{"type":"CloseStream"}';
const j05 = '/api/ws/speech_to_text/voice_stream';
const J05 = 8000;                 // periodic KeepAlive interval (ms)
const uu6 = { safety: 5000, noData: 1500 };  // finalize timeouts
```

Audio chunks sent after `CloseStream` are dropped client-side with a log line: *"Dropping audio chunk after CloseStream: N bytes"*.

### Captured session stats

One 14.978-second session captured 2026-05-09T14:58:07Z:

- 72 client frames: 67 binary (audio) + 3 text (2× KeepAlive + 1× CloseStream) + 2 close frames
- Audio bytes (sum of binary payloads): ~190 KB
- Per-frame: min 2625, max 3300, avg 2848 bytes
- Linear16 @ 16 kHz mono = 32 KB/s → each frame is ~82–103 ms of audio, avg ~89 ms
- Total audio sent: ~6.0 seconds (rest of the 15s window was silence between KAs)

## 6. Server → Client protocol

The CLI's message handler is a 4-case `switch` on `msg.type`:

```js
O.on("message", (v) => {
  let parsed = JSON.parse(v.toString());
  switch (parsed.type) {
    case "TranscriptText":     /* interim */
    case "TranscriptEndpoint": /* finalize interim → final */
    case "TranscriptError":    /* recoverable transcription error */
    case "error":              /* server error */
  }
});
```

| `type` | shape | meaning | client action |
|---|---|---|---|
| `TranscriptText` | `{ type, data: "<text>" }` | partial/interim transcript | store as `lastInterim`; call `onTranscript(text, isFinal=false)` |
| `TranscriptEndpoint` | `{ type }` | utterance boundary | promote `lastInterim` → `onTranscript(text, isFinal=true)`; if post-CloseStream, resolves the finalize promise |
| `TranscriptError` | `{ type, description?, error_code? }` | transcription-side error | `onError(description \|\| error_code \|\| "unknown transcription error")` |
| `error` | `{ type, message? }` | server-side error | `onError(message)` |

So Anthropic **re-wraps Deepgram's native protocol** (`Results`, `UtteranceEnd`, `SpeechStarted`, `Metadata`) into 4 Anthropic-flavored types. The CLI never sees raw Deepgram messages — the wrapper decouples the client from the provider.

> **Note on capture limits**: the lm-proxy MITM only captured the WS upgrade response, not post-upgrade frames in the server→client direction. The 4 message types above come from reading the JS source's `switch` statement, not from observing the wire. The access log records that the server sent **909 bytes total** during the 15-second session — consistent with a small number of compressed transcript messages.

## 7. State machine flags

```js
let w = false;   // WS connected
let D = false;   // CloseStream sent (drop subsequent audio)
let j = false;   // finalize() called
let J = false;   // upgrade rejected (4xx/5xx on handshake)
let Z = "";      // lastTranscriptText (last unreported interim)
let M = null;    // keepalive interval handle
let X = null;    // finalize resolver callback
let L = null;    // no-data-timeout reset callback (called on each TranscriptText)
```

### finalize() resolves via one of:

| reason | trigger |
|---|---|
| `"ws_already_closed"` | WS in CLOSED/CLOSING state when finalize() called |
| `"post_closestream_endpoint"` | `TranscriptEndpoint` received after `CloseStream` was sent |
| `"safety_timeout"` | 5000 ms elapsed since `CloseStream` |
| `"no_data_timeout"` | 1500 ms with no incoming message |
| `"ws_close"` | WS closed before finalize resolved |

If `lastInterim` is still populated when finalize resolves, it's promoted to a final transcript before the promise resolves — users never lose a half-spoken word.

## 8. Upgrade rejection handling

Special-cased for Cloudflare:

```js
on("unexpected-response", (req, res) => {
  if (res.statusCode === 101) return;  // ws lib spuriously fires this on success; ignored
  log("cf-mitigated=", res.headers["cf-mitigated"], "cf-ray=", res.headers["cf-ray"]);
  onError("upgrade rejected with HTTP " + status,
          { fatal: status >= 400 && status < 500 });
});
```

If Cloudflare blocks the upgrade (`cf-mitigated: challenge`), the error is marked `fatal` and the CLI won't auto-retry — the user has to re-enable voice mode manually.

## 9. Audio capture (client side)

The CLI tries three paths on Linux (similar on macOS / Windows):

1. **Native module**: `vendor/audio-capture/x64-linux/audio-capture.node` (preferred — NAPI binding to platform audio API)
2. **`arecord`** (ALSA): `arecord -f S16_LE -r 16000 -c 1 -t raw`
3. **`rec`** (SoX) — installs via `apt-get install sox` / `dnf install sox` / `pacman -S sox` if missing

Sanity checks before recording:
- `/proc/asound/cards` must show at least one soundcard
- `arecord` probe runs for 150 ms to check it works
- Refuses to record if `CLAUDE_CODE_REMOTE` env var is set (i.e. over SSH session)

## 10. Modes

`/voice <mode>`:

| mode | behavior |
|---|---|
| `hold` (default) | Push-to-talk: hold Space while speaking |
| `tap` | Tap Space to start, tap again to stop |
| `off` | Disable |

`/voice on` returns *"Unknown mode: 'on'. Use hold, tap, or off."*

## 11. Practical hooks for testing / observing

- Set `VOICE_STREAM_BASE_URL=ws://localhost:9000` and run a local WS server to inspect/replay/mock the protocol.
- The 4 server message types are tiny — a minimal mock can serve `{"type":"TranscriptText","data":"hello"}` and `{"type":"TranscriptEndpoint"}` and the CLI will accept it.
- All client→server traffic is recoverable via a transparent MITM proxy (see [methodology.md](./methodology.md)) since OAuth Bearer tokens travel in headers, not as bound TLS material.

## 12. Code reference

The whole module is in `claude.exe` (bundled JS). Public exports:

```js
// module exports
isVoiceStreamAvailable()    // → boolean; checks OAuth token presence
connectVoiceStream(handlers, opts) // → { send, finalize, close, isConnected }
FINALIZE_TIMEOUTS_MS         // { safety: 5000, noData: 1500 }
```

The `handlers` object:
```js
{
  onReady(controller),
  onTranscript(text, isFinal),
  onError(msg, opts?),
  onClose(),
}
```

The `opts` object:
```js
{
  language?: "en" | ...,
  keyterms?: string[],
}
```
