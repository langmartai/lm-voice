'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CRED_PATHS = [
  path.join(os.homedir(), '.claude', '.credentials.json'),
  path.join(os.homedir(), '.config', 'claude', '.credentials.json'),
];

function findCredentialsFile() {
  for (const p of CRED_PATHS) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function readClaudeOAuthToken() {
  if (process.env.CLAUDE_OAUTH_TOKEN) return process.env.CLAUDE_OAUTH_TOKEN;

  const file = findCredentialsFile();
  if (!file) {
    throw new Error(
      `Could not find Claude credentials. Run 'claude login' first, or set CLAUDE_OAUTH_TOKEN env var.\n` +
      `Searched: ${CRED_PATHS.join(', ')}`
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${file} as JSON: ${err.message}`);
  }
  const token =
    parsed?.claudeAiOauth?.accessToken ??
    parsed?.oauthAccount?.accessToken ??
    parsed?.accessToken ??
    null;
  if (!token) {
    throw new Error(`No accessToken found in ${file}. Try 'claude login' again.`);
  }
  return token;
}

module.exports = { readClaudeOAuthToken, findCredentialsFile };
