'use strict';

// Background poller for *every* registered lm-assist host. Cheap: each tick
// is one HTTP GET /sessions per host (a few KB of JSON), no OCR, no LLM.
// Detects:
//   - new sessions appearing on a host
//   - existing sessions whose lastModified advanced
//   - the host going down / coming back up
// Emits events so main.js can push notifications, and exposes a snapshot +
// a prompt-ready summary so the agent can answer "anything happening
// elsewhere?" without making extra API calls during a turn.
//
// Does NOT replace WorldState (which owns the *current* host in detail).
// This is the "what's going on across the rest of my fleet" channel.

const { EventEmitter } = require('node:events');
const { LMAssistClient } = require('./lm-assist-client');

class MultiHostMonitor extends EventEmitter {
  constructor({ servers = [], currentEndpoint = '', intervalMs = 30_000, excludeIds = new Set(), maxSessionsPerHost = 100, maxProjectsPerHost = 12 } = {}) {
    super();
    this.servers = servers.slice();                // [{ url, label }, ...]
    this.currentEndpoint = currentEndpoint;
    this.intervalMs = intervalMs;
    this.excludeIds = excludeIds;
    this.maxSessionsPerHost = maxSessionsPerHost;
    this.maxProjectsPerHost = maxProjectsPerHost;
    this.clients = new Map();    // url → LMAssistClient
    this.snapshots = new Map();  // url → { label, sessions[], lastFetchAt, health, error }
    this.timer = null;
    this.firstTick = true;
  }

  setServers(servers) {
    this.servers = (servers || []).slice();
    // Drop snapshots/clients for hosts that aren't in the list anymore
    const urls = new Set(this.servers.map((s) => s.url));
    for (const k of [...this.clients.keys()]) if (!urls.has(k)) this.clients.delete(k);
    for (const k of [...this.snapshots.keys()]) if (!urls.has(k)) this.snapshots.delete(k);
  }
  setCurrentEndpoint(endpoint) { this.currentEndpoint = endpoint; }
  setExclude(set) { this.excludeIds = set || new Set(); }

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async tick() {
    const wasFirst = this.firstTick;
    for (const server of this.servers) {
      // Skip the host that WorldState owns in detail — no duplicate work.
      if (server.url === this.currentEndpoint) continue;
      try {
        let client = this.clients.get(server.url);
        if (!client) { client = new LMAssistClient({ endpoint: server.url }); this.clients.set(server.url, client); }
        let health = null;
        try { health = await client.health(); } catch {}

        // PREFERRED PATH — list every project on the host via /projects,
        // then fetch the top N sessions for each project and merge. This
        // bypasses the daemon's `--project` scope (which would otherwise
        // hide sessions that live in subdirectories of the bound path).
        let all = [];
        let projectsUsed = false;
        try {
          const projResp = await client.listProjects({ includeSize: false });
          const projects = projResp?.data?.projects ?? projResp?.projects ?? [];
          if (Array.isArray(projects) && projects.length) {
            projectsUsed = true;
            // Sort projects by lastModified desc; fetch sessions from the top
            // few (cap to keep tick cost bounded — most hosts have <10 active
            // projects but a few have dozens of stale ones).
            const sortedProjects = projects
              .slice()
              .sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0))
              .slice(0, this.maxProjectsPerHost);
            const seen = new Set();
            // Limited parallelism so a host with 20 projects doesn't flood.
            const results = await Promise.all(sortedProjects.map(async (p) => {
              const encoded = p.encodedPath || p.encoded || (p.path ? p.path.replace(/\//g, '-') : null);
              if (!encoded) return [];
              try {
                const r = await client.listProjectSessions(encoded);
                return r?.data?.sessions ?? r?.sessions ?? [];
              } catch { return []; }
            }));
            for (const arr of results) {
              for (const s of arr) {
                const id = s.sessionId ?? s.id;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                all.push(s);
              }
            }
          }
        } catch {
          // /projects not available on this daemon — fall through to the
          // legacy single-scope listing below.
        }

        // FALLBACK — older lm-assist or one that doesn't expose /projects.
        if (!projectsUsed) {
          const resp = await client.listSessions();
          all = resp?.sessions ?? resp?.data?.sessions ?? [];
        }

        const filtered = all
          .filter((s) => {
            const id = s.sessionId ?? s.id;
            return id && !this.excludeIds.has(id);
          })
          .sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0))
          .slice(0, this.maxSessionsPerHost);

        const prev = this.snapshots.get(server.url);
        this.snapshots.set(server.url, {
          label: server.label || server.url,
          sessions: filtered,
          lastFetchAt: Date.now(),
          health: health ? { version: health.version, status: health.status, hostname: health.hostname } : null,
          error: null,
        });

        if (!wasFirst && prev) {
          const oldIds = new Set(prev.sessions.map((s) => s.sessionId ?? s.id));
          const oldMod = new Map(prev.sessions.map((s) => [s.sessionId ?? s.id, s.lastModified]));
          for (const s of filtered) {
            const sid = s.sessionId ?? s.id;
            if (!oldIds.has(sid)) {
              this.emit('host-session-new', { host: server.url, label: server.label, sid, summary: s.sessionSummary });
            } else if (oldMod.get(sid) !== s.lastModified) {
              this.emit('host-session-changed', { host: server.url, label: server.label, sid, summary: s.sessionSummary });
            }
          }
        }
      } catch (err) {
        const prev = this.snapshots.get(server.url);
        const wasUp = prev && !prev.error;
        this.snapshots.set(server.url, {
          label: server.label || server.url,
          sessions: prev?.sessions ?? [],
          lastFetchAt: Date.now(),
          health: prev?.health ?? null,
          error: err.message,
        });
        if (wasUp) this.emit('host-down', { host: server.url, label: server.label, error: err.message });
      }
    }
    this.firstTick = false;
  }

  getSnapshot() {
    const out = {};
    for (const [url, snap] of this.snapshots) out[url] = snap;
    return out;
  }

  // Compact prompt-ready summary of the OTHER hosts only. Empty string if
  // there's nothing to show so the agent prompt stays lean.
  formatForPrompt() {
    if (this.snapshots.size === 0) return '';
    const lines = [];
    for (const [url, snap] of this.snapshots) {
      if (!snap.sessions.length && !snap.error) continue;
      if (snap.error) {
        lines.push(`Host ${snap.label || url}: unreachable (${snap.error.slice(0, 80)})`);
        continue;
      }
      const labelLine = `Host ${snap.label || url}${snap.health?.version ? ` (lm-assist ${snap.health.version})` : ''}:`;
      lines.push(labelLine);
      for (const s of snap.sessions.slice(0, 3)) {
        const sid = (s.sessionId ?? s.id ?? '').slice(0, 8);
        const title = s.customTitle || s.slug || s.sessionSummary?.split(' — ')[0]?.slice(0, 60) || 'session';
        const turns = s.numTurns ?? 0;
        lines.push(`  - ${title} (sid ${sid}, ${turns} turns, ${_ago(s.lastModified)})`);
      }
    }
    if (!lines.length) return '';
    return ['[OTHER HOSTS — recent session activity]', ...lines, '[END OTHER HOSTS]'].join('\n');
  }
}

function _ago(iso) {
  if (!iso) return 'unknown';
  const t = Date.parse(iso) || 0;
  if (!t) return 'unknown';
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return 'just now';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

module.exports = { MultiHostMonitor };
