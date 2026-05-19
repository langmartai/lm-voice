'use strict';

// Host discovery — scans the user's Claude Code session files
// (~/.claude/projects/**/*.jsonl) for endpoint references, SSH targets, and
// bare LAN IPs, then probes each plausible host:port over HTTP /health.
//
// What's harvested per file (stream-scanned, not memory-mapped):
//   1. http(s)://(ipv4|localhost)(:port)?         — explicit URLs
//   2. <ipv4>:<port>                              — bare host:port pairs
//   3. <ipv4>                                     — bare LAN IPs (RFC1918), probed on default lm-assist ports
//   4. ssh [opts] [user@]<host>                   — SSH access info
//
// Endpoint references are NOT only in the file's opening config — they
// frequently appear deep inside tool output. We read up to 8 MB per file,
// streaming in chunks to keep memory bounded.
//
// Returned shape:
//   {
//     scanned: N,
//     candidateCount: N,                          // unique host:port URLs probed
//     reachable:    [{ url, version, status, hostname, ms }],
//     unreachable:  [{ url, error, ms }],
//     sshTargets:   [{ host, users:[], occurrences, urlReachable }],
//     elapsedMs: N,
//   }

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Strict matchers — only patterns that genuinely look like an endpoint,
// not anything with a colon in it (ISO timestamps, log levels, etc.).
//
// Hostnames without explicit http:// scheme are ignored — they're almost
// always project names or stray tokens, not endpoints.
const URL_RE         = /\bhttps?:\/\/((?:\d{1,3}\.){3}\d{1,3}|localhost|127\.0\.0\.1)(?::(\d{2,5}))?/gi;
const IPV4_PORT_RE   = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/g;
const IPV4_BARE_RE   = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w.:])/g;
// SSH command parsing: grab the whole ssh invocation up to a quote / shell
// metachar / newline, then tokenise to extract -i, -p, user@host.
const SSH_LINE_RE    = /\bssh\b[^\n"'`\\;|&<>]{0,300}/g;

const IGNORE_PORTS  = new Set(['80', '443', '22', '3389', '8080', '8443']);
const LIKELY_PORTS  = new Set(['3100', '3101', '3199']);
const PROBE_PORTS_FOR_BARE_IP = ['3100']; // common lm-assist default; tight to keep probe count low

const PER_FILE_BYTE_CAP = 8 * 1024 * 1024;  // 8 MB per file
const READ_CHUNK_BYTES  = 256 * 1024;       // 256 KB chunks
const CHUNK_TAIL_BYTES  = 256;              // retain last 256 B across chunks for boundary-spanning matches

function isValidIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d+$/.test(p) || p.length > 3) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 127) return true;
  return false;
}

function collectJsonlFiles(dir, { maxFiles = 500 } = {}) {
  const out = [];
  try {
    const stack = [dir];
    while (stack.length && out.length < maxFiles) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const fp = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(fp);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push(fp);
          if (out.length >= maxFiles) break;
        }
      }
    }
  } catch {}
  return out;
}

async function runWithConcurrency(items, concurrency, worker) {
  let idx = 0;
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const myIdx = idx++;
        await worker(items[myIdx]);
      }
    })());
  }
  await Promise.all(runners);
}

// Stream-read a file up to PER_FILE_BYTE_CAP, calling `onText` with overlapping
// text windows so regex matches that span chunk boundaries are still caught.
function streamScan(fp, onText) {
  return new Promise((resolve) => {
    let fd;
    try { fd = fs.openSync(fp, 'r'); } catch { return resolve(); }
    let offset = 0;
    let carry = '';
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    try {
      while (offset < PER_FILE_BYTE_CAP) {
        const want = Math.min(READ_CHUNK_BYTES, PER_FILE_BYTE_CAP - offset);
        const n = fs.readSync(fd, buf, 0, want, offset);
        if (n <= 0) break;
        const text = carry + buf.slice(0, n).toString('utf8');
        onText(text);
        // keep a tail to handle boundary-spanning matches in the next chunk
        carry = text.length > CHUNK_TAIL_BYTES ? text.slice(text.length - CHUNK_TAIL_BYTES) : text;
        offset += n;
        if (n < want) break; // EOF reached
      }
    } catch {} finally {
      try { fs.closeSync(fd); } catch {}
    }
    resolve();
  });
}

function extractFromText(text, acc) {
  let m;

  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    const port = m[2] || '3100'; // default lm-assist port if URL had none
    if (IGNORE_PORTS.has(port)) continue;
    acc.hostPorts.add(`${host}:${port}`);
  }

  IPV4_PORT_RE.lastIndex = 0;
  while ((m = IPV4_PORT_RE.exec(text)) !== null) {
    const host = m[1];
    const port = m[2];
    if (IGNORE_PORTS.has(port)) continue;
    if (!isValidIpv4(host)) continue;
    acc.hostPorts.add(`${host}:${port}`);
  }

  // Bare LAN IPs — promote to probe candidates on default ports so we don't
  // miss hosts that were only ever mentioned by IP in conversation.
  IPV4_BARE_RE.lastIndex = 0;
  while ((m = IPV4_BARE_RE.exec(text)) !== null) {
    const host = m[1];
    if (!isValidIpv4(host)) continue;
    if (!isPrivateIpv4(host)) continue; // skip public IPs — too noisy, would generate thousands
    acc.lanHosts.add(host);
  }

  // SSH commands — parse the full invocation so we capture -i keyfile, -p port,
  // user, and host. Each parsed access record is stored under its (user, host,
  // keyFile, port) key so duplicates collapse. github.com and similar public
  // TLDs are filtered out (documentation examples).
  SSH_LINE_RE.lastIndex = 0;
  while ((m = SSH_LINE_RE.exec(text)) !== null) {
    const access = parseSshLine(m[0]);
    if (!access) continue;
    const { host } = access;
    if (isValidIpv4(host)) {
      // Allow private LAN and public (cloud) IPs alike — public IPs in ssh
      // commands are real targets (OCI instances) not examples.
    } else {
      if (!/\.(local|lan|internal|home|corp|intra|test)$/i.test(host)) continue;
    }
    let rec = acc.ssh.get(host);
    if (!rec) { rec = { host, users: new Map(), occurrences: 0, accesses: new Map() }; acc.ssh.set(host, rec); }
    rec.occurrences++;
    if (access.user) rec.users.set(access.user, (rec.users.get(access.user) || 0) + 1);
    // Collapse by full access tuple — keep the best (most-specific) entry.
    const key = `${access.user || ''}|${access.keyFile || ''}|${access.port || ''}`;
    const cur = rec.accesses.get(key);
    if (!cur) {
      rec.accesses.set(key, { ...access, occurrences: 1, opts: [...access.opts] });
    } else {
      cur.occurrences++;
      // Merge opts (dedup)
      for (const o of access.opts) if (!cur.opts.includes(o)) cur.opts.push(o);
    }
  }
}

// Parse a single `ssh ...` command line into {user, host, keyFile, port, opts}.
// Returns null if the line doesn't end at a recognisable target.
function parseSshLine(line) {
  // Tokenise on whitespace. Strip trailing punctuation/quotes from each token.
  const toks = line.trim().split(/\s+/);
  if (toks[0] !== 'ssh') return null;
  let user = null, host = null, keyFile = null, port = null;
  const opts = [];
  for (let i = 1; i < toks.length; i++) {
    let t = toks[i];
    // Skip trailing backticks/commas/parens that often appear in chat text
    const cleaned = t.replace(/[`,)\]\.]+$/, '');
    if (cleaned === '-i' && i + 1 < toks.length) { keyFile = toks[++i].replace(/[`,)\]]+$/, ''); continue; }
    if (cleaned === '-p' && i + 1 < toks.length) { port = toks[++i].replace(/\D+$/, ''); continue; }
    if (cleaned === '-o' && i + 1 < toks.length) { opts.push(toks[++i].replace(/[`,)\]]+$/, '')); continue; }
    if (cleaned === '-t' || cleaned === '-v' || cleaned === '-A' || cleaned === '-q' || cleaned === '-N' || cleaned === '-f') continue;
    if (cleaned.startsWith('-')) continue; // unknown flag — ignore
    // Positional — first non-flag token that looks like a target wins.
    const mUH = cleaned.match(/^(?:([a-zA-Z][a-zA-Z0-9._-]*)@)?([0-9.]+|[a-zA-Z][a-zA-Z0-9.-]*)$/);
    if (!mUH) continue;
    const maybeHost = mUH[2];
    // Reject obvious non-hosts (single words, numbers without dots)
    if (!/\./.test(maybeHost)) continue;
    if (isValidIpv4(maybeHost) === false && !/\.[a-zA-Z]{2,}$/.test(maybeHost)) continue;
    user = mUH[1] || null;
    host = maybeHost;
    break;
  }
  if (!host) return null;
  return { user, host, keyFile, port: port || null, opts };
}

function probeHealth(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const req = http.request(`${url}/health`, { method: 'GET', timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = null; }
          // lm-assist replies with {success:true, data:{status, version, hostname, ...}}
          const data = json?.data ?? json ?? {};
          if (data?.status === 'healthy' || data?.version) {
            resolve({ ok: true, url, version: data.version ?? null, status: data.status ?? null, hostname: data.hostname ?? null, ms: Date.now() - t0 });
          } else {
            resolve({ ok: false, url, error: `unexpected response (${res.statusCode})`, ms: Date.now() - t0 });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, url, error: err.message, ms: Date.now() - t0 }));
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end();
    } catch (err) {
      resolve({ ok: false, url, error: err.message, ms: Date.now() - t0 });
    }
  });
}

async function discoverHosts({ maxFiles = 200, concurrentProbes = 12 } = {}) {
  const t0 = Date.now();
  const acc = {
    hostPorts: new Set(),
    lanHosts: new Set(),
    ssh: new Map(),
  };
  let scanned = 0;

  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    const files = collectJsonlFiles(CLAUDE_PROJECTS_DIR, { maxFiles });
    scanned = files.length;
    // Parallel I/O — file reads block in libuv threadpool (default 4 workers).
    // 6 keeps the pool full without thrashing the disk on spinning media.
    await runWithConcurrency(files, 6, async (fp) => {
      await streamScan(fp, (text) => extractFromText(text, acc));
    });
  }

  // Always include local defaults so a fresh install still probes localhost.
  acc.hostPorts.add('localhost:3100');
  acc.hostPorts.add('127.0.0.1:3100');

  // Promote bare LAN IPs onto the probe list using default ports.
  for (const ip of acc.lanHosts) {
    for (const port of PROBE_PORTS_FOR_BARE_IP) acc.hostPorts.add(`${ip}:${port}`);
  }

  const urls = [...acc.hostPorts].map((c) => `http://${c}`);
  const reachable = [];
  const unreachable = [];
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const u = urls[idx++];
      const r = await probeHealth(u);
      if (r.ok) reachable.push(r);
      else unreachable.push(r);
    }
  }
  await Promise.all(new Array(Math.min(concurrentProbes, urls.length)).fill(0).map(() => worker()));

  reachable.sort((a, b) => {
    const ap = LIKELY_PORTS.has(new URL(a.url).port) ? 0 : 1;
    const bp = LIKELY_PORTS.has(new URL(b.url).port) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.url.localeCompare(b.url);
  });

  // Build SSH targets list with the full per-access records. Sort each host's
  // accesses by how often they appear (most-used first) and surface the "best"
  // one (with a key file) for direct use by the SSH probe path.
  const reachableHosts = new Set(reachable.map((r) => new URL(r.url).hostname));
  const sshTargets = [...acc.ssh.values()]
    .map((s) => {
      const accesses = [...s.accesses.values()]
        .sort((a, b) => {
          // Prefer entries with explicit user and key file.
          const aScore = (a.keyFile ? 2 : 0) + (a.user ? 1 : 0) + Math.min(a.occurrences, 50) / 50;
          const bScore = (b.keyFile ? 2 : 0) + (b.user ? 1 : 0) + Math.min(b.occurrences, 50) / 50;
          return bScore - aScore;
        });
      return {
        host: s.host,
        users: [...s.users.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => ({ user: u, occurrences: n })),
        accesses,                       // full list of (user, host, keyFile, port, opts) tuples
        bestAccess: accesses[0] ?? null, // most-specific record to use for probing
        occurrences: s.occurrences,
        urlReachable: reachableHosts.has(s.host),
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences);

  return {
    scanned,
    candidateCount: acc.hostPorts.size,
    candidates: [...acc.hostPorts],
    reachable,
    unreachable,
    sshTargets,
    elapsedMs: Date.now() - t0,
  };
}

// SSH-based health probe: run `ssh <opts> <user>@<host> 'curl -s -m 5 http://localhost:<port>/health'`
// and parse the JSON reply. Used as a fallback when direct HTTP probe fails
// (firewalls, lm-assist bound to localhost only on the remote, etc.).
function probeHealthViaSsh(access, { remotePort = 3100, timeoutMs = 10000 } = {}) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [];
    // Only pass -i when the key file actually exists on this machine.
    // Session files often reference Linux paths (~/.ssh/ssh-keys/...) that
    // don't exist on the local Windows box; ssh-agent / Pageant will pick up
    // the right key automatically if we just omit -i.
    if (access.keyFile) {
      const expanded = expandHome(access.keyFile);
      try { if (fs.statSync(expanded).isFile()) args.push('-i', expanded); } catch {}
    }
    if (access.port)    args.push('-p', access.port);
    // Always use BatchMode + a short timeout so we never hang on missing keys.
    args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new');
    for (const o of access.opts || []) {
      if (!args.includes(o)) args.push('-o', o);
    }
    const target = access.user ? `${access.user}@${access.host}` : access.host;
    args.push(target);
    // The remote shell prints two markers so we can distinguish "ssh failed"
    // from "ssh ok, lm-assist missing": __SSH_PROBE_OK__ proves the shell
    // ran; __SSH_PROBE_NO_LMASSIST__ proves curl couldn't reach lm-assist.
    args.push(
      `printf '__SSH_PROBE_OK__\\n__HOSTNAME__:%s\\n' "$(hostname)"; ` +
      `curl -s -m 5 http://localhost:${remotePort}/health || printf '__SSH_PROBE_NO_LMASSIST__'`
    );

    let stdout = '', stderr = '';
    let proc;
    try {
      proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: `spawn failed: ${err.message}`, ms: Date.now() - t0 });
    }
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, error: `ssh error: ${err.message}`, ms: Date.now() - t0 });
    });
    proc.on('close', (code) => {
      clearTimeout(killer);
      const ms = Date.now() - t0;
      // Did the SSH session succeed? The marker `__SSH_PROBE_OK__` is always
      // emitted by the remote shell before curl runs, so its presence proves
      // SSH auth + remote shell worked, even when lm-assist is absent.
      const sshOk = stdout.includes('__SSH_PROBE_OK__') || stdout.includes('__SSH_PROBE_NO_LMASSIST__');
      if (!sshOk) {
        return resolve({
          ok: false, sshOk: false, lmAssistOk: false,
          error: `ssh failed (exit ${code})`,
          ms, stderr: stderr.slice(0, 200),
          access: { user: access.user, host: access.host, keyFile: access.keyFile, port: access.port, opts: access.opts },
        });
      }
      // Strip the markers and try to parse the curl output as JSON.
      const body = stdout.replace(/__SSH_PROBE_OK__\s*/, '').replace(/__SSH_PROBE_NO_LMASSIST__/g, '').trim();
      if (stdout.includes('__SSH_PROBE_NO_LMASSIST__') || !body) {
        return resolve({
          ok: false, sshOk: true, lmAssistOk: false,
          error: `ssh OK but lm-assist not running on remote localhost:${remotePort}`,
          ms, host: access.host, hostname: stdout.match(/__HOSTNAME__:(\S+)/)?.[1] || null,
          access: { user: access.user, host: access.host, keyFile: access.keyFile, port: access.port, opts: access.opts },
        });
      }
      let json = null;
      try { json = JSON.parse(body); } catch {}
      const data = json?.data ?? json ?? {};
      if (data?.status === 'healthy' || data?.version) {
        resolve({
          ok: true, sshOk: true, lmAssistOk: true,
          url: `ssh+http://${target}:${remotePort}`,
          version: data.version ?? null,
          status: data.status ?? null,
          hostname: data.hostname ?? null,
          ms,
          access: { user: access.user, host: access.host, keyFile: access.keyFile, port: access.port, opts: access.opts },
        });
      } else {
        resolve({
          ok: false, sshOk: true, lmAssistOk: false,
          error: `unexpected ssh probe response`, ms, raw: body.slice(0, 200),
          access: { user: access.user, host: access.host, keyFile: access.keyFile, port: access.port, opts: access.opts },
        });
      }
    });
  });
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

module.exports = { discoverHosts, probeHealthViaSsh, CLAUDE_PROJECTS_DIR };
