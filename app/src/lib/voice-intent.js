'use strict';

// Lightweight voice-command intent matcher for session/server control.
// Runs BEFORE the agent. If it returns a non-null intent, the agent is skipped
// and the action is performed directly with a short spoken confirmation.

const VERBS_SWITCH = ['switch', 'change', 'use', 'pick', 'select', 'open', 'go to', 'go too', 'load', 'jump to', 'pin'];
const VERBS_LIST   = ['list', 'show', 'pick a', 'choose'];
const WHAT_PHRASES = ['what session', "what's my session", 'what is my session', 'current session', 'which session'];
const STATUS_RE = /\b(?:what(?:'s|\s+is)\s+new|what(?:'s|\s+is)\s+going\s+on|any\s+updates?|anything\s+chang\w*|anything\s+happen\w*|what\s+chang\w*|background|running\s+(?:executions?|agents?|jobs?)|what(?:'s|\s+is)\s+running|status\s+(?:of|update)|how(?:'s|\s+is)\s+(?:it|things))\b/i;
const UNPIN_RE = /\b(unpin|clear|forget|drop)\s+(?:the\s+)?session\b|\bno session\b|\breset\s+session\b/i;
// "Recap": questions about the VOICE conversation itself — answer from local history, not the agent.
const RECAP_RE = /\b(?:what\s+(?:are|did)\s+we\s+(?:discuss\w*|talk\w*|chat\w*|work\w+\s+on)|what\s+did\s+i\s+(?:just\s+)?(?:say|ask|tell)|what'?s\s+our\s+(?:chat|conversation|discussion)|recap|summari[sz]e\s+(?:our|this|the)\s+(?:chat|conversation|discussion)|recent\s+discuss\w*|last\s+thing\s+(?:i\s+)?(?:said|asked))\b/i;

// Voice / speed control — keep regexes specific so they don't shadow free-form questions.
const VOICE_LIST_RE = /\b(?:list|show|tell|what)\b[a-z\s']{0,30}\bvoices?\b/i;
const VOICE_SET_RE = /\b(?:change|switch|set|use|swap)\s+(?:the\s+)?voice\s+(?:to\s+|with\s+)?([a-zA-Z]\s*\d|\w+)\b/i;
const SPEED_FASTER_RE = /\b(?:speak|talk)?\s*(?:faster|quicker|speed\s+up)\b/i;
const SPEED_SLOWER_RE = /\b(?:speak|talk)?\s*(?:slower|slow\s+down)\b/i;
const SPEED_SET_RE = /\b(?:set\s+)?(?:speech\s+|talk\s+|voice\s+)?speed\s+(?:to\s+)?([0-9]+(?:\.[0-9]+)?)\b/i;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[.,!?;:]+$/g, '').trim();
}

function escapeForRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function detect(transcript, ctx = {}) {
  const t = norm(transcript);
  if (!t) return null;

  // "unpin / clear session"
  if (UNPIN_RE.test(t)) return { intent: 'unpin' };

  // "what's new" / "any updates" / "what's running" — background state query
  if (STATUS_RE.test(t)) return { intent: 'status' };

  // "recap" / "what did we discuss" / "what did I just say" — local voice history
  if (RECAP_RE.test(t)) return { intent: 'recap' };

  // Voice + speed control
  if (VOICE_LIST_RE.test(t)) return { intent: 'voice-list' };
  if (SPEED_FASTER_RE.test(t)) return { intent: 'speed-faster' };
  if (SPEED_SLOWER_RE.test(t)) return { intent: 'speed-slower' };
  const spd = t.match(SPEED_SET_RE);
  if (spd) return { intent: 'speed-set', value: spd[1] };
  const v = t.match(VOICE_SET_RE);
  if (v) return { intent: 'voice-set', target: v[1].replace(/\s+/g, '').toUpperCase() };

  // "what session am I on" → query current
  for (const p of WHAT_PHRASES) {
    if (t.includes(p)) return { intent: 'current' };
  }

  // "list sessions" / "show sessions" / "pick a session"
  for (const v of VERBS_LIST) {
    const re = new RegExp(`^${escapeForRegex(v)}\\b.*\\b(session|sessions|server|servers)`, 'i');
    if (re.test(t)) return { intent: 'open-picker' };
  }

  // "switch to <name>" / "use session <name>" — extract the target name
  for (const v of VERBS_SWITCH) {
    const re = new RegExp(`^${escapeForRegex(v)}\\b(?:\\s+to)?(?:\\s+(?:the\\s+)?(?:session|project|server))?\\s+(.+)$`, 'i');
    const m = t.match(re);
    if (m && m[1]) {
      const target = norm(m[1]).replace(/^(the\s+|session\s+|project\s+|server\s+)+/i, '').trim();
      if (target) return { intent: 'switch', target };
    }
  }

  return null;
}

/**
 * Score how well `candidate` (project label / session id) matches the user's `target` phrase.
 * Higher = better. Returns 0 if no plausible match.
 */
function scoreMatch(target, candidate) {
  const t = norm(target);
  const c = norm(candidate);
  if (!t || !c) return 0;
  if (t === c) return 100;
  if (c.includes(t)) return 80;
  if (t.includes(c)) return 70;
  // word-overlap heuristic
  const tw = new Set(t.split(/\s+/));
  const cw = new Set(c.split(/[\s\-_]+/));
  let overlap = 0;
  for (const w of tw) if (cw.has(w)) overlap++;
  if (overlap >= 1) return 30 + overlap * 10;
  return 0;
}

function resolveTarget(target, candidates) {
  // candidates: [{ id, label, projectShort, server }]
  let best = null;
  for (const c of candidates) {
    const score = Math.max(
      scoreMatch(target, c.label),
      scoreMatch(target, c.projectShort),
      scoreMatch(target, c.id?.slice(0, 8)),
    );
    if (score > 0 && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}

module.exports = { detect, resolveTarget, scoreMatch };
