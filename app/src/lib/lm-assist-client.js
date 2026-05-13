'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function request(endpoint, pathname, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(pathname, endpoint);
    } catch (err) {
      return reject(new Error(`Bad endpoint URL: ${endpoint}${pathname}: ${err.message}`));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const req = lib.request(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode} on ${method} ${pathname}: ${text.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          err.responseText = text;
          return reject(err);
        }
        const ct = res.headers['content-type'] ?? '';
        if (ct.includes('application/json')) {
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`Failed to parse JSON response: ${err.message}`));
          }
        } else {
          resolve(text);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class LMAssistClient {
  constructor({ endpoint }) {
    if (!endpoint) throw new Error('LMAssistClient requires endpoint');
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  async health() {
    return request(this.endpoint, '/health');
  }

  async listSessions() {
    return request(this.endpoint, '/sessions');
  }

  async getSession(id, { unlimited = false, lastN = null } = {}) {
    const params = new URLSearchParams();
    if (unlimited) params.set('unlimited', 'true');
    if (lastN != null) params.set('lastN', String(lastN));
    const q = params.toString();
    return request(this.endpoint, `/sessions/${encodeURIComponent(id)}${q ? '?' + q : ''}`);
  }

  async execute({ prompt, cwd, model = 'haiku', permissionMode = 'bypassPermissions', settingSources = ['project', 'user'], effort = 'low', thinking = null, background = true, abortController = null }) {
    const body = {
      prompt,
      cwd,
      background,
      model,
      permissionMode,
      settingSources,
      outputConfig: { effort },
    };
    if (thinking) body.extendedThinking = thinking;
    return request(this.endpoint, '/agent/execute', { method: 'POST', body });
  }

  async getExecution(id) {
    return request(this.endpoint, `/agent/execution/${encodeURIComponent(id)}`);
  }

  async waitForExecution(id, { intervalMs = 1000, timeoutMs = 120_000 } = {}) {
    const started = Date.now();
    while (true) {
      const exec = await this.getExecution(id);
      const status = exec.status ?? exec.state;
      if (status === 'completed' || status === 'failed' || status === 'aborted' || status === 'success' || status === 'error') {
        return exec;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Execution ${id} did not complete within ${timeoutMs}ms (last status: ${status})`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async abortExecution(id) {
    return request(this.endpoint, `/agent/execution/${encodeURIComponent(id)}/abort`, { method: 'POST' });
  }
}

module.exports = { LMAssistClient, request };
