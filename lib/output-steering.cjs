'use strict';

const OPEN = '<nubos_output_shaping>';
const CLOSE = '</nubos_output_shaping>';
const SHAPING_RE = /\n*<nubos_output_shaping>[\s\S]*?<\/nubos_output_shaping>\s*$/;

const PROFILES = Object.freeze({
  balanced: '',
  concise: 'Skip preamble and postamble; lead with the substance. Do not restate code, file '
    + 'contents, diffs, or tool output that already appear above — reference them by path and line.',
  terse: 'Skip preamble and postamble; lead with the substance. Never restate code, files, '
    + 'diffs, or tool output already present — reference them by path and line. After a tool '
    + 'call succeeds, continue without narrating the result.',
  minimal: 'Minimum tokens. Fragments are fine. No preamble, no postamble, no narration. Never '
    + 'restate existing code, files, diffs, or tool output — reference by path and line. State '
    + 'only what changed or what the answer is.',
});

const EFFORT_RANK = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 });

function steeringDirective(profile) {
  const key = typeof profile === 'string' ? profile.toLowerCase() : 'balanced';
  return Object.prototype.hasOwnProperty.call(PROFILES, key) ? PROFILES[key] : '';
}

function enrichSystemPrompt(prompt, profile) {
  const base = String(prompt == null ? '' : prompt).replace(SHAPING_RE, '');
  const directive = steeringDirective(profile);
  if (!directive) return base;
  return base + '\n\n' + OPEN + '\n' + directive + '\n' + CLOSE;
}

function classifyTurn(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'new_user_ask';
  let lastAssistant = -1;
  for (let k = messages.length - 1; k >= 0; k -= 1) {
    if (messages[k] && messages[k].role === 'assistant') { lastAssistant = k; break; }
  }
  const pending = messages.slice(lastAssistant + 1);
  if (pending.length === 0) return 'new_user_ask';
  if (pending.some((m) => m && m.role === 'user')) return 'new_user_ask';
  const tools = pending.filter((m) => m && m.role === 'tool');
  if (tools.length === 0) return 'new_user_ask';
  return tools.some((m) => _isErrorResult(m.content)) ? 'error_continuation' : 'mechanical_continuation';
}

function _isErrorResult(content) {
  const s = String(content == null ? '' : content);
  return /^Error:/.test(s) || /\b(ERROR|FAILED|FATAL|Exception|Traceback)\b/.test(s);
}

function routeEffort(currentEffort, turnKind, opts) {
  const o = opts || {};
  if (typeof currentEffort !== 'string' || !(currentEffort in EFFORT_RANK)) return currentEffort;
  if (turnKind !== 'mechanical_continuation') return currentEffort;
  const target = typeof o.mechanicalEffort === 'string' && o.mechanicalEffort in EFFORT_RANK
    ? o.mechanicalEffort : 'low';
  return EFFORT_RANK[target] < EFFORT_RANK[currentEffort] ? target : currentEffort;
}

module.exports = {
  PROFILES,
  EFFORT_RANK,
  steeringDirective,
  enrichSystemPrompt,
  classifyTurn,
  routeEffort,
};
