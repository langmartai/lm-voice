'use strict';

const { ipcRenderer, clipboard } = require('electron');

const $ = (id) => document.getElementById(id);

const state = {
  hosts: [],
  otherHosts: {},
  currentEndpoint: null,
  // Tab state
  activeTab: 'conversation',
  // Host tab state
  hostFilter: 'all',
  hostSearch: '',
  hostSelectedKey: null,
  // Session tab state
  sessHostFilter: '',       // url filter, '' = all
  sessRecencyMs: 0,         // any time by default
  sessSearch: '',
  sessSelectedId: null,
  sessConv: null,           // last fetched conversation { sid, messages }
  sessSubTab: 'conversation', // 'conversation' | 'details'
  // Projects tab state — aggregates sessions across hosts by project name
  projSearch: '',
  projSelectedKey: null,
  // Conversation tab state — live bubbles from the agent + STT
  conv: [],                 // [{ id, role, text, count?, isInterim? }]
  convInterimId: null,      // id of the currently-streaming user bubble
  // World / engine
  world: null,
  session: null,
  statusText: 'Idle',
  statusClass: 'idle',
  engineEvents: [],
  engineFilter: '',
  engineSearch: '',
  engineFollow: true,
};

// ── element refs ──
const hostListEl    = $('host-list');
const hostDetailEl  = $('host-detail');
const sessListEl    = $('session-list');
const sessDetailEl  = $('session-detail');
const summaryEl     = $('header-summary');
const statusEl      = $('status-text');
const hostSearchEl  = $('host-search');
const sessSearchEl  = $('sess-search');
const sessHostFilterEl = $('sess-host-filter');
const sessRecencyEl = $('sess-recency-filter');
const projListEl   = $('project-list');
const projDetailEl = $('project-detail');
const projSearchEl = $('proj-search');
const countProjectsEl = $('count-projects');
const countHostsEl  = $('count-hosts');
const countSessionsEl = $('count-sessions');
const countEngineEl   = $('count-engine');

const convListEl   = $('conv-list');
const convInputEl  = $('conv-input');
const convSendBtn  = $('conv-send');
const convDotEl    = $('conv-dot');
const convStatusEl = $('conv-status-text');
const convProjectEl = $('conv-project');
const convSessionEl = $('conv-session');
const convHostEl   = $('conv-host');

const engineListEl   = $('engine-list');
const engineSourceFilterEl = $('engine-source-filter');
const engineSearchEl = $('engine-search');
const engineClearBtn = $('engine-clear');
const engineFollowEl = $('engine-follow');

// ── constants ──
const CAT_RANK = { 'direct': 0, 'via-ssh': 1, 'proxy': 2, 'ssh-only': 3, 'failed': 4 };
const CAT_LABEL = {
  'direct': 'lm-assist', 'via-ssh': 'via SSH', 'proxy': 'proxy',
  'ssh-only': 'SSH only', 'failed': 'unreachable',
};

// ── helpers ──
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}
function classifyHost(h) {
  if (h.sshOnly) return h.sshVerifiedAt ? 'ssh-only' : 'failed';
  if (h.viaSsh) return 'via-ssh';
  const m = String(h.url || '').match(/:(\d+)$/);
  const port = m ? m[1] : null;
  if (port && port !== '3100') return 'proxy';
  return 'direct';
}
function ipOfEntry(h) {
  const m = String(h.url || '').match(/^[a-z]+:\/\/([^/:]+)/i);
  return m ? m[1] : null;
}
function hostKey(h) {
  const name = h.hostname || h.remoteHostname;
  if (name) return 'name:' + name;
  const ip = ipOfEntry(h);
  return ip ? 'ip:' + ip : 'url:' + h.url;
}
function describeAccess(a) {
  if (!a) return null;
  const parts = ['ssh'];
  if (a.keyFile) parts.push('-i', a.keyFile);
  if (a.port) parts.push('-p', String(a.port));
  parts.push(`${a.user ? a.user + '@' : ''}${a.host}`);
  return parts.join(' ');
}
function fmtRelative(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const delta = (Date.now() - t) / 1000;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d ago`;
  if (delta < 30 * 86400) return `${Math.floor(delta / (7 * 86400))}w ago`;
  if (delta < 365 * 86400) return `${Math.floor(delta / (30 * 86400))}mo ago`;
  return `${Math.floor(delta / (365 * 86400))}y ago`;
}
function projShortName(p) {
  if (!p) return '(unknown)';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
function shortSid(sid) {
  return sid ? String(sid).slice(0, 8) : '?';
}

// ── data shaping ──
function buildHostGroups() {
  const groups = new Map();
  for (const h of state.hosts) {
    const key = hostKey(h);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const out = [];
  for (const [key, entries] of groups) {
    const hostname = entries.map((e) => e.hostname || e.remoteHostname).find(Boolean) || null;
    const ips = [...new Set(entries.map(ipOfEntry).filter(Boolean))];
    const users = [];
    for (const e of entries) {
      const u = e.access?.user;
      if (u && !users.includes(u)) users.push(u);
    }
    const cats = entries.map(classifyHost).sort((a, b) => CAT_RANK[a] - CAT_RANK[b]);
    const bestCat = cats[0];
    const version = entries.map((e) => e.version).find(Boolean) || null;
    let totalSessions = 0;
    for (const e of entries) {
      const live = state.otherHosts[e.url];
      if (live?.sessions) totalSessions += live.sessions.length;
    }
    out.push({ key, hostname, ips, users, bestCat, version, totalSessions, entries });
  }
  out.sort((a, b) => {
    if (CAT_RANK[a.bestCat] !== CAT_RANK[b.bestCat]) return CAT_RANK[a.bestCat] - CAT_RANK[b.bestCat];
    return (a.hostname || a.key).localeCompare(b.hostname || b.key);
  });
  return out;
}

// Flatten all sessions across all hosts into a unified list. Deduplicate by
// sessionId. When the same session is reported by multiple URLs (different
// loopback addresses of the same machine) we keep the entry with the most
// recent `lastModified` so the ordering reflects truly-latest state.
function getAllSessions() {
  const bySid = new Map();
  for (const [url, snap] of Object.entries(state.otherHosts)) {
    if (!snap?.sessions) continue;
    const hostname = snap.label || snap.health?.hostname || null;
    for (const s of snap.sessions) {
      const sid = s.sessionId ?? s.id;
      if (!sid) continue;
      const existing = bySid.get(sid);
      if (existing) {
        existing._seenOnHosts.push(url);
        // Pick the freshest lastModified + numTurns we've seen.
        const cur = Date.parse(s.lastModified) || 0;
        const prev = Date.parse(existing.lastModified) || 0;
        if (cur > prev) {
          existing.lastModified = s.lastModified;
          existing.numTurns = s.numTurns ?? existing.numTurns;
          existing.userPromptCount = s.userPromptCount ?? existing.userPromptCount;
          existing.totalCostUsd = s.totalCostUsd ?? existing.totalCostUsd;
          existing.lastUserMessage = s.lastUserMessage ?? existing.lastUserMessage;
        }
        continue;
      }
      bySid.set(sid, { ...s, _host: url, _hostname: hostname, _seenOnHosts: [url] });
    }
  }
  const out = [...bySid.values()];
  out.sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));
  return out;
}

// Hosts dropdown should also be deduped by hostname (machine), not URL.
function getHostsWithSessions() {
  // Group session counts by machine identity (hostname when available, IP
  // otherwise). Multiple URLs that hit the same machine collapse into one
  // dropdown entry, with the count being unique-sessionId count.
  const byMachine = new Map();
  for (const [url, snap] of Object.entries(state.otherHosts)) {
    if (!snap?.sessions?.length) continue;
    const hostname = snap.label || snap.health?.hostname || null;
    const key = hostname || url;
    if (!byMachine.has(key)) byMachine.set(key, { hostname: hostname || url, urls: [], sids: new Set() });
    const m = byMachine.get(key);
    m.urls.push(url);
    for (const s of snap.sessions) {
      const sid = s.sessionId ?? s.id;
      if (sid) m.sids.add(sid);
    }
  }
  const out = [];
  for (const m of byMachine.values()) {
    // Pick the canonical URL for filtering (first listed). Filter compares
    // against `_seenOnHosts` on the session record, not a single URL.
    out.push({ url: m.urls[0], urls: m.urls, hostname: m.hostname, count: m.sids.size });
  }
  out.sort((a, b) => a.hostname.localeCompare(b.hostname));
  return out;
}

// ── HOSTS TAB ──
function renderHostsTab() {
  const groups = buildHostGroups();
  const all = groups.filter((g) => {
    if (state.hostFilter === 'lm-assist') return g.bestCat === 'direct' || g.bestCat === 'via-ssh';
    if (state.hostFilter === 'ssh') return g.bestCat === 'ssh-only';
    return true;
  }).filter((g) => {
    if (!state.hostSearch) return true;
    const q = state.hostSearch.toLowerCase();
    if ((g.hostname || '').toLowerCase().includes(q)) return true;
    for (const ip of g.ips) if (ip.toLowerCase().includes(q)) return true;
    for (const u of g.users) if (u.toLowerCase().includes(q)) return true;
    return false;
  });

  if (!all.find((g) => g.key === state.hostSelectedKey)) {
    state.hostSelectedKey = all[0]?.key ?? null;
  }

  if (!all.length) {
    hostListEl.innerHTML = `<div class="muted" style="padding:20px;text-align:center">No hosts match.</div>`;
    hostDetailEl.innerHTML = `<div class="empty-detail">Run Discover to find hosts.</div>`;
    return;
  }

  hostListEl.innerHTML = all.map((g) => renderHostListItem(g)).join('');
  for (const item of hostListEl.querySelectorAll('.host-item')) {
    item.addEventListener('click', () => {
      state.hostSelectedKey = item.getAttribute('data-key');
      renderHostsTab();
    });
  }

  const sel = all.find((g) => g.key === state.hostSelectedKey);
  hostDetailEl.innerHTML = sel ? renderHostDetail(sel) : `<div class="empty-detail">Select a host.</div>`;
  wireHostDetail();
}

function renderHostListItem(g) {
  const isCurrent = g.entries.some((e) => e.url === state.currentEndpoint);
  const isSelected = g.key === state.hostSelectedKey;
  const name = g.hostname || g.ips[0] || '(unknown)';
  const ipShort = g.ips.length === 0 ? '—' : g.ips.length === 1 ? g.ips[0] : `${g.ips[0]} +${g.ips.length - 1}`;
  const user = g.users[0] || '';
  const subBits = [];
  if (ipShort !== '—') subBits.push(ipShort);
  if (user) subBits.push(`${user}@`);
  return `
    <div class="host-item ${g.bestCat}${isCurrent ? ' current' : ''}${isSelected ? ' selected' : ''}" data-key="${escapeHtml(g.key)}">
      <span class="dot"></span>
      <div class="body">
        <div class="name">${escapeHtml(name)}${isCurrent ? '<span class="cur-pill">current</span>' : ''}</div>
        <div class="sub">${escapeHtml(subBits.join(' · '))}</div>
      </div>
      <span class="tag">${escapeHtml(CAT_LABEL[g.bestCat])}</span>
    </div>
  `;
}

function renderHostDetail(g) {
  const isCurrent = g.entries.some((e) => e.url === state.currentEndpoint);
  const name = g.hostname || g.ips[0] || '(unknown)';
  const ipText = g.ips.length ? g.ips.join(', ') : '—';
  const userText = g.users.length ? g.users.join(', ') : '—';

  const infoCells = [
    { k: 'Hostname',                                v: name },
    { k: 'IP address' + (g.ips.length > 1 ? 'es' : ''), v: ipText },
    { k: 'SSH user' + (g.users.length > 1 ? 's' : ''), v: userText },
    { k: 'Endpoints',                               v: String(g.entries.length) },
  ];
  if (g.version) infoCells.push({ k: 'Version', v: g.version });
  if (g.totalSessions) infoCells.push({ k: 'Live sessions', v: String(g.totalSessions) });

  const epHtml = g.entries
    .slice()
    .sort((a, b) => CAT_RANK[classifyHost(a)] - CAT_RANK[classifyHost(b)])
    .map((e) => {
      const cls = classifyHost(e);
      const isActive = e.url === state.currentEndpoint;
      const liveSnap = state.otherHosts[e.url];
      const sessionCount = liveSnap?.sessions?.length;
      const metaBits = [];
      if (e.version) metaBits.push(`v${e.version}`);
      if (sessionCount != null) metaBits.push(`${sessionCount} session${sessionCount === 1 ? '' : 's'}`);
      if (isActive) metaBits.push('active');
      const canSelect = (cls === 'direct' || cls === 'via-ssh' || cls === 'proxy') && !isActive;
      return `
        <div class="endpoint ${cls}${isActive ? ' active' : ''}">
          <div style="flex:1;min-width:0">
            <div class="ep-url">${escapeHtml(e.url)}</div>
            ${metaBits.length ? `<div class="ep-meta">${escapeHtml(metaBits.join(' · '))}</div>` : ''}
          </div>
          <span class="ep-tag">${escapeHtml(CAT_LABEL[cls])}</span>
          ${canSelect ? `<button class="btn-use" data-url="${escapeHtml(e.url)}">Use</button>` : ''}
        </div>`;
    }).join('');

  const sshSeen = new Set();
  const sshLines = [];
  for (const e of g.entries) {
    const cmd = describeAccess(e.access);
    if (cmd && !sshSeen.has(cmd)) { sshSeen.add(cmd); sshLines.push(cmd); }
  }
  const sshHtml = sshLines.length
    ? sshLines.map((cmd) => `
        <div class="ssh-block">
          <code>${escapeHtml(cmd)}</code>
          <button class="copy-btn" data-copy="${escapeHtml(cmd)}">Copy</button>
        </div>`).join('')
    : `<div class="muted">No SSH access recorded.</div>`;

  // Build the session list for this host (deduped by sessionId across its
  // URLs). Show a compact list; clicking a row jumps to the Sessions tab
  // with this host pre-filtered and the session selected.
  const seenSids = new Set();
  const hostSessions = [];
  for (const e of g.entries) {
    const liveSnap = state.otherHosts[e.url];
    if (!liveSnap?.sessions) continue;
    for (const s of liveSnap.sessions) {
      const sid = s.sessionId ?? s.id;
      if (!sid || seenSids.has(sid)) continue;
      seenSids.add(sid);
      hostSessions.push(s);
    }
  }
  hostSessions.sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));

  let sessHtml;
  if (!hostSessions.length) {
    sessHtml = `<div class="muted">No active sessions on this host.</div>`;
  } else {
    const machineHostname = g.hostname || g.ips[0] || '';
    sessHtml = hostSessions.slice(0, 30).map((s) => {
      const sid = s.sessionId ?? s.id;
      const proj = projShortName(s.projectPath ?? s.cwd ?? '');
      const turns = s.userPromptCount ?? s.numTurns;
      const cost = typeof s.totalCostUsd === 'number' ? `$${s.totalCostUsd.toFixed(2)}` : '';
      const when = fmtRelative(s.lastModified);
      const isRunning = !!s.runningExec;
      return `
        <div class="host-session-row${isRunning ? ' running' : ''}" data-sid="${escapeHtml(sid)}" data-host="${escapeHtml(machineHostname)}">
          <div class="hsr-proj">${escapeHtml(proj)}</div>
          <div class="hsr-meta">
            ${turns != null ? `<span class="hsr-turns">${escapeHtml(String(turns))}T</span>` : ''}
            ${cost ? `<span class="hsr-cost">${escapeHtml(cost)}</span>` : ''}
            <span class="hsr-when">${escapeHtml(when)}</span>
          </div>
          <div class="hsr-sid">${escapeHtml(sid)}</div>
        </div>`;
    }).join('')
      + (hostSessions.length > 30 ? `<div class="muted" style="margin-top:6px">+${hostSessions.length - 30} more…</div>` : '')
      + `<div style="margin-top:10px"><button class="btn-use" data-action="view-sessions" data-host="${escapeHtml(g.hostname || g.ips[0] || '')}">View all in Sessions tab</button></div>`;
  }

  return `
    <div class="detail-head ${g.bestCat}">
      <span class="dot"></span>
      <div class="detail-title">
        <h2>${escapeHtml(name)}</h2>
        <div class="meta">${escapeHtml(`${g.ips.join(', ') || '—'}  ·  ${g.entries.length} endpoint${g.entries.length === 1 ? '' : 's'}`)}</div>
      </div>
      <span class="tag-big">${escapeHtml(CAT_LABEL[g.bestCat])}${g.version ? ' · v' + escapeHtml(g.version) : ''}</span>
    </div>

    <div class="section">
      <h3>Overview</h3>
      <div class="info-grid">
        ${infoCells.map((c) => `
          <div class="info-cell">
            <div class="k">${escapeHtml(c.k)}</div>
            <div class="v">${escapeHtml(c.v)}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="section">
      <h3>Sessions (${hostSessions.length})</h3>
      ${sessHtml}
    </div>

    <div class="section">
      <h3>Endpoints (${g.entries.length})</h3>
      ${epHtml}
    </div>

    <div class="section">
      <h3>SSH access</h3>
      ${sshHtml}
    </div>
  `;
}

function wireHostDetail() {
  for (const btn of hostDetailEl.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', () => {
      const txt = btn.getAttribute('data-copy');
      try { clipboard.writeText(txt); } catch {}
      btn.classList.add('copied');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1200);
    });
  }
  for (const btn of hostDetailEl.querySelectorAll('.btn-use')) {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      if (action === 'view-sessions') {
        // Jump to Sessions tab pre-filtered to this host.
        state.sessHostFilter = btn.getAttribute('data-host') || '';
        state.sessSelectedId = null;
        state.sessConv = null;
        state.sessSubTab = 'conversation';
        setActiveTab('sessions');
        statusEl.textContent = `Filtered Sessions tab to ${state.sessHostFilter}`;
        return;
      }
      // Default: switch lm-assist endpoint to this URL.
      const url = btn.getAttribute('data-url');
      if (url) {
        ipcRenderer.send('hosts-select-endpoint', url);
        statusEl.textContent = `Switched current endpoint to ${url}`;
      }
    });
  }
  for (const row of hostDetailEl.querySelectorAll('.host-session-row')) {
    row.addEventListener('click', () => {
      const sid = row.getAttribute('data-sid');
      const host = row.getAttribute('data-host');
      // Jump to Sessions tab with this host filtered and this session
      // selected — conversation fetches automatically on render.
      state.sessHostFilter = host || '';
      state.sessSelectedId = sid;
      state.sessConv = null;
      state.sessSubTab = 'conversation';
      setActiveTab('sessions');
      fetchSessionConversation(sid);
      statusEl.textContent = `Opened session ${sid.slice(0, 8)}…`;
    });
  }
}

// ── SESSIONS TAB ──
function renderSessionsTab() {
  // Populate host filter dropdown — one entry per machine, value is the
  // hostname so we filter against all URLs that machine answers on.
  const hosts = getHostsWithSessions();
  const totalUnique = hosts.reduce((n, h) => n + h.count, 0);
  const prevHostSel = state.sessHostFilter;
  sessHostFilterEl.innerHTML = `<option value="">All hosts (${totalUnique})</option>` +
    hosts.map((h) => `<option value="${escapeHtml(h.hostname)}"${h.hostname === prevHostSel ? ' selected' : ''}>${escapeHtml(h.hostname)} (${h.count})</option>`).join('');

  // Build session list
  const all = getAllSessions();
  // Map hostname -> set of URLs (so the host-filter resolves to URLs)
  const machineUrls = new Map(hosts.map((h) => [h.hostname, new Set(h.urls)]));
  const now = Date.now();
  const visible = all.filter((s) => {
    if (state.sessHostFilter) {
      const allowed = machineUrls.get(state.sessHostFilter);
      if (!allowed) return false;
      if (!s._seenOnHosts.some((u) => allowed.has(u))) return false;
    }
    if (state.sessRecencyMs && Date.parse(s.lastModified) && (now - Date.parse(s.lastModified) > state.sessRecencyMs)) return false;
    if (state.sessSearch) {
      const q = state.sessSearch.toLowerCase();
      const sid = (s.sessionId || s.id || '').toLowerCase();
      const proj = ((s.projectPath ?? s.cwd ?? '') + '').toLowerCase();
      const last = ((s.lastUserMessage ?? s.sessionSummary ?? '') + '').toLowerCase();
      if (!sid.includes(q) && !proj.includes(q) && !last.includes(q)) return false;
    }
    return true;
  });

  if (!visible.find((s) => (s.sessionId || s.id) === state.sessSelectedId)) {
    state.sessSelectedId = (visible[0]?.sessionId || visible[0]?.id) ?? null;
  }

  if (!visible.length) {
    sessListEl.innerHTML = `<div class="muted" style="padding:20px;text-align:center">No sessions match.</div>`;
    sessDetailEl.innerHTML = `<div class="empty-detail">No session selected.</div>`;
    return;
  }

  sessListEl.innerHTML = visible.map(renderSessionListItem).join('');
  for (const item of sessListEl.querySelectorAll('.session-item')) {
    item.addEventListener('click', () => {
      state.sessSelectedId = item.getAttribute('data-id');
      state.sessConv = null;
      state.sessSubTab = 'conversation';  // every new selection lands on the conversation
      renderSessionsTab();
      fetchSessionConversation(state.sessSelectedId);
    });
  }

  const sel = visible.find((s) => (s.sessionId || s.id) === state.sessSelectedId);
  sessDetailEl.innerHTML = sel ? renderSessionDetail(sel) : `<div class="empty-detail">Select a session.</div>`;
}

function renderSessionListItem(s) {
  const sid = s.sessionId || s.id;
  const isSelected = sid === state.sessSelectedId;
  const proj = projShortName(s.projectPath ?? s.cwd ?? '');
  const last = (s.lastUserMessage ?? s.sessionSummary ?? '').trim();
  const when = fmtRelative(s.lastModified ?? s.ts ?? s.createdAt);
  const turns = s.userPromptCount ?? s.numTurns;
  const cost = typeof s.totalCostUsd === 'number' ? `$${s.totalCostUsd.toFixed(2)}` : '';
  const isRunning = !!s.runningExec;
  return `
    <div class="session-item${isSelected ? ' selected' : ''}${isRunning ? ' running' : ''}" data-id="${escapeHtml(sid)}">
      <div class="row1">
        <span class="proj" title="${escapeHtml(s.projectPath ?? s.cwd ?? '')}">${escapeHtml(proj)}</span>
        <span class="when">${escapeHtml(when)}</span>
      </div>
      <div class="row2">
        <span class="host-chip">${escapeHtml(s._hostname || s._host)}</span>
        ${turns != null ? `<span class="turns">${escapeHtml(String(turns))}T</span>` : ''}
        ${cost ? `<span class="cost">${escapeHtml(cost)}</span>` : ''}
      </div>
      ${last ? `<div class="last-msg">${escapeHtml(last.slice(0, 120))}</div>` : ''}
      <div class="sid">${escapeHtml(sid)}</div>
    </div>
  `;
}

function renderSessionDetail(s) {
  const sid = s.sessionId || s.id;
  const projFull = s.projectPath ?? s.cwd ?? '';
  const proj = projShortName(projFull);
  const turns = s.userPromptCount ?? s.numTurns;
  const cost = typeof s.totalCostUsd === 'number' ? `$${s.totalCostUsd.toFixed(2)}` : '';
  const when = fmtRelative(s.lastModified);
  const isRunning = !!s.runningExec;

  // ── conversation tab ──
  let convInner;
  if (state.sessConv && state.sessConv.sid === sid) {
    const msgs = state.sessConv.messages || [];
    if (!msgs.length) {
      convInner = '<div class="conv-empty">No messages in this session.</div>';
    } else {
      convInner = renderConversationBlocks(msgs);
    }
  } else {
    convInner = '<div class="conv-empty">Loading conversation…</div>';
  }

  // ── details tab ──
  const created = s.createdAt ? new Date(s.createdAt).toLocaleString() : '';
  const lastModFull = s.lastModified ? new Date(s.lastModified).toLocaleString() : '';
  const info = [
    { k: 'Session id', v: sid },
    { k: 'Project',    v: projFull || '—' },
    { k: 'Host',       v: s._hostname || s._host },
  ];
  if (turns != null)  info.push({ k: 'Turns',      v: String(turns) });
  if (cost)           info.push({ k: 'Total cost', v: cost });
  if (s.size != null) info.push({ k: 'Size',       v: `${(s.size / 1024).toFixed(1)} KB` });
  if (created)        info.push({ k: 'Created',    v: created });
  if (lastModFull)    info.push({ k: 'Last activity', v: lastModFull });

  const detailsInner = `
    <div class="info-grid">
      ${info.map((c) => `
        <div class="info-cell">
          <div class="k">${escapeHtml(c.k)}</div>
          <div class="v">${escapeHtml(c.v)}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
      <button class="btn-use" data-action="switch" data-id="${escapeHtml(sid)}" data-host="${escapeHtml(s._host)}">Switch to this session</button>
      <button class="copy-btn" data-copy="${escapeHtml(sid)}">Copy session id</button>
      <button class="copy-btn" data-copy="${escapeHtml(projFull)}">Copy project path</button>
    </div>
  `;

  const showConv = state.sessSubTab === 'conversation';

  return `
    <div class="sess-detail-frame">
      <div class="session-detail-head">
        <div class="proj-name">${escapeHtml(proj)}${isRunning ? ' <span class="chip running" style="vertical-align:middle;margin-left:6px">running</span>' : ''}</div>
        <div class="proj-path">${escapeHtml(projFull || '')}</div>
        <div class="chips-row">
          <span class="chip host">${escapeHtml(s._hostname || s._host)}</span>
          ${turns != null ? `<span class="chip">${escapeHtml(String(turns))} turns</span>` : ''}
          ${cost ? `<span class="chip">${escapeHtml(cost)}</span>` : ''}
          ${when ? `<span class="chip">${escapeHtml(when)}</span>` : ''}
        </div>
      </div>

      <nav class="sub-tabs">
        <button class="sub-tab ${showConv ? 'active' : ''}" data-subtab="conversation">Conversation</button>
        <button class="sub-tab ${showConv ? '' : 'active'}" data-subtab="details">Details &amp; actions</button>
      </nav>

      <div class="sub-tab-pane" ${showConv ? '' : 'hidden'}>
        <div id="conv-scroll" class="conv-scroll">${convInner}</div>
      </div>
      <div class="sub-tab-pane details-pane" ${showConv ? 'hidden' : ''}>
        ${detailsInner}
      </div>
    </div>
  `;
}

function isToolMsg(m) { return m.kind === 'tool_use' || m.kind === 'tool_result' || m.role === 'tool'; }

// Walk messages, collapsing consecutive tool entries into one compact row.
function renderConversationBlocks(msgs) {
  const out = [];
  let buf = [];
  const flush = () => {
    if (buf.length === 0) return;
    out.push(renderToolGroup(buf));
    buf = [];
  };
  for (const m of msgs) {
    if (isToolMsg(m)) {
      buf.push(m);
    } else {
      flush();
      out.push(renderTextMsg(m));
    }
  }
  flush();
  return out.join('');
}

function renderTextMsg(m) {
  const who = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : (m.role || 'msg');
  const cls = who === 'user' ? 'msg-user' : who === 'assistant' ? 'msg-asst' : 'msg-other';
  const fullText = String(m.text || '');
  const text = fullText.length > 1200 ? fullText.slice(0, 1200) + '…' : fullText;
  return `
    <div class="msg ${cls}">
      <div class="msg-who">${escapeHtml(who)}</div>
      <div class="msg-text">${escapeHtml(text)}</div>
    </div>`;
}

function renderToolGroup(items) {
  // Sum the actual tool count (each message may carry several tools) and
  // collect distinct tool names in first-seen order.
  const names = [];
  let total = 0;
  for (const it of items) {
    const nameList = (it.toolNames && it.toolNames.length) ? it.toolNames : (it.toolName ? [it.toolName] : []);
    if (nameList.length === 0) total += 1;
    else {
      total += nameList.length;
      for (const n of nameList) if (!names.includes(n)) names.push(n);
    }
  }
  const summary = names.length
    ? names.slice(0, 8).join(' · ') + (names.length > 8 ? ` +${names.length - 8} more` : '')
    : '(unnamed tool calls)';
  return `
    <div class="msg msg-tool-group">
      <div class="msg-who">tool calls <span class="count">${total}</span></div>
      <div class="msg-text">${escapeHtml(summary)}</div>
    </div>`;
}

async function fetchSessionConversation(sid) {
  if (!sid) return;
  try {
    const data = await ipcRenderer.invoke('hosts-window-fetch-conversation', sid);
    if (data?.ok) {
      state.sessConv = { sid, messages: data.messages || [] };
      // Only re-render if still selected
      if (state.activeTab === 'sessions' && state.sessSelectedId === sid) renderSessionsTab();
    } else {
      state.sessConv = { sid, messages: [] };
      if (state.activeTab === 'sessions' && state.sessSelectedId === sid) renderSessionsTab();
    }
  } catch (err) {
    state.sessConv = { sid, messages: [] };
  }
}

// Wire session detail buttons + sub-tabs + auto-scroll. Run after every render.
function wireSessionDetail() {
  for (const btn of sessDetailEl.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', () => {
      const txt = btn.getAttribute('data-copy');
      try { clipboard.writeText(txt); } catch {}
      btn.classList.add('copied');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1200);
    });
  }
  for (const btn of sessDetailEl.querySelectorAll('[data-action=switch]')) {
    btn.addEventListener('click', () => {
      ipcRenderer.send('hosts-select-session', { id: btn.getAttribute('data-id'), endpoint: btn.getAttribute('data-host') });
      statusEl.textContent = `Switched to session ${btn.getAttribute('data-id')}`;
    });
  }
  for (const btn of sessDetailEl.querySelectorAll('.sub-tab')) {
    btn.addEventListener('click', () => {
      state.sessSubTab = btn.getAttribute('data-subtab');
      renderSessionsTab();
      wireSessionDetail();
    });
  }
  // Scroll conversation to bottom (most recent visible) when the
  // Conversation sub-tab is showing.
  if (state.sessSubTab === 'conversation') {
    const scroller = sessDetailEl.querySelector('#conv-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

// ── CONVERSATION TAB ──
// Split into header (cheap, called on every world-state tick) and bubbles
// (only when conv array actually changes). This keeps the karaoke spans
// alive during 5-second world-state pushes that would otherwise wipe them.
function renderConvHeader() {
  if (convDotEl) { convDotEl.className = `dot ${state.statusClass || 'idle'}`; }
  if (convStatusEl) convStatusEl.textContent = state.statusText || 'Idle';
  const w = state.world || {};
  if (convProjectEl) convProjectEl.textContent = w.project || '—';
  if (convSessionEl) {
    const a = w.activeSession;
    convSessionEl.textContent = a ? `${a.label || a.sid?.slice(0, 8)} · ${a.numTurns || 0}T` : (state.session?.id?.slice(0, 8) || '—');
  }
  if (convHostEl) convHostEl.textContent = w.host?.hostname || w.host?.endpoint || state.currentEndpoint || '—';
}

let _lastConvLen = 0;
function renderConvBubbles() {
  if (!convListEl) return;
  // Capture intent BEFORE the innerHTML swap clobbers scrollTop.
  const wasNearBottom = (convListEl.scrollHeight - convListEl.scrollTop - convListEl.clientHeight) < 60;
  const isNewMessage = state.conv.length > _lastConvLen;
  _lastConvLen = state.conv.length;
  if (!state.conv.length) {
    convListEl.innerHTML = '<div class="conv-empty">No turns yet.<br><span style="font-size:11px;opacity:0.7">Hold the hotkey in the small popup to speak, or type below.</span></div>';
  } else {
    convListEl.innerHTML = state.conv.map(renderConvBubble).join('');
  }
  // A brand-new message always pins to the bottom; mid-conversation re-renders
  // only follow if the user was already near the bottom.
  if (isNewMessage || wasNearBottom) convListEl.scrollTop = convListEl.scrollHeight;
}

function renderConversationTab() {
  renderConvHeader();
  renderConvBubbles();
}

function renderConvBubble(b) {
  if (b.role === 'tool-group') {
    return `
      <div class="conv-bubble tool-group">
        <div class="who">tool calls <span class="count">${b.count || 1}</span></div>
        <div class="text">${escapeHtml(b.text || '')}</div>
      </div>`;
  }
  const cls = b.role === 'user' ? 'user' : 'asst';
  const interim = b.isInterim ? ' interim' : '';
  return `
    <div class="conv-bubble ${cls}${interim}">
      <div class="who">${escapeHtml(b.role)}</div>
      <div class="text">${escapeHtml(b.text || '')}</div>
    </div>`;
}

function appendConvBubble(bubble) {
  state.conv.push({ id: `b${Date.now()}-${state.conv.length}`, ...bubble });
  if (state.conv.length > 200) state.conv.splice(0, state.conv.length - 200);
  if (state.activeTab === 'conversation') renderConversationTab();
}

// ── TTS-synced karaoke highlighting (visual only — popup owns the audio) ──
let _karaokeFrame = 0;
let _karaokeToken = 0;
// Mirrors popup audio state. _ttsPlaying stays true until either stop-wav or
// tts-ended. Pause tracking lets us freeze the karaoke clock so the highlight
// stops moving when audio is suspended.
let _ttsPlaying = false;
let _ttsPaused = false;
let _ttsPausedAt = 0;
let _ttsTotalPausedMs = 0;

function findAssistantBubbleEl(text) {
  if (!convListEl) return null;
  const target = (text || '').replace(/\s+/g, ' ').trim();
  const bubbles = convListEl.querySelectorAll('.conv-bubble.asst');
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const el = bubbles[i].querySelector('.text');
    if (el && el.textContent.replace(/\s+/g, ' ').trim() === target) return el;
  }
  // Fall back to the most recent assistant bubble — covers cases where the
  // bubble was created with a slightly longer (un-truncated) text but the
  // TTS got a truncated version.
  if (bubbles.length) return bubbles[bubbles.length - 1].querySelector('.text');
  return null;
}

// Wrap each whitespace-delimited word in `bubble` in a span with predicted
// start/end times. Pacing is weighted by character count + a small pause
// after sentence/clause-ending punctuation.
function wrapWordsForHighlight(bubble, totalDuration) {
  const original = bubble.textContent;
  bubble.innerHTML = '';
  const parts = original.split(/(\s+)/);
  const wordParts = parts.filter((p) => p.trim().length > 0);

  const weights = wordParts.map((w) => {
    const body = (w.match(/[a-zA-Z0-9]/g) || []).length;
    let weight = Math.max(1, body);
    if (/[.!?]['")\]]?$/.test(w)) weight += 6;
    else if (/[,;:]['")\]]?$/.test(w)) weight += 3;
    return weight;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const secPerWeight = totalDuration / totalWeight;

  let cursor = 0;
  let i = 0;
  for (const part of parts) {
    if (part.trim().length === 0) {
      bubble.appendChild(document.createTextNode(part));
    } else {
      const start = cursor;
      const dur = weights[i] * secPerWeight;
      const end = start + dur;
      cursor = end;
      const span = document.createElement('span');
      span.className = 'tts-word';
      span.textContent = part;
      span.dataset.s = start.toFixed(3);
      span.dataset.e = end.toFixed(3);
      bubble.appendChild(span);
      i++;
    }
  }
  return bubble.querySelectorAll('.tts-word');
}

function startKaraoke({ duration, text }) {
  if (!duration || !text) return;
  // Cancel any prior animation so a new utterance always supersedes.
  if (_karaokeFrame) { cancelAnimationFrame(_karaokeFrame); _karaokeFrame = 0; }
  _karaokeToken++;
  const token = _karaokeToken;
  // Reset pause-state — fresh utterance.
  _ttsPlaying = true;
  _ttsPaused = false;
  _ttsPausedAt = 0;
  _ttsTotalPausedMs = 0;

  // Make sure the Conversation tab is what's rendered so the bubble exists in
  // the DOM. If user is on another tab we still highlight in the background.
  if (state.activeTab === 'conversation') {
    // Re-render so any pending bubble appears, then wrap.
    renderConversationTab();
  }

  const bubble = findAssistantBubbleEl(text);
  if (!bubble) return;
  const spans = wrapWordsForHighlight(bubble, duration);
  if (!spans.length) return;
  const startedAt = performance.now();

  const tick = () => {
    if (token !== _karaokeToken) return; // superseded
    // Pause-aware elapsed: subtract completed pause windows + any open one.
    const liveOffset = _ttsPaused ? performance.now() - _ttsPausedAt : 0;
    const elapsed = (performance.now() - startedAt - _ttsTotalPausedMs - liveOffset) / 1000;
    let activeIdx = -1;
    for (let i = 0; i < spans.length; i++) {
      const s = parseFloat(spans[i].dataset.s);
      const e = parseFloat(spans[i].dataset.e);
      if (elapsed >= s && elapsed < e) { activeIdx = i; break; }
    }
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('tts-current', i === activeIdx);
      spans[i].classList.toggle('tts-past', i < activeIdx);
    }
    if (elapsed > (duration + 0.5)) {
      for (const s of spans) s.classList.remove('tts-current');
      // Leave tts-past on the trailing words so the final state stays "all read".
      _karaokeFrame = 0;
      return;
    }
    _karaokeFrame = requestAnimationFrame(tick);
  };
  _karaokeFrame = requestAnimationFrame(tick);
}

function stopKaraoke() {
  _karaokeToken++;            // invalidates any running tick()
  if (_karaokeFrame) { cancelAnimationFrame(_karaokeFrame); _karaokeFrame = 0; }
  _ttsPlaying = false;
  _ttsPaused = false;
  _ttsPausedAt = 0;
  _ttsTotalPausedMs = 0;
  if (!convListEl) return;
  for (const w of convListEl.querySelectorAll('.tts-word')) {
    w.classList.remove('tts-current');
    w.classList.remove('tts-past');
  }
}

// ── ENGINE TAB ──
function pushEngineEvent(evt) {
  state.engineEvents.push(evt);
  if (state.engineEvents.length > 500) state.engineEvents.splice(0, state.engineEvents.length - 500);
  if (countEngineEl) countEngineEl.textContent = state.engineEvents.length;
  if (state.activeTab === 'engine') renderEngineTab(true);
}

function renderEngineTab(append = false) {
  if (countEngineEl) countEngineEl.textContent = state.engineEvents.length;
  const q = state.engineSearch.toLowerCase();
  const f = state.engineFilter;
  const visible = state.engineEvents.filter((e) => {
    if (f && (e.source || 'other') !== f) return false;
    if (q) {
      const blob = `${e.source || ''} ${e.text || ''} ${e.delta || ''} ${e.id || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  if (!visible.length) {
    engineListEl.innerHTML = `<div class="muted" style="padding:20px;text-align:center">No engine events match.</div>`;
    return;
  }
  engineListEl.innerHTML = visible.map(renderEngineRow).join('');
  // Auto-scroll to newest unless user disabled follow.
  if (state.engineFollow) engineListEl.scrollTop = engineListEl.scrollHeight;
}

function renderEngineRow(e) {
  const src = (e.source || 'other').toLowerCase();
  const time = e.at ? new Date(e.at).toLocaleTimeString() : '';
  const body = e.text || e.delta || e.msg || JSON.stringify({ ...e, at: undefined, source: undefined }).slice(0, 300);
  return `
    <div class="engine-row ${src}">
      <span class="er-time">${escapeHtml(time)}</span>
      <span class="er-source">${escapeHtml(src)}</span>
      <span class="er-text">${escapeHtml(body.length > 400 ? body.slice(0, 400) + '…' : body)}</span>
    </div>`;
}

// ── PROJECTS TAB ──
// Aggregate sessions across every host, grouped by the project's leaf folder
// name (`/home/ubuntu/lm-unified-trade` and `C:\home\lm-unified-trade` both
// collapse to `lm-unified-trade`). Each group records every host + path it
// was seen on so the detail pane can show the full breakdown.
function buildProjectGroups() {
  const byKey = new Map();
  for (const [hostUrl, snap] of Object.entries(state.otherHosts)) {
    const sessions = snap?.sessions ?? [];
    if (!sessions.length) continue;
    const hostname = snap.label || snap.health?.hostname || hostUrl;
    for (const s of sessions) {
      const fullPath = String(s.projectPath ?? s.cwd ?? '').replace(/[\\/]+$/, '');
      if (!fullPath) continue;
      const leaf = projShortName(fullPath);
      const key = leaf.toLowerCase();
      let g = byKey.get(key);
      if (!g) {
        g = {
          key, name: leaf,
          hosts: new Map(),   // hostUrl → { hostname, paths:Set, sessions:[] }
          totalSessions: 0,
          totalCost: 0,
          lastModified: '',
        };
        byKey.set(key, g);
      }
      let h = g.hosts.get(hostUrl);
      if (!h) {
        h = { hostUrl, hostname, paths: new Set(), sessions: [] };
        g.hosts.set(hostUrl, h);
      }
      h.paths.add(fullPath);
      h.sessions.push(s);
      g.totalSessions++;
      if (typeof s.totalCostUsd === 'number') g.totalCost += s.totalCostUsd;
      const lm = s.lastModified || '';
      if (lm > g.lastModified) g.lastModified = lm;
    }
  }
  const out = [...byKey.values()];
  out.sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));
  return out;
}

function renderProjectsTab() {
  const groups = buildProjectGroups();
  if (countProjectsEl) countProjectsEl.textContent = groups.length;

  const q = state.projSearch.toLowerCase();
  const visible = q ? groups.filter((g) => {
    if (g.name.toLowerCase().includes(q)) return true;
    for (const h of g.hosts.values()) {
      for (const p of h.paths) if (p.toLowerCase().includes(q)) return true;
    }
    return false;
  }) : groups;

  if (!visible.find((g) => g.key === state.projSelectedKey)) {
    state.projSelectedKey = visible[0]?.key ?? null;
  }

  if (!visible.length) {
    projListEl.innerHTML = `<div class="muted" style="padding:20px;text-align:center">No projects yet.<div style="font-size:11px;opacity:0.6;margin-top:6px">Run Discover, or wait for the multi-host monitor to fetch session lists.</div></div>`;
    projDetailEl.innerHTML = `<div class="empty-detail">No project selected.</div>`;
    return;
  }

  projListEl.innerHTML = visible.map(renderProjectListItem).join('');
  for (const item of projListEl.querySelectorAll('.project-item')) {
    item.addEventListener('click', () => {
      state.projSelectedKey = item.getAttribute('data-key');
      renderProjectsTab();
    });
  }

  const sel = visible.find((g) => g.key === state.projSelectedKey);
  projDetailEl.innerHTML = sel ? renderProjectDetail(sel) : `<div class="empty-detail">Select a project.</div>`;
  wireProjectDetail();
}

function renderProjectListItem(g) {
  const isSelected = g.key === state.projSelectedKey;
  const hostList = [...g.hosts.values()];
  const hostsChips = hostList
    .slice(0, 3)
    .map((h) => `<span class="proj-host-chip">${escapeHtml(h.hostname)}</span>`)
    .join('') + (hostList.length > 3 ? `<span class="proj-host-chip dim">+${hostList.length - 3}</span>` : '');
  const costStr = g.totalCost > 0 ? `$${g.totalCost.toFixed(2)}` : '';
  const when = fmtRelative(g.lastModified);
  return `
    <div class="project-item${isSelected ? ' selected' : ''}" data-key="${escapeHtml(g.key)}">
      <div class="proj-row1">
        <span class="proj-name">${escapeHtml(g.name)}</span>
        <span class="proj-when">${escapeHtml(when)}</span>
      </div>
      <div class="proj-row2">${hostsChips}</div>
      <div class="proj-row3">
        <span class="proj-stat"><strong>${g.totalSessions}</strong> session${g.totalSessions === 1 ? '' : 's'}</span>
        <span class="proj-stat"><strong>${hostList.length}</strong> host${hostList.length === 1 ? '' : 's'}</span>
        ${costStr ? `<span class="proj-stat cost">${escapeHtml(costStr)}</span>` : ''}
      </div>
    </div>
  `;
}

function renderProjectDetail(g) {
  const hostList = [...g.hosts.values()].sort((a, b) => b.sessions.length - a.sessions.length);
  const totalSessions = g.totalSessions;
  const costStr = g.totalCost > 0 ? `$${g.totalCost.toFixed(2)}` : '—';

  // Per-host breakdown
  const hostsHtml = hostList.map((h) => {
    const paths = [...h.paths];
    const cost = h.sessions.reduce((s, x) => s + (typeof x.totalCostUsd === 'number' ? x.totalCostUsd : 0), 0);
    return `
      <div class="proj-host-block">
        <div class="proj-host-block-head">
          <span class="proj-host-name">${escapeHtml(h.hostname)}</span>
          <span class="proj-host-counts">${h.sessions.length} session${h.sessions.length === 1 ? '' : 's'}${cost > 0 ? ` · $${cost.toFixed(2)}` : ''}</span>
        </div>
        <div class="proj-host-paths">${paths.map((p) => `<code>${escapeHtml(p)}</code>`).join('')}</div>
      </div>
    `;
  }).join('');

  // All sessions across all hosts, newest first
  const allSessions = [];
  for (const h of hostList) {
    for (const s of h.sessions) {
      allSessions.push({ ...s, _host: h.hostUrl, _hostname: h.hostname });
    }
  }
  allSessions.sort((a, b) => (Date.parse(b.lastModified) || 0) - (Date.parse(a.lastModified) || 0));

  const sessionsHtml = allSessions.slice(0, 50).map((s) => {
    const sid = s.sessionId ?? s.id;
    const turns = s.userPromptCount ?? s.numTurns;
    const cost = typeof s.totalCostUsd === 'number' ? `$${s.totalCostUsd.toFixed(2)}` : '';
    const when = fmtRelative(s.lastModified);
    return `
      <div class="proj-session-row" data-sid="${escapeHtml(sid)}" data-host="${escapeHtml(s._hostname)}">
        <span class="pss-host">${escapeHtml(s._hostname)}</span>
        ${turns != null ? `<span class="pss-turns">${escapeHtml(String(turns))}T</span>` : ''}
        ${cost ? `<span class="pss-cost">${escapeHtml(cost)}</span>` : ''}
        <span class="pss-when">${escapeHtml(when)}</span>
        <span class="pss-sid">${escapeHtml(sid)}</span>
      </div>`;
  }).join('') + (allSessions.length > 50 ? `<div class="muted" style="margin-top:6px">+${allSessions.length - 50} more…</div>` : '');

  return `
    <div class="detail-head">
      <span class="dot" style="background:#6db8ff;box-shadow:0 0 8px rgba(109,184,255,0.6)"></span>
      <div class="detail-title">
        <h2>${escapeHtml(g.name)}</h2>
        <div class="meta">${hostList.length} host${hostList.length === 1 ? '' : 's'} · ${totalSessions} session${totalSessions === 1 ? '' : 's'}${g.totalCost > 0 ? ` · ${costStr}` : ''}</div>
      </div>
    </div>

    <div class="section">
      <h3>Hosts (${hostList.length})</h3>
      ${hostsHtml}
    </div>

    <div class="section">
      <h3>Sessions (${allSessions.length})</h3>
      ${sessionsHtml || '<div class="muted">No sessions.</div>'}
    </div>
  `;
}

function wireProjectDetail() {
  for (const row of projDetailEl.querySelectorAll('.proj-session-row')) {
    row.addEventListener('click', () => {
      const sid = row.getAttribute('data-sid');
      const host = row.getAttribute('data-host');
      state.sessHostFilter = host || '';
      state.sessSelectedId = sid;
      state.sessConv = null;
      state.sessSubTab = 'conversation';
      setActiveTab('sessions');
      fetchSessionConversation(sid);
      statusEl.textContent = `Opened session ${sid.slice(0, 8)}…`;
    });
  }
}

// ── tab switching ──
function setActiveTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-tab') === name));
  $('pane-conversation').hidden = name !== 'conversation';
  $('pane-engine').hidden = name !== 'engine';
  $('pane-hosts').hidden = name !== 'hosts';
  $('pane-projects').hidden = name !== 'projects';
  $('pane-sessions').hidden = name !== 'sessions';
  if (name === 'conversation') renderConversationTab();
  else if (name === 'engine') renderEngineTab();
  else if (name === 'hosts') renderHostsTab();
  else if (name === 'projects') renderProjectsTab();
  else if (name === 'sessions') {
    renderSessionsTab();
    if (state.sessSelectedId && !state.sessConv) fetchSessionConversation(state.sessSelectedId);
  }
}

// ── top-level render that updates summary + active tab ──
function renderAll() {
  const groups = buildHostGroups();
  let lmCount = 0, sshCount = 0;
  for (const g of groups) {
    if (g.bestCat === 'direct' || g.bestCat === 'via-ssh') lmCount++;
    if (g.bestCat === 'ssh-only') sshCount++;
  }
  // Use deduped count for the chip + header (a session reported on N URLs
  // of the same machine is one session, not N).
  const uniqueSessionCount = getAllSessions().length;
  summaryEl.textContent = `${groups.length} machine${groups.length === 1 ? '' : 's'} · ${lmCount} with lm-assist · ${sshCount} SSH-only · ${uniqueSessionCount} session${uniqueSessionCount === 1 ? '' : 's'}`;
  countHostsEl.textContent = groups.length;
  countSessionsEl.textContent = uniqueSessionCount;
  // Always recompute the projects count even when on another tab so the
  // badge stays accurate.
  if (countProjectsEl) countProjectsEl.textContent = buildProjectGroups().length;
  if (state.activeTab === 'hosts') renderHostsTab();
  else if (state.activeTab === 'projects') renderProjectsTab();
  else if (state.activeTab === 'sessions') {
    renderSessionsTab();
    wireSessionDetail();
  }
}

// Run wireSessionDetail after every sessions-tab render (the original render
// function does the HTML; this MutationObserver wires up new buttons).
new MutationObserver(() => { if (state.activeTab === 'sessions') wireSessionDetail(); })
  .observe(sessDetailEl, { childList: true });

// ── wiring ──
async function load() {
  const data = await ipcRenderer.invoke('hosts-window-get-state');
  state.hosts = data?.allHosts || [];
  state.otherHosts = data?.otherHosts || {};
  state.currentEndpoint = data?.currentEndpoint || null;
  state.world = data?.world || null;
  state.session = data?.session || null;
  state.engineEvents = (data?.engineEvents || []).slice();
  if (countEngineEl) countEngineEl.textContent = state.engineEvents.length;
  renderAll();
  if (state.activeTab === 'conversation') renderConversationTab();
  if (state.activeTab === 'engine') renderEngineTab();
  statusEl.textContent = `${state.hosts.length} host record(s) cached`;
}

$('btn-refresh').addEventListener('click', load);
$('btn-close').addEventListener('click', () => ipcRenderer.send('hosts-window-close'));
$('btn-discover').addEventListener('click', async () => {
  $('btn-discover').disabled = true;
  statusEl.textContent = 'Scanning Claude session files and probing hosts…';
  try {
    const result = await ipcRenderer.invoke('hosts-window-discover');
    statusEl.textContent = `Discovered ${result.reachable?.length ?? 0} direct, ${result.sshDiscovered?.length ?? 0} via SSH, ${result.sshOnlyHosts?.length ?? 0} SSH-only (${(result.elapsedMs/1000).toFixed(1)}s)`;
    await load();
  } catch (err) {
    statusEl.textContent = `Discovery failed: ${err.message}`;
  } finally {
    $('btn-discover').disabled = false;
  }
});

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => setActiveTab(t.getAttribute('data-tab')));
});

document.querySelectorAll('input[name=host-filter]').forEach((el) => {
  el.addEventListener('change', () => { state.hostFilter = el.value; renderHostsTab(); });
});
hostSearchEl.addEventListener('input', () => { state.hostSearch = hostSearchEl.value.trim(); renderHostsTab(); });

sessHostFilterEl.addEventListener('change', () => { state.sessHostFilter = sessHostFilterEl.value; renderSessionsTab(); });
sessRecencyEl.addEventListener('change', () => { state.sessRecencyMs = Number(sessRecencyEl.value); renderSessionsTab(); });
sessSearchEl.addEventListener('input', () => { state.sessSearch = sessSearchEl.value.trim(); renderSessionsTab(); });
if (projSearchEl) projSearchEl.addEventListener('input', () => { state.projSearch = projSearchEl.value.trim(); renderProjectsTab(); });

// Contextual ESC:
//  • While TTS is playing (or paused) — single ESC toggles pause/resume;
//    a second ESC within ~400 ms (double-tap) hides the window.
//  • Otherwise — single ESC hides the window (original behavior).
let _lastEscAt = 0;
const DOUBLE_TAP_MS = 400;
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const now = performance.now();
  const recentEsc = (now - _lastEscAt) < DOUBLE_TAP_MS;
  _lastEscAt = now;

  if (_ttsPlaying) {
    if (recentEsc) {
      // Double-tap while playing/paused → hide. Resume audio first so we
      // don't leave the popup's AudioContext suspended in the background.
      if (_ttsPaused) ipcRenderer.send('tts-resume-req');
      ipcRenderer.send('hosts-window-close');
      return;
    }
    // Single ESC → toggle pause.
    ipcRenderer.send(_ttsPaused ? 'tts-resume-req' : 'tts-pause-req');
    return;
  }
  ipcRenderer.send('hosts-window-close');
});

ipcRenderer.on('hosts-window-state', (_, data) => {
  state.hosts = data?.allHosts || [];
  state.otherHosts = data?.otherHosts || {};
  state.currentEndpoint = data?.currentEndpoint || null;
  renderAll();
});

// ── live conversation + engine IPC ── (mirror what the popup receives) ──
// World/status updates only redraw the header — body redraws only when the
// conversation array changes, so karaoke spans survive timer ticks.
ipcRenderer.on('world-state', (_, payload) => {
  state.world = payload?.world ?? state.world;
  if (state.activeTab === 'conversation') renderConvHeader();
});
ipcRenderer.on('status', (_, p) => {
  state.statusText = p?.text || '';
  state.statusClass = p?.class || 'idle';
  if (state.activeTab === 'conversation') renderConvHeader();
});
ipcRenderer.on('session-update', (_, sess) => {
  state.session = sess || null;
  if (state.activeTab === 'conversation') renderConvHeader();
});

// User-speech transcript: streamed interim while talking, finalised on release.
ipcRenderer.on('transcript', (_, p) => {
  const text = (p?.text || '').trim();
  if (!text) return;
  if (p.isFinal) {
    // Finalise: replace the interim bubble (if any) with a user bubble.
    if (state.convInterimId) {
      const ib = state.conv.find((b) => b.id === state.convInterimId);
      if (ib) { ib.text = text; ib.isInterim = false; }
      else appendConvBubble({ role: 'user', text });
      state.convInterimId = null;
    } else {
      appendConvBubble({ role: 'user', text });
    }
  } else {
    // Interim: create or update the streaming bubble.
    if (!state.convInterimId) {
      const id = `interim-${Date.now()}`;
      state.conv.push({ id, role: 'user', text, isInterim: true });
      state.convInterimId = id;
    } else {
      const ib = state.conv.find((b) => b.id === state.convInterimId);
      if (ib) ib.text = text;
    }
  }
  if (state.activeTab === 'conversation') renderConversationTab();
});

ipcRenderer.on('reply', (_, text) => {
  if (text == null) return;
  appendConvBubble({ role: 'assistant', text: String(text) });
});

// TTS playback IPC mirrors the popup's, but here we only animate the
// karaoke highlight — the small popup window owns the actual audio output
// so we never decode/play to avoid double sound.
ipcRenderer.on('play-wav', (_, payload) => {
  if (!payload) return;
  // Legacy shape: just an ArrayBuffer (no duration/text) — nothing to sync.
  if (payload && payload.byteLength !== undefined && !payload.text) return;
  const { duration, text } = payload;
  startKaraoke({ duration, text });
});
ipcRenderer.on('stop-wav', () => { stopKaraoke(); });
// Pause / resume relays (driven by ESC in the keydown handler below).
ipcRenderer.on('tts-pause', () => {
  if (!_ttsPlaying || _ttsPaused) return;
  _ttsPaused = true;
  _ttsPausedAt = performance.now();
});
ipcRenderer.on('tts-resume', () => {
  if (!_ttsPlaying || !_ttsPaused) return;
  _ttsTotalPausedMs += performance.now() - _ttsPausedAt;
  _ttsPausedAt = 0;
  _ttsPaused = false;
});
ipcRenderer.on('tts-ended', () => {
  _ttsPlaying = false;
  _ttsPaused = false;
  _ttsPausedAt = 0;
  _ttsTotalPausedMs = 0;
});

// Engine events pushed each time main calls ambient.push()
ipcRenderer.on('engine-event', (_, evt) => {
  if (!evt) return;
  pushEngineEvent(evt);
});

// ── conversation text input ──
function submitConvText() {
  const v = (convInputEl.value || '').trim();
  if (!v || convInputEl.disabled) return;
  appendConvBubble({ role: 'user', text: v });
  ipcRenderer.send('text-input', v);
  convInputEl.value = '';
}
if (convSendBtn) convSendBtn.addEventListener('click', submitConvText);
if (convInputEl) convInputEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitConvText(); }
});

ipcRenderer.on('input-busy', (_, busy) => {
  if (convInputEl) convInputEl.disabled = !!busy;
  if (convSendBtn) convSendBtn.disabled = !!busy;
});

// ── engine toolbar ──
if (engineSourceFilterEl) engineSourceFilterEl.addEventListener('change', () => { state.engineFilter = engineSourceFilterEl.value; renderEngineTab(); });
if (engineSearchEl) engineSearchEl.addEventListener('input', () => { state.engineSearch = engineSearchEl.value.trim(); renderEngineTab(); });
if (engineClearBtn) engineClearBtn.addEventListener('click', () => { state.engineEvents = []; renderEngineTab(); if (countEngineEl) countEngineEl.textContent = '0'; });
if (engineFollowEl) engineFollowEl.addEventListener('change', () => { state.engineFollow = engineFollowEl.checked; });

load();
