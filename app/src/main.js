'use strict';

const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');

const cfg = require('./lib/config');
const { readClaudeOAuthToken } = require('./lib/oauth');
const { STTClient } = require('./lib/stt-client');
const { SupertonicTTS } = require('./lib/tts-client');
const { LMAssistClient } = require('./lib/lm-assist-client');
const { Hotkey } = require('./lib/hotkey');
const { buildAgentPrompt, cleanForTTS } = require('./lib/agent-prompt');

let config = cfg.load();
let tray = null;
let popupWindow = null;
let hotkey = null;
let stt = null;
let tts = null;
let lmAssist = null;
let recording = false;
let oauthToken = null;

// --- popup window --- //
function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 340,
    height: 220,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  popupWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  popupWindow.on('blur', () => {
    if (popupWindow?.isVisible() && !config.ui.pinPopup) popupWindow.hide();
  });
}

function showPopupNearTray() {
  if (!popupWindow) return;
  if (!config.ui.showPopup) return;
  const trayBounds = tray?.getBounds?.();
  const winBounds = popupWindow.getBounds();
  if (trayBounds && trayBounds.width > 0) {
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
    const y = Math.round(trayBounds.y - winBounds.height - 8);
    popupWindow.setPosition(Math.max(0, x), Math.max(0, y));
  }
  popupWindow.showInactive();
}

function pushRenderer(channel, payload) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send(channel, payload);
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
}

async function pickSessionInteractive() {
  try {
    const sessions = await lmAssist.listSessions();
    const items = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? []);
    if (!items.length) {
      dialog.showMessageBox({ message: 'No sessions found on lm-assist.', type: 'info' });
      return;
    }
    const recent = items.slice(0, 12).map((s) => ({
      label: `${shortLabel(s)} — ${s.id?.slice(0, 8) ?? '?'}`,
      click: () => setSession({
        id: s.id ?? s.sessionId,
        cwd: s.cwd ?? s.projectPath ?? null,
        label: shortLabel(s),
      }),
    }));
    const menu = Menu.buildFromTemplate(recent);
    menu.popup();
  } catch (err) {
    dialog.showErrorBox('Cannot list sessions', err.message);
  }
}

function shortLabel(s) {
  return s.label || s.title || s.cwd?.split(/[\\/]/).pop() || s.id?.slice(0, 8) || 'session';
}

// --- core flow --- //
async function onHotkeyPress() {
  if (recording) return;
  recording = true;
  setStatus('Listening', 'listening');
  showPopupNearTray();
  pushRenderer('transcript', { text: '', isFinal: false });
  pushRenderer('reply', '');

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

  if (!final) {
    setStatus('No speech detected', 'idle');
    return;
  }

  await runAgent(final);
}

// Track last final transcript across the STT lifecycle.
let lastFinalTranscript = '';

async function runAgent(transcript) {
  setStatus('Thinking', 'thinking');

  const prompt = buildAgentPrompt({
    transcript,
    session: config.session,
    lmAssistEndpoint: config.lmAssist.endpoint,
    maxReplyChars: config.agent.maxReplyChars ?? 350,
  });

  let reply = '';
  try {
    const exec = await lmAssist.execute({
      prompt,
      cwd: config.session.cwd ?? process.cwd(),
      model: config.agent.model ?? 'haiku',
      effort: config.agent.effort ?? 'low',
    });
    const id = exec.id ?? exec.executionId ?? exec.exec_id;
    if (!id) throw new Error('lm-assist did not return an execution id');
    const finalExec = await lmAssist.waitForExecution(id, { intervalMs: 1200, timeoutMs: 90_000 });
    reply = finalExec.result?.text
         ?? finalExec.result?.message
         ?? finalExec.result
         ?? finalExec.message
         ?? finalExec.output
         ?? '';
    if (typeof reply !== 'string') reply = JSON.stringify(reply);
  } catch (err) {
    setStatus(`Agent error: ${err.message}`, 'error');
    return;
  }

  const spoken = cleanForTTS(reply, config.agent.maxReplyChars ?? 350);
  pushRenderer('reply', spoken);

  if (!spoken) {
    setStatus('No reply', 'idle');
    return;
  }

  setStatus('Speaking', 'speaking');
  try {
    if (!tts) tts = new SupertonicTTS({
      voiceStyle: config.tts.voiceStyle,
      speed: config.tts.speed,
    });
    const wav = await tts.synthesizeWav(spoken, { lang: config.tts.lang ?? 'en' });
    const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    pushRenderer('play-wav', ab);
  } catch (err) {
    setStatus(`TTS error: ${err.message}`, 'error');
    return;
  }

  setTimeout(() => setStatus('Idle', 'idle'), 1500);
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
  const menu = Menu.buildFromTemplate([
    { label: `Session: ${sessionLabel}`, enabled: false },
    { label: 'Pick session…', click: () => pickSessionInteractive() },
    { type: 'separator' },
    { label: `lm-assist: ${config.lmAssist.endpoint}`, enabled: false },
    { label: `Hotkey: ${config.hotkey.pushToTalk} (${config.hotkey.mode})`, enabled: false },
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

async function init() {
  await app.whenReady();

  lmAssist = new LMAssistClient({ endpoint: config.lmAssist.endpoint });
  try {
    await lmAssist.health();
  } catch (err) {
    console.error('lm-assist health check failed:', err.message);
  }

  createPopupWindow();
  popupWindow.webContents.once('did-finish-load', () => {
    if (config.session?.id) pushRenderer('session-update', config.session);
    setStatus('Idle', 'idle');
  });

  tray = new Tray(buildTrayIcon());
  rebuildTrayMenu();
  tray.on('click', () => {
    if (popupWindow.isVisible()) popupWindow.hide();
    else showPopupNearTray();
  });

  hotkey = new Hotkey({ key: config.hotkey.pushToTalk, mode: config.hotkey.mode });
  hotkey.on('press', onHotkeyPress);
  hotkey.on('release', onHotkeyRelease);
  try {
    await hotkey.start();
  } catch (err) {
    dialog.showErrorBox('Cannot register hotkey', err.message);
  }

  // Hide from dock on macOS; on Windows skipTaskbar handles it
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
}

app.on('window-all-closed', (e) => {
  // Don't quit when popup closes — tray stays alive.
  e.preventDefault?.();
});

app.on('before-quit', () => {
  if (hotkey) hotkey.stop();
});

init().catch((err) => {
  console.error('Failed to init:', err);
  dialog.showErrorBox('LM Voice failed to start', err.stack || err.message);
  app.quit();
});
