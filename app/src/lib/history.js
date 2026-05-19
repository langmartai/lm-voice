'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function historyDir() {
  return path.join(os.homedir(), '.lm-voice', 'history');
}

function ensureDir() {
  const d = historyDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(sessionId) {
  if (!sessionId) return null;
  // Use last 12 chars of session id for filename uniqueness; sanitize.
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(ensureDir(), `${safe}.jsonl`);
}

function append(sessionId, entry) {
  const f = fileFor(sessionId);
  if (!f) return;
  const line = JSON.stringify({
    ts: entry.ts ?? new Date().toISOString(),
    sessionId,
    ...entry,
  }) + '\n';
  fs.appendFileSync(f, line, 'utf8');
}

function readSession(sessionId, { limit = 50 } = {}) {
  const f = fileFor(sessionId);
  if (!f || !fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  const out = [];
  for (const l of tail) {
    try { out.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }
  return out;
}

function listSessions() {
  const d = ensureDir();
  const files = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl'));
  const out = [];
  for (const f of files) {
    const full = path.join(d, f);
    let last = null;
    try {
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine) last = JSON.parse(lastLine);
    } catch { /* skip */ }
    if (last) {
      out.push({
        sessionId: last.sessionId,
        lastTs: last.ts,
        lastText: last.text?.slice(0, 120),
        lastRole: last.role,
      });
    }
  }
  out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  return out;
}

module.exports = { append, readSession, listSessions, historyDir };
