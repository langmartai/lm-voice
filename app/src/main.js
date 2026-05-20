'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, BrowserView, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');

// ── Silent crash logging ────────────────────────────────────────────────────
// Suppress Electron's modal error dialogs and write all exceptions, unhandled
// rejections, and renderer-process crashes to ~/.lm-voice/errors.log. Tail it
// to debug instead of dismissing pop-ups.
const ERROR_LOG = path.join(os.homedir(), '.lm-voice', 'errors.log');
const BRIEF_LOG = path.join(os.homedir(), '.lm-voice', 'briefing.log');
try { fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true }); } catch {}
function logError(label, err) {
  try {
    const line = `[${new Date().toISOString()}] ${label}\n  ${err?.stack || err?.message || err}\n`;
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
  try { console.error(label, err?.stack || err?.message || err); } catch {}
}
// Briefing-pipeline trace log so we can see exactly which stage the briefing
// flow reaches on each hotkey press: OCR → SID → context load → agent → TTS.
function logBrief(label, detail) {
  try {
    const t = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const d = detail == null ? '' : (typeof detail === 'object' ? JSON.stringify(detail) : String(detail));
    fs.appendFileSync(BRIEF_LOG, `[${t}] ${label}${d ? '  ' + d : ''}\n`);
  } catch {}
}
process.on('uncaughtException', (err) => {
  // EPIPE on stdout/stderr happens when the parent process closes the pipe
  // (e.g. when we're launched via Start-Process with redirected stdio and the
  // log file is unlinked). It's harmless — swallow silently.
  if (err && err.code === 'EPIPE') return;
  logError('uncaughtException', err);
});
process.on('unhandledRejection', (err) => logError('unhandledRejection', err));
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
// Suppress Electron's "Object has been destroyed" and similar default dialogs.
if (app.commandLine) app.commandLine.appendSwitch('disable-features', 'DialogConfirmedTimings');
// dialog.showErrorBox is what triggers the modal pop-up. Replace it with the
// silent logger so any code-path that still calls it just writes to the file.
const _origShowErrorBox = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, content) => {
  logError(`dialog.showErrorBox: ${title}`, new Error(content));
};

const cfg = require('./lib/config');
const { readClaudeOAuthToken } = require('./lib/oauth');
const { STTClient } = require('./lib/stt-client');
const { SupertonicTTS } = require('./lib/tts-client');
const { LMAssistClient } = require('./lib/lm-assist-client');
const { Hotkey } = require('./lib/hotkey');
const { buildAgentPrompt, cleanForTTS } = require('./lib/agent-prompt');
const history = require('./lib/history');
const voiceIntent = require('./lib/voice-intent');
const { SessionWatcher, speakStatus } = require('./lib/session-watcher');
const { AmbientLog, SessionDeltaWatcher, ScreenshotOcrWatcher, captureScreenPng, normalizeOcrText, extractSidFromText, extractSidFromImage, extractSidFuzzy } = require('./lib/awareness');
const { VoiceApiServer } = require('./lib/api-server');
const { wavTo16kMonoPcm } = require('./lib/wav-utils');
const { VOICES, resolveVoiceId, describeVoice, listForSpeech } = require('./lib/voices');
const { synthesizeMarkupToWav, stripMarkup } = require('./lib/tts-markup');
const { WorldState } = require('./lib/world-state');
const { MultiHostMonitor } = require('./lib/multi-host-monitor');
const { MetaCache } = require('./lib/meta-cache');
const { discoverHosts, probeHealthViaSsh } = require('./lib/host-discovery');
const { ClaudeAiBridge } = require('./lib/claude-ai-bridge');

let config = cfg.load();
// One-shot migration: switch the legacy RIGHT CTRL default to LEFT CTRL.
// Users who picked another key explicitly keep their choice.
if (config.hotkey?.pushToTalk === 'RIGHT CTRL') {
  config = cfg.update({ hotkey: { pushToTalk: 'LEFT CTRL' } });
}
let tray = null;
let popupWindow = null;
let pickerWindow = null;
let hostsWindow = null;
let hotkey = null;
let stt = null;
let tts = null;
let lmAssist = null;
let watcher = null;
let ambient = null;
let sessionDelta = null;
let screenOcr = null;
let apiServer = null;
let worldState = null;
let multiHost = null;
let metaCache = null;
let claudeAiBridge = null;
let claudeAiWindow = null;
let claudeAiBrowser = null;
let claudeAiViews = { claudeAi: null, conversation: null, active: 'claude-ai' };
const CLAUDE_AI_TAB_BAR_HEIGHT = 36;
// True when we auto-started screenOcr on popup show — so we know whether to
// stop it on popup hide. If the user explicitly enabled OCR in config, we
// leave it running regardless of popup visibility.
let screenOcrAutoStarted = false;
let recording = false;
// Claude Code sessionIds the voice agent itself owns — used to filter watcher
// notifications so our own session resumes don't trigger "another session has
// new activity" spam.
const knownVoiceSessions = new Set();

// lm-assist executionIds the voice agent has spawned. Watcher notifications
// for any of these are silenced so the user doesn't see a bubble for every
// agent call they just made. Entries auto-expire after 2 minutes.
const knownOurExecutions = new Set();
function trackOurExecution(execId) {
  if (!execId) return;
  knownOurExecutions.add(execId);
  setTimeout(() => knownOurExecutions.delete(execId), 120_000).unref?.();
}

function rememberHeldVoiceSession(endpoint, sessionId) {
  if (!endpoint || !sessionId) return;
  const sessions = { ...(config.voiceAgent?.sessions ?? {}), [endpoint]: sessionId };
  // Append to allSessions (dedup, cap 200 newest) so the ambient watcher
  // never picks up any historical voice-agent session as "user activity".
  const prevAll = Array.isArray(config.voiceAgent?.allSessions) ? config.voiceAgent.allSessions : [];
  const allSessions = [sessionId, ...prevAll.filter((s) => s !== sessionId)].slice(0, 200);
  config = cfg.update({ voiceAgent: { sessions, allSessions } });
  knownVoiceSessions.add(sessionId);
  if (sessionDelta) sessionDelta.addExclude(sessionId);
}

function clearHeldVoiceSession(endpoint) {
  const sessions = { ...(config.voiceAgent?.sessions ?? {}) };
  const old = sessions[endpoint];
  if (old) {
    knownVoiceSessions.delete(old);
    // cfg.update uses deep-merge, so `delete` would be lost — write null
    // (which our read-site treats as "no held session" via `|| null`).
    sessions[endpoint] = null;
    config = cfg.update({ voiceAgent: { sessions } });
  }
}
let oauthToken = null;

// --- popup window --- //
function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 500,
    height: 440,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    focusable: true,
    minWidth: 360,
    minHeight: 240,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Popup stays hidden but still owns the mic worklet + TTS playback —
      // disable Chromium's hidden-window throttling so audio doesn't stutter.
      backgroundThrottling: false,
    },
  });
  popupWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Drop any cached HTML/JS/CSS from previous launches so renderer edits
  // always take effect on next start. Local file:// loads should never be
  // memoised across versions.
  try { popupWindow.webContents.session.clearCache(); } catch {}
  popupWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Log renderer console errors + crashes silently instead of pop-ups.
  popupWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) logError('popup renderer', new Error(`${src || ''}:${line}  [${level}]  ${msg}`));
  });
  popupWindow.webContents.on('render-process-gone', (_e, details) => {
    logError('popup render-process-gone', new Error(JSON.stringify(details)));
    // Reload the popup so the tray + hotkey path stays functional even after
    // a renderer crash. Conversation history is lost (renderer-only state),
    // but the agent's history.jsonl on disk is intact.
    try {
      setTimeout(() => { try { popupWindow.reload(); } catch {} }, 200);
    } catch {}
  });
  popupWindow.webContents.on('did-fail-load', (_e, errCode, errDesc, url) => {
    logError('popup did-fail-load', new Error(`${errCode} ${errDesc} url=${url}`));
  });
  popupWindow.webContents.on('unresponsive', () => {
    logError('popup unresponsive', new Error('popup webContents unresponsive'));
  });
  popupWindow.on('blur', () => {
    if (popupWindow?.isVisible() && !config.ui.pinPopup) popupWindow.hide();
  });
  // First push as soon as the popup becomes visible so the world chips
  // populate immediately instead of waiting for the next 5-second tick.
  popupWindow.on('show', () => {
    try {
      pushRenderer('world-state', {
        world: worldState?.getSnapshot() ?? null,
        otherHosts: multiHost?.getSnapshot() ?? {},
        allHosts: metaCache?.listHosts() ?? [],
      });
    } catch {}
  });
  popupWindow.on('moved', () => {
    if (!popupWindow || popupWindow.isDestroyed()) return;
    const [x, y] = popupWindow.getPosition();
    config = cfg.update({ ui: { popupPosition: { x, y } } });
  });
  popupWindow.on('resized', () => {
    if (!popupWindow || popupWindow.isDestroyed()) return;
    const [w, h] = popupWindow.getSize();
    config = cfg.update({ ui: { popupSize: { w, h } } });
  });
  // While the popup is visible, keep an OCR loop running so we always know
  // the current Claude Code SID on screen. Polls at 12s (vs the 25s
  // background default) for snappier detection. Hidden → stop (if we
  // started it ourselves; respect user's explicit config toggle).
  popupWindow.on('show', () => { startScreenOcrForPopup(); });
  popupWindow.on('hide', () => { stopScreenOcrForPopup(); });
}

function startScreenOcrForPopup() {
  if (!ambient) return; // not initialised yet
  if (screenOcr) {
    // Already running (config-enabled). Just speed it up while popup is open.
    screenOcr.setIntervalMs(12000);
    return;
  }
  // Auto-start a fresh watcher
  screenOcr = new ScreenshotOcrWatcher({
    ambient,
    intervalMs: 12000,
    minDeltaChars: config.awareness?.screenOcr?.minDeltaChars ?? 60,
    lang: config.awareness?.screenOcr?.lang ?? 'eng',
    lmAssist,
  });
  screenOcr.on('error', (err) => console.error('OCR error:', err.message));
  screenOcr.on('sid-found', onScreenSidFound);
  screenOcr.start();
  screenOcrAutoStarted = true;
  logBrief('screenOcr.auto-start', { intervalMs: 12000 });
}

function stopScreenOcrForPopup() {
  if (!screenOcr) return;
  if (screenOcrAutoStarted) {
    screenOcr.stop();
    screenOcr = null;
    screenOcrAutoStarted = false;
    logBrief('screenOcr.auto-stop');
  } else {
    // User had it on already — leave it running, just slow back down.
    screenOcr.setIntervalMs(config.awareness?.screenOcr?.intervalMs ?? 25000);
  }
}

// Union of config.lmAssist.servers + endpoints we've ever picked sessions
// from (config.recentSessions[].endpoint) — covers the "I used 10.0.1.117
// via the API but never added it to servers" case so the multi-host monitor
// still watches it.
function _allKnownHosts(cfgObj) {
  const out = new Map();
  for (const s of cfgObj.lmAssist?.servers ?? []) {
    if (s?.url) out.set(s.url, { url: s.url, label: s.label || s.url });
  }
  for (const r of cfgObj.recentSessions ?? []) {
    if (r?.endpoint && !out.has(r.endpoint)) out.set(r.endpoint, { url: r.endpoint, label: r.endpoint });
  }
  // Always include the current endpoint
  const cur = cfgObj.lmAssist?.endpoint;
  if (cur && !out.has(cur)) out.set(cur, { url: cur, label: 'current' });
  return [...out.values()];
}

let _worldBroadcastTimer = null;
function startWorldStateBroadcaster() {
  if (_worldBroadcastTimer) return;
  const tick = async () => {
    if (!popupWindow || popupWindow.isDestroyed()) return;
    if (!popupWindow.isVisible()) return; // skip when hidden — nothing to render
    try {
      if (worldState) await worldState.refresh({ pinnedSessionId: config.session?.id ?? null });
    } catch {}
    cacheWorldSnapshot();
    pushRenderer('world-state', {
      world: worldState?.getSnapshot() ?? null,
      otherHosts: multiHost?.getSnapshot() ?? {},
      allHosts: metaCache?.listHosts() ?? [],
    });
    pushHostsWindow();
  };
  // Fire immediately, then every 5s
  tick().catch(() => {});
  _worldBroadcastTimer = setInterval(() => tick().catch(() => {}), 5000);
}

// Write-through the current world + multi-host snapshots into MetaCache so
// the next launch has instant world-state visible (and the cache becomes a
// historical record even when individual hosts go down).
function cacheWorldSnapshot() {
  if (!metaCache) return;
  try {
    const ws = worldState?.getSnapshot();
    if (ws?.host?.endpoint && ws.host.version) {
      metaCache.upsertHost(ws.host.endpoint, {
        version: ws.host.version,
        status: ws.host.status,
        hostname: ws.host.hostname,
      });
    }
    if (ws?.activeSession) {
      metaCache.upsertSession(ws.activeSession.sid, {
        host: ws.host.endpoint,
        cwd: ws.activeSession.cwd,
        lastModified: ws.activeSession.lastModified,
        numTurns: ws.activeSession.numTurns,
        summary: ws.activeSession.summary,
        label: ws.activeSession.label,
      });
    }
    for (const r of ws?.relatedSessions ?? []) {
      metaCache.upsertSession(r.sid, {
        host: ws.host.endpoint,
        cwd: r.cwd,
        lastModified: r.lastModified,
        numTurns: r.numTurns,
        label: r.label,
      });
    }
    const mh = multiHost?.getSnapshot() ?? {};
    for (const [url, snap] of Object.entries(mh)) {
      if (snap.health) {
        metaCache.upsertHost(url, {
          label: snap.label,
          version: snap.health.version,
          status: snap.health.status,
          hostname: snap.health.hostname,
        });
      } else if (snap.error) {
        metaCache.markHostError(url, new Error(snap.error));
      }
      metaCache.upsertSessionsFromHost(url, snap.sessions ?? []);
    }
  } catch {}
}

// Full discovery pass: scan session files for endpoint candidates + SSH info,
// probe each candidate, then for every reachable lm-assist enumerate its
// sessions and bulk-write them to the MetaCache. SSH-only hosts (no lm-assist
// on default port) are still recorded under an "ssh://" pseudo-URL so the
// agent can be told "yi@10.0.1.123 is reachable via SSH".
//
// Returns the raw discoverHosts result extended with:
//   additions      — new hosts that were merged into config.lmAssist.servers
//   remoteSessions — [{ url, count, error? }] one entry per reachable host
async function runDiscovery({ maxFiles = 200 } = {}) {
  const result = await discoverHosts({ maxFiles });

  // Persist reachable hosts + version info.
  if (metaCache) {
    for (const r of result.reachable) {
      metaCache.upsertHost(r.url, {
        version: r.version, status: r.status, hostname: r.hostname,
        discoveredAt: new Date().toISOString(),
      });
    }
    // Tag each direct-reachable host with the best SSH access record for the
    // same IP. Stored on the same entry so a single lookup gives both HTTP
    // endpoint and SSH access details.
    for (const r of result.reachable) {
      try {
        const u = new URL(r.url);
        const sshRec = result.sshTargets.find((s) => s.host === u.hostname);
        if (sshRec?.bestAccess) {
          metaCache.upsertHost(r.url, {
            access: sshRec.bestAccess,
            allAccesses: sshRec.accesses,
          });
        }
      } catch {}
    }
    // SSH-only entries (ssh://host) are written below per-target after the
    // SSH probe runs, so each entry reflects actual SSH verification state.
  }

  // SSH-based fallback probe — for every SSH target whose direct HTTP probe
  // to :3100 failed, try running `ssh <best-access> 'curl localhost:3100/health'`
  // using the access info harvested from session files. We DON'T filter out
  // hosts that responded on other ports (e.g. lm-proxy on :9998) — those
  // could still be running lm-assist on :3100 bound to localhost only.
  const lmAssistDirectHosts = new Set();
  for (const r of result.reachable) {
    try {
      const u = new URL(r.url);
      if (u.port === '3100') lmAssistDirectHosts.add(u.hostname);
    } catch {}
  }
  const sshProbeTargets = result.sshTargets.filter((s) => s.bestAccess && !lmAssistDirectHosts.has(s.host));
  const sshDiscovered = [];        // lm-assist reachable via SSH tunnel
  const sshOnlyHosts = [];          // SSH works but no lm-assist on remote
  const sshFailedHosts = [];        // SSH itself failed
  const SSH_CONCURRENCY = 4;
  let sshIdx = 0;
  await Promise.all(new Array(Math.min(SSH_CONCURRENCY, sshProbeTargets.length)).fill(0).map(async () => {
    while (sshIdx < sshProbeTargets.length) {
      const target = sshProbeTargets[sshIdx++];
      const r = await probeHealthViaSsh(target.bestAccess);
      const access = target.bestAccess;
      if (r.lmAssistOk) {
        // (1) lm-assist reachable via SSH tunnel — record under http://host:3100 with viaSsh
        sshDiscovered.push(r);
        const httpUrl = `http://${target.host}:3100`;
        if (metaCache) {
          metaCache.upsertHost(httpUrl, {
            version: r.version, status: r.status, hostname: r.hostname,
            access, viaSsh: true,
            discoveredAt: new Date().toISOString(),
          });
        }
      } else if (r.sshOk) {
        // (2) SSH worked, lm-assist not installed — record under ssh://host with full access
        sshOnlyHosts.push({ host: target.host, hostname: r.hostname, access });
        if (metaCache) {
          metaCache.upsertHost(`ssh://${target.host}`, {
            sshOnly: true,
            lmAssistInstalled: false,
            sshVerifiedAt: new Date().toISOString(),
            remoteHostname: r.hostname,
            access,
            allAccesses: target.accesses,         // every (user, key) pair observed in session files
            occurrences: target.occurrences,
          });
        }
      } else {
        // (3) SSH itself failed — record under ssh://host with last error
        sshFailedHosts.push({ host: target.host, error: r.error, access });
        if (metaCache) {
          metaCache.upsertHost(`ssh://${target.host}`, {
            sshOnly: true,
            lmAssistInstalled: false,
            sshVerifiedAt: null,
            sshLastError: r.error,
            sshLastTriedAt: new Date().toISOString(),
            access,
            allAccesses: target.accesses,
            occurrences: target.occurrences,
          });
        }
      }
    }
  }));

  // Enumerate /sessions on each direct-reachable host in parallel. lm-proxy /
  // other services that responded to /health but don't speak lm-assist's
  // session protocol will throw — we keep them in `result.reachable` for
  // visibility but exclude them from config so MultiHostMonitor doesn't keep
  // failing. (SSH-discovered hosts can't be queried over HTTP from here, so
  // we skip /sessions enumeration on them — a follow-up could ssh+curl
  // /sessions too, but the list response can be large.)
  const remoteSessions = [];
  await Promise.all(result.reachable.map(async (r) => {
    try {
      const client = new LMAssistClient({ endpoint: r.url });
      const resp = await client.listSessions();
      const sessions = resp?.data?.sessions ?? resp?.sessions ?? (Array.isArray(resp) ? resp : []);
      if (metaCache && Array.isArray(sessions)) metaCache.upsertSessionsFromHost(r.url, sessions);
      remoteSessions.push({ url: r.url, count: Array.isArray(sessions) ? sessions.length : 0, lmAssist: true });
    } catch (err) {
      remoteSessions.push({ url: r.url, count: 0, error: err.message, lmAssist: false });
    }
  }));

  // Merge into config ONLY endpoints that actually speak the lm-assist session
  // API. lm-proxy and other /health-responders get filtered out here.
  const lmAssistUrls = new Set(remoteSessions.filter((x) => x.lmAssist).map((x) => x.url));
  const have = new Set((config.lmAssist?.servers ?? []).map((s) => s.url));
  const additions = result.reachable
    .filter((r) => lmAssistUrls.has(r.url) && !have.has(r.url))
    .map((r) => ({ url: r.url, label: r.hostname || r.url }));
  if (additions.length) {
    const servers = [...(config.lmAssist?.servers ?? []), ...additions];
    config = cfg.update({ lmAssist: { servers } });
  }
  if (multiHost) multiHost.setServers(_allKnownHosts(config));

  return { ...result, additions, remoteSessions, sshDiscovered, sshOnlyHosts, sshFailedHosts };
}

function onScreenSidFound(evt) {
  const sid = evt?.sid;
  if (!sid) return;
  if (knownVoiceSessions.has(sid)) return; // don't track our own voice-agent sids
  lastKnownSid = sid;
  lastKnownSidAt = Date.now();
  logBrief('screen.sid-found', { sid });
  // Refresh world state so the agent always references the on-screen session.
  if (worldState) {
    worldState.refresh({ hintedSid: sid, pinnedSessionId: config.session?.id ?? null }).catch(() => {});
  }
}

function showPopupNearTray() {
  if (!popupWindow) return;
  if (!config.ui.showPopup) return;
  // Restore user-chosen size first, then prefer user-chosen position.
  if (config.ui.popupSize?.w && config.ui.popupSize?.h) {
    popupWindow.setSize(config.ui.popupSize.w, config.ui.popupSize.h);
  }
  if (config.ui.popupPosition && Number.isFinite(config.ui.popupPosition.x) && Number.isFinite(config.ui.popupPosition.y)) {
    popupWindow.setPosition(config.ui.popupPosition.x, config.ui.popupPosition.y);
  } else {
    const trayBounds = tray?.getBounds?.();
    const winBounds = popupWindow.getBounds();
    if (trayBounds && trayBounds.width > 0) {
      const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
      const y = Math.round(trayBounds.y - winBounds.height - 8);
      popupWindow.setPosition(Math.max(0, x), Math.max(0, y));
    }
  }
  popupWindow.showInactive();
}

function pushRenderer(channel, payload) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send(channel, payload);
  }
  if (hostsWindow && !hostsWindow.isDestroyed()) {
    hostsWindow.webContents.send(channel, payload);
  }
}

function setStatus(text, klass) {
  pushRenderer('status', { text, class: klass });
  if (tray) tray.setToolTip(`LM Voice — ${text}`);
}

// --- session management --- //
function setSession(session) {
  config = cfg.update({ session });
  pushRenderer('session-update', config.session);
  rebuildTrayMenu();
  if (watcher) watcher.setPinnedSession(config.session?.id ?? null);
}

function openSessionPicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.show();
    pickerWindow.focus();
    return;
  }
  pickerWindow = new BrowserWindow({
    width: 540,
    height: 460,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'LM Voice — Pick session',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  pickerWindow.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  pickerWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) logError('picker renderer', new Error(`${src || ''}:${line}  [${level}]  ${msg}`));
  });
  pickerWindow.webContents.on('render-process-gone', (_e, details) => {
    logError('picker render-process-gone', new Error(JSON.stringify(details)));
  });
  pickerWindow.once('ready-to-show', () => pickerWindow.show());
  pickerWindow.on('closed', () => { pickerWindow = null; });
}

ipcMain.handle('picker-get-state', () => ({
  endpoint: config.lmAssist.endpoint,
  servers: config.lmAssist.servers ?? [{ url: config.lmAssist.endpoint, label: 'local' }],
  recentSessions: config.recentSessions ?? [],
  currentSession: config.session ?? null,
  allHosts: metaCache?.listHosts() ?? [],
}));

ipcMain.handle('picker-fetch-sessions', async (_, endpoint) => {
  try {
    const probe = new LMAssistClient({ endpoint });
    const health = await probe.health().catch(() => null);
    const version = health?.data?.version ?? health?.version ?? null;
    const resp = await probe.listSessions();
    const sessions = resp?.data?.sessions ?? resp?.sessions ?? (Array.isArray(resp) ? resp : []);
    return { ok: true, sessions, version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('picker-add-server', (_, { url, label }) => {
  const list = [...(config.lmAssist.servers ?? [])];
  if (!list.find((s) => s.url === url)) {
    list.push({ url, label: label || url });
  }
  config = cfg.update({ lmAssist: { servers: list } });
  return config.lmAssist.servers;
});

ipcMain.handle('picker-remove-server', (_, url) => {
  const list = (config.lmAssist.servers ?? []).filter((s) => s.url !== url);
  config = cfg.update({ lmAssist: { servers: list } });
  return config.lmAssist.servers;
});

ipcMain.handle('picker-get-history', (_, sessionId) => {
  if (!sessionId) return [];
  try { return history.readSession(sessionId, { limit: 80 }); } catch { return []; }
});

ipcMain.on('picker-select', (_, choice) => {
  const endpointChanged = choice.endpoint && choice.endpoint !== config.lmAssist.endpoint;
  if (endpointChanged) {
    const servers = [...(config.lmAssist.servers ?? [])];
    if (!servers.find((s) => s.url === choice.endpoint)) {
      servers.push({ url: choice.endpoint, label: choice.endpoint });
    }
    config = cfg.update({ lmAssist: { endpoint: choice.endpoint, servers } });
    lmAssist = new LMAssistClient({ endpoint: config.lmAssist.endpoint });
    if (watcher) watcher.setClient(lmAssist);
    if (sessionDelta) sessionDelta.setClient(lmAssist);
    if (worldState) worldState.setClient(lmAssist, config.lmAssist.endpoint);
    if (multiHost) {
      multiHost.setServers(_allKnownHosts(config));
      multiHost.setCurrentEndpoint(config.lmAssist.endpoint);
    }
  }
  // Push to recentSessions (dedupe by sessionId+endpoint, cap 12)
  const key = `${config.lmAssist.endpoint}|${choice.id}`;
  const recent = (config.recentSessions ?? []).filter((r) => `${r.endpoint}|${r.id}` !== key);
  recent.unshift({
    endpoint: config.lmAssist.endpoint,
    id: choice.id,
    cwd: choice.cwd,
    label: choice.label,
    ts: new Date().toISOString(),
  });
  config = cfg.update({ recentSessions: recent.slice(0, 12) });

  setSession({ id: choice.id, cwd: choice.cwd, label: choice.label });
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});

ipcMain.on('picker-skip', () => {
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
});

ipcMain.on('popup-hide', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
});

ipcMain.on('popup-open-picker', () => {
  openSessionPicker();
});

ipcMain.on('popup-open-hosts', () => {
  openHostsWindow();
});

function openHostsWindow() {
  if (hostsWindow && !hostsWindow.isDestroyed()) {
    hostsWindow.show();
    hostsWindow.focus();
    return;
  }
  hostsWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'LM Voice — Hosts & Sessions',
    backgroundColor: '#14171f',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  try { hostsWindow.webContents.session.clearCache(); } catch {}
  hostsWindow.setMenuBarVisibility(false);
  hostsWindow.loadFile(path.join(__dirname, 'renderer', 'hosts.html'));
  hostsWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) logError('hosts renderer', new Error(`${src || ''}:${line}  [${level}]  ${msg}`));
  });
  hostsWindow.webContents.on('render-process-gone', (_e, details) => {
    logError('hosts render-process-gone', new Error(JSON.stringify(details)));
  });
  hostsWindow.once('ready-to-show', () => hostsWindow.show());
  hostsWindow.on('closed', () => { hostsWindow = null; });
}

function readClaudeAiSnippet() {
  try {
    return fs.readFileSync(path.join(__dirname, 'lib', 'claude-ai-page-bridge.userscript.js'), 'utf8');
  } catch (err) {
    logError('readClaudeAiSnippet', err);
    return null;
  }
}

function configureClaudeAiSession() {
  const { session } = require('electron');
  const sess = session.fromPartition('persist:lm-voice-claudeai');
  sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = details?.requestingUrl || '';
    if (/^https:\/\/claude\.ai/.test(origin) && (permission === 'media' || permission === 'microphone')) {
      return callback(true);
    }
    callback(false);
  });
  sess.setPermissionCheckHandler((_wc, permission, origin) => {
    if (/^https:\/\/claude\.ai/.test(origin) && (permission === 'media' || permission === 'microphone')) return true;
    return false;
  });
}

function layoutClaudeAiViews() {
  if (!claudeAiBrowser || claudeAiBrowser.isDestroyed()) return;
  const [w, h] = claudeAiBrowser.getContentSize();
  const bounds = {
    x: 0,
    y: CLAUDE_AI_TAB_BAR_HEIGHT,
    width: w,
    height: Math.max(0, h - CLAUDE_AI_TAB_BAR_HEIGHT),
  };
  for (const v of [claudeAiViews.claudeAi, claudeAiViews.conversation]) {
    if (v) try { v.setBounds(bounds); } catch {}
  }
}

function switchClaudeAiTab(name) {
  if (!claudeAiBrowser || claudeAiBrowser.isDestroyed()) return;
  const target = name === 'conversation' ? claudeAiViews.conversation : claudeAiViews.claudeAi;
  if (!target) return;
  try { claudeAiBrowser.removeBrowserView(claudeAiViews.claudeAi); } catch {}
  try { claudeAiBrowser.removeBrowserView(claudeAiViews.conversation); } catch {}
  claudeAiBrowser.addBrowserView(target);
  claudeAiViews.active = (name === 'conversation') ? 'conversation' : 'claude-ai';
  layoutClaudeAiViews();
  // Move keyboard focus onto the newly-active BrowserView's webContents so
  // its document-level keydown listeners (Space/Enter/Esc in the conversation
  // renderer) actually fire. Without this, the host shell keeps focus after
  // a tab-strip click and the renderer never sees the keypress.
  try { target.webContents.focus(); } catch {}
  try {
    claudeAiBrowser.webContents.send('claude-ai-browser:tab-state', { active: claudeAiViews.active });
  } catch {}
}

function openClaudeAiBrowser(navigateTo, tab) {
  if (claudeAiBrowser && !claudeAiBrowser.isDestroyed()) {
    claudeAiBrowser.show();
    claudeAiBrowser.focus();
    if (navigateTo && claudeAiViews.claudeAi) {
      try { claudeAiViews.claudeAi.webContents.loadURL(navigateTo); } catch {}
    }
    if (tab) switchClaudeAiTab(tab);
    return claudeAiBrowser;
  }
  configureClaudeAiSession();
  claudeAiBrowser = new BrowserWindow({
    width: 1200,
    height: 860,
    show: false,
    title: 'Claude.ai (LM Voice bridge)',
    backgroundColor: '#0f1219',
    webPreferences: {
      // Tab strip is local, so the host shell stays in the default partition.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  claudeAiBrowser.setMenuBarVisibility(false);
  claudeAiBrowser.loadFile(path.join(__dirname, 'renderer', 'browser-tabs.html'));

  const snippet = readClaudeAiSnippet();
  const injectSnippet = (wc) => {
    if (!snippet) return;
    try {
      const url = wc.getURL();
      if (!/^https:\/\/claude\.ai(\/|$)/.test(url)) return;
      wc.executeJavaScript(snippet, true).catch((err) => logError('claude-ai inject', err));
    } catch (err) {
      logError('claude-ai inject (sync)', err);
    }
  };

  const claudeAiView = new BrowserView({
    webPreferences: {
      partition: 'persist:lm-voice-claudeai',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  claudeAiView.setAutoResize({ width: true, height: true, horizontal: false, vertical: false });
  claudeAiView.webContents.on('did-finish-load', () => injectSnippet(claudeAiView.webContents));
  claudeAiView.webContents.on('did-navigate-in-page', () => injectSnippet(claudeAiView.webContents));
  claudeAiView.webContents.on('did-frame-finish-load', (_e, isMainFrame) => { if (isMainFrame) injectSnippet(claudeAiView.webContents); });
  claudeAiView.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) logError('claude-ai view console', new Error(`${src || ''}:${line}  [${level}]  ${msg}`));
  });
  claudeAiView.webContents.loadURL(navigateTo || 'https://claude.ai/');

  const conversationView = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  conversationView.setAutoResize({ width: true, height: true, horizontal: false, vertical: false });
  conversationView.webContents.loadFile(path.join(__dirname, 'renderer', 'claude-ai.html'));
  conversationView.webContents.on('did-finish-load', () => {
    try {
      conversationView.webContents.send('claude-ai:hydrate', {
        lastConvId: config.claudeAi?.lastConvId ?? null,
      });
    } catch {}
  });
  conversationView.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) logError('conversation view console', new Error(`${src || ''}:${line}  [${level}]  ${msg}`));
  });

  claudeAiViews = { claudeAi: claudeAiView, conversation: conversationView, active: 'claude-ai' };

  claudeAiBrowser.webContents.once('did-finish-load', () => {
    switchClaudeAiTab(tab || 'claude-ai');
    layoutClaudeAiViews();
  });
  claudeAiBrowser.on('resize', () => layoutClaudeAiViews());
  claudeAiBrowser.once('ready-to-show', () => claudeAiBrowser.show());
  claudeAiBrowser.on('closed', () => {
    claudeAiBrowser = null;
    claudeAiViews = { claudeAi: null, conversation: null, active: 'claude-ai' };
  });
  return claudeAiBrowser;
}

async function claudeAiBrowserGetUrl() {
  // Return the claude.ai BrowserView's URL — that's the user-visible one. The
  // host BrowserWindow's webContents is just the tab strip shell.
  const wc = claudeAiViews?.claudeAi?.webContents;
  if (!wc || wc.isDestroyed()) return null;
  try { return wc.getURL(); } catch { return null; }
}

async function claudeAiBrowserGetConvId() {
  const url = await claudeAiBrowserGetUrl();
  if (!url) return null;
  const m = url.match(/^https:\/\/claude\.ai\/chat\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

async function claudeAiBrowserExecuteJs(code) {
  if (!claudeAiBrowser || claudeAiBrowser.isDestroyed()) {
    return { ok: false, error: 'embedded browser not open' };
  }
  // Execute against the claude.ai BrowserView — that's where the logged-in
  // cookies / session live. The host window's webContents only renders the
  // tab strip and has no claude.ai cookies.
  const wc = claudeAiViews.claudeAi?.webContents || claudeAiBrowser.webContents;
  try { return await wc.executeJavaScript(code, true); }
  catch (e) { return { ok: false, error: e.message }; }
}

async function createConversationViaBrowser({ name = 'LM Voice session', model = 'claude-opus-4-7' } = {}) {
  const safeName = String(name).replace(/`/g, "'");
  const safeModel = String(model).replace(/`/g, "'");
  const code = `
    (async () => {
      const orgMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
      if (!orgMatch) return { ok: false, error: 'not logged in' };
      const org = decodeURIComponent(orgMatch[1]);
      const cookies = Object.fromEntries(document.cookie.split(';').map(p => {
        const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }));
      const headers = {
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
        'anthropic-client-sha':      '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
        'Content-Type': 'application/json',
        'Accept': '*/*',
      };
      if (cookies['anthropic-device-id']) headers['anthropic-device-id']    = cookies['anthropic-device-id'];
      if (cookies['ajs_anonymous_id'])    headers['anthropic-anonymous-id'] = cookies['ajs_anonymous_id'];
      if (cookies['activitySessionId'])   headers['x-activity-session-id']  = cookies['activitySessionId'];
      const uuid = crypto.randomUUID();
      const body = { uuid, name: \`${safeName}\`, model: \`${safeModel}\`, include_conversation_preferences: true };
      const r = await fetch(\`/api/organizations/\${org}/chat_conversations\`, {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify(body),
      });
      const t = await r.text(); let resp; try { resp = JSON.parse(t); } catch { resp = t; }
      return { ok: r.ok, status: r.status, org, uuid, response: resp };
    })()
  `;
  return claudeAiBrowserExecuteJs(code);
}

// Hotkey-triggered: bring the embedded claude.ai browser forward, switch to
// the Conversation tab, and start a new voice session if one isn't already
// open. The bridge needs the page snippet to be attached before it can drive
// the upstream; we wait for that briefly when the browser was just opened.
async function launchClaudeAiConversation() {
  const justOpened = !claudeAiBrowser || claudeAiBrowser.isDestroyed();
  openClaudeAiBrowser(null, 'conversation');
  try { claudeAiBrowser?.show(); claudeAiBrowser?.focus(); } catch {}

  // Wait for the page snippet to attach to the local bridge — it needs to
  // be ready before sendToPageText can open the upstream. Skip the wait if
  // the page is already attached.
  if (claudeAiBridge && !claudeAiBridge.status().pageAttached) {
    const deadline = Date.now() + (justOpened ? 8000 : 3000);
    while (Date.now() < deadline) {
      if (claudeAiBridge.status().pageAttached) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!claudeAiBridge?.status().pageAttached) {
    return { ok: false, error: 'page not attached after wait — log in to claude.ai inside the embedded browser first' };
  }
  // If an upstream is already open, leave it alone (don't disrupt a live
  // turn). Bringing the window forward is enough.
  if (claudeAiBridge.status().upstreamOpen) {
    return { ok: true, alreadyOpen: true };
  }
  // Otherwise create a fresh conversation and open the voice WS on it.
  const c = await createConversationViaBrowser({ name: 'LM Voice session', model: 'claude-opus-4-7' });
  if (!c?.ok) return { ok: false, step: 'create-conversation', error: c?.error || c };
  const openMsg = { _bridge: 'open', convId: c.uuid, voice: 'airy', language: 'en-US', autoStartMic: true };
  const sent = claudeAiBridge.sendToPageText(JSON.stringify(openMsg));
  if (!sent) return { ok: false, step: 'open-upstream', error: 'send to page failed', convId: c.uuid };
  return { ok: true, convId: c.uuid };
}

async function deleteConversationViaBrowser({ convId } = {}) {
  if (!convId) return { ok: false, error: 'convId is required' };
  const safeUuid = String(convId).replace(/[^a-f0-9-]/gi, '');
  const code = `
    (async () => {
      const orgMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
      if (!orgMatch) return { ok: false, error: 'not logged in' };
      const org = decodeURIComponent(orgMatch[1]);
      const cookies = Object.fromEntries(document.cookie.split(';').map(p => {
        const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }));
      const headers = {
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
        'anthropic-client-sha':      '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
        'Accept': '*/*',
      };
      if (cookies['anthropic-device-id']) headers['anthropic-device-id']    = cookies['anthropic-device-id'];
      if (cookies['ajs_anonymous_id'])    headers['anthropic-anonymous-id'] = cookies['ajs_anonymous_id'];
      if (cookies['activitySessionId'])   headers['x-activity-session-id']  = cookies['activitySessionId'];
      const url = \`/api/organizations/\${org}/chat_conversations/${safeUuid}\`;
      try {
        const r = await fetch(url, { method: 'DELETE', credentials: 'include', headers });
        const t = await r.text();
        return { ok: r.ok, status: r.status, body: t.slice(0, 200) };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    })()
  `;
  return claudeAiBrowserExecuteJs(code);
}

async function sendCompletionViaBrowser({ convId, prompt, model = 'claude-opus-4-7', timezone, locale = 'en-US' } = {}) {
  if (!convId) return { ok: false, error: 'convId is required' };
  if (typeof prompt !== 'string' || !prompt.length) return { ok: false, error: 'prompt is required' };
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const payload = JSON.stringify({ convId, prompt, model, timezone: tz, locale });
  const code = `
    (async () => {
      const req = ${payload};
      const orgMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
      if (!orgMatch) return { ok: false, error: 'not logged in' };
      const org = decodeURIComponent(orgMatch[1]);
      const cookies = Object.fromEntries(document.cookie.split(';').map(p => {
        const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }));
      const headers = {
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
        'anthropic-client-sha':      '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      };
      if (cookies['anthropic-device-id']) headers['anthropic-device-id']    = cookies['anthropic-device-id'];
      if (cookies['ajs_anonymous_id'])    headers['anthropic-anonymous-id'] = cookies['ajs_anonymous_id'];
      if (cookies['activitySessionId'])   headers['x-activity-session-id']  = cookies['activitySessionId'];

      let parentMessageUuid = null;
      try {
        const c = await fetch(\`/api/organizations/\${org}/chat_conversations/\${req.convId}\`, {
          credentials: 'include', headers: { ...headers, 'Accept': '*/*' },
        });
        const cj = await c.json();
        parentMessageUuid = cj?.current_leaf_message_uuid || null;
      } catch {}

      const humanMessageUuid = crypto.randomUUID();
      const assistantMessageUuid = crypto.randomUUID();
      const body = {
        prompt: req.prompt,
        timezone: req.timezone,
        personalized_styles: [{ key: 'Default', name: 'Normal', type: 'default', prompt: '', summary: '' }],
        locale: req.locale,
        model: req.model,
        tools: [],
        turn_message_uuids: { human_message_uuid: humanMessageUuid, assistant_message_uuid: assistantMessageUuid },
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: 'messages',
        parent_message_uuid: parentMessageUuid,
      };
      const url = \`/api/organizations/\${org}/chat_conversations/\${req.convId}/completion\`;
      const r = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      if (!r.ok) {
        const t = await r.text();
        return { ok: false, status: r.status, body: t.slice(0, 400) };
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let text = '';
      const events = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\\n\\n')) !== -1 || (idx = buf.indexOf('\\r\\n\\r\\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + (buf[idx] === '\\r' ? 4 : 2));
          for (const line of chunk.split(/\\r?\\n/)) {
            if (!line.startsWith('data:')) continue;
            const json = line.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            try {
              const ev = JSON.parse(json);
              events.push(ev.type);
              if (ev.type === 'content_block_delta' && ev.delta?.text) text += ev.delta.text;
            } catch {}
          }
        }
      }
      return { ok: true, status: 200, text, humanMessageUuid, assistantMessageUuid, parentMessageUuid, eventCount: events.length, eventTypes: events };
    })()
  `;
  return claudeAiBrowserExecuteJs(code);
}

function openClaudeAiWindow() {
  // Conversation UI is now a tab inside the embedded browser. Open the browser
  // and switch to the conversation tab.
  openClaudeAiBrowser(null, 'conversation');
}

function openClaudeAiWindowStandalone_DEPRECATED() {
  if (claudeAiWindow && !claudeAiWindow.isDestroyed()) {
    claudeAiWindow.show();
    claudeAiWindow.focus();
    return;
  }
  claudeAiWindow = new BrowserWindow({
    width: 720,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: 'LM Voice — Claude.ai voice',
    backgroundColor: '#14171f',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  try { claudeAiWindow.webContents.session.clearCache(); } catch {}
  claudeAiWindow.setMenuBarVisibility(false);
  claudeAiWindow.loadFile(path.join(__dirname, 'renderer', 'claude-ai.html'));
  claudeAiWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    if (level >= 2) logError('claude-ai renderer', new Error(`${src || ''}:${line}  [${level}]  ${msg}`));
  });
  claudeAiWindow.once('ready-to-show', () => {
    claudeAiWindow.show();
    try {
      claudeAiWindow.webContents.send('claude-ai:hydrate', {
        lastConvId: config.claudeAi?.lastConvId ?? null,
      });
    } catch {}
  });
  claudeAiWindow.on('closed', () => { claudeAiWindow = null; });
}

function pushHostsWindow() {
  if (!hostsWindow || hostsWindow.isDestroyed()) return;
  hostsWindow.webContents.send('hosts-window-state', {
    allHosts: metaCache?.listHosts() ?? [],
    otherHosts: multiHost?.getSnapshot() ?? {},
    currentEndpoint: config.lmAssist.endpoint,
  });
}

ipcMain.on('claude-ai-browser:switch-tab', (_, name) => switchClaudeAiTab(name));
ipcMain.on('claude-ai-browser:ready', () => {
  try {
    claudeAiBrowser?.webContents.send('claude-ai-browser:tab-state', { active: claudeAiViews.active });
  } catch {}
});
ipcMain.on('claude-ai-browser:reload-claude-ai', () => {
  const wc = claudeAiViews?.claudeAi?.webContents;
  if (wc && !wc.isDestroyed()) {
    try { wc.reload(); } catch (err) { logError('claude-ai reload', err); }
  }
});

ipcMain.handle('claude-ai:get-page-snippet', async () => {
  try {
    const p = path.join(__dirname, 'lib', 'claude-ai-page-bridge.userscript.js');
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    logError('claude-ai:get-page-snippet', err);
    return null;
  }
});

ipcMain.handle('claude-ai:bridge-status', () => claudeAiBridge?.status() ?? null);

ipcMain.handle('hosts-window-get-state', () => ({
  allHosts: metaCache?.listHosts() ?? [],
  otherHosts: multiHost?.getSnapshot() ?? {},
  currentEndpoint: config.lmAssist.endpoint,
  world: worldState?.getSnapshot() ?? null,
  session: config.session ?? null,
  engineEvents: ambient?.peek() ?? [],
}));

ipcMain.handle('hosts-window-discover', async () => {
  const result = await runDiscovery({ maxFiles: 200 });
  pushHostsWindow();
  return result;
});

ipcMain.on('hosts-window-close', () => {
  if (hostsWindow && !hostsWindow.isDestroyed()) hostsWindow.close();
});

// Fetch the last N messages of a session from the host that owns it. The
// hosts window already knows which host each session belongs to (we wired
// `_host` onto each session record when shaping the list), but here we just
// try every monitored host and pick whichever one responds.
ipcMain.handle('hosts-window-fetch-conversation', async (_, sessionId) => {
  if (!sessionId) return { ok: false, error: 'no sessionId' };
  const mh = multiHost?.getSnapshot() ?? {};
  // Find the host that lists this sessionId.
  let targetUrl = null;
  for (const [url, snap] of Object.entries(mh)) {
    const has = (snap.sessions ?? []).some((s) => (s.sessionId ?? s.id) === sessionId);
    if (has) { targetUrl = url; break; }
  }
  if (!targetUrl) targetUrl = config.lmAssist.endpoint; // fall back to current endpoint
  try {
    const client = new LMAssistClient({ endpoint: targetUrl });
    const conv = await client.getConversation(sessionId, { lastN: 80, toolDetail: 'summary' });
    // Normalise to a flat list. The renderer needs to distinguish three
    // kinds: 'user', 'assistant', 'tool'. lm-assist's tool entries arrive
    // either as `role:'tool'` or as assistant messages with content blocks
    // of {type:'tool_use'|'tool_result'} — pick out the tool name so the
    // renderer can collapse consecutive tool calls into one summary row.
    const raw = conv?.data?.messages ?? conv?.messages ?? conv?.data?.conversation ?? conv?.conversation ?? [];
    const messages = (Array.isArray(raw) ? raw : []).map((m) => {
      const role = m.role || m.type || m.who || 'msg';
      let kind = role;
      let text = '';
      let toolName = null;
      let toolNames = [];   // list when an assistant turn fires multiple tools

      // --- detect lm-assist's tool-call summary format ---
      // Shape: role='assistant', content='[N tool call(s)]', toolCalls=<string|array>
      const contentStr = typeof m.content === 'string' ? m.content : '';
      const tcRaw = m.toolCalls;
      const isToolSummary =
        (tcRaw != null && tcRaw !== '' && tcRaw !== '[]') ||
        /^\s*\[\d+\s+tool\s+call\(s\)\]/i.test(contentStr);

      if (isToolSummary) {
        kind = 'tool_use';
        // toolCalls may be a JSON string, a Python-repr string, or an array.
        // Regex out every `'name':'X'` or `"name":"X"` rather than parse.
        const tcStr = typeof tcRaw === 'string' ? tcRaw : JSON.stringify(tcRaw ?? '');
        for (const mm of tcStr.matchAll(/['"]name['"]\s*:\s*['"]([^'"]+)['"]/g)) {
          toolNames.push(mm[1]);
        }
        toolName = toolNames[0] || 'tool';
        text = toolNames.length
          ? toolNames.join(' · ')
          : contentStr.replace(/^\s*\[\d+\s+tool\s+call\(s\)\]\s*/i, '').trim();
        return { role, kind, text, toolName, toolNames };
      }

      // --- fallback to richer content-block parsing (older lm-assist shapes) ---
      if (Array.isArray(m.content)) {
        const tu = m.content.find((c) => c && c.type === 'tool_use');
        const tr = m.content.find((c) => c && c.type === 'tool_result');
        if (tu) {
          kind = 'tool_use';
          toolName = tu.name || tu.tool || 'tool';
          toolNames = [toolName];
          text = typeof tu.input === 'string' ? tu.input
               : tu.input ? Object.entries(tu.input).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v).slice(0, 80)}`).join(' ')
               : '';
        } else if (tr) {
          kind = 'tool_result';
          toolName = tr.toolName || tr.tool || tr.name || null;
          const content = tr.content ?? tr.summary ?? tr.text ?? '';
          text = typeof content === 'string' ? content
               : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join(' ')
               : String(content);
        } else {
          text = m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n').trim();
        }
      } else if (typeof m.content === 'string') {
        text = m.content;
      } else if (typeof m.text === 'string') {
        text = m.text;
      } else {
        text = String(m.summary ?? m.preview ?? '');
      }

      if (role === 'tool') kind = 'tool_result';

      return { role, kind, text, toolName, toolNames };
    });
    return { ok: true, host: targetUrl, messages };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Switch to a specific session (and its host) — wire through the same path
// that the picker uses.
// Refresh world-state right after an endpoint/session swap so the new state
// is on screen within ~200 ms instead of waiting for the 5-second world tick.
async function _afterEndpointSwap() {
  try {
    if (worldState) await worldState.refresh({ pinnedSessionId: config.session?.id ?? null });
  } catch {}
  cacheWorldSnapshot();
  pushRenderer('world-state', {
    world: worldState?.getSnapshot() ?? null,
    otherHosts: multiHost?.getSnapshot() ?? {},
    allHosts: metaCache?.listHosts() ?? [],
  });
  pushHostsWindow();
}

ipcMain.on('hosts-select-session', async (_, { id, endpoint }) => {
  if (!id) return;
  const endpointChanged = endpoint && endpoint !== config.lmAssist.endpoint;
  if (endpointChanged) {
    const servers = [...(config.lmAssist.servers ?? [])];
    if (!servers.find((s) => s.url === endpoint)) servers.push({ url: endpoint, label: endpoint });
    config = cfg.update({ lmAssist: { endpoint, servers } });
    lmAssist = new LMAssistClient({ endpoint: config.lmAssist.endpoint });
    if (watcher) watcher.setClient(lmAssist);
    if (sessionDelta) sessionDelta.setClient(lmAssist);
    if (worldState) worldState.setClient(lmAssist, config.lmAssist.endpoint);
    if (multiHost) {
      multiHost.setServers(_allKnownHosts(config));
      multiHost.setCurrentEndpoint(config.lmAssist.endpoint);
    }
  }
  setSession({ id, cwd: null, label: null });
  await _afterEndpointSwap();
});

ipcMain.on('hosts-select-endpoint', async (_, url) => {
  if (!url || url === config.lmAssist.endpoint) return;
  const servers = [...(config.lmAssist.servers ?? [])];
  if (!servers.find((s) => s.url === url)) servers.push({ url, label: url });
  config = cfg.update({ lmAssist: { endpoint: url, servers } });
  lmAssist = new LMAssistClient({ endpoint: config.lmAssist.endpoint });
  if (watcher) watcher.setClient(lmAssist);
  if (sessionDelta) sessionDelta.setClient(lmAssist);
  if (worldState) worldState.setClient(lmAssist, config.lmAssist.endpoint);
  if (multiHost) {
    multiHost.setServers(_allKnownHosts(config));
    multiHost.setCurrentEndpoint(config.lmAssist.endpoint);
  }
  await _afterEndpointSwap();
});

// Text-input path: same downstream as a voice transcript (intent classifier
// first, then handleVoiceIntent or runAgent). No OCR / briefing flow — the
// user explicitly typed something, we don't need to guess.
ipcMain.on('text-input', async (_, text) => {
  const transcript = String(text || '').trim();
  if (!transcript) return;
  // Stop any ongoing TTS so the new turn isn't talked over.
  pushRenderer('stop-wav');
  briefingAborted = true;
  // Lock the input while we process so the user can't queue another
  // before this one resolves (also keeps the agent's held session sane).
  pushRenderer('input-busy', true);
  // (Downstream handleVoiceIntent / executeAgentTurn each log the user turn
  // to history.jsonl, so we don't repeat it here.)
  try {
    const intent = voiceIntent.detect(transcript);
    if (intent) {
      await handleVoiceIntent(intent, transcript);
    } else {
      await runAgent(transcript);
    }
  } catch (err) {
    setStatus(`Text-input error: ${err.message}`, 'error');
    logError('text-input', err);
  } finally {
    pushRenderer('input-busy', false);
  }
});

ipcMain.on('popup-toggle-pin', () => {
  const next = !config.ui.pinPopup;
  config = cfg.update({ ui: { pinPopup: next } });
  pushRenderer('popup-pin-state', { pinned: next });
  rebuildTrayMenu();
});

ipcMain.handle('popup-get-pin-state', () => ({ pinned: !!config.ui.pinPopup }));

// TTS pause/resume relay. Audio actually plays in the popup renderer, but the
// user controls it from the hosts window (or anywhere). Main just forwards
// the request to every renderer so audio (popup) and karaoke (hosts) stay
// in sync. tts-ended is the popup telling main playback finished naturally,
// which we then mirror to hosts so it can clear its `playing` flag.
ipcMain.on('tts-pause-req', () => pushRenderer('tts-pause'));
ipcMain.on('tts-resume-req', () => pushRenderer('tts-resume'));
ipcMain.on('tts-ended', () => pushRenderer('tts-ended'));

function shortLabel(s) {
  return s.label || s.title || s.cwd?.split(/[\\/]/).pop() || (s.id ?? s.sessionId)?.slice(0, 8) || 'session';
}

// --- core flow --- //
async function onHotkeyPress() {
  if (recording) return;
  logBrief('press', { ts: Date.now() });
  // Hotkey press always silences any ongoing TTS — lets the user interrupt a
  // briefing mid-sentence and take over.
  pushRenderer('stop-wav');
  recording = true;
  briefingAborted = false;
  setStatus('Listening', 'listening');
  // The small popup is the legacy recording surface — keep it hidden. The
  // user sees everything in the Hosts & Sessions window's Conversation tab,
  // so open that one instead if it isn't already up.
  if (!hostsWindow || hostsWindow.isDestroyed() || !hostsWindow.isVisible()) {
    openHostsWindow();
  }
  // Start a fresh interim bubble for this turn — but don't wipe prior history.
  pushRenderer('transcript', { text: '', isFinal: false });
  // Kick off a screen capture + OCR + SID extraction in parallel with STT.
  pressTimeOcr = _captureScreenAndFindSid();
  // Refresh the world-state snapshot (host / project / active session /
  // running executions) so by the time the user finishes speaking we have
  // an up-to-date picture for the agent prompt.
  if (worldState) worldState.refresh({ pinnedSessionId: config.session?.id ?? null }).catch(() => {});

  // Auto-briefing: as soon as OCR resolves and we find a SID, fetch its
  // context and run the agent → speak the result. The user hears this while
  // still holding the key. If they say anything substantial, onHotkeyRelease
  // sets briefingAborted = true so we stop pushing audio.
  briefingTask = (async () => {
    const taskT0 = Date.now();
    logBrief('press.brief.task.start');
    let ocrResult;
    try {
      ocrResult = await Promise.race([
        pressTimeOcr,
        new Promise((r) => setTimeout(() => r(null), 6000)),
      ]);
    } catch (err) {
      logBrief('press.brief.ocr.threw', { error: err.message });
      return;
    }
    let sid = ocrResult?.sid ?? null;
    // Sticky-cache fallback: if this capture missed the SID but we saw one
    // recently, use that instead so a transient occlusion doesn't kill the
    // briefing.
    let cached = false;
    if (!sid && lastKnownSid && (Date.now() - lastKnownSidAt) < SID_STICKY_MS) {
      sid = lastKnownSid;
      cached = true;
    }
    logBrief('press.brief.ocr.resolved', { sid, cached, ms: Date.now() - taskT0 });
    if (!sid) {
      logBrief('press.brief.abort', { reason: 'no-sid-and-no-cache' });
      setStatus('No session id found on screen', 'error');
      return;
    }
    if (briefingAborted) { logBrief('press.brief.abort', { reason: 'aborted-before-context' }); return; }

    setStatus(`Found session ${sid.slice(0, 8)}${cached ? ' (cached)' : ''}`, 'thinking');
    setStatus('Loading session context…', 'thinking');
    try { await loadScreenSessionContext(sid); }
    catch (err) { logBrief('press.brief.context.threw', { error: err.message }); }
    if (briefingAborted) { logBrief('press.brief.abort', { reason: 'aborted-before-agent' }); return; }

    setStatus('Briefing — asking the agent…', 'thinking');
    pushRenderer('transcript', { text: `(briefing on session ${sid.slice(0, 8)}…)`, isFinal: true });

    logBrief('press.brief.agent.start', { sid });
    const agentT0 = Date.now();
    try {
      const r = await executeAgentTurn(
        `Brief me in 2 to 3 sentences on what is happening in the Claude Code session shown on my screen (SID ${sid}). Use the recent turns provided in the ambient context. Be specific about the last action and the most sensible next step.`
      );
      logBrief('press.brief.agent.done', { ms: Date.now() - agentT0, replyLen: (r?.reply || '').length });
      if (briefingAborted) { logBrief('press.brief.abort', { reason: 'aborted-after-agent' }); return; }
      const reply = r?.reply ?? '';
      if (reply && reply.trim()) {
        logBrief('press.brief.speak.start', { chars: reply.length });
        await speak(reply);
        logBrief('press.brief.speak.done', { totalMs: Date.now() - taskT0 });
      } else {
        logBrief('press.brief.empty-reply');
      }
    } catch (err) {
      logBrief('press.brief.agent.error', { error: err.message, stack: (err.stack || '').slice(0, 400) });
      if (!briefingAborted) {
        try { await speak(`Couldn't load the session briefing: ${err.message.slice(0, 80)}`); } catch {}
      }
    }
  })().catch((e) => { logBrief('press.brief.task.unhandled', { error: e?.message }); });

  try {
    if (!oauthToken) oauthToken = readClaudeOAuthToken();
  } catch (err) {
    setStatus(`Auth error: ${err.message}`, 'error');
    recording = false;
    return;
  }

  stt = new STTClient({
    token: oauthToken,
    language: config.stt.language,
    keyterms: [
      ...(config.stt.keyterms ?? []),
      ...(config.session.label ? [config.session.label] : []),
    ],
  });

  lastFinalTranscript = '';
  stt.on('transcript', (text, isFinal) => {
    if (isFinal) lastFinalTranscript = text;
    pushRenderer('transcript', { text, isFinal });
  });
  stt.on('error', (err) => {
    setStatus(`STT error: ${err.message}`, 'error');
  });

  try {
    await stt.connect();
    pushRenderer('start-recording');
  } catch (err) {
    setStatus(`STT connect failed: ${err.message}`, 'error');
    recording = false;
    return;
  }
}

async function onHotkeyRelease() {
  if (!recording) return;
  setStatus('Finalizing', 'thinking');
  pushRenderer('stop-recording');

  try {
    if (stt) await stt.finalize();
  } catch (err) {
    setStatus(`Finalize error: ${err.message}`, 'error');
  }

  // STTClient promotes lastInterim → final on close, so the 'transcript' handler
  // updates lastFinalTranscript via the listener registered in onHotkeyPress.
  const final = lastFinalTranscript;

  try {
    if (stt) stt.close();
  } catch {}
  stt = null;
  recording = false;

  // Decide whether the user "really" said something.
  const trimmed = (final || '').trim();
  const hasRealWord = /[a-z]{3,}/i.test(trimmed);
  const isEffectivelyEmpty = !trimmed || trimmed.length <= 3 || !hasRealWord;

  if (isEffectivelyEmpty) {
    logBrief('release.silent.await-brief');
    setStatus('Briefing', 'thinking');
    if (briefingTask) {
      try { await briefingTask; } catch {}
    }
    logBrief('release.silent.brief-done');
    return;
  }

  logBrief('release.spoke', { transcript: trimmed.slice(0, 80) });
  briefingAborted = true;
  pushRenderer('stop-wav');

  // Make sure the on-screen session context is in ambient before we run the
  // user's actual command (the briefingTask may still be mid-fetch).
  if (pressTimeOcr) {
    try {
      const r = await Promise.race([
        pressTimeOcr,
        new Promise((res) => setTimeout(() => res(null), 2000)),
      ]);
      if (r?.sid) {
        try { await loadScreenSessionContext(r.sid); } catch {}
      }
    } catch {}
    pressTimeOcr = null;
  }

  // Voice-control short-circuit: switch session / list / current
  const intent = voiceIntent.detect(final);
  if (intent) {
    const handled = await handleVoiceIntent(intent, final);
    if (handled) return;
  }

  await runAgent(final);
}

async function handleVoiceIntent(intent, transcript, output = speak) {
  // Always log the user utterance even when we short-circuit.
  try {
    if (config.session?.id) {
      history.append(config.session.id, {
        role: 'user',
        text: transcript,
        endpoint: config.lmAssist.endpoint,
        meta: { intent: intent.intent },
      });
    }
  } catch {}

  if (intent.intent === 'open-picker') {
    openSessionPicker();
    return await output("Opening session picker.");
  }

  if (intent.intent === 'current') {
    const lbl = config.session?.label || config.session?.id?.slice(0, 8) || 'none';
    return await output(`Current session is ${lbl}.`);
  }

  if (intent.intent === 'status') {
    if (watcher) {
      try { await watcher.tick(); } catch {}
    }
    const snap = watcher?.getSnapshot() ?? { recent: [], runningCount: 0 };
    return await output(speakStatus(snap, config.session));
  }

  if (intent.intent === 'unpin') {
    setSession({ id: null, cwd: null, label: null });
    return await output('Session cleared.');
  }

  if (intent.intent === 'voice-list') {
    const currentId = config.tts?.voiceStyle ?? 'M1';
    const currentDesc = describeVoice(currentId);
    const currentName = currentDesc ? currentDesc.name : currentId;
    return await output(`${listForSpeech()} You are currently using ${currentName}.`);
  }

  if (intent.intent === 'voice-set') {
    const resolvedId = resolveVoiceId(intent.target);
    if (!resolvedId) {
      return await output(`I don't recognize voice "${intent.target}". Try Marcus, Dylan, Theo, Aria, Luna, or Nova.`);
    }
    config = cfg.update({ tts: { voiceStyle: resolvedId } });
    tts = null;
    rebuildTrayMenu();
    return await output(previewVoiceText(resolvedId));
  }

  if (intent.intent === 'speed-set') {
    const v = Math.max(0.5, Math.min(2.0, parseFloat(intent.value)));
    if (!Number.isFinite(v)) return await output(`I could not understand that speed. Try "speed to one point two".`);
    config = cfg.update({ tts: { speed: v } });
    tts = null;
    rebuildTrayMenu();
    return await output(previewSpeedText(v));
  }

  if (intent.intent === 'speed-faster') {
    const v = Math.min(2.0, (config.tts?.speed ?? 1.05) + 0.15);
    config = cfg.update({ tts: { speed: v } });
    tts = null;
    rebuildTrayMenu();
    return await output(previewSpeedText(v, 'faster'));
  }

  if (intent.intent === 'speed-slower') {
    const v = Math.max(0.5, (config.tts?.speed ?? 1.05) - 0.15);
    config = cfg.update({ tts: { speed: v } });
    tts = null;
    rebuildTrayMenu();
    return await output(previewSpeedText(v, 'slower'));
  }

  if (intent.intent === 'recap') {
    if (!config.session?.id) return await output('No session is pinned. Nothing to recap.');
    let recent = [];
    try { recent = history.readSession(config.session.id, { limit: 12 }); } catch {}
    const turns = recent.slice(0, -1).filter((h) => h.role === 'user' || h.role === 'assistant');
    if (!turns.length) return await output("We haven't talked about anything yet in this session.");
    const last = turns.slice(-6);
    const summarized = last.map((h) => {
      const who = h.role === 'user' ? 'You' : 'I';
      const t = (h.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 140);
      return `${who} said: ${t}`;
    }).join('. ');
    return await output(`Our recent chat — ${summarized}`);
  }

  if (intent.intent === 'switch') {
    const candidates = [];
    for (const r of (config.recentSessions ?? [])) {
      candidates.push({
        id: r.id, label: r.label,
        projectShort: (r.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '',
        endpoint: r.endpoint, cwd: r.cwd,
      });
    }
    try {
      const resp = await lmAssist.listSessions();
      const live = resp?.data?.sessions ?? resp?.sessions ?? [];
      for (const s of live) {
        const cwd = s.projectPath ?? s.cwd ?? '';
        candidates.push({
          id: s.sessionId ?? s.id,
          label: cwd.split(/[\\/]/).filter(Boolean).pop() || (s.sessionId ?? s.id)?.slice(0, 8) || 'session',
          projectShort: cwd.split(/[\\/]/).filter(Boolean).pop() || '',
          endpoint: config.lmAssist.endpoint, cwd,
        });
      }
    } catch (e) {
      return await output(`Cannot reach lm-assist to find a matching session.`);
    }
    const match = voiceIntent.resolveTarget(intent.target, candidates);
    if (!match) return await output(`No session matches "${intent.target}". Try opening the picker.`);
    if (match.endpoint && match.endpoint !== config.lmAssist.endpoint) {
      const servers = [...(config.lmAssist.servers ?? [])];
      if (!servers.find((s) => s.url === match.endpoint)) servers.push({ url: match.endpoint, label: match.endpoint });
      config = cfg.update({ lmAssist: { endpoint: match.endpoint, servers } });
      lmAssist = new LMAssistClient({ endpoint: config.lmAssist.endpoint });
      if (watcher) watcher.setClient(lmAssist);
      if (sessionDelta) sessionDelta.setClient(lmAssist);
    }
    setSession({ id: match.id, cwd: match.cwd ?? null, label: match.label ?? null });
    return await output(`Switched to ${match.label || 'session'}.`);
  }

  return false;
}

// Read RIFF/PCM duration from a WAV Buffer so the renderer can sync word
// highlights with playback. Header layout is fixed for our 16-bit mono output.
function wavDurationSec(wavBuf) {
  try {
    const channels = wavBuf.readUInt16LE(22);
    const sampleRate = wavBuf.readUInt32LE(24);
    const bitDepth = wavBuf.readUInt16LE(34);
    const dataSize = wavBuf.readUInt32LE(40);
    const bytesPerSample = bitDepth / 8;
    const frames = dataSize / (channels * bytesPerSample);
    return frames / sampleRate;
  } catch { return null; }
}

// Build a rich sample line for the named voice — long enough that the user
// can actually hear the timbre / pacing, short enough that they don't have
// to wait. The phrase is intentionally varied (vowels, consonants, prosody)
// so different voices feel distinct.
function previewVoiceText(id) {
  const d = describeVoice(id) || { name: id, tone: '' };
  // Uses TTS markup so the user immediately hears pauses and emphasis at work.
  return `Voice changed to [emph]${d.name}[/emph]. [pause 400] Hello — I am ${d.name}, the [slow]${d.tone}[/slow] voice. [pause] The quick brown fox jumps over the lazy dog. [pause] How do I sound?`;
}

function previewSpeedText(value, hint) {
  const s = value.toFixed(2);
  if (hint === 'faster') return `Speaking [fast]faster[/fast], now at [emph]${s}[/emph]. This is what I sound like at the new speed.`;
  if (hint === 'slower') return `Speaking [slow]slower[/slow], now at [emph]${s}[/emph]. This is what I sound like at the new speed.`;
  return `Speed set to [emph]${s}[/emph]. [pause] This is what I sound like at the new speed.`;
}

async function speak(text) {
  // Pipeline:
  //   1. Strip markdown (cleanForTTS) so asterisks etc. don't get spoken
  //   2. Display text = same minus our TTS markup tags ([pause], [slow], etc.)
  //   3. Synth audio chunk-by-chunk honouring the markup; concat into one WAV
  //   4. Send the WAV + the display text to the renderer for karaoke
  const md = cleanForTTS(text, 100000);
  const displayText = stripMarkup(md);
  pushRenderer('reply', displayText);
  setStatus('Speaking', 'speaking');
  try {
    if (config.session?.id) {
      history.append(config.session.id, { role: 'assistant', text: displayText, endpoint: config.lmAssist.endpoint, meta: { source: 'voice-intent' } });
    }
  } catch {}
  try {
    if (!tts) tts = new SupertonicTTS({ voiceStyle: config.tts.voiceStyle, speed: config.tts.speed });
    if (md && md.trim()) {
      const wav = await synthesizeMarkupToWav(md, tts, config.tts.speed, { lang: config.tts.lang ?? 'en' });
      const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
      const duration = wavDurationSec(wav);
      pushRenderer('play-wav', { buffer: ab, duration, text: displayText });
    }
  } catch (err) {
    setStatus(`TTS error: ${err.message}`, 'error');
  }
  setTimeout(() => setStatus('Idle', 'idle'), 1500);
  return true;
}

// Track last final transcript across the STT lifecycle.
let lastFinalTranscript = '';

// Press-time screen OCR + auto-briefing. On hotkey press we kick off the OCR
// in parallel with STT. As soon as OCR completes and we find a Claude Code
// SID, we immediately start fetching that session's recent conversation and
// have Haiku brief the user — they hear the briefing while still holding the
// key. If they say something substantial on release, we cancel the briefing
// audio and process their command instead.
let pressTimeOcr = null;     // Promise<{ text, sid }>
let briefingTask = null;     // Promise — the auto-briefing running on press
let briefingAborted = false; // user spoke → don't bother synthesising more TTS
// Sticky cache of the last SID we saw on screen — falls back when a single
// capture misses the status line (window resize, occlusion, OCR jitter, etc.).
let lastKnownSid = null;
let lastKnownSidAt = 0;
const SID_STICKY_MS = 5 * 60 * 1000; // 5 min

async function _captureScreenAndFindSid() {
  const t0 = Date.now();
  try {
    let tess;
    try { tess = require('tesseract.js'); }
    catch { logBrief('ocr.skip', 'tesseract.js not installed'); return { text: '', sid: null }; }
    logBrief('ocr.capture.start');
    setStatus('Capturing screen…', 'thinking');
    const png = await captureScreenPng();
    if (!png) { logBrief('ocr.capture.empty'); return { text: '', sid: null }; }
    logBrief('ocr.capture.done', { bytes: png.length, ms: Date.now() - t0 });

    let worker = screenOcr?._worker ?? null;
    let oneShot = false;
    if (!worker) {
      logBrief('ocr.worker.init.start');
      setStatus('Initialising OCR engine…', 'thinking');
      worker = await tess.createWorker('eng');
      const ASCII_PRINTABLE = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
      try { await worker.setParameters({ tessedit_char_whitelist: ASCII_PRINTABLE, preserve_interword_spaces: '1' }); } catch {}
      oneShot = true;
      logBrief('ocr.worker.init.done', { ms: Date.now() - t0 });
    } else {
      logBrief('ocr.worker.reused');
    }
    logBrief('ocr.recognize.start');
    setStatus('Reading screen (OCR)…', 'thinking');
    const recT0 = Date.now();
    const result = await worker.recognize(png);
    logBrief('ocr.recognize.done', { ms: Date.now() - recT0 });

    const text = normalizeOcrText(result?.data?.text ?? '');
    // Statusline-focused SID pass first — Tesseract reads tiny 4K statusline
    // text far better when the bottom strip is isolated and upscaled 2x.
    // Falls back to the full-frame text below if the focused pass missed.
    let focusedSid = null;
    let focusedText = '';
    try {
      const focused = await extractSidFromImage(png, worker);
      if (focused?.sid) focusedSid = focused.sid;
      if (focused?.text) focusedText = focused.text;
    } catch (e) { logBrief('ocr.sidstrip.error', { error: e.message }); }
    if (oneShot) { try { await worker.terminate(); } catch {} }
    // Look for an explicit `sid: <uuid>` first; if absent, accept any
    // bare UUID anywhere on screen (last one wins — most likely to be the
    // current session id rather than a copy/quoted reference earlier on
    // the page).
    let sid = focusedSid;
    const explicitMatches = [...text.matchAll(/\bsid\s*[:=]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
    if (!sid && explicitMatches.length) {
      sid = explicitMatches[explicitMatches.length - 1][1].toLowerCase();
    } else if (!sid) {
      const anyUuid = [...text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
      if (anyUuid.length) sid = anyUuid[anyUuid.length - 1][1].toLowerCase();
    }
    // Update the sticky cache so future briefings can fall back on this id.
    if (sid) { lastKnownSid = sid; lastKnownSidAt = Date.now(); }

    // Fuzzy fallback: OCR sometimes mangles a single char per group (e.g.
    // reads `b714` as `b71u4`) so the strict regex misses even when the SID
    // line is on screen. Pull the known SID list from lm-assist and find the
    // canonical one whose hex form is within 3 edits of our coerced candidate.
    let fromFuzzy = false;
    let fromLmAssist = false;
    if (!sid && lmAssist) {
      try {
        const resp = await lmAssist.listSessions();
        const sessions = resp?.sessions ?? resp?.data?.sessions ?? (Array.isArray(resp) ? resp : []);
        const ids = sessions
          .map((s) => s?.sessionId ?? s?.id)
          .filter((s) => typeof s === 'string' && s.length === 36);
        // Combine full-frame + focused statusline text for fuzzy search —
        // the focused text is usually the cleanest, but full-frame catches
        // SIDs that fall outside the bottom band.
        const fuzzy = extractSidFuzzy(focusedText + '\n' + text, ids, 3);
        if (fuzzy) {
          sid = fuzzy;
          fromFuzzy = true;
          lastKnownSid = sid;
          lastKnownSidAt = Date.now();
        } else {
          // Last-resort: most-recently-modified session, excluding voice's own.
          const sorted = [...sessions]
            .filter((s) => !knownVoiceSessions.has(s.sessionId ?? s.id))
            .sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));
          const candidate = sorted[0]?.sessionId ?? sorted[0]?.id ?? null;
          if (candidate) {
            sid = candidate;
            fromLmAssist = true;
            lastKnownSid = sid;
            lastKnownSidAt = Date.now();
          }
        }
      } catch (err) {
        logBrief('ocr.lm-assist-fallback.error', { error: err.message });
      }
    }

    logBrief('ocr.sid', {
      sid,
      source: focusedSid
        ? 'statusline-strip'
        : (explicitMatches.length ? 'full-explicit'
          : (fromFuzzy ? 'fuzzy-known'
            : (fromLmAssist ? 'lm-assist'
              : (sid ? 'full-bare' : 'none')))),
      explicitSid: explicitMatches.length > 0,
      fromFuzzy,
      fromLmAssist,
      textLen: text.length,
      totalMs: Date.now() - t0,
    });
    return { text, sid };
  } catch (err) {
    logBrief('ocr.error', { error: err.message, totalMs: Date.now() - t0 });
    console.error('captureScreenAndFindSid:', err.message);
    return { text: '', sid: null };
  }
}

// Pull the latest conversation from the on-screen Claude Code session and
// push it into the ambient log so the next agent turn sees it.
async function loadScreenSessionContext(sid) {
  const t0 = Date.now();
  if (!sid || !lmAssist || !ambient) {
    logBrief('context.skip', { reason: !sid ? 'no-sid' : !lmAssist ? 'no-client' : 'no-ambient' });
    return null;
  }
  try {
    logBrief('context.fetch.start', { sid });
    const conv = await lmAssist.getConversation(sid, { lastN: 10, toolDetail: 'summary' });
    const messages = conv?.messages ?? conv?.data?.messages ?? [];
    logBrief('context.fetch.done', { sid, messages: messages.length, ms: Date.now() - t0 });
    if (!messages.length) return null;
    const formatted = messages.slice(-10).map((m) => {
      const role = m.role || '?';
      const txt = (typeof m.content === 'string' ? m.content : (m.content?.text ?? '')).replace(/\s+/g, ' ').slice(0, 240);
      return `  [${role}] ${txt}`;
    }).join('\n');
    ambient.push({
      source: 'execution',
      text: `User's screen shows Claude Code session ${sid}. Recent turns from that session:\n${formatted}\n\nWhen the user refers to "this session" or asks what's happening, they mean session ${sid.slice(0, 8)} above.`,
    });
    logBrief('context.pushed', { sid });
    return { sid, turnCount: messages.length };
  } catch (err) {
    logBrief('context.error', { sid, error: err.message });
    console.error('loadScreenSessionContext:', err.message);
    return null;
  }
}

// ── API helpers ─────────────────────────────────────────────────────────────

// Run STT on a WAV buffer (any sample rate / channels) → final transcript.
// Streams PCM through the same STTClient the popup uses. Chunks are paced at
// roughly real-time (3200 B @ 16 kHz ≈ 100 ms of audio), with a small
// acceleration so total time is bounded but the server still sees a stream
// rather than a single big burst (which seems to make Anthropic's endpointer
// drop the utterance).
async function sttFromWavBuf(wavBuf, { paceMs = 25, trailingSilenceMs = 1200 } = {}) {
  if (!oauthToken) oauthToken = readClaudeOAuthToken();
  const pcm16k = wavTo16kMonoPcm(wavBuf);
  // Append silence so Anthropic's endpointer (utterance_end_ms=1000) sees a
  // gap and emits the final transcript before we close the WebSocket.
  // Without this, the tail of the utterance is lost when finalize() fires.
  const trailingBytes = Math.round((trailingSilenceMs / 1000) * 16000) * 2;
  const padded = Buffer.concat([pcm16k, Buffer.alloc(trailingBytes)]);
  const client = new STTClient({
    token: oauthToken,
    language: config.stt.language,
    keyterms: config.stt.keyterms ?? [],
  });
  let finalText = '';
  client.on('transcript', (text, isFinal) => { if (text) finalText = text; });
  await client.connect();
  const CHUNK = 3200; // 100 ms of 16 kHz mono linear16
  for (let off = 0; off < padded.length; off += CHUNK) {
    client.sendAudio(padded.slice(off, Math.min(off + CHUNK, padded.length)));
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
  }
  await client.finalize();
  try { client.close(); } catch {}
  return finalText;
}

// Synthesize text → 16-bit PCM WAV buffer using Supertonic TTS.
async function ttsToWavBuf(text) {
  if (!tts) tts = new SupertonicTTS({ voiceStyle: config.tts.voiceStyle, speed: config.tts.speed });
  return await tts.synthesizeWav(text, { lang: config.tts.lang ?? 'en' });
}

// Full pipeline: WAV → STT → (intent | agent) → reply text → WAV.
async function runFullVoicePipeline(wavBuf) {
  const transcript = await sttFromWavBuf(wavBuf);
  if (!transcript) {
    return { transcript: '', reply: '', source: 'no-speech', audioBase64: null };
  }
  const intent = voiceIntent.detect(transcript);
  let reply = '';
  let source = 'agent';
  if (intent) {
    source = `intent:${intent.intent}`;
    let collected = '';
    const collector = async (text) => { collected = text; return true; };
    await handleVoiceIntent(intent, transcript, collector);
    reply = collected;
  }
  if (!reply) {
    const r = await executeAgentTurn(transcript);
    reply = r.reply;
  }
  // Synthesise audio if we have a reply.
  let audioBase64 = null;
  if (reply && reply.trim()) {
    try {
      const wav = await ttsToWavBuf(cleanForTTS(reply, config.agent.maxReplyChars ?? 350));
      audioBase64 = wav.toString('base64');
    } catch {}
  }
  return { transcript, reply, source, audioBase64 };
}

// Pure agent execution — runs the full execute/resume pipeline and returns
// the raw reply text. Used by both runAgent (which speaks it) and the API
// (which returns it as JSON / re-synthesises via TTS).
async function executeAgentTurn(transcript) {
  // Log user turn (kept for the conversation popup + audit trail)
  try {
    if (config.session?.id) {
      history.append(config.session.id, {
        role: 'user',
        text: transcript,
        endpoint: config.lmAssist.endpoint,
      });
    }
  } catch (e) { console.error('history append (user) failed:', e.message); }

  // Held voice-agent session per endpoint. First turn = full prompt + fresh execute.
  // Subsequent turns = bare transcript + resume the same Claude Code session — this
  // keeps the model context warm and avoids the 10–15s fresh-spawn warmup cost.
  const endpoint = config.lmAssist.endpoint;
  const heldSessionId = (config.voiceAgent?.sessions ?? {})[endpoint] || null;
  const isFirstTurn = !heldSessionId;

  // Drain ambient context (session deltas + screen OCR diff) and prepend so the
  // agent learns what's been happening in the background — only spending tokens
  // when the user actually speaks.
  const ambientBlock = ambient?.size() ? ambient.renderForPrompt() : '';
  if (ambient) ambient.drain();

  // Refresh world state so the agent gets up-to-date host / project / session
  // info every turn. Prefer the recently-OCR'd SID as the hint — that's
  // what the user is currently looking at on screen.
  if (worldState) {
    try {
      const hint = (lastKnownSid && (Date.now() - lastKnownSidAt) < SID_STICKY_MS) ? lastKnownSid : null;
      await worldState.refresh({ hintedSid: hint, pinnedSessionId: config.session?.id ?? null });
    } catch {}
  }
  const worldContext = [
    worldState?.formatForPrompt() ?? '',
    multiHost?.formatForPrompt() ?? '',
  ].filter(Boolean).join('\n\n');

  // Only build the full system-style prompt on the first turn; on resume the
  // session already has all the prior context, so we send a header block
  // (world state + ambient deltas + the new transcript).
  const headerBlocks = [worldContext, ambientBlock].filter(Boolean).join('\n\n');
  const userBlock = headerBlocks
    ? `${headerBlocks}\n\n[USER SAID]\n${transcript}`
    : transcript;
  const prompt = isFirstTurn
    ? buildAgentPrompt({
        transcript,
        session: config.session,
        lmAssistEndpoint: endpoint,
        maxReplyChars: config.agent.maxReplyChars ?? 350,
        recentVoiceHistory: [],
        worldContext: headerBlocks,
      })
    : userBlock;

  let exec;
  try {
    exec = isFirstTurn
      ? await lmAssist.execute({
          prompt,
          cwd: config.session.cwd ?? process.cwd(),
          model: config.agent.model ?? 'haiku',
          effort: config.agent.effort ?? 'low',
        })
      : await lmAssist.resumeExecution({
          sessionId: heldSessionId,
          prompt,
          cwd: config.session.cwd ?? process.cwd(),
          model: config.agent.model ?? 'haiku',
          effort: config.agent.effort ?? 'low',
        });
  } catch (err) {
    // If resume failed (session expired / not found), fall back to fresh execute and start a new held session.
    if (!isFirstTurn) {
      clearHeldVoiceSession(endpoint);
      const freshPrompt = buildAgentPrompt({
        transcript,
        session: config.session,
        lmAssistEndpoint: endpoint,
        maxReplyChars: config.agent.maxReplyChars ?? 350,
        recentVoiceHistory: [],
      });
      exec = await lmAssist.execute({
        prompt: freshPrompt,
        cwd: config.session.cwd ?? process.cwd(),
        model: config.agent.model ?? 'haiku',
        effort: config.agent.effort ?? 'low',
      });
    } else {
      throw err;
    }
  }
  const id = exec?.executionId ?? exec?.id ?? exec?.exec_id;
  if (!id) throw new Error('lm-assist did not return an execution id');
  trackOurExecution(id);
  const finalExec = await lmAssist.waitForExecution(id, { intervalMs: 1200, timeoutMs: 90_000 });
  const claudeSessionId = finalExec?.sessionId ?? exec?.sessionId;
  if (claudeSessionId && !String(claudeSessionId).startsWith('pending-')) {
    rememberHeldVoiceSession(endpoint, claudeSessionId);
  }
  if (finalExec?.status === 'failed' || finalExec?.status === 'error' || finalExec?.status === 'aborted') {
    throw new Error(`execution ${finalExec.status}` + (finalExec.error ? `: ${finalExec.error}` : ''));
  }
  const resultResp = await lmAssist.getExecutionResult(id);
  if (resultResp?.error) throw new Error(String(resultResp.error));
  const inner = resultResp?.result ?? resultResp;
  if (inner && typeof inner === 'object' && inner.success === false && inner.error) throw new Error(String(inner.error));
  let reply = (typeof inner === 'string' ? inner : null)
       ?? inner?.result
       ?? inner?.text
       ?? inner?.message
       ?? inner?.output
       ?? '';
  if (typeof reply !== 'string') reply = JSON.stringify(reply);

  // Context budget — retire the held session if usage is approaching the limit.
  try {
    const usage = inner?.usage ?? {};
    const used =
      (usage.cacheReadInputTokens || 0) +
      (usage.cacheCreationInputTokens || 0) +
      (usage.inputTokens || 0);
    const limit = config.voiceAgent?.contextLimit ?? 200000;
    const threshold = config.voiceAgent?.contextThreshold ?? 0.75;
    if (used > 0 && used >= limit * threshold) {
      const heldNow = (config.voiceAgent?.sessions ?? {})[endpoint];
      if (heldNow) {
        clearHeldVoiceSession(endpoint);
        const usedK = Math.round(used / 1000);
        const limitK = Math.round(limit / 1000);
        if (ambient) ambient.push({
          source: 'execution',
          text: `Voice agent session was reset — context reached ${usedK}K of ${limitK}K limit. Next turn starts fresh.`,
        });
      }
    }
  } catch {}

  // Log assistant turn at history (raw reply — caller can clean for TTS if needed)
  try {
    if (config.session?.id && reply && reply.trim()) {
      history.append(config.session.id, {
        role: 'assistant',
        text: reply.slice(0, 1500),
        endpoint: config.lmAssist.endpoint,
      });
    }
  } catch {}

  return { reply, sessionId: claudeSessionId, usage: inner?.usage };
}

async function runAgent(transcript) {
  setStatus('Thinking', 'thinking');
  let reply;
  try {
    ({ reply } = await executeAgentTurn(transcript));
  } catch (err) {
    const msg = `Agent error: ${err.message}`;
    setStatus(msg, 'error');
    pushRenderer('notify', { type: 'agent-error', msg });
    try { await speak(`Sorry, the agent failed. ${err.message.slice(0, 120)}`); } catch {}
    return;
  }
  if (!reply || !reply.trim()) {
    const msg = 'Agent returned no reply.';
    setStatus(msg, 'error');
    pushRenderer('notify', { type: 'agent-empty', msg });
    try { await speak('I got an empty response. Try rephrasing the question.'); } catch {}
    return;
  }
  // Route through speak() so markup is honoured + bubble & audio stay in sync.
  await speak(reply);
}

// --- ipc handlers --- //
ipcMain.on('mic-chunk', (_, buf) => {
  if (!stt || !recording) return;
  try {
    stt.sendAudio(Buffer.from(buf));
  } catch (err) {
    console.error('sendAudio failed', err);
  }
});

ipcMain.on('mic-error', (_, msg) => {
  setStatus(`Mic error: ${msg}`, 'error');
});

// --- tray --- //
function buildTrayIcon() {
  const png = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icons', 'icon.png'));
  if (!png.isEmpty()) return png.resize({ width: 16, height: 16 });
  // fallback: 1x1 transparent until user provides an icon
  return nativeImage.createEmpty();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const sessionLabel = config.session?.label || config.session?.id?.slice(0, 8) || 'No session';
  const snap = watcher?.getSnapshot();
  const runningLabel = snap?.runningCount
    ? `${snap.runningCount} background execution${snap.runningCount === 1 ? '' : 's'} running`
    : 'No background executions';
  const menu = Menu.buildFromTemplate([
    { label: `Session: ${sessionLabel}`, enabled: false },
    { label: 'Pick session…', click: () => openSessionPicker() },
    { label: 'Clear pinned session', click: () => setSession({ id: null, cwd: null, label: null }) },
    { label: 'Reset voice memory (next turn = fresh)', click: () => clearHeldVoiceSession(config.lmAssist.endpoint) },
    { type: 'separator' },
    { label: runningLabel, enabled: false },
    { label: `lm-assist: ${config.lmAssist.endpoint}`, enabled: false },
    { label: 'Open Hosts & Sessions window', click: () => openHostsWindow() },
    { label: 'Open Claude.ai voice…', click: () => openClaudeAiWindow() },
    { label: 'Open Claude.ai browser (auto-bridge)…', click: () => openClaudeAiBrowser() },
    { label: 'Discover hosts (scan session files)…', click: async () => {
        setStatus('Scanning Claude session files…', 'thinking');
        try {
          const r = await runDiscovery({ maxFiles: 200 });
          const sessionsLine = r.remoteSessions
            .filter((x) => !x.error && x.count > 0)
            .map((x) => `${new URL(x.url).hostname}=${x.count}`)
            .join(', ');
          const sshLine = r.sshTargets
            .filter((s) => s.bestAccess)
            .slice(0, 6)
            .map((s) => `${s.bestAccess.user ? s.bestAccess.user + '@' : ''}${s.host}${s.bestAccess.keyFile ? ' (' + s.bestAccess.keyFile + ')' : ''}`)
            .join('; ');
          const sshDiscLine = (r.sshDiscovered ?? [])
            .map((x) => `${x.viaSsh.user}@${x.viaSsh.host}=${x.version}`)
            .join(', ');
          const totalReachable = r.reachable.length + (r.sshDiscovered?.length ?? 0);
          setStatus(`${totalReachable} host(s) (${r.additions.length} direct, ${r.sshDiscovered?.length ?? 0} via SSH)`, 'notify');
          pushRenderer('notify', { type: 'host-discovery', msg: `Scanned ${r.scanned} files in ${(r.elapsedMs/1000).toFixed(1)}s — direct: ${r.reachable.length}, via SSH: ${r.sshDiscovered?.length ?? 0}. Sessions: ${sessionsLine || 'none'}. SSH-only found: ${sshDiscLine || 'none'}. SSH targets: ${sshLine}.` });
        } catch (err) {
          setStatus(`Discovery failed: ${err.message}`, 'error');
        }
    } },
    {
      label: `Hotkey: ${config.hotkey.pushToTalk} (${config.hotkey.mode})`,
      submenu: (() => {
        const keys = [
          'LEFT CTRL', 'RIGHT CTRL',
          'LEFT ALT',  'RIGHT ALT',
          'LEFT SHIFT', 'RIGHT SHIFT',
          'CAPS LOCK',
          'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19',
        ];
        const cur = config.hotkey.pushToTalk;
        const curMode = config.hotkey.mode;
        const items = keys.map((k) => ({
          label: (k === cur ? '✓ ' : '   ') + k,
          click: () => {
            config = cfg.update({ hotkey: { pushToTalk: k } });
            if (hotkey) hotkey.setKey(k);
            rebuildTrayMenu();
            setStatus(`Hotkey changed to ${k}`, 'notify');
          },
        }));
        items.push({ type: 'separator' });
        items.push({
          label: (curMode === 'hold' ? '✓ ' : '   ') + 'Hold (press-to-talk)',
          click: () => {
            config = cfg.update({ hotkey: { mode: 'hold' } });
            if (hotkey) hotkey.setMode('hold');
            rebuildTrayMenu();
          },
        });
        items.push({
          label: (curMode === 'toggle' ? '✓ ' : '   ') + 'Toggle (press to start/stop)',
          click: () => {
            config = cfg.update({ hotkey: { mode: 'toggle' } });
            if (hotkey) hotkey.setMode('toggle');
            rebuildTrayMenu();
          },
        });
        return items;
      })(),
    },
    { type: 'separator' },
    {
      label: (() => {
        const id = config.tts?.voiceStyle ?? 'M1';
        const d = describeVoice(id);
        return `Voice: ${d ? d.name : id}`;
      })(),
      submenu: VOICES.map((v) => ({
        label: `${v.name} (${v.id}) — ${v.tone}` + (v.id === (config.tts?.voiceStyle ?? 'M1') ? '   ✓' : ''),
        click: () => {
          config = cfg.update({ tts: { voiceStyle: v.id } });
          tts = null;
          rebuildTrayMenu();
          speak(previewVoiceText(v.id)).catch(() => {});
        },
      })),
    },
    {
      label: `Ambient awareness — sessions: ${config.awareness?.sessionDelta?.enabled !== false ? 'on' : 'off'} | OCR: ${config.awareness?.screenOcr?.enabled === true ? 'on' : 'off'}`,
      submenu: [
        {
          label: (config.awareness?.sessionDelta?.enabled !== false ? '✓ ' : '  ') + 'Session-delta polling',
          click: () => {
            const next = !(config.awareness?.sessionDelta?.enabled !== false);
            config = cfg.update({ awareness: { sessionDelta: { enabled: next } } });
            if (next && !sessionDelta && lmAssist) {
              sessionDelta = new SessionDeltaWatcher({
                lmAssist, ambient,
                intervalMs: config.awareness?.sessionDelta?.intervalMs ?? 30000,
                activeWindowMs: config.awareness?.sessionDelta?.activeWindowMs ?? 600000,
                maxNewMsgsPerSession: config.awareness?.sessionDelta?.maxNewMsgsPerSession ?? 6,
              });
              sessionDelta.setExclude([...knownVoiceSessions]);
              sessionDelta.on('error', () => {});
              sessionDelta.start();
            } else if (!next && sessionDelta) {
              sessionDelta.stop();
              sessionDelta = null;
            }
            rebuildTrayMenu();
          },
        },
        {
          label: (config.awareness?.screenOcr?.enabled === true ? '✓ ' : '  ') + 'Screen OCR (needs tesseract.js)',
          click: () => {
            const next = !(config.awareness?.screenOcr?.enabled === true);
            config = cfg.update({ awareness: { screenOcr: { enabled: next } } });
            if (next && !screenOcr) {
              screenOcr = new ScreenshotOcrWatcher({
                ambient,
                intervalMs: config.awareness?.screenOcr?.intervalMs ?? 25000,
                minDeltaChars: config.awareness?.screenOcr?.minDeltaChars ?? 60,
                lang: config.awareness?.screenOcr?.lang ?? 'eng',
                lmAssist,
              });
              screenOcr.on('error', (err) => console.error('OCR error:', err.message));
              screenOcr.on('sid-found', onScreenSidFound);
              screenOcr.start();
            } else if (!next && screenOcr) {
              screenOcr.stop();
              screenOcr = null;
            }
            rebuildTrayMenu();
          },
        },
        {
          label: `Ambient buffer: ${ambient?.size() ?? 0} update(s) pending`,
          enabled: false,
        },
      ],
    },
    {
      label: `Speed: ${(config.tts?.speed ?? 1.05).toFixed(2)}`,
      submenu: [
        { label: 'Slower (-0.15)', click: () => {
            const s = Math.max(0.5, (config.tts?.speed ?? 1.05) - 0.15);
            config = cfg.update({ tts: { speed: s } });
            tts = null; rebuildTrayMenu();
            speak(previewSpeedText(s, 'slower')).catch(() => {});
        } },
        { label: 'Faster (+0.15)', click: () => {
            const s = Math.min(2.0, (config.tts?.speed ?? 1.05) + 0.15);
            config = cfg.update({ tts: { speed: s } });
            tts = null; rebuildTrayMenu();
            speak(previewSpeedText(s, 'faster')).catch(() => {});
        } },
        { type: 'separator' },
        ...[0.7, 0.85, 1.0, 1.15, 1.3, 1.5].map((s) => ({
          label: s.toFixed(2) + (Math.abs(s - (config.tts?.speed ?? 1.05)) < 0.04 ? ' ✓' : ''),
          click: () => {
            config = cfg.update({ tts: { speed: s } });
            tts = null; rebuildTrayMenu();
            speak(previewSpeedText(s)).catch(() => {});
          },
        })),
      ],
    },
    { type: 'separator' },
    {
      label: config.ui.showPopup ? 'Hide popup window on idle' : 'Always show popup',
      click: () => { config = cfg.update({ ui: { showPopup: !config.ui.showPopup } }); rebuildTrayMenu(); },
    },
    { label: 'Open config…', click: () => shell.openPath(cfg.configPath()) },
    { type: 'separator' },
    { label: 'Quit LM Voice', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// Switch Chromium's screen-capture backend to Windows Graphics Capture (WGC)
// before the app is ready. The default DXGI desktop-duplicator path spams
// stderr with "Failed to capture frames within 500 ms / Duplication failed"
// when another app holds the duplicator or display state changes. WGC is the
// modern Win10+ API and recovers cleanly from those races. Must be set before
// app.whenReady().
app.commandLine.appendSwitch('enable-features', 'WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer,WebRtcScreenCaptureZeroHzMode');
app.commandLine.appendSwitch('disable-features', 'AllowDXGIGPUOptimization');
// Quiet the remaining Chromium native logs (anything below FATAL is dropped).
app.commandLine.appendSwitch('log-level', '3');

async function init() {
  await app.whenReady();

  lmAssist = new LMAssistClient({ endpoint: config.lmAssist.endpoint });
  try {
    await lmAssist.health();
  } catch (err) {
    console.error('lm-assist health check failed:', err.message);
  }

  watcher = new SessionWatcher({ lmAssist, intervalMs: 15000 });
  watcher.on('pinned-changed', (evt) => {
    const delta = evt.delta ?? 0;
    const msg = delta > 0 ? `Pinned: ${delta} new turn${delta === 1 ? '' : 's'}` : 'Pinned session updated';
    setStatus(msg, 'notify');
    pushRenderer('notify', { type: 'pinned-changed', msg, id: evt.id });
    rebuildTrayMenu();
  });
  watcher.on('execution-started', (evt) => {
    if (knownOurExecutions.has(evt.id)) { rebuildTrayMenu(); return; }
    setStatus(`Execution started (${evt.count} running)`, 'notify');
    pushRenderer('notify', { type: 'execution-started', msg: 'Background execution started', id: evt.id, count: evt.count });
    rebuildTrayMenu();
  });
  watcher.on('execution-finished', (evt) => {
    if (knownOurExecutions.has(evt.id)) { rebuildTrayMenu(); return; }
    setStatus(`Execution finished (${evt.count} still running)`, 'notify');
    pushRenderer('notify', { type: 'execution-finished', msg: 'Background execution finished', id: evt.id, count: evt.count });
    rebuildTrayMenu();
  });
  watcher.on('session-changed', (evt) => {
    if (knownVoiceSessions.has(evt.id)) return; // our own voice-agent session — silent
    pushRenderer('notify', { type: 'session-changed', msg: 'Another session has new activity', id: evt.id });
  });
  watcher.on('session-new', (evt) => {
    if (knownVoiceSessions.has(evt.id)) return; // voice-agent created this — silent
    pushRenderer('notify', { type: 'session-new', msg: 'New session detected', id: evt.id });
  });
  watcher.on('error', () => { /* swallow — poll loop continues */ });
  watcher.setPinnedSession(config.session?.id ?? null);
  // Seed: every voice-agent session this app has ever created is "ours" —
  // currently held + the full allSessions history. The ambient watcher and
  // the regular watcher should both ignore activity in any of these.
  for (const sid of Object.values(config.voiceAgent?.sessions ?? {})) {
    if (sid) knownVoiceSessions.add(sid);
  }
  for (const sid of (config.voiceAgent?.allSessions ?? [])) {
    if (sid) knownVoiceSessions.add(sid);
  }
  watcher.start();

  // Persistent meta cache — written through by WorldState + MultiHostMonitor
  // so the popup shows last-known world state instantly on next launch, even
  // before any HTTP call to lm-assist returns.
  metaCache = new MetaCache();

  // Ambient awareness — buffer session deltas (and optionally screen OCR) so the
  // next user turn can be prefixed with what's been happening in the background.
  ambient = new AmbientLog({ max: 200 });
  // Mirror every ambient push into the hosts window's Engine tab so the user
  // can see what the engine is observing without tailing a log file.
  const _ambientPush = ambient.push.bind(ambient);
  ambient.push = (evt) => {
    const stored = _ambientPush(evt);
    try { pushRenderer('engine-event', { ...evt, at: evt?.at ?? Date.now() }); } catch {}
    return stored;
  };

  // Single source of truth about host / project / active session / status —
  // consumed by the agent prompt and the /api/state endpoint.
  worldState = new WorldState({ lmAssist, excludeIds: knownVoiceSessions, endpoint: config.lmAssist.endpoint });
  worldState.refresh({ pinnedSessionId: config.session?.id ?? null }).catch(() => {});

  // Cheap background monitor of every OTHER registered host. Polls /sessions
  // every 30s — small JSON, no OCR. Detects new sessions + lastModified
  // bumps so the agent can surface "something else is happening elsewhere".
  multiHost = new MultiHostMonitor({
    servers: _allKnownHosts(config),
    currentEndpoint: config.lmAssist.endpoint,
    intervalMs: 30000,
    excludeIds: knownVoiceSessions,
  });
  multiHost.on('host-session-new', (evt) => {
    if (ambient) ambient.push({
      source: 'execution',
      text: `A new session appeared on host ${evt.label || evt.host}: ${evt.summary?.slice(0, 100) ?? evt.sid.slice(0, 8)}.`,
    });
  });
  multiHost.on('host-session-changed', (evt) => {
    if (ambient) ambient.push({
      source: 'execution',
      text: `Session activity on host ${evt.label || evt.host}: ${evt.summary?.slice(0, 100) ?? evt.sid.slice(0, 8)}.`,
    });
  });
  multiHost.on('host-down', (evt) => {
    if (ambient) ambient.push({
      source: 'execution',
      text: `Host ${evt.label || evt.host} became unreachable.`,
    });
  });
  multiHost.start();

  // Push a compact world-state snapshot to the popup every 5s so the header
  // chips (project / active session / host count) always reflect reality
  // without having to wait for the next agent turn.
  startWorldStateBroadcaster();

  if (config.awareness?.sessionDelta?.enabled !== false) {
    sessionDelta = new SessionDeltaWatcher({
      lmAssist,
      ambient,
      intervalMs: config.awareness?.sessionDelta?.intervalMs ?? 30000,
      activeWindowMs: config.awareness?.sessionDelta?.activeWindowMs ?? 600000,
      maxNewMsgsPerSession: config.awareness?.sessionDelta?.maxNewMsgsPerSession ?? 6,
    });
    sessionDelta.setExclude([...knownVoiceSessions]);
    sessionDelta.on('error', () => { /* swallow — poll loop continues */ });
    sessionDelta.start();
  }

  // HTTP API — programmatic access to STT / TTS / agent / full pipeline.
  if (config.api?.enabled !== false) {
    apiServer = new VoiceApiServer({
      port: config.api?.port ?? 3199,
      host: config.api?.host ?? '127.0.0.1',
      handlers: {
        stt: (wavBuf) => sttFromWavBuf(wavBuf),
        tts: (text) => ttsToWavBuf(text),
        intent: (transcript) => voiceIntent.detect(transcript),
        showPopup: () => {
          if (popupWindow && !popupWindow.isDestroyed()) {
            popupWindow.show();
            popupWindow.focus();
            return { shown: true };
          }
          return { shown: false, error: 'popup window not created' };
        },
        dumpDom: async () => {
          if (!popupWindow || popupWindow.isDestroyed()) return { ok: false };
          const html = await popupWindow.webContents.executeJavaScript(`document.getElementById('hosts-panel')?.outerHTML || '(no panel)'`);
          return { ok: true, html };
        },
        openHostsWindow: () => { openHostsWindow(); return { ok: true }; },
        captureHostsWindow: async ({ tab = null, selectSid = null } = {}) => {
          if (!hostsWindow || hostsWindow.isDestroyed()) openHostsWindow();
          // Wait for page + initial data fetch (load() does an IPC round-trip).
          await new Promise((r) => setTimeout(r, 1500));
          if (tab) {
            try {
              const clicked = await hostsWindow.webContents.executeJavaScript(`
                (function(){
                  var t = document.querySelector('.tab[data-tab="${tab}"]');
                  if (!t) return false;
                  t.click();
                  return document.querySelector('.tab.active').getAttribute('data-tab') === '${tab}';
                })()
              `);
              if (!clicked) await new Promise((r) => setTimeout(r, 300));
              await new Promise((r) => setTimeout(r, 600));
            } catch {}
          }
          const img = await hostsWindow.webContents.capturePage();
          const png = img.toPNG();
          const out = require('path').join(require('os').tmpdir(), `lm-voice-hosts-${tab || 'default'}-${Date.now()}.png`);
          require('fs').writeFileSync(out, png);
          return { ok: true, path: out, size: png.length };
        },
        capturePopup: async ({ expandHosts = false } = {}) => {
          if (!popupWindow || popupWindow.isDestroyed()) return { ok: false, error: 'popup not available' };
          if (!popupWindow.isVisible()) popupWindow.show();
          // Force a world-state push so the chips populate before capture.
          try {
            if (worldState) await worldState.refresh({ pinnedSessionId: config.session?.id ?? null });
          } catch {}
          cacheWorldSnapshot();
          pushRenderer('world-state', {
            world: worldState?.getSnapshot() ?? null,
            otherHosts: multiHost?.getSnapshot() ?? {},
            allHosts: metaCache?.listHosts() ?? [],
          });
          await new Promise((r) => setTimeout(r, 400));
          if (expandHosts) {
            // Click the hosts chip + expand the first group so the screenshot
            // shows the populated panel.
            try {
              await popupWindow.webContents.executeJavaScript(`
                (function(){
                  var chip = document.getElementById('world-hosts');
                  if (chip) chip.click();
                  var first = document.querySelector('[data-group-key]');
                  if (first) first.click();
                  return 'expanded';
                })()
              `);
            } catch {}
            await new Promise((r) => setTimeout(r, 400));
          }
          const img = await popupWindow.webContents.capturePage();
          const png = img.toPNG();
          const out = require('path').join(require('os').tmpdir(), `lm-voice-popup-${Date.now()}.png`);
          require('fs').writeFileSync(out, png);
          return { ok: true, path: out, size: png.length };
        },
        agent: async (transcript) => {
          const intent = voiceIntent.detect(transcript);
          if (intent) {
            let collected = '';
            const collector = async (text) => { collected = text; return true; };
            await handleVoiceIntent(intent, transcript, collector);
            return { reply: collected, source: `intent:${intent.intent}`, intent: intent.intent };
          }
          const r = await executeAgentTurn(transcript);
          return { reply: r.reply, source: 'agent', sessionId: r.sessionId, usage: r.usage };
        },
        run: (wavBuf) => runFullVoicePipeline(wavBuf),
        state: async () => {
          // Refresh world-state on every state call so a polling client always
          // sees up-to-date info (~200ms latency for the 2 HTTP fetches).
          if (worldState) {
            try { await worldState.refresh({ pinnedSessionId: config.session?.id ?? null }); } catch {}
          }
          return {
            session: config.session,
            voiceAgent: {
              held: (config.voiceAgent?.sessions ?? {})[config.lmAssist.endpoint] || null,
              allSessionsCount: (config.voiceAgent?.allSessions ?? []).length,
            },
            tts: { voiceStyle: config.tts.voiceStyle, speed: config.tts.speed },
            lmAssist: { endpoint: config.lmAssist.endpoint },
            ambient: {
              size: ambient?.size() ?? 0,
              recent: ambient?.peek().slice(-5) ?? [],
            },
            api: { port: config.api?.port, host: config.api?.host },
            world: worldState?.getSnapshot() ?? null,
            otherHosts: multiHost?.getSnapshot() ?? {},
            metaCache: metaCache ? {
              ...metaCache.stats(),
              hosts: metaCache.listHosts(),
            } : null,
          };
        },
        discoverHosts: async () => runDiscovery({ maxFiles: 200 }),
        resetSession: async () => {
          const endpoint = config.lmAssist.endpoint;
          const oldHeld = (config.voiceAgent?.sessions ?? {})[endpoint] || null;
          clearHeldVoiceSession(endpoint);
          return { ok: true, cleared: oldHeld };
        },
        claudeAiStatus: async () => ({
          bridge: claudeAiBridge?.status() ?? { listening: false },
          window: { open: !!(claudeAiWindow && !claudeAiWindow.isDestroyed()), visible: !!(claudeAiWindow && !claudeAiWindow.isDestroyed() && claudeAiWindow.isVisible()) },
        }),
        claudeAiSnippet: async () => {
          try {
            return fs.readFileSync(path.join(__dirname, 'lib', 'claude-ai-page-bridge.userscript.js'), 'utf8');
          } catch (err) {
            logError('claudeAiSnippet', err);
            return null;
          }
        },
        claudeAiWindowOpen: async () => { openClaudeAiWindow(); return { ok: true }; },
        claudeAiWindowCaptureLog: async () => {
          const wc = claudeAiViews?.conversation?.webContents;
          if (!wc) return { ok: false, error: 'conversation view not open — call /api/claude-ai/browser/open first' };
          try {
            const result = await wc.executeJavaScript(`
              (() => {
                const log = document.getElementById('log');
                if (!log) return { ok: false, error: 'no #log element' };
                const rows = Array.from(log.children).map(el => ({
                  kind: el.className.replace('row ', '').trim(),
                  text: el.textContent || '',
                }));
                const status = document.getElementById('status-text')?.textContent || '';
                const events = document.getElementById('events');
                return { ok: true, status, rows, eventsRaw: events?.textContent || '' };
              })()
            `, true);
            return result;
          } catch (e) {
            return { ok: false, error: e.message };
          }
        },
        claudeAiWindowClose: async () => {
          if (claudeAiWindow && !claudeAiWindow.isDestroyed()) {
            claudeAiWindow.close();
            return { ok: true, closed: true };
          }
          return { ok: true, closed: false };
        },
        claudeAiBrowserOpen: async ({ url } = {}) => {
          openClaudeAiBrowser(url);
          return { ok: true };
        },
        claudeAiBrowserClose: async () => {
          if (claudeAiBrowser && !claudeAiBrowser.isDestroyed()) {
            claudeAiBrowser.close();
            return { ok: true, closed: true };
          }
          return { ok: true, closed: false };
        },
        claudeAiBrowserStatus: async () => ({
          open: !!(claudeAiBrowser && !claudeAiBrowser.isDestroyed()),
          url: await claudeAiBrowserGetUrl(),
          convId: await claudeAiBrowserGetConvId(),
        }),
        claudeAiBrowserNavigate: async ({ url }) => {
          if (!url || !/^https:\/\/claude\.ai(\/|$)/.test(url)) {
            return { ok: false, error: 'url must be on https://claude.ai/' };
          }
          if (!claudeAiBrowser || claudeAiBrowser.isDestroyed()) {
            openClaudeAiBrowser(url);
            return { ok: true, opened: true };
          }
          // Navigate the claude.ai BrowserView, NOT the host window — the
          // host serves the tab-strip shell.
          const wc = claudeAiViews?.claudeAi?.webContents;
          if (!wc || wc.isDestroyed()) {
            return { ok: false, error: 'claude.ai view not available' };
          }
          try { await wc.loadURL(url); } catch (e) { return { ok: false, error: e.message }; }
          return { ok: true };
        },
        claudeAiBrowserSendCompletion: async (opts = {}) => sendCompletionViaBrowser(opts),
        claudeAiVoiceInjectText: async ({ text, convId } = {}) => {
          // Send a text message into the conversation currently bound to the
          // open voice WS. We POST it via claude.ai's normal /completion
          // endpoint from the embedded browser. The voice WS may or may not
          // relay the new turn's message_sse events — that's the open
          // experiment.
          if (typeof text !== 'string' || !text.trim()) {
            return { ok: false, error: 'text is required' };
          }
          const useConv = convId || claudeAiBridge?.status().lastConvId;
          if (!useConv) {
            return { ok: false, error: 'no active voice conversation — pass convId explicitly or start a session first' };
          }
          return sendCompletionViaBrowser({ convId: useConv, prompt: text });
        },
        claudeAiSessionStart: async ({ convId, context, contextModel, name, voice = 'airy', language = 'en-US', autoStartMic = true } = {}) => {
          let usedConvId = convId;
          let createdConv = null;
          let contextResult = null;
          if (!usedConvId) {
            const c = await createConversationViaBrowser({ name: name || 'LM Voice session', model: contextModel || 'claude-opus-4-7' });
            if (!c?.ok) return { ok: false, step: 'create-conversation', error: c?.error || c };
            createdConv = c.uuid;
            usedConvId = c.uuid;
          }
          if (context && context.trim()) {
            contextResult = await sendCompletionViaBrowser({
              convId: usedConvId, prompt: context, model: contextModel || 'claude-opus-4-7', language,
            });
            if (!contextResult?.ok) return { ok: false, step: 'send-context', error: contextResult?.error || contextResult, convId: usedConvId, createdConv };
          }
          if (!claudeAiBridge?.status().pageAttached) {
            return { ok: false, step: 'open-upstream', error: 'page not attached — open the embedded browser first', convId: usedConvId, createdConv, contextResult };
          }
          // Send the upstream-open control message to the current page FIRST.
          // Then navigate the claude.ai tab to the conversation URL — that
          // navigation destroys the page snippet and re-injects on the new
          // page, but the upstream WS is already established and lives in its
          // own JS heap until close.
          const openMsg = { _bridge: 'open', convId: usedConvId, voice, language };
          if (autoStartMic) openMsg.autoStartMic = true;
          const opened = claudeAiBridge.sendToPageText(JSON.stringify(openMsg));
          if (!opened) return { ok: false, step: 'open-upstream', error: 'send to page failed', convId: usedConvId, createdConv, contextResult };
          // Skip auto-navigate — it would tear down the page bridge mid-flight.
          // User can switch tabs manually to see the conversation page.
          return { ok: true, convId: usedConvId, createdConv, contextResult, autoStartMic: !!autoStartMic };
        },
        claudeAiBrowserCreateConversation: async (opts = {}) => createConversationViaBrowser(opts),
        claudeAiBrowserDeleteConversation: async (opts = {}) => deleteConversationViaBrowser(opts),
        claudeAiBrowserListConversations: async ({ limit = 20 } = {}) => {
          const lim = Math.max(1, Math.min(100, Number(limit) || 20));
          const code = `
            (async () => {
              const orgMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
              if (!orgMatch) return { ok: false, error: 'not logged in (no lastActiveOrg cookie)' };
              const org = decodeURIComponent(orgMatch[1]);
              const cookies = Object.fromEntries(document.cookie.split(';').map(p => {
                const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
              }));
              const headers = {
                'anthropic-client-platform': 'web_claude_ai',
                'anthropic-client-version': '1.0.0',
                'anthropic-client-sha':      '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
                'Accept': '*/*',
              };
              if (cookies['anthropic-device-id']) headers['anthropic-device-id']    = cookies['anthropic-device-id'];
              if (cookies['ajs_anonymous_id'])    headers['anthropic-anonymous-id'] = cookies['ajs_anonymous_id'];
              if (cookies['activitySessionId'])   headers['x-activity-session-id']  = cookies['activitySessionId'];
              const url = \`/api/organizations/\${org}/chat_conversations_v2?limit=${lim}\`;
              try {
                const r = await fetch(url, { credentials: 'include', headers });
                const t = await r.text();
                let body; try { body = JSON.parse(t); } catch { body = t; }
                return { ok: r.ok, status: r.status, org, conversations: Array.isArray(body) ? body : (body?.chat_conversations || body) };
              } catch (e) { return { ok: false, error: String(e.message || e) }; }
            })()
          `;
          return claudeAiBrowserExecuteJs(code);
        },
        claudeAiUpstreamOpen: async ({ convId, orgId, voice, language, timezone, autoStartMic }) => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          if (!claudeAiBridge.status().pageAttached) {
            return { ok: false, error: 'page snippet not attached — paste it into a claude.ai devtools console first' };
          }
          const msg = { _bridge: 'open', convId };
          if (orgId) msg.orgId = orgId;
          if (voice) msg.voice = voice;
          if (language) msg.language = language;
          if (timezone) msg.timezone = timezone;
          if (autoStartMic) msg.autoStartMic = true;
          const sent = claudeAiBridge.sendToPageText(JSON.stringify(msg));
          return sent ? { ok: true, sent: msg } : { ok: false, error: 'send failed' };
        },
        claudeAiUpstreamClose: async () => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          claudeAiBridge.sendToPageText(JSON.stringify({ _bridge: 'close' }));
          return { ok: true };
        },
        claudeAiMicStart: async () => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          if (!claudeAiBridge.status().pageAttached) return { ok: false, error: 'page not attached' };
          const sent = claudeAiBridge.sendToPageText(JSON.stringify({ _bridge: 'mic_start' }));
          return sent ? { ok: true } : { ok: false, error: 'send failed' };
        },
        claudeAiPlaybackSet: async ({ enabled }) => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          if (!claudeAiBridge.status().pageAttached) return { ok: false, error: 'page not attached' };
          const sent = claudeAiBridge.sendToPageText(JSON.stringify({ _bridge: 'playback_set', enabled: !!enabled }));
          return sent ? { ok: true, enabled: !!enabled } : { ok: false, error: 'send failed' };
        },
        claudeAiMicStop: async () => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          claudeAiBridge.sendToPageText(JSON.stringify({ _bridge: 'mic_stop' }));
          return { ok: true };
        },
        claudeAiSendAudio: async (buf) => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          if (!claudeAiBridge.status().pageAttached) return { ok: false, error: 'page not attached' };
          const sent = claudeAiBridge.sendToPageBinary(buf);
          return sent ? { ok: true, bytes: buf.length } : { ok: false, error: 'send failed' };
        },
        claudeAiSendText: async (text) => {
          if (!claudeAiBridge) return { ok: false, error: 'bridge not running' };
          if (!claudeAiBridge.status().pageAttached) return { ok: false, error: 'page not attached' };
          const sent = claudeAiBridge.sendToPageText(text);
          return sent ? { ok: true } : { ok: false, error: 'send failed' };
        },
        claudeAiEvents: async (limit) => claudeAiBridge?.recentEvents(limit) ?? [],
      },
    });
    apiServer.start().then(() => {
      console.log(`[lm-voice] API listening on http://${config.api?.host ?? '127.0.0.1'}:${config.api?.port ?? 3199}`);
    }).catch((err) => {
      console.error('[lm-voice] API failed to start:', err.message);
    });
  }

  if (config.awareness?.screenOcr?.enabled === true) {
    screenOcr = new ScreenshotOcrWatcher({
      ambient,
      intervalMs: config.awareness?.screenOcr?.intervalMs ?? 25000,
      minDeltaChars: config.awareness?.screenOcr?.minDeltaChars ?? 60,
      lang: config.awareness?.screenOcr?.lang ?? 'eng',
      lmAssist,
    });
    screenOcr.on('error', (err) => console.error('OCR error:', err.message));
    screenOcr.on('sid-found', onScreenSidFound);
    screenOcr.start();
  }

  claudeAiBridge = new ClaudeAiBridge({
    port: config.claudeAi?.bridgePort ?? 8765,
    host: '127.0.0.1',
    log: (...a) => { try { console.log('[claude-ai-bridge]', ...a); } catch {} },
  });
  const pushTabBridgeState = () => {
    if (!claudeAiBrowser || claudeAiBrowser.isDestroyed()) return;
    const s = claudeAiBridge.status();
    try {
      claudeAiBrowser.webContents.send('claude-ai-browser:bridge-state', {
        pageAttached: s.pageAttached,
        upstreamOpen: s.upstreamOpen,
      });
    } catch {}
  };
  claudeAiBridge.on('page-attached', pushTabBridgeState);
  claudeAiBridge.on('page-detached', pushTabBridgeState);
  claudeAiBridge.on('page-event', (msg) => {
    if (msg?._bridge === 'upstream_open' || msg?._bridge === 'upstream_close' || msg?._bridge === 'upstream_error') {
      pushTabBridgeState();
    }
  });
  claudeAiBridge.start().catch((err) => logError('claude-ai bridge start', err));

  createPopupWindow();
  popupWindow.webContents.once('did-finish-load', () => {
    if (config.session?.id) pushRenderer('session-update', config.session);
    setStatus('Idle', 'idle');
  });

  tray = new Tray(buildTrayIcon());
  rebuildTrayMenu();
  // Left-click on the tray icon now opens the Hosts & Sessions window (the
  // primary UI). The small popup is the legacy recording surface and stays
  // hidden — it's still alive in the background as an audio host for
  // mic/TTS, but the user never sees it.
  tray.on('click', () => {
    if (hostsWindow && !hostsWindow.isDestroyed() && hostsWindow.isVisible()) hostsWindow.hide();
    else openHostsWindow();
  });

  hotkey = new Hotkey({ key: config.hotkey.pushToTalk, mode: config.hotkey.mode });
  // The hotkey now launches the claude.ai conversation flow (embedded browser
  // + Conversation tab + new voice session). Release is a no-op — the new
  // flow keeps the mic on continuously rather than push-to-talk.
  hotkey.on('press', () => {
    launchClaudeAiConversation().then((r) => {
      if (!r?.ok) logError('hotkey launch', new Error(r?.error || JSON.stringify(r)));
    }).catch((err) => logError('hotkey launch', err));
  });
  hotkey.on('release', () => { /* no-op under the claude.ai flow */ });
  try {
    await hotkey.start();
  } catch (err) {
    dialog.showErrorBox('Cannot register hotkey', err.message);
  }

  // Hide from dock on macOS; on Windows skipTaskbar handles it
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Auto-open picker if no session is configured yet
  if (!config.session?.id) {
    openSessionPicker();
  }
}

app.on('window-all-closed', (e) => {
  // Don't quit when popup closes — tray stays alive.
  e.preventDefault?.();
});

app.on('before-quit', () => {
  if (hotkey) hotkey.stop();
  if (watcher) watcher.stop();
  if (sessionDelta) sessionDelta.stop();
  if (screenOcr) screenOcr.stop();
  if (multiHost) multiHost.stop();
  if (apiServer) apiServer.stop();
  if (claudeAiBridge) claudeAiBridge.stop().catch(() => {});
});

init().catch((err) => {
  console.error('Failed to init:', err);
  dialog.showErrorBox('LM Voice failed to start', err.stack || err.message);
  app.quit();
});
