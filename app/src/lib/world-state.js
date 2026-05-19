'use strict';

// Single source of truth for "what is going on right now" — host, project,
// active Claude Code session, that session's status, other related sessions,
// and any running agents. Refreshed on demand (hotkey press, manual call)
// and consumed by the agent prompt + the /api/state surface.
//
// The "active session" is resolved with this priority:
//   1. Explicitly given (e.g. SID just OCR'd off the screen)
//   2. User's pinned session (config.session.id), if it still exists upstream
//   3. Most-recently-modified non-voice-agent session on the host
//
// Project = basename of the active session's cwd. Crude but it's the same
// signal IDEs use, and most users name projects after their folder.

const path = require('node:path');

function basename(p) {
  if (!p) return null;
  return String(p).split(/[\\/]+/).filter(Boolean).pop() || null;
}

function safeNum(x) { return typeof x === 'number' ? x : Number(x) || 0; }

class WorldState {
  constructor({ lmAssist, excludeIds = new Set(), endpoint = '' } = {}) {
    this.lmAssist = lmAssist;
    this.excludeIds = excludeIds;
    this.endpoint = endpoint;
    this.snapshot = {
      refreshedAt: 0,
      host: { endpoint, version: null, status: null, hostname: null },
      project: null,
      activeSession: null,    // { sid, label, cwd, lastModified, numTurns, runningExec }
      relatedSessions: [],    // up to 5 other recently-modified non-voice sessions
      runningExecutions: [],  // active /monitor/executions
    };
  }

  setClient(lmAssist, endpoint) {
    this.lmAssist = lmAssist;
    if (endpoint) this.endpoint = endpoint;
  }

  setExclude(set) { this.excludeIds = set || new Set(); }

  // Refresh the snapshot from lm-assist. `hintedSid` lets the caller bias
  // toward a specific session id (e.g. one we just OCR'd off the screen),
  // overriding the pinned/most-recent heuristic.
  async refresh({ hintedSid = null, pinnedSessionId = null } = {}) {
    if (!this.lmAssist) return this.snapshot;
    const t0 = Date.now();
    let sessions = [];
    let executions = [];
    let health = null;

    try {
      const resp = await this.lmAssist.listSessions();
      sessions = resp?.sessions ?? resp?.data?.sessions ?? (Array.isArray(resp) ? resp : []);
    } catch {}

    try {
      const resp = await this.lmAssist.getMonitorExecutions();
      executions = resp?.executions ?? resp?.data?.executions ?? [];
    } catch {}

    try { health = await this.lmAssist.health(); } catch {}

    // Filter our voice-agent's own sessions out so the agent doesn't fixate on them.
    const live = sessions
      .filter((s) => {
        const id = s.sessionId ?? s.id;
        return id && !this.excludeIds.has(id);
      })
      .sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));

    // Resolve the active session.
    let active = null;
    if (hintedSid) active = live.find((s) => (s.sessionId ?? s.id) === hintedSid) || null;
    if (!active && pinnedSessionId) active = live.find((s) => (s.sessionId ?? s.id) === pinnedSessionId) || null;
    if (!active) active = live[0] ?? null;

    const activeSid = active ? (active.sessionId ?? active.id) : null;
    const runningForActive = executions.find((e) => (e.sessionId === activeSid)) || null;

    this.snapshot = {
      refreshedAt: Date.now(),
      refreshMs: Date.now() - t0,
      host: {
        endpoint: this.endpoint,
        version: health?.version ?? null,
        status: health?.status ?? null,
        hostname: health?.hostname ?? null,
      },
      project: active ? basename(active.cwd ?? active.projectPath) : null,
      activeSession: active ? {
        sid: activeSid,
        label: active.customTitle || active.slug || basename(active.cwd ?? active.projectPath) || (activeSid || '').slice(0, 8),
        cwd: active.cwd ?? active.projectPath ?? null,
        lastModified: active.lastModified,
        numTurns: safeNum(active.numTurns),
        summary: active.sessionSummary?.slice(0, 200) ?? null,
        runningExec: runningForActive ? { executionId: runningForActive.executionId, startedAt: runningForActive.startedAt } : null,
        hinted: !!hintedSid,
        pinned: !hintedSid && !!pinnedSessionId,
      } : null,
      relatedSessions: live.slice(0, 6).map((s) => ({
        sid: s.sessionId ?? s.id,
        label: s.customTitle || s.slug || basename(s.cwd ?? s.projectPath) || (s.sessionId ?? '').slice(0, 8),
        cwd: s.cwd ?? s.projectPath ?? null,
        lastModified: s.lastModified,
        numTurns: safeNum(s.numTurns),
      })),
      runningExecutions: executions.map((e) => ({
        executionId: e.executionId,
        sessionId: e.sessionId,
        startedAt: e.startedAt,
      })),
    };
    return this.snapshot;
  }

  getSnapshot() { return this.snapshot; }

  // Render the snapshot as a compact, agent-readable context block to
  // prepend to the next prompt. Targets ≤ 400 tokens so it doesn't crowd
  // the user's actual question.
  formatForPrompt() {
    const s = this.snapshot;
    if (!s || !s.activeSession) return '';
    const lines = [];
    lines.push('[WORLD STATE — what the user is currently doing]');
    lines.push(`Host: ${s.host.endpoint}${s.host.version ? ` (lm-assist ${s.host.version})` : ''}`);
    if (s.project) lines.push(`Project: ${s.project}`);
    const a = s.activeSession;
    lines.push(`Active session: ${a.label} (sid ${a.sid.slice(0, 8)}, ${a.numTurns} turns, last activity ${this._ago(a.lastModified)})`);
    if (a.cwd) lines.push(`  cwd: ${a.cwd}`);
    if (a.summary) lines.push(`  summary: ${a.summary}`);
    if (a.runningExec) lines.push(`  *currently running* — execution ${a.runningExec.executionId.slice(0, 16)} started ${this._ago(a.runningExec.startedAt)}`);
    if (a.hinted) lines.push(`  (this session id was read off the user's screen)`);
    else if (a.pinned) lines.push(`  (this is the user's pinned session)`);
    else lines.push(`  (most-recently-active session on this host)`);

    if (s.relatedSessions.length > 1) {
      const others = s.relatedSessions.filter((r) => r.sid !== a.sid).slice(0, 4);
      if (others.length) {
        lines.push(`Other recent sessions on the same host:`);
        for (const o of others) {
          lines.push(`  - ${o.label} (sid ${o.sid.slice(0, 8)}, ${o.numTurns} turns, ${this._ago(o.lastModified)})`);
        }
      }
    }

    if (s.runningExecutions.length > 0) {
      lines.push(`Background executions in flight: ${s.runningExecutions.length}`);
    } else {
      lines.push(`No background executions running.`);
    }

    lines.push('[END WORLD STATE]');
    return lines.join('\n');
  }

  _ago(iso) {
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
}

module.exports = { WorldState };
