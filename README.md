# lm-voice

Reverse-engineered notes on the voice (STT / TTS) endpoints used by **Anthropic's Claude products**:

- **Claude Code CLI** — dictation-only Speech-to-Text (push-to-talk input).
- **Claude.ai web** — full bidirectional conversational voice (STT + TTS, with server-side interrupt).

Both products are first-party Anthropic surfaces but they use **different endpoints, different hosts, different auth, and different audio codecs**.

## TL;DR comparison

| | Claude Code CLI (`/voice`) | Claude.ai web (voice mode) |
|---|---|---|
| Direction | STT only (dictates into prompt) | STT + TTS (full duplex) |
| Host | `api.anthropic.com` | `claude.ai` |
| Path | `/api/ws/speech_to_text/voice_stream` | `/api/ws/voice/organizations/{orgId}/chat_conversations/{convId}` |
| Transport | WebSocket (`wss://`) | WebSocket (`wss://`) |
| Input codec | `linear16` (16-bit PCM, 16 kHz, mono, uncompressed) | `opus` (compressed, 16 kHz, mono) |
| Output | JSON transcript messages | PCM 16 kHz audio + JSON events |
| STT backend (known) | **Deepgram Nova-3** (`stt_provider=deepgram-nova3`) | server-side (not exposed in query params, but interim/final cadence + `utterance_seq` matches Deepgram Nova streaming) |
| Model used | (n/a — STT only) | **`claude-haiku-4-5`** regardless of the conversation's configured model — observed live 2026-05-19 |
| Server frame envelope | flat JSON (`type: TranscriptText`, …) | flat JSON for lifecycle + a `message_sse` wrapper that re-multiplexes the existing `POST /completion` SSE stream |
| TTS frame | n/a | 320 B binary frames = 16-bit LE PCM, 16 kHz mono, 10 ms each |
| Voice (TTS) | n/a | `voice=airy` (configurable; multiple voices presumed) |
| Auth | OAuth Bearer (`sk-ant-oat01-…`) | Browser cookies (`anthropic-device-id`, `__cf_bm`, …) |
| User-Agent | `claude-cli/<version> (external, cli)` | browser UA (Chrome) |
| Client header | `anthropic-client-platform: claude_code_cli`, `x-app: cli` | `client_platform=web_claude_ai` (query param) |
| Conversation scope | Stateless per session (dictation) | Bound to a specific `chat_conversations/{id}` |
| Compression | none on text frames | `permessage-deflate` (zlib) |
| KeepAlive | every 8 s, `{"type":"KeepAlive"}` | (not directly observed; permessage-deflate hides text content) |
| Sound effects | none | static MP3s at `/audio/voice/sfx/{enter,exit,disconnected}_voice_mode.mp3` |

## Documents

- [**claude-code-cli-stt.md**](./claude-code-cli-stt.md) — full breakdown of the Claude Code CLI dictation endpoint, including the protocol state machine extracted from the bundled JS in `claude.exe`.
- [**claude-ai-voice.md**](./claude-ai-voice.md) — what we have on the Claude.ai web voice mode endpoint.
- [**methodology.md**](./methodology.md) — how this was captured (transparent TLS MITM via [lm-proxy](https://github.com/yi/lm-proxy)) and what we still don't have.

## Reference implementations

- [**app/**](./app) — Electron tray app for Windows. Two parallel voice paths:
  1. **CLI-STT path (original)**: hold a hotkey, speak a question about a specific Claude Code session, get a short spoken reply. Uses the Anthropic STT endpoint above; pipes through an lm-assist Haiku agent; speaks back via [Supertonic](https://github.com/supertone-inc/supertonic) on-device TTS.
  2. **Claude.ai voice bridge (added 2026-05-19)**: launches an embedded Chromium `BrowserWindow` (persistent partition), auto-injects a relay snippet into the `claude.ai` page, captures mic via `WebCodecs AudioEncoder` (raw Opus), pipes everything through the *real* claude.ai voice WebSocket. The browser handles TLS / cookies / `permessage-deflate` for free — no copy-paste, no Cloudflare TLS-fingerprint workarounds. HTTP API at `:3199/api/claude-ai/*` exposes every action (open browser, open upstream, start/stop mic, toggle playback, dump events). See [`app/README.md`](./app/README.md) and [`app/src/lib/claude-ai-bridge.js`](./app/src/lib/claude-ai-bridge.js).

## Status & caveats

- This is **reverse-engineered from network captures of a user's own traffic** plus reading the JS that ships inside the Claude Code CLI binary. It is not from Anthropic documentation.
- Endpoint paths, query params, and message shapes can change without notice.
- Server→client WS response bodies were not fully captured (the lm-proxy audit only logs the WS upgrade response, not post-upgrade frames). What we know about server-side messages comes from **the JS source's message-handler `switch` statement**, not from observing the wire.
- All identifiers (organization IDs, conversation IDs, tokens, cookie values) in this repo are redacted to `{orgId}`, `{convId}`, etc.

## Versions captured

- Claude Code CLI: **v2.1.137** (binary at `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, 220 MB Node SEA).
- Captured: 2026-05-09.
