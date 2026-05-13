# LM Voice — Windows voice companion for Claude Code sessions

A small Electron tray app. Hold a hotkey, speak a question or instruction, and a Haiku agent running on **lm-assist** (local or remote) interprets it against a **specific Claude Code session**, then replies out loud via on-device **Supertonic** TTS.

```
[ mic ]                                                                   [ speaker ]
  │                                                                          ▲
  ▼                                                                          │
[ Electron renderer ]                                                    [ Electron renderer ]
  │ WebAudio + AudioWorklet                                                  │ <audio>
  │  → resample → linear16 @ 16kHz mono                                      │
  ▼                                                                          │ WAV bytes via IPC
[ Electron main ]                                                        [ Electron main ]
  │                                                                          │
  │  WS  wss://api.anthropic.com/api/ws/speech_to_text/voice_stream      [ Supertonic ONNX ]
  ▼     (Deepgram Nova-3, OAuth Bearer, KeepAlive+CloseStream)               ▲
[ STT transcript text ]                                                      │ synthesize text
  │                                                                          │
  ▼  HTTP  POST {endpoint}/agent/execute  model=haiku, cwd={session.cwd}     │
[ lm-assist (local or remote) ]                                              │
  │                                                                          │
  │  spawns Claude Code agent (Haiku) with prompt:                           │
  │    "You are a voice assistant. The user said: ...                        │
  │     Target session: {sessionId} at {cwd}.                                │
  │     Query lm-assist via curl {endpoint}/sessions/{id}/conversation       │
  │     Reply SHORT, conversational, TTS-friendly."                          │
  │                                                                          │
  ▼  GET {endpoint}/agent/execution/{id}  → poll until completed             │
[ agent reply text ]  ──── clean for TTS (strip markdown, cap length) ───────┘
```

## Status

Pre-release MVP. Built on Linux; Windows is the target. Some Windows-specific bits (tray icon hit-testing, global key hook permissions) need testing on a Windows machine.

## Prerequisites

- **Windows 10 / 11** (target). Also runs on macOS / Linux for dev.
- **Node.js 20+** for `npm install` / dev.
- **Microphone** + access to it (Windows: Settings → Privacy → Microphone).
- **Claude Code** installed and logged in (`claude login`) — the app reuses the OAuth token from `~/.claude/.credentials.json`. The same token authorizes the Anthropic STT WebSocket.
- **lm-assist** running somewhere reachable. Local default: `http://localhost:3100`. Remote: e.g. `http://10.0.1.123:3100`.
- **Internet** for the STT WebSocket call. TTS is fully local once models are downloaded.

## Setup

```bash
cd app
npm install
```

`npm install` will also build the native `onnxruntime-node` and `node-global-key-listener` bindings for the local Electron version (via `electron-builder install-app-deps` postinstall hook).

### First-run model download

On first synthesis the app downloads ~80 MB of Supertonic ONNX models + voice styles from HuggingFace into `~/.lm-voice/assets/`. This happens once; subsequent runs are fully offline for TTS.

If you want to pre-fetch:

```bash
node -e "require('./src/lib/tts-client').ensureAssets({ onProgress: console.log }).then(console.log)"
```

## Run

```bash
npm start
```

A tray icon appears. Hold **Right Ctrl** and speak. Release to send. A small popup shows the live transcript and the spoken reply.

### Configure

Config lives at `~/.lm-voice/config.yaml`. Open from the tray menu (*Open config…*).

```yaml
lmAssist:
  endpoint: http://localhost:3100    # or http://10.0.1.123:3100 for remote

session:
  id: 9a6113a4-475d-4885-a5d1-54fc89f74a79
  cwd: C:\path\to\project
  label: lm-proxy

stt:
  provider: anthropic
  language: en
  keyterms:                          # bias Deepgram Nova-3 toward your vocabulary
    - lm-assist
    - lm-voice
    - "brent oil"

tts:
  provider: supertonic
  voiceStyle: M1                     # one of M1..M5, F1..F5 (download all on first run)
  speed: 1.05
  lang: en

hotkey:
  pushToTalk: RIGHT CTRL             # one of RIGHT CTRL, LEFT CTRL, RIGHT ALT, F12, CAPS LOCK, ...
  mode: hold                         # hold = push-to-talk, toggle = press to start/stop

agent:
  model: haiku
  maxReplyChars: 350                 # hard cap on spoken reply
  effort: low

ui:
  showPopup: true
```

### Pick a session

Tray menu → *Pick session…* lists recent sessions from lm-assist. Choosing one writes it into `config.yaml`. From then on, voice commands are interpreted against that session's `cwd` and conversation history.

## How the TTS-friendly reply works

The Haiku agent gets a system prompt (in `src/lib/agent-prompt.js`) with strict rules:

- plain spoken English, no markdown / bullets / code / URLs / file paths
- hard cap at `agent.maxReplyChars` characters (default 350)
- summarize, never enumerate ("eight items, the biggest is X" — not a list of 8)
- speak numbers naturally ("about thirty trades", not "n=30")
- no meta-commentary ("Sure!", "Let me check…")
- refuse to perform write actions, defer those to the terminal session

After the agent replies, `cleanForTTS()` (same file) does belt-and-braces defense: strips any markdown that leaked through, drops URLs, collapses whitespace, hard-truncates at a sentence boundary.

## Build a Windows installer

```bash
npm run build:win
```

Produces `dist/LM Voice Setup <version>.exe` (NSIS installer) under `dist/`. Sign it with your own code-signing cert before distributing.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `"No accessToken found"` on startup | Not logged in | Run `claude login` once |
| Hotkey does nothing | Another app captured the key | Change `hotkey.pushToTalk` in config |
| `WebSocket upgrade rejected: HTTP 401` | OAuth token expired | `claude login` to refresh |
| `WebSocket upgrade rejected: HTTP 403 cf-mitigated=challenge` | Cloudflare blocked the WS upgrade | Retry shortly; if persistent, you may be rate-limited |
| Mic permission popup never appears | Windows mic permission denied | Settings → Privacy → Microphone → allow desktop apps |
| TTS first run hangs | Downloading models from HuggingFace | Wait ~30s on first run; check `~/.lm-voice/assets/` populating |
| `ENOENT onnxruntime-node` on Linux dev | Native binding mismatch | `npm rebuild onnxruntime-node` |
| `node-global-key-listener` errors on Linux | Needs `sudo` or `setcap` to grab key events | On Windows this just works; dev on Linux requires root |
| Reply is too long / verbose | Lower `agent.maxReplyChars`, or sharpen prompt in `agent-prompt.js` | — |

## Architecture (file map)

```
app/
├── package.json                   electron + onnxruntime-node + ws + key-listener
├── src/
│   ├── main.js                    Electron main: tray, hotkey, IPC, orchestration
│   ├── lib/
│   │   ├── config.js              ~/.lm-voice/config.yaml load/save
│   │   ├── oauth.js               Read Claude OAuth from ~/.claude/.credentials.json
│   │   ├── stt-client.js          Anthropic WS STT (port of connectVoiceStream)
│   │   ├── tts-client.js          Supertonic ONNX wrapper + model auto-download
│   │   ├── lm-assist-client.js    HTTP client + execution polling
│   │   ├── agent-prompt.js        TTS-friendly Haiku system prompt + reply cleaner
│   │   ├── hotkey.js              Global push-to-talk via node-global-key-listener
│   │   └── supertonic/helper.mjs  Vendored from supertone-inc/supertonic
│   └── renderer/
│       ├── index.html             Popup: status + transcript + reply
│       ├── style.css
│       ├── index.js               Mic capture, WebAudio worklet wiring, WAV playback
│       └── mic-worklet.js         Resample 48k → 16k, Float32 → Int16 LE
└── assets/
    └── icons/                     Tray icon (drop your icon.png / icon.ico here)
```

## What's reused from the lm-voice protocol docs

- The STT client in `src/lib/stt-client.js` is a direct port of the `connectVoiceStream` function we documented in `../claude-code-cli-stt.md`. Same path, same query params, same KeepAlive interval (8 s), same finalize timeouts (5 s safety / 1.5 s no-data), same 4 server message types (`TranscriptText`, `TranscriptEndpoint`, `TranscriptError`, `error`).
- We send `anthropic-client-platform: claude_code_cli` and `x-app: cli` so the endpoint accepts us with the same auth surface as Claude Code itself.

## License

MIT.
