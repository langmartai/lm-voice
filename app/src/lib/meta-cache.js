'use strict';

// Persistent metadata cache for hosts + Claude Code session info, so the
// popup and the agent prompt can show the world *instantly* on startup and
// during network blips — no waiting for a fresh /sessions round-trip.
//
// Layout:
//   ~/.lm-voice/meta-cache/hosts.json                  — { url → host info }
//   ~/.lm-voice/meta-cache/sessions/<sid>.json         — one file per session
//
// Writes are async-but-immediate (write-through); reads serve from the
// in-memory map when warm, otherwise lazy-load from disk on first access.
// Stale files are pruned automatically by `prune()`.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(os.homedir(), '.lm-voice', 'meta-cache');
const HOSTS_FILE = path.join(ROOT, 'hosts.json');
const SESSIONS_DIR = path.join(ROOT, 'sessions');

class MetaCache {
  constructor() {
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    this._hosts = this._loadHosts();
    this._sessions = new Map();
    this._sessionsLoadedFromDisk = false;
  }

  // ── hosts ───────────────────────────────────────────────────────────────
  _loadHosts() {
    try { return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')); } catch { return {}; }
  }
  _saveHosts() {
    try { fs.writeFileSync(HOSTS_FILE, JSON.stringify(this._hosts, null, 2)); } catch {}
  }

  upsertHost(url, info = {}) {
    if (!url) return null;
    const prev = this._hosts[url] || {};
    this._hosts[url] = {
      url,
      ...prev,
      ...info,
      lastSeenAt: new Date().toISOString(),
    };
    this._saveHosts();
    return this._hosts[url];
  }

  markHostError(url, err) {
    if (!url) return;
    const prev = this._hosts[url] || { url };
    this._hosts[url] = {
      ...prev,
      url,
      lastError: err?.message || String(err),
      lastErrorAt: new Date().toISOString(),
    };
    this._saveHosts();
  }

  getHost(url) { return url ? this._hosts[url] || null : null; }
  listHosts() { return Object.values(this._hosts); }

  // ── sessions ────────────────────────────────────────────────────────────
  _sessionPath(sid) { return path.join(SESSIONS_DIR, `${sid}.json`); }

  upsertSession(sid, info = {}) {
    if (!sid) return null;
    const prev = this._sessions.get(sid) || this._readSessionFile(sid) || {};
    const merged = { ...prev, sid, ...info, cachedAt: new Date().toISOString() };
    this._sessions.set(sid, merged);
    try { fs.writeFileSync(this._sessionPath(sid), JSON.stringify(merged, null, 2)); } catch {}
    return merged;
  }

  _readSessionFile(sid) {
    try { return JSON.parse(fs.readFileSync(this._sessionPath(sid), 'utf8')); } catch { return null; }
  }

  getSession(sid) {
    if (!sid) return null;
    if (this._sessions.has(sid)) return this._sessions.get(sid);
    const file = this._readSessionFile(sid);
    if (file) this._sessions.set(sid, file);
    return file;
  }

  listCachedSessions({ host = null, sinceMs = 0 } = {}) {
    if (!this._sessionsLoadedFromDisk) this._loadAllSessions();
    const all = [...this._sessions.values()];
    return all
      .filter((s) => (!host || s.host === host))
      .filter((s) => (!sinceMs || (Date.parse(s.lastModified) || 0) >= sinceMs))
      .sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));
  }

  _loadAllSessions() {
    let files;
    try { files = fs.readdirSync(SESSIONS_DIR); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const sid = f.slice(0, -5);
      if (this._sessions.has(sid)) continue;
      const data = this._readSessionFile(sid);
      if (data) this._sessions.set(sid, data);
    }
    this._sessionsLoadedFromDisk = true;
  }

  // Bulk write-through after a successful `listSessions()` call on a host.
  upsertSessionsFromHost(hostUrl, sessions) {
    for (const s of sessions || []) {
      const sid = s.sessionId ?? s.id;
      if (!sid) continue;
      this.upsertSession(sid, {
        host: hostUrl,
        cwd: s.cwd ?? s.projectPath ?? null,
        lastModified: s.lastModified,
        numTurns: s.numTurns,
        summary: s.sessionSummary?.slice(0, 200),
        label: s.customTitle || s.slug || null,
        size: s.size,
      });
    }
  }

  // Maintenance: drop session files we haven't refreshed in `olderThanMs`.
  prune({ olderThanMs = 30 * 24 * 3600 * 1000 } = {}) {
    let files;
    try { files = fs.readdirSync(SESSIONS_DIR); } catch { return 0; }
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const f of files) {
      const fp = path.join(SESSIONS_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          this._sessions.delete(f.slice(0, -5));
          removed++;
        }
      } catch {}
    }
    return removed;
  }

  stats() {
    if (!this._sessionsLoadedFromDisk) this._loadAllSessions();
    return {
      root: ROOT,
      hostCount: Object.keys(this._hosts).length,
      sessionCount: this._sessions.size,
    };
  }
}

module.exports = { MetaCache, META_ROOT: ROOT };
