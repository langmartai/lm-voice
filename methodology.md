# Methodology

How the protocol details in this repo were obtained.

## 1. Capture stack

All captures came from a single Linux host where the user runs both Claude Code and a Chrome browser logged into claude.ai. The host runs a transparent TLS interception proxy ([lm-proxy](https://github.com/yi/lm-proxy)) bound to ports 80/443 of `127.0.0.1`, with selected hostnames routed there via `/etc/hosts`. The proxy:

1. Terminates inbound TLS using a leaf certificate signed by a local CA generated on first run.
2. Decrypts the HTTP request + response and writes both to `logs/http-audit.jsonl`.
3. Re-establishes a fresh outbound TLS connection to the **real** upstream (real DNS, real cert verification).
4. Pipes bytes back to the client.

This is MITM **only on the user's own machine for the user's own traffic** — the CA was generated and trusted locally, the proxy is not a remote service, and the captured accounts are owned by the user. No third-party traffic was intercepted.

### What's intercepted

- `api.anthropic.com` — Claude Code CLI traffic (including the STT WebSocket)
- `claude.ai` — Claude.ai web app traffic (including the voice WebSocket and sound-effect MP3s)
- `a-api.anthropic.com`, `mcp-proxy.anthropic.com`, `assets-proxy.anthropic.com` and CDN hostnames — auxiliary

### What's NOT captured

- **Server → client WS frames after the 101 upgrade.** lm-proxy's HTTP audit only logs the upgrade response (status + headers); it does not buffer post-upgrade frames in the server-to-client direction. The TLS access log shows the byte count (e.g. *"909 bytes server→client over 15 seconds"*) but the bytes themselves are streamed straight through and not retained.
- **Decompressed text frames** when `permessage-deflate` is active (claude.ai voice). The captured base64 contains the raw deflated bytes.

## 2. Binary inspection

For Claude Code CLI specifically, the bundled JS is recoverable via `strings` on the SEA binary:

```bash
BIN=/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
strings -n 6 "$BIN" | grep -E "voice_stream|speech_to_text|stt_provider|TranscriptText|TranscriptEndpoint"
```

The binary is a Node Single Executable Application (~220 MB). The compiled JS bundle is embedded as a packaged blob and shows up readably in a strings dump because identifiers and string literals are preserved through Node SEA packaging.

Functions of interest in the dump:

- `ej8` — the `connectVoiceStream` implementation (full WS lifecycle, message switch, finalize state machine)
- `mu6` — `isVoiceStreamAvailable` (checks OAuth token presence)
- `uu6` — `FINALIZE_TIMEOUTS_MS = { safety: 5000, noData: 1500 }`
- `WP4`, `w05`, `j05`, `J05` — constants (`KeepAlive` text, `CloseStream` text, endpoint path, 8 s interval)

The minified identifiers are stable enough across versions that re-running `strings` on a future build should find the same functions with light renaming.

## 3. Cross-checking captures vs. source

Where possible, we cross-checked:

| claim | observed in wire capture | observed in JS source |
|---|---|---|
| WS path `/api/ws/speech_to_text/voice_stream` | ✅ in URL | ✅ as constant `j05` |
| Query param `stt_provider=deepgram-nova3` | ✅ in URL | ✅ as `URLSearchParams` literal |
| `{"type":"KeepAlive"}` text frame | ✅ 2 frames observed | ✅ as constant `WP4` |
| `{"type":"CloseStream"}` text frame | ✅ 1 frame observed | ✅ as constant `w05` |
| 8-second keepalive interval | ✅ matches inter-frame timing | ✅ as constant `J05 = 8000` |
| Server message types `TranscriptText`, `TranscriptEndpoint`, `TranscriptError`, `error` | ❌ not in capture (server bytes not buffered) | ✅ in message-handler `switch` |
| Linear16 PCM @ 16 kHz mono | ✅ frame sizes consistent (89 ms avg) | ✅ as URL params |

So everything **client→server** is double-confirmed; server→client message types come from the source only.

## 4. Redactions

The following identifiers have been redacted in this repo:

| original | replaced with |
|---|---|
| OAuth access token (`sk-ant-oat01-…`) | `sk-ant-oat01-...` |
| Cookie values (`anthropic-device-id`, `__cf_bm`, `_cfuvid`, session) | omitted |
| Organization ID (`7cad1e03-…`) | `{orgId}` |
| Conversation IDs (`202f1245-…`, `c8422b61-…`, `f4f13e6c-…`) | `{convId}` |
| CF-RAY trace IDs | as-captured (not sensitive) |
| `request-id` (`req_011CasC4b2TSXommSUjdHYGH`) | as-captured (server-side trace ID) |
| User timezone (`Asia/Jakarta`) | kept as an example of the captured value |

User-side IPs were `::ffff:127.0.0.1` (the proxy is local) or `::ffff:10.0.1.123` (the host's LAN address — not externally routable).

## 5. Reproducing

To reproduce or extend on your own machine:

1. Stand up an SSL-intercepting proxy ([lm-proxy](https://github.com/yi/lm-proxy), mitmproxy, Charles, Burp, …) and trust its CA on the system running Claude Code / a browser.
2. For Claude Code: ensure `api.anthropic.com` resolves to the proxy IP (`/etc/hosts` pin, since OS-level DNS doesn't catch every resolver path).
3. For Claude.ai: same for `claude.ai`. The browser must trust the CA — install it into the OS keychain *and* the Chromium NSS store (`certutil -d sql:$HOME/.pki/nssdb -A -t "CT,c,c" -n local-ca -i ca.crt`).
4. Open Claude Code, run `/voice`, hold Space, speak. Or open claude.ai → start a conversation → toggle voice mode.
5. Trawl the proxy logs for `speech_to_text` (CLI) or `/api/ws/voice/` (web).

To decode WebSocket frames from base64-captured bytes, the parser in this repo's `claude-ai-voice.md` is reusable — handles unmasking and `permessage-deflate` is a one-additional-step inflater on text frames.
