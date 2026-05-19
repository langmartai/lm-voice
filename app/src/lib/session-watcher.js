'use strict';

const { EventEmitter } = require('node:events');

// Lightweight poll-based watcher over lm-assist /sessions and /monitor/executions.
// Emits state-change events for the pinned session and for background executions.
// lm-assist does not expose SSE/WebSocket, so we poll every intervalMs.
class SessionWatcher extends EventEmitter {
  constructor({ lmAssist, intervalMs = 15000 } = {}) {
    super();
    this.lmAssist = lmAssist;
    this.intervalMs = intervalMs;
    this.pinnedId = null;
    this.lastModifiedBySession = new Map();
    this.lastPinnedTurns = null;
    this.lastRunningCount = 0;
    this.lastRunningIds = new Set();
    this.recentEvents = [];
    this.timer = null;
    this.firstTick = true;
  }

  setClient(lmAssist) {
    this.lmAssist = lmAssist;
    // Endpoint changed — clear baselines so next tick reseeds without spurious events.
    this.lastModifiedBySession.clear();
    this.lastRunningCount = 0;
    this.lastRunningIds.clear();
    this.firstTick = true;
  }

  setPinnedSession(id) {
    this.pinnedId = id;
    this.lastPinnedTurns = null;
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

  pushEvent(evt) {
    this.recentEvents.unshift({ ...evt, at: Date.now() });
    if (this.recentEvents.length > 20) this.recentEvents.pop();
  }

  getSnapshot() {
    return {
      pinnedId: this.pinnedId,
      pinnedTurns: this.lastPinnedTurns,
      runningCount: this.lastRunningCount,
      runningIds: [...this.lastRunningIds],
      recent: this.recentEvents.slice(0, 8),
    };
  }

  consumeEvents() {
    const out = this.recentEvents.slice(0, 8);
    this.recentEvents = [];
    return out;
  }

  async tick() {
    if (!this.lmAssist) return;
    const wasFirst = this.firstTick;

    // 1. Sessions — detect pinned-changed + other-session-changed + new-session.
    try {
      const resp = await this.lmAssist.listSessions();
      const sessions = resp?.data?.sessions ?? resp?.sessions ?? (Array.isArray(resp) ? resp : []);
      for (const s of sessions) {
        const id = s.sessionId ?? s.id;
        if (!id) continue;
        const lastMod = s.lastModified;
        const prev = this.lastModifiedBySession.get(id);
        if (!wasFirst) {
          if (prev === undefined) {
            const evt = { type: 'session-new', id, label: s.sessionSummary?.slice(0, 80) };
            this.pushEvent(evt);
            this.emit('session-new', evt);
          } else if (prev !== lastMod) {
            if (id === this.pinnedId) {
              const delta = (s.numTurns ?? 0) - (this.lastPinnedTurns ?? s.numTurns ?? 0);
              const evt = { type: 'pinned-changed', id, label: s.sessionSummary?.slice(0, 80), delta };
              this.pushEvent(evt);
              this.emit('pinned-changed', evt);
            } else {
              const evt = { type: 'session-changed', id, label: s.sessionSummary?.slice(0, 80) };
              this.pushEvent(evt);
              this.emit('session-changed', evt);
            }
          }
        }
        if (id === this.pinnedId) this.lastPinnedTurns = s.numTurns;
        this.lastModifiedBySession.set(id, lastMod);
      }
    } catch (err) {
      this.emit('error', err);
    }

    // 2. Running executions — track set membership so we can fire per-execution events.
    try {
      const resp = await this.lmAssist.getMonitorExecutions();
      const execs = resp?.data?.executions ?? resp?.executions ?? (Array.isArray(resp) ? resp : []);
      const currentIds = new Set();
      for (const e of execs) {
        const id = e.executionId ?? e.id;
        if (id) currentIds.add(id);
      }
      if (!wasFirst) {
        for (const id of currentIds) {
          if (!this.lastRunningIds.has(id)) {
            const evt = { type: 'execution-started', id, count: currentIds.size };
            this.pushEvent(evt);
            this.emit('execution-started', evt);
          }
        }
        for (const id of this.lastRunningIds) {
          if (!currentIds.has(id)) {
            const evt = { type: 'execution-finished', id, count: currentIds.size };
            this.pushEvent(evt);
            this.emit('execution-finished', evt);
          }
        }
      }
      this.lastRunningIds = currentIds;
      this.lastRunningCount = currentIds.size;
    } catch (err) {
      this.emit('error', err);
    }

    this.firstTick = false;
  }
}

function speakStatus(snapshot, pinnedSession) {
  const lines = [];
  const recent = snapshot.recent ?? [];

  if (snapshot.runningCount > 0) {
    lines.push(`${snapshot.runningCount} background execution${snapshot.runningCount === 1 ? '' : 's'} running.`);
  }

  const pinnedEvt = recent.find((e) => e.type === 'pinned-changed');
  if (pinnedEvt && pinnedSession?.id) {
    const delta = pinnedEvt.delta ?? 0;
    if (delta > 0) lines.push(`Pinned session got ${delta} new turn${delta === 1 ? '' : 's'}.`);
    else lines.push(`Pinned session updated.`);
  }

  const otherChanged = recent.filter((e) => e.type === 'session-changed').length;
  if (otherChanged > 0) {
    lines.push(`${otherChanged} other session${otherChanged === 1 ? '' : 's'} had activity.`);
  }

  const startedExecs = recent.filter((e) => e.type === 'execution-started').length;
  if (startedExecs > 0 && snapshot.runningCount === 0) {
    // started and already finished
    lines.push(`${startedExecs} execution${startedExecs === 1 ? '' : 's'} started and finished.`);
  }

  if (!lines.length) return 'Nothing has changed.';
  return lines.join(' ');
}

module.exports = { SessionWatcher, speakStatus };
