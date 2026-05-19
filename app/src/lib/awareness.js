'use strict';

const { EventEmitter } = require('node:events');

// ── AmbientLog ──────────────────────────────────────────────────────────────
//
// Shared ring buffer of ambient updates from background watchers. Drained
// by the agent flow on each user turn and prepended to the prompt — so the
// voice agent learns about ambient context only when the user speaks (no
// idle tokens spent).
class AmbientLog {
  constructor({ max = 40 } = {}) {
    this.entries = [];
    this.max = max;
  }

  push(entry) {
    this.entries.push({ at: Date.now(), ...entry });
    while (this.entries.length > this.max) this.entries.shift();
  }

  // Drain returns the current entries and clears the buffer. Caller is
  // responsible for actually using them (e.g. prepending to next prompt).
  drain() {
    const out = this.entries;
    this.entries = [];
    return out;
  }

  peek() {
    return this.entries.slice();
  }

  size() {
    return this.entries.length;
  }

  // Render the buffered entries as a compact context block for inclusion in
  // a prompt. Keep it short and obviously bracketed so the agent can
  // identify (and not echo) it.
  renderForPrompt() {
    if (!this.entries.length) return '';
    const lines = ['[AMBIENT CONTEXT — background updates since your last turn]'];
    for (const e of this.entries) {
      if (e.source === 'session') {
        lines.push(`- session "${e.label}" (${e.sessionId.slice(0, 8)}) added ${e.added} new message(s):`);
        for (const m of (e.messages || []).slice(0, 4)) {
          const text = (m.content ?? m.text ?? '').toString().replace(/\s+/g, ' ').slice(0, 240);
          if (text) lines.push(`    [${m.role}] ${text}`);
        }
      } else if (e.source === 'screen') {
        lines.push(`- user's screen changed (OCR diff):`);
        const text = String(e.delta ?? '').replace(/\s+/g, ' ').slice(0, 400);
        if (text) lines.push(`    ${text}`);
      } else if (e.source === 'execution') {
        lines.push(`- ${e.text}`);
      }
    }
    lines.push('[END AMBIENT CONTEXT]');
    return lines.join('\n');
  }
}

// ── SessionDeltaWatcher ─────────────────────────────────────────────────────
//
// Polls lm-assist /sessions every intervalMs. For sessions whose
// lastModified advanced since the last tick, fetches the conversation
// delta and pushes it into the ambient log. Skips sessions in the
// `excludeIds` set (e.g. our own voice-agent session).
class SessionDeltaWatcher extends EventEmitter {
  constructor({ lmAssist, ambient, intervalMs = 30_000, activeWindowMs = 10 * 60_000, maxNewMsgsPerSession = 6 } = {}) {
    super();
    this.lmAssist = lmAssist;
    this.ambient = ambient;
    this.intervalMs = intervalMs;
    this.activeWindowMs = activeWindowMs;
    this.maxNewMsgsPerSession = maxNewMsgsPerSession;
    this.excludeIds = new Set();
    this.lastLineIndexBySession = new Map(); // sessionId -> lineIndex of last seen msg
    this.lastModifiedBySession = new Map();
    this.timer = null;
    this.firstTick = true;
  }

  setClient(lmAssist) {
    this.lmAssist = lmAssist;
    this.lastLineIndexBySession.clear();
    this.lastModifiedBySession.clear();
    this.firstTick = true;
  }

  setExclude(ids) {
    this.excludeIds = new Set(ids || []);
  }

  addExclude(id) {
    if (id) this.excludeIds.add(id);
  }

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    if (!this.lmAssist) return;
    const wasFirst = this.firstTick;
    let sessions = [];
    try {
      const resp = await this.lmAssist.listSessions();
      sessions = resp?.sessions ?? resp ?? (Array.isArray(resp) ? resp : []);
    } catch (err) {
      this.emit('error', err);
      this.firstTick = false;
      return;
    }

    const now = Date.now();
    for (const s of sessions) {
      const id = s.sessionId ?? s.id;
      if (!id) continue;
      if (this.excludeIds.has(id)) {
        // Still track the modified time so we don't backfill if it ever leaves the exclude set
        this.lastModifiedBySession.set(id, s.lastModified);
        continue;
      }
      const lastMod = s.lastModified;
      const prevMod = this.lastModifiedBySession.get(id);
      this.lastModifiedBySession.set(id, lastMod);

      // Skip stale (not modified within active window) and unchanged sessions.
      const modTime = Date.parse(lastMod ?? 0) || 0;
      const isActive = modTime && (now - modTime) <= this.activeWindowMs;
      if (!isActive) continue;
      if (prevMod === lastMod) continue;

      // On the very first tick we just seed baselines — don't backfill stale history.
      if (wasFirst) continue;

      // Fetch the new conversation slice for this session.
      let conv;
      try {
        conv = await this.lmAssist.getConversation(id, { lastN: this.maxNewMsgsPerSession + 4, toolDetail: 'summary' });
      } catch (err) {
        this.emit('error', err);
        continue;
      }
      const messages = conv?.messages ?? conv?.data?.messages ?? [];
      if (!messages.length) continue;

      const seen = this.lastLineIndexBySession.get(id);
      const newMessages = messages.filter((m) => seen == null || (m.lineIndex ?? 0) > seen);
      const maxLine = messages.reduce((mx, m) => Math.max(mx, m.lineIndex ?? 0), seen ?? -1);
      this.lastLineIndexBySession.set(id, maxLine);

      if (!newMessages.length) continue;

      const trimmed = newMessages.slice(-this.maxNewMsgsPerSession);
      this.ambient.push({
        source: 'session',
        sessionId: id,
        label: shortSessionLabel(s),
        added: newMessages.length,
        messages: trimmed.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : (m.content?.text ?? ''),
        })),
      });
      this.emit('session-delta', { sessionId: id, added: newMessages.length });
    }

    this.firstTick = false;
  }
}

function shortSessionLabel(s) {
  if (!s) return 'unknown';
  return (
    s.customTitle ||
    s.slug ||
    s.sessionSummary?.split(' — ')[0]?.slice(0, 60) ||
    s.cwd?.split(/[\\/]/).filter(Boolean).pop() ||
    s.projectPath?.split(/[\\/]/).filter(Boolean).pop() ||
    (s.sessionId ?? s.id ?? '').slice(0, 8) ||
    'unknown'
  );
}

// ── ScreenshotOcrWatcher ────────────────────────────────────────────────────
//
// Captures the primary screen on an interval, runs Tesseract OCR locally,
// diffs vs the previous reading, and only pushes meaningful changes to the
// ambient log. Tesseract worker is lazy-initialised so a cold start happens
// at most once per Electron session.
//
// Pulls the screen via Electron's built-in desktopCapturer; OCR via the
// `tesseract.js` npm dep (must be installed).
class ScreenshotOcrWatcher extends EventEmitter {
  constructor({ ambient, intervalMs = 25_000, minDeltaChars = 40, lang = 'eng', lmAssist = null } = {}) {
    super();
    this.ambient = ambient;
    this.intervalMs = intervalMs;
    this.minDeltaChars = minDeltaChars;
    this.lang = lang;
    this.lmAssist = lmAssist;
    this.timer = null;
    this._worker = null;
    this._workerInit = null;
    this._lastText = '';
    this._lastSid = null;
    this._busy = false;
  }

  // Allow main to inject / swap the lm-assist client after construction
  // (e.g. when the user switches endpoints).
  setLmAssist(client) { this.lmAssist = client; }

  // Change the poll interval at runtime — useful when the popup opens
  // (faster polling for snappier SID detection) and closes (back to default).
  setIntervalMs(ms) {
    if (!ms || ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    }
  }

  async _initWorker() {
    if (this._worker) return this._worker;
    if (this._workerInit) return this._workerInit;
    this._workerInit = (async () => {
      let tess;
      try {
        tess = require('tesseract.js');
      } catch (e) {
        throw new Error('tesseract.js is not installed — run `npm install tesseract.js`');
      }
      const w = await tess.createWorker(this.lang);
      // Constrain Tesseract's output vocabulary to printable ASCII only —
      // every codepoint a normal English screen with code on it would use.
      // The model can no longer waste neurons matching to Greek / CJK /
      // accented look-alikes that the user will never have, which sharpens
      // hex / symbol / mixed-case recognition. Combined with the post-pass
      // ASCII strip in normalizeOcrText, this is belt-and-braces.
      const ASCII_PRINTABLE = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
      try {
        await w.setParameters({
          tessedit_char_whitelist: ASCII_PRINTABLE,
          // Preserve interword spaces — helps disambiguate adjacent tokens
          // that the auto-segmenter might otherwise glue together.
          preserve_interword_spaces: '1',
        });
      } catch {}
      this._worker = w;
      return w;
    })();
    return this._workerInit;
  }

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._worker) {
      try { this._worker.terminate(); } catch {}
      this._worker = null;
      this._workerInit = null;
    }
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const path = require('node:path');
      const os = require('node:os');
      const debugPath = path.join(os.homedir(), '.lm-voice', 'last-capture.png');
      const png = await captureScreenPng({ debugSavePath: debugPath });
      if (!png) return;
      const worker = await this._initWorker();
      const result = await worker.recognize(png);
      const text = normalizeOcrText(result?.data?.text ?? '');
      try { require('node:fs').writeFileSync(path.join(os.homedir(), '.lm-voice', 'last-ocr.txt'), text); } catch {}

      // SID extraction — prefer a focused crop+upscale of the bottom
      // statusline strip (Tesseract reads tiny 4K text much better when
      // it's isolated and scaled up), fall back to the full-frame pass,
      // and finally do a fuzzy match against known lm-assist sessions to
      // recover when OCR mangles a single char per group.
      let sid = null;
      let focusedText = '';
      try {
        const focused = await extractSidFromImage(png, worker);
        if (focused?.sid) sid = focused.sid;
        if (focused?.text) focusedText = focused.text;
      } catch {}
      if (!sid) sid = extractSidFromText(text);
      if (!sid && this.lmAssist) {
        try {
          const resp = await this.lmAssist.listSessions();
          const sessions = resp?.sessions ?? resp?.data?.sessions ?? (Array.isArray(resp) ? resp : []);
          const ids = sessions
            .map((s) => s?.sessionId ?? s?.id)
            .filter((s) => typeof s === 'string' && s.length === 36);
          const fuzzy = extractSidFuzzy(focusedText + '\n' + text, ids, 3);
          if (fuzzy) sid = fuzzy;
        } catch {}
      }
      if (sid && sid !== this._lastSid) {
        this._lastSid = sid;
        this.emit('sid-found', { sid, source: 'screen' });
      }

      const delta = computeTextDelta(this._lastText, text, this.minDeltaChars);
      this._lastText = text;
      if (delta) {
        this.ambient.push({ source: 'screen', delta });
        this.emit('screen-delta', { length: delta.length });
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._busy = false;
    }
  }
}

// Fuzzy SID match against a list of known session IDs. Returns the canonical
// known SID if a candidate sequence in `text` matches one within `maxEdits`
// Levenshtein distance (after hex-coercion + dash strip). Handles the residual
// case where focused OCR reads e.g. `b71u4` instead of `b714` — coerce gives
// us a 33-char hex string while real SIDs are 32 chars, one edit away.
function _editDistance(a, b, cap = 4) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1; // early exit
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function extractSidFuzzy(text, knownSids, maxEdits = 3) {
  if (!text || !Array.isArray(knownSids) || !knownSids.length) return null;
  // Pull UUID-ish windows from the text — any run of hex/letter/dash chars
  // 28-44 long that contains at least 3 dashes. Group sizes can deviate from
  // the canonical 8-4-4-4-12 by a few chars (OCR drops/inserts), so we don't
  // anchor on group lengths at all — we let the Levenshtein check below filter.
  const re = /[0-9A-Za-z\-]{28,44}/g;
  const cands = new Set();
  for (const m of text.matchAll(re)) {
    const compact = m[0];
    if ((compact.match(/-/g) || []).length < 3) continue;
    const coerced = _coerceHex(compact);
    const hex = coerced.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length >= 28 && hex.length <= 36) cands.add(hex);
  }
  if (!cands.size) return null;

  let best = null;
  let bestDist = maxEdits + 1;
  for (const cand of cands) {
    for (const sid of knownSids) {
      const norm = sid.toLowerCase().replace(/-/g, '');
      if (norm.length !== 32) continue;
      const d = _editDistance(cand, norm, maxEdits);
      if (d < bestDist) {
        bestDist = d;
        best = sid.toLowerCase();
      }
    }
  }
  return best;
}

// Focused SID extraction: crops the bottom statusline strip out of the
// full-screen PNG, upscales it 2x, and runs OCR on just that. On a 4K
// monitor the statusline font is too small in the full frame for Tesseract
// to reliably read the UUID — it inserts spurious chars (e.g. `e16b4a22`
// → `el6buda22`) that break the 8-4-4-4-12 group regex even after the
// letter-to-hex coercion runs. A focused 2x upscale of just the strip
// usually produces a clean read.
//
// Returns { sid, text } — sid is null when no UUID matched. Caller owns
// the worker so we don't pay for a re-init.
async function extractSidFromImage(png, worker) {
  if (!png || !worker) return { sid: null, text: '' };
  let electron;
  try { electron = require('electron'); }
  catch { return { sid: null, text: '' }; }
  const { nativeImage } = electron;
  if (!nativeImage) return { sid: null, text: '' };

  let img;
  try { img = nativeImage.createFromBuffer(png); }
  catch { return { sid: null, text: '' }; }
  const size = img.getSize();
  if (!size?.width || !size?.height) return { sid: null, text: '' };

  // Crop the bottom statusline band. We want enough vertical room to catch
  // a multi-line Claude Code statusline (often 2-3 lines: hint row, sid
  // row, model row) but exclude the Windows taskbar (~50px) below it,
  // which is pure icons/clock and just adds OCR noise.
  const TASKBAR_PX = 50;
  const bandH = Math.min(360, Math.max(120, Math.floor(size.height * 0.14)));
  const y = Math.max(0, size.height - TASKBAR_PX - bandH);
  let cropped;
  try {
    cropped = img.crop({
      x: 0,
      y,
      width: size.width,
      height: bandH,
    });
  } catch { return { sid: null, text: '' }; }

  const cSize = cropped.getSize();
  let upscaled;
  try {
    upscaled = cropped.resize({
      width: cSize.width * 2,
      quality: 'best',
    });
  } catch { upscaled = cropped; }

  const focusedPng = upscaled.toPNG();
  try {
    const path = require('node:path');
    const os = require('node:os');
    const fs = require('node:fs');
    fs.writeFileSync(path.join(os.homedir(), '.lm-voice', 'last-sidstrip.png'), focusedPng);
  } catch {}

  let recRes;
  try { recRes = await worker.recognize(focusedPng); }
  catch { return { sid: null, text: '' }; }
  const text = normalizeOcrText(recRes?.data?.text ?? '');
  try {
    const path = require('node:path');
    const os = require('node:os');
    const fs = require('node:fs');
    fs.writeFileSync(path.join(os.homedir(), '.lm-voice', 'last-sidstrip-ocr.txt'), text);
  } catch {}

  return { sid: extractSidFromText(text), text };
}

// Pull the last `sid: <uuid>` reference from screen OCR. Falls back to any
// bare UUID on the page (newest wins). Returns null if no UUID found.
// normalizeOcrText is expected to have hex-coerced common Tesseract misreads
// (0le → 01e, Ufef → 4fef) before this is called.
function extractSidFromText(text) {
  if (!text) return null;
  const explicit = [...text.matchAll(/\bsid\s*[:=]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
  if (explicit.length) return explicit[explicit.length - 1][1].toLowerCase();
  const bare = [...text.matchAll(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
  if (bare.length) return bare[bare.length - 1][1].toLowerCase();
  return null;
}

// Capture the primary screen as a PNG Buffer at NATIVE physical resolution.
//
// `display.size` is in device-independent pixels (DIP); on a 4K display at
// 200% Windows scaling it reports 1920×1080, not 3840×2160. Multiplying by
// `display.scaleFactor` recovers the true pixel grid so small text — code,
// labels, terminals — keeps the ≥ 10 px x-height that Tesseract (and any
// other OCR) needs to read it.
//
// A soft 4096 px cap guards against >8K displays where the PNG would balloon
// to 50+ MB; otherwise we send the screen 1:1, no cropping, no downscaling.
async function captureScreenPng({ debugSavePath = null } = {}) {
  let electron;
  try {
    electron = require('electron');
  } catch {
    return null;
  }
  const { desktopCapturer, screen } = electron;
  if (!desktopCapturer || !screen) return null;

  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor || 1;
  const physW = Math.round(primary.size.width * scale);
  const physH = Math.round(primary.size.height * scale);

  // Soft cap to keep PNG and OCR cost bounded on very large displays.
  const MAX_W = 4096;
  let tw = physW;
  let th = physH;
  if (tw > MAX_W) {
    const r = MAX_W / tw;
    tw = MAX_W;
    th = Math.round(physH * r);
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: tw, height: th },
  });
  if (!sources?.length) return null;
  const png = sources[0].thumbnail.toPNG();

  if (debugSavePath) {
    try { require('node:fs').writeFileSync(debugSavePath, png); } catch {}
  }
  return png;
}

// Reduce OCR text to lines, trim, drop short noise, keep ordering.
// Strip non-ASCII bytes: the screen is pure English so any non-ASCII output
// is Tesseract emitting Latin-1/UTF-8 for icon glyphs or chrome — drop it
// to keep the ambient text clean and parseable by the agent.
function normalizeOcrText(text) {
  let s = String(text || '').replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, ' ');
  s = fixHexishTokens(s);
  return s.split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3)
    .join('\n');
}

// Common OCR letter↔digit confusions when reading hex strings (UUIDs,
// session IDs, commit hashes). For tokens that mostly look hex but have a
// few stray letters, coerce the letters back to their digit twins so the
// agent sees the real identifier.
const _hexFix = {
  o: '0', O: '0',
  l: '1', I: '1', i: '1',
  z: '2', Z: '2',
  S: '5', s: '5',
  G: '6',
  T: '7',
  B: '8',
  g: '9', q: '9',
  U: '4', u: '4',
};
function _coerceHex(tok) {
  let out = '';
  for (const ch of tok) {
    if (/[0-9a-fA-F]/.test(ch)) out += ch.toLowerCase();
    else if (ch === '-') out += '-';
    else if (_hexFix[ch]) out += _hexFix[ch];
    else return tok; // unknown char — abort, leave original
  }
  return out;
}
function fixHexishTokens(s) {
  // UUID-shaped: 8-4-4-4-12, tolerating OCR-introduced whitespace around
  // hyphens and the most common letter↔digit confusions.
  const re = /\b[0-9A-Za-z]{8}\s*-\s*[0-9A-Za-z]{4}\s*-\s*[0-9A-Za-z]{4}\s*-\s*[0-9A-Za-z]{4}\s*-\s*[0-9A-Za-z]{12}\b/g;
  return s.replace(re, (m) => {
    const compact = m.replace(/\s+/g, '');
    const fixed = _coerceHex(compact);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fixed) ? fixed : m;
  });
}

// Return the meaningful delta between previous and current OCR text.
// OCR jitter (single-character differences across runs of the same screen)
// makes line-level comparison too noisy, so we use a word-set approach:
// extract all alphanumeric tokens ≥3 chars from both readings, return the
// new ones. Word order is lost but that's fine for "what's on screen now"
// awareness — the agent can infer context from the vocabulary.
function _tokens(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}
function computeTextDelta(prev, current, minChars = 40) {
  if (!current) return '';
  if (!prev) {
    return current.length >= minChars ? current.slice(0, 2000) : '';
  }
  const prevSet = new Set(_tokens(prev));
  // For each line in `current`, keep it intact if it contains tokens that
  // weren't in the previous reading. This preserves UUIDs, file paths, code
  // structure — anything where token order matters — while still deduping
  // repeated content via word-set comparison.
  const newLines = [];
  let newTokenCount = 0;
  for (const line of current.split('\n')) {
    const toks = _tokens(line);
    if (!toks.length) continue;
    const newInLine = toks.filter((t) => !prevSet.has(t));
    if (newInLine.length >= 2) {
      // Require ≥2 new tokens per line to filter pure OCR jitter on otherwise
      // unchanged lines (1-character variants still produce 1 "new" token).
      newLines.push(line);
      newTokenCount += newInLine.length;
    }
  }
  if (newTokenCount < 5) return '';
  const joined = newLines.join('\n');
  return joined.length >= minChars ? joined.slice(0, 2000) : '';
}

module.exports = {
  AmbientLog,
  SessionDeltaWatcher,
  ScreenshotOcrWatcher,
  captureScreenPng,
  extractSidFromText,
  extractSidFromImage,
  extractSidFuzzy,
  // exposed for tests
  computeTextDelta,
  normalizeOcrText,
};
