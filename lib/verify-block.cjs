'use strict';

// Single source of truth for reading a task plan's <verify> block.
// The regex previously existed in three places (lib/plan-lint.cjs,
// bin/np-tools/plan-lint.cjs, and — as a comment only — workflows/execute-phase.md),
// which is why the orchestrator had no way to actually obtain the command:
// $VERIFY_CMD was never defined anywhere.

// D1: the canonical <verify> body is NOT bare lines — it is the container form
// the planner is required to emit and the plan-checker enforces:
//   <verify><automated>npm test</automated></verify>
// (agents/np-planner.md answer_validation #5/#7, np-plan-checker.md Dimension 7;
// 409 occurrences across the nubos-context plan corpus, 0 bare-line blocks.)
// Handing that to `bash -c` verbatim is a syntax error (rc=2), which flipped the
// original "verify is always green" bug into "verify is always red" — an endless
// build-fixer loop that never reaches loop-commit.
//
// Whitelist, not blacklist: <automated> is the ONLY executable container. Prose,
// unknown tags and above all <manual> — a human procedure — must never reach bash.
const VERIFY_RE = /<verify>([\s\S]*?)<\/verify>/g;
const AUTOMATED_RE = /<automated>([\s\S]*?)<\/automated>/g;
// Unclosed variant included on purpose: a truncated <manual> must swallow the
// rest of the block rather than leak its body onto the command line.
const MANUAL_RE = /<manual>[\s\S]*?(?:<\/manual>|$)/g;
const CONTAINER_TAG_RE = /<\/?(?:verify|automated|manual)>/g;

// XML entities: real plans carry `grep -nE '"--min=80"' composer.json &amp;&amp; ! grep …`.
// `&amp;` decodes LAST so that `&amp;lt;` yields the literal `&lt;`, not `<`.
function _decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractVerifyBlocks(body) {
  const out = [];
  for (const m of String(body || '').matchAll(VERIFY_RE)) {
    out.push({ start: m.index, body: m[1] });
  }
  return out;
}

function _pushLines(text, out) {
  for (const raw of String(text).split('\n')) {
    // Stray container tags (e.g. an unclosed `<automated>npm test`) are removed
    // rather than executed — the goal is a runnable line, never a syntax error.
    const line = _decodeEntities(raw.replace(CONTAINER_TAG_RE, '')).trim();
    if (!line || line.startsWith('#')) continue;
    out.push(line);
  }
}

// The executable lines of every <verify> block, in order: <manual> steps,
// comments and blank lines dropped, entities decoded, nothing else interpreted.
// Callers fail closed on an empty result (bash -c "" exits 0 = falsely green).
function verifyCommandLines(body) {
  const out = [];
  for (const block of extractVerifyBlocks(body)) {
    // Manual steps die first, so they cannot leak through either branch below.
    const blockBody = String(block.body).replace(MANUAL_RE, '\n');
    const automated = [...blockBody.matchAll(AUTOMATED_RE)];
    if (automated.length) {
      for (const m of automated) _pushLines(m[1], out);
      continue;
    }
    // Legacy bare-line form (no <automated> container) — still supported so an
    // older hand-written plan keeps working.
    _pushLines(blockBody, out);
  }
  return out;
}

module.exports = { extractVerifyBlocks, verifyCommandLines };
