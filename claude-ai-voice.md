# Claude.ai web — voice mode endpoint

The voice mode in the **Claude.ai web app** is **fully conversational**: the user speaks, the model speaks back, and either side can interrupt the other. This is a different endpoint family from Claude Code's dictation, on a different host with a different transport profile.

Captured: web app traffic on 2026-05-09 (claude.ai browser session).

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

## 5. Protocol on the wire — what we don't know yet

Because `permessage-deflate` was active and we didn't decompress, we **don't have decoded server→client text frames** in this round. Things we'd want to learn next:

- **Message-type vocabulary** — what events does the server send? Candidates (by analogy with other realtime voice APIs):
  - Transcripts of the user's speech (interim + final)
  - Model's text response (token stream)
  - TTS audio chunks (PCM frames over binary opcode)
  - Speech start / speech end / interrupt events
  - Turn-boundary events
  - Conversation state / tool use / errors
- **TTS pipeline** — which voice models back `voice=airy`? Likely candidates: ElevenLabs, OpenAI TTS, Cartesia, an in-house Anthropic model. No identifying strings have been observed.
- **Server interrupt semantics** — exactly which client-side signal triggers the server to truncate its own TTS. The `server_interrupt_enabled=true` param suggests this is a feature toggle.
- **Available voice names** — `airy` is one; the UI almost certainly exposes others.
- **Conversation persistence** — does the chat thread record the voice exchange as normal turns? Re-using `convId` across WS connections suggests yes.

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
