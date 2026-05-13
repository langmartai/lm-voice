'use strict';

/**
 * Build the agent prompt for the Haiku voice assistant.
 *
 * The agent's job is to interpret the spoken command, query the target
 * Claude Code session via lm-assist's API (and optionally read project
 * files), and produce a SHORT, conversational reply suitable for TTS.
 */
function buildAgentPrompt({ transcript, session, lmAssistEndpoint, maxReplyChars = 350 }) {
  const sessionBlock = session?.id
    ? [
        `Target Claude Code session:`,
        `  Session ID: ${session.id}`,
        `  Project directory (cwd): ${session.cwd ?? '(unknown)'}`,
        session.label ? `  Label: ${session.label}` : null,
      ].filter(Boolean).join('\n')
    : 'No specific Claude Code session has been selected yet — answer general questions; for session-specific queries, say so and suggest the user pick a session.';

  const endpoint = lmAssistEndpoint.replace(/\/+$/, '');

  return `You are a voice assistant. The user spoke a command into a microphone and it was transcribed to text. You will reply with text that will be spoken aloud by a TTS engine.

${sessionBlock}

lm-assist API base URL: ${endpoint}

Available read endpoints on lm-assist (use Bash with curl):
  GET ${endpoint}/sessions
      → list all sessions
  GET ${endpoint}/sessions/{id}/conversation?lastN=20&toolDetail=summary
      → formatted recent conversation (most useful for "what is X doing now?" style questions)
  GET ${endpoint}/sessions/{id}?fromUserPromptIndex=N&toUserPromptIndex=M
      → raw session JSONL slice
  GET ${endpoint}/monitor/executions
      → currently running agent executions
  GET ${endpoint}/sessions/{id}/conversation?lastN=5
      → just the very last few turns

You may also read files in the project directory if it is set.

THE USER SAID (transcribed from voice):
"${transcript.replace(/"/g, '\\"')}"

REPLY RULES — read carefully, this is the hardest part of your job:

1. Output PLAIN SPOKEN ENGLISH. No markdown. No bullets. No headers. No code blocks. No URLs. No file paths unless absolutely essential. No tables.

2. Be SHORT. Hard cap: ${maxReplyChars} characters. Aim for 1 to 3 sentences. The user is listening, not reading. They cannot scan.

3. Speak numbers naturally:
   - "thirty trades", not "n=30" or "30 trades total"
   - "about a million dollars", not "$1,034,219"
   - "twenty percent", not "20%"
   - "last Tuesday", not "2026-05-05"

4. SUMMARIZE, do not enumerate. If there are 8 things, say "eight of them, the biggest is X" — never list all 8.

5. If you don't know something or the data isn't available, say so in one sentence. Don't guess.

6. If the user's command is ambiguous, ask ONE clarifying question — short, single sentence.

7. Acknowledge action requests but don't pretend to do things you cannot do. If the user asks you to MODIFY anything (place trade, edit code, run a command), respond "I can't do that from voice — switch to the terminal session for that" unless the action is read-only.

8. NO meta-commentary. Do not say "Sure!", "Let me check…", "I will now query the API…", or "Here is the answer:". Just answer.

9. Output ONLY the spoken reply. Nothing before, nothing after. No quotes around it.`;
}

/**
 * Clean a Haiku response to be more TTS-friendly.
 * The system prompt above tries to enforce this, but defense in depth:
 * strip markdown, collapse whitespace, hard-cap length.
 */
function cleanForTTS(text, maxChars = 600) {
  if (!text) return '';
  let s = String(text);

  // Strip code fences and inline code
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]+)`/g, '$1');

  // Strip markdown formatting
  s = s.replace(/^\s*[#>*\-+]\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Drop URLs
  s = s.replace(/https?:\/\/\S+/g, '');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Hard cap
  if (s.length > maxChars) {
    const cutAt = s.lastIndexOf('.', maxChars);
    s = s.slice(0, cutAt > maxChars - 80 ? cutAt + 1 : maxChars - 1).trim();
    if (!/[.!?]$/.test(s)) s += '.';
  }

  return s;
}

module.exports = { buildAgentPrompt, cleanForTTS };
