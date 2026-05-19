'use strict';

const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);

const chipsEl = $('server-chips');
const addToggleBtn = $('add-server-toggle');
const addBlock = $('add-server');
const newUrlEl = $('new-url');
const newLabelEl = $('new-label');
const addSaveBtn = $('add-server-save');
const addCancelBtn = $('add-server-cancel');
const statusEl = $('endpoint-status');
const tabBtns = document.querySelectorAll('.tab');
const sessionsPane = $('sessions');
const recentPane = $('recent');
const historyPane = $('history');
const emptyEl = $('empty');
const loadingEl = $('loading');
const refreshBtn = $('refresh');
const skipBtn = $('skip');

let state = {
  endpoint: '',
  servers: [],
  recentSessions: [],
  currentSession: null,
  sessions: [],
  activeTab: 'sessions',
  allHosts: [],
};

function setStatus(text, klass) {
  statusEl.textContent = text;
  statusEl.classList.remove('ok', 'error');
  if (klass) statusEl.classList.add(klass);
}

function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = (Date.now() - t) / 1000;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function projectShortName(p) {
  if (!p) return '(unknown)';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

// Group hosts by machine identity (hostname when known, else IP). Each group
// becomes a single chip — the label shows the hostname plus its primary IP
// and SSH user.
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
const CAT_RANK = { 'direct': 0, 'via-ssh': 1, 'proxy': 2, 'ssh-only': 3, 'failed': 4 };

function buildHostGroups() {
  const all = state.allHosts || [];
  if (!all.length) {
    // Fallback: legacy server list, no grouping.
    return (state.servers.length ? state.servers : [{ url: state.endpoint, label: state.endpoint }])
      .map((s) => ({
        key: 'url:' + s.url,
        hostname: null,
        ips: [s.url],
        bestEndpoint: s.url,
        cat: 'direct',
        sshUsers: [],
        entries: [{ url: s.url }],
      }));
  }
  const groups = new Map();
  for (const h of all) {
    const k = hostKey(h);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
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
    // Best endpoint = first http:// entry on port 3100 (real lm-assist), else
    // first http:// entry, else null (ssh-only group, no endpoint to query).
    const lmAssistEntry = entries.find((e) => e.url?.startsWith('http://') && e.url.endsWith(':3100'));
    const anyHttp = entries.find((e) => e.url?.startsWith('http://'));
    const bestEndpoint = (lmAssistEntry || anyHttp)?.url || null;
    out.push({ key, hostname, ips, sshUsers: users, cat: bestCat, bestEndpoint, entries });
  }
  // Direct first, ssh-only last.
  out.sort((a, b) => {
    if (CAT_RANK[a.cat] !== CAT_RANK[b.cat]) return CAT_RANK[a.cat] - CAT_RANK[b.cat];
    return (a.hostname || a.key).localeCompare(b.hostname || b.key);
  });
  return out;
}

function renderServerChips() {
  chipsEl.innerHTML = '';
  const groups = buildHostGroups();
  for (const g of groups) {
    const active = g.bestEndpoint && g.bestEndpoint === state.endpoint;
    const chip = document.createElement('div');
    chip.className = 'chip ' + g.cat + (active ? ' active' : '') + (g.bestEndpoint ? '' : ' disabled');
    const ipText = g.ips.slice(0, 2).join(', ') + (g.ips.length > 2 ? ` +${g.ips.length - 2}` : '');
    const userText = g.sshUsers[0] || '';
    chip.innerHTML = `
      <span class="dot"></span>
      <div class="chip-text">
        <div class="lbl">${escapeHtml(g.hostname || g.ips[0] || g.key)}</div>
        <div class="sub">
          ${ipText ? `<span class="kv"><span class="k">ip</span>${escapeHtml(ipText)}</span>` : ''}
          ${userText ? `<span class="kv"><span class="k">ssh</span>${escapeHtml(userText)}${g.sshUsers.length > 1 ? `+${g.sshUsers.length - 1}` : ''}</span>` : ''}
        </div>
      </div>
      <span class="cat-tag">${escapeHtml(g.cat === 'direct' ? 'lm-assist' : g.cat === 'via-ssh' ? 'via SSH' : g.cat === 'proxy' ? 'proxy' : g.cat === 'ssh-only' ? 'SSH only' : g.cat)}</span>
    `;
    chip.title = g.entries.map((e) => `${e.url}${e.version ? ' (v' + e.version + ')' : ''}`).join('\n');
    chip.addEventListener('click', () => {
      if (!g.bestEndpoint) {
        // SSH-only group: no lm-assist endpoint to query — show a notice in
        // the sessions pane instead of trying to fetch.
        setStatus(`${g.hostname || g.ips[0]} has no lm-assist (SSH only)`, 'error');
        sessionsPane.innerHTML = `<div class="muted" style="padding:14px;line-height:1.5">
          <b>${escapeHtml(g.hostname || g.ips[0] || 'this host')}</b> is reachable via SSH but doesn't have lm-assist installed.<br><br>
          To enable session listing, install lm-assist on the remote:<br>
          <code style="display:block;margin-top:6px;padding:6px;background:rgba(255,255,255,0.05);border-radius:4px;font-size:11px">
            ${escapeHtml(g.entries.map((e) => {
              const a = e.access;
              if (!a) return '';
              const k = a.keyFile ? `-i ${a.keyFile} ` : '';
              return `ssh ${k}${a.user ? a.user + '@' : ''}${a.host}`;
            }).filter(Boolean)[0] || '')}
          </code>
        </div>`;
        return;
      }
      state.endpoint = g.bestEndpoint;
      renderServerChips();
      loadSessions();
    });
    chipsEl.appendChild(chip);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}

function groupByProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const proj = projectShortName(s.projectPath ?? s.cwd);
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj).push(s);
  }
  // Sort projects by most recent session
  return Array.from(groups.entries()).map(([proj, items]) => ({
    proj,
    items: items.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '')),
    lastTs: items.reduce((m, x) => (x.lastModified > m ? x.lastModified : m), ''),
  })).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

function sessionRow(s, opts = {}) {
  const id = s.sessionId ?? s.id;
  const fullProj = s.projectPath ?? s.cwd ?? '';
  const proj = projectShortName(fullProj);
  const last = (s.lastUserMessage ?? '').trim() || '(no user messages)';
  const when = fmtRelative(s.lastModified ?? s.ts ?? s.createdAt);
  const turns = s.userPromptCount != null ? `${s.userPromptCount} turns` : '';
  const cost = typeof s.totalCostUsd === 'number' ? `$${s.totalCostUsd.toFixed(2)}` : '';
  const isCurrent = state.currentSession?.id === id;

  const row = document.createElement('div');
  row.className = 'item' + (isCurrent ? ' current' : '');
  row.title = fullProj;
  row.innerHTML = `
    <div class="row1">
      <span class="proj"></span>
      <span class="meta"></span>
    </div>
    <div class="last"></div>
    <div class="sid"></div>
  `;
  const projEl = row.querySelector('.proj');
  if (opts.showProject !== false) projEl.textContent = proj;
  else projEl.textContent = '·';
  row.querySelector('.meta').textContent = [when, turns, cost].filter(Boolean).join(' · ');
  row.querySelector('.last').textContent = last;
  row.querySelector('.sid').textContent = id;

  row.addEventListener('click', () => {
    ipcRenderer.send('picker-select', {
      id,
      cwd: fullProj || null,
      label: proj,
      endpoint: opts.endpoint || state.endpoint,
    });
  });
  return row;
}

function renderSessions() {
  sessionsPane.innerHTML = '';
  if (!state.sessions.length) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = 'No sessions on this server.';
    sessionsPane.appendChild(emptyEl);
    return;
  }
  emptyEl.classList.add('hidden');
  const groups = groupByProject(state.sessions);
  for (const g of groups) {
    const hdr = document.createElement('div');
    hdr.className = 'group-header';
    hdr.innerHTML = `<span></span><span></span>`;
    hdr.firstChild.textContent = g.proj;
    hdr.lastChild.textContent = `${g.items.length} session${g.items.length === 1 ? '' : 's'}`;
    sessionsPane.appendChild(hdr);
    for (const s of g.items) sessionsPane.appendChild(sessionRow(s, { showProject: false }));
  }
}

function renderRecent() {
  recentPane.innerHTML = '';
  if (!state.recentSessions.length) {
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = 'No recent sessions yet — pick one to start.';
    recentPane.appendChild(m);
    return;
  }
  for (const r of state.recentSessions) {
    const fakeSession = {
      sessionId: r.id,
      projectPath: r.cwd,
      lastUserMessage: `[${r.endpoint}] ${r.label || ''}`,
      lastModified: r.ts,
    };
    recentPane.appendChild(sessionRow(fakeSession, { showProject: true, endpoint: r.endpoint }));
  }
}

async function renderHistory() {
  historyPane.innerHTML = '';
  const sid = state.currentSession?.id;
  if (!sid) {
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = 'No active session — pick one and start talking to see history.';
    historyPane.appendChild(m);
    return;
  }
  const entries = await ipcRenderer.invoke('picker-get-history', sid);
  if (!entries.length) {
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = `No conversation logged yet for session ${sid.slice(0, 8)}…`;
    historyPane.appendChild(m);
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'history-entry ' + (e.role === 'user' ? 'user' : 'assistant');
    row.innerHTML = `<span class="role"></span><span class="text"></span><span class="ts"></span>`;
    row.querySelector('.role').textContent = e.role === 'user' ? 'YOU' : 'BOT';
    row.querySelector('.text').textContent = e.text || '';
    row.querySelector('.ts').textContent = fmtRelative(e.ts);
    historyPane.appendChild(row);
  }
  historyPane.scrollTop = historyPane.scrollHeight;
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const b of tabBtns) b.classList.toggle('active', b.dataset.tab === tab);
  sessionsPane.classList.toggle('active', tab === 'sessions');
  recentPane.classList.toggle('active', tab === 'recent');
  historyPane.classList.toggle('active', tab === 'history');
  if (tab === 'recent') renderRecent();
  if (tab === 'history') renderHistory();
}

async function loadSessions() {
  setStatus(`Connecting to ${state.endpoint}…`);
  state.sessions = [];
  loadingEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  sessionsPane.innerHTML = '';
  try {
    const res = await ipcRenderer.invoke('picker-fetch-sessions', state.endpoint);
    loadingEl.classList.add('hidden');
    if (!res.ok) {
      setStatus(`Error: ${res.error}`, 'error');
      return;
    }
    state.sessions = res.sessions;
    setStatus(`Connected · ${res.sessions.length} sessions${res.version ? ` · lm-assist ${res.version}` : ''}`, 'ok');
    renderSessions();
  } catch (err) {
    loadingEl.classList.add('hidden');
    setStatus(`Error: ${err.message}`, 'error');
  }
}

async function init() {
  state = { ...state, ...(await ipcRenderer.invoke('picker-get-state')) };
  if (!state.endpoint && state.servers.length) state.endpoint = state.servers[0].url;
  renderServerChips();
  await loadSessions();
}

// Add-server interactions
addToggleBtn.addEventListener('click', () => {
  addBlock.classList.toggle('hidden');
  if (!addBlock.classList.contains('hidden')) newUrlEl.focus();
});

addCancelBtn.addEventListener('click', () => {
  addBlock.classList.add('hidden');
  newUrlEl.value = '';
  newLabelEl.value = '';
});

async function commitNewServer() {
  const url = newUrlEl.value.trim();
  if (!url) return;
  const label = newLabelEl.value.trim() || null;
  const updated = await ipcRenderer.invoke('picker-add-server', { url, label });
  state.servers = updated;
  state.endpoint = url;
  newUrlEl.value = '';
  newLabelEl.value = '';
  addBlock.classList.add('hidden');
  renderServerChips();
  loadSessions();
}

addSaveBtn.addEventListener('click', commitNewServer);
newUrlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewServer(); } });
newLabelEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewServer(); } });

// Tabs
for (const b of tabBtns) b.addEventListener('click', () => switchTab(b.dataset.tab));

refreshBtn.addEventListener('click', () => {
  if (state.activeTab === 'sessions') loadSessions();
  else if (state.activeTab === 'recent') renderRecent();
  else if (state.activeTab === 'history') renderHistory();
});

skipBtn.addEventListener('click', () => ipcRenderer.send('picker-skip'));

const closeBtn = $('close-btn');
if (closeBtn) closeBtn.addEventListener('click', () => ipcRenderer.send('picker-skip'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('picker-skip');
});

init();
