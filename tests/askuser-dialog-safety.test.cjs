'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Every directory whose Markdown may drive an askuser dialog. `workflows/` was the
// original scope; `agents/` was invisible to the linter for its whole life even
// though 8 of its files call askuser.
const SCANNED_DIRS = ['workflows', 'agents', 'skills', 'templates'];

// ---------------------------------------------------------------------------
// KNOWN LIMITS OF THIS LINT — read before trusting a green run.
//
// This is a regex/heuristic lint over shell fragments embedded in Markdown
// prose. It is NOT a bash parser and can never be airtight. What it does NOT
// see, today:
//
//   * Routing expressed as prose ("On `Abort` the workflow exits 0") instead of
//     shell. Several dialogs legitimately route this way; ADS-2 skips a spec
//     when no case block follows it, so a prose-routed dialog is unchecked.
//   * Dispatch through a variable indirection (`eval`, arrays, `${!var}`).
//   * A case arm whose body is loud but wrong (semantics are out of scope —
//     ADS-1 only proves an unmatched answer cannot pass silently).
//   * Labels built at runtime from `$(...)` rather than written as literals.
//   * askuser specs whose JSON is elided with `…` (agents/np-planner.md) — they
//     cannot be parsed, so their labels are unchecked. ADS-0 pins the count so a
//     NEW unparseable spec is a deliberate act, not an accident.
//   * Shell that is NOT inside a ```bash/```sh/```shell fence. Scanning only
//     fences is deliberate — prose quoting broken code (e.g. the comment
//     explaining a fix) would otherwise be flagged as the offence — but it means
//     a dialog written in an unfenced/indented block is invisible.
//   * ADS-2 pairs a spec with the FIRST case block before the next askuser call.
//     A dialog dispatched further downstream, or by a case block that appears
//     above it, reads as prose-routed and is skipped.
//
// The point of this file is to make the common shapes mechanically impossible,
// not to claim the class is closed. When a defect slips through, widen the lint
// here rather than fixing only the one site.
// ---------------------------------------------------------------------------

// Recursive on purpose: `skills/` keeps all 215 of its .md files one level down,
// so a readdir-only scan would report "skills/ is covered" while reading nothing
// from it.
function _mdFiles() {
  const out = [];
  const walk = (abs) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.md')) out.push(p);
    }
  };
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

const _rel = (f) => path.relative(ROOT, f);

// --- shell-ish tokenizing helpers -------------------------------------------

// Strip `#` comments while respecting quotes, so an `esac` mentioned in a
// comment can no longer terminate a case block early (the old non-greedy
// `[\s\S]*?esac` regex produced a false POSITIVE that way).
function _stripComments(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    let quote = null;
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { cut = i; break; }
    }
    out.push(cut < 0 ? line : line.slice(0, cut));
  }
  return out.join('\n');
}

// Join `\`-continued lines so an askuser call split over two lines is still one
// logical statement.
function _joinContinuations(raw) {
  return raw.replace(/\\\n\s*/g, ' ');
}

function _normalize(raw) {
  return _joinContinuations(_stripComments(raw));
}

// Only the ```bash fences. Prose ABOUT a defect legitimately quotes the broken
// code (the whole point of the comment above a fix), so a raw-file grep for a
// bad pattern flags the explanation as the offence.
//
// Non-code lines are BLANKED rather than dropped, so every offset still maps to
// the real line number in the real file — an offender message must be greppable.
function _bashFences(raw) {
  const lines = raw.split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      const opening = !inFence && /^\s*```(bash|sh|shell)\s*$/.test(line);
      inFence = inFence ? false : opening;
      return '';
    }
    return inFence ? line : '';
  }).join('\n');
}

// Shell variables that receive an askuser answer. Covers every assignment shape
// that reaches a shell variable:
//   VAR=$(node … askuser …)      VAR="$(node … askuser …)"
//   VAR=$( \n node … askuser …)  VAR=`node … askuser …`
function _answerVars(text) {
  const vars = new Set();
  const re = /(\w+)=\s*"?(?:\$\(|`)([\s\S]{0,400}?)askuser/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Reject a match that already closed its substitution before askuser.
    if (!m[2].includes(')') && !m[2].includes('`')) vars.add(m[1]);
  }
  return vars;
}

// Locate `case … in … esac` with a real stack, so nesting is handled and an
// inner `esac` can no longer satisfy an outer block.
function _caseBlocks(text) {
  const tokenRe = /\bcase\s+("?\$\{?(\w+)\}?"?)\s+in\b|\besac\b/g;
  const stack = [];
  const blocks = [];
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m[2]) {
      stack.push({ variable: m[2], start: tokenRe.lastIndex, index: m.index });
    } else if (stack.length) {
      const open = stack.pop();
      blocks.push({
        variable: open.variable,
        index: open.index,
        body: text.slice(open.start, m.index),
      });
    }
  }
  return blocks;
}

// The body of a case block minus every nested case block, so arms of an inner
// dispatch are not mistaken for arms of the outer one.
function _ownBody(block, text) {
  let body = block.body;
  for (const inner of _caseBlocks(block.body)) {
    const start = body.indexOf(inner.body);
    if (start < 0) continue;
    body = body.slice(0, start) + '\n'.repeat(0) + body.slice(start + inner.body.length);
  }
  return body;
}

// A case arm looks like `pat)` / `(pat)` / `"a"|"b")` at the head of a line.
// The terminating `)` is the first one OUTSIDE quotes — a label may legitimately
// contain parentheses ("Clean working tree (reset-slice)"), so a paren-free
// regex would silently drop the arm and report a false violation.
function _arms(bodyText) {
  const out = [];
  for (const line of bodyText.split('\n')) {
    let i = 0;
    while (i < line.length && /[ \t]/.test(line[i])) i++;
    if (line[i] === '(') i++;
    const start = i;
    let quote = null;
    let end = -1;
    for (; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(') { end = -2; break; } // an unquoted `(` means this is not an arm head
      if (c === ')') { end = i; break; }
    }
    if (end < 0) continue;
    const pat = line.slice(start, end).trim();
    if (!pat) continue;
    // Shell substitution/assignment syntax means this is a body line, not an arm.
    if (/[$=`{};]/.test(pat)) continue;
    if (/^(if|then|else|elif|fi|while|for|do|done|esac|case)\b/.test(pat)) continue;
    out.push(pat);
  }
  return out;
}

// Bash pattern → RegExp. Quotes inside a pattern only make characters literal;
// none of the quoted spans in this repo carry glob metacharacters, so stripping
// them is a faithful approximation of what the shell does.
function _globToRegExp(pattern) {
  const src = pattern.replace(/["']/g, '');
  let re = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') {
      const close = src.indexOf(']', i + 1);
      if (close < 0) { re += '\\['; continue; }
      re += src.slice(i, close + 1);
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function _armMatches(arm, value) {
  return arm.split('|').some((alt) => {
    try { return _globToRegExp(alt.trim()).test(value); } catch { return false; }
  });
}

// --- askuser spec extraction -------------------------------------------------

// Pull `askuser --json '{…}'` specs out by brace-matching (the JSON spans lines
// and a lazy regex mis-slices it).
function _specs(text) {
  const out = [];
  const re = /askuser\s+--json\s+'/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = text.indexOf('{', m.index);
    if (start < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    const rawSpec = text.slice(start, end + 1);
    // Collapse `'"$VAR"'` shell interpolation back to a JSON-safe placeholder.
    const cleaned = rawSpec.replace(/'"\$\{?[A-Za-z_]\w*\}?"'/g, 'X');
    let spec = null;
    try { spec = JSON.parse(cleaned); } catch { spec = null; }
    out.push({
      spec,
      line: text.slice(0, m.index).split('\n').length,
      end: end + 1,
      parsed: spec != null,
    });
  }
  return out;
}

// Shell variables that receive a `type:confirm` answer specifically.
function _confirmVars(text) {
  const vars = new Set();
  for (const s of _specs(text)) {
    if (!s.parsed || s.spec.type !== 'confirm') continue;
    const head = text.slice(0, text.lastIndexOf('askuser', s.end));
    const assign = /(\w+)=\s*"?(?:\$\(|`)[^\n]{0,300}$/.exec(head);
    if (assign) vars.add(assign[1]);
  }
  return vars;
}

function _labels(spec) {
  const opts = spec && Array.isArray(spec.options) ? spec.options : [];
  return opts
    .map((o) => (typeof o === 'string' ? o : o && o.label))
    .filter((l) => typeof l === 'string' && l.length);
}

// The first case block that starts after a spec — the block that dispatches it.
function _dispatchFor(spec, text) {
  const blocks = _caseBlocks(text).filter((b) => b.index > spec.end);
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.index - b.index);
  const first = blocks[0];
  // A case block far below (past the next askuser call) is not this dispatch.
  const nextSpec = text.indexOf('askuser', spec.end);
  if (nextSpec >= 0 && first.index > nextSpec) return null;
  return first;
}

// =============================================================================

test('ADS-0: every askuser spec in scanned dirs is machine-parseable (or pinned)', () => {
  // Unparseable specs are invisible to ADS-2. They exist on purpose (elided
  // `…` illustrations inside agent prompts) but must not multiply silently.
  const unparseable = [];
  for (const file of _mdFiles()) {
    const text = _bashFences(_normalize(fs.readFileSync(file, "utf-8")));
    for (const s of _specs(text)) {
      if (!s.parsed) unparseable.push(_rel(file) + ':' + s.line);
    }
  }
  assert.deepEqual(unparseable, [
    // np-planner's "Tooling Conventions" section documents the CALL SHAPE with
    // `"options":[…]` elided. It is prose about syntax, not a dialog anyone
    // executes — there are no real labels behind it to check.
    'agents/np-planner.md:518',
  ], 'a new askuser spec cannot be parsed — ADS-2 cannot check its labels. '
   + 'Write the JSON literally, or add it here with a reason.');
});

test('ADS-1: every askuser-driven case block has a loud default arm', () => {
  // Without a `*)` arm an unmatched answer falls through silently: the orphan
  // guard resumed over a live checkpoint (the 1.3.3 no-op regression), the
  // plan-checker and stuck dialogs re-entered the while-loop at the same round
  // forever, and validate-phase committed without VALIDATION.md.
  //
  // A `*) ;;` no-op is NOT a default arm: it satisfies the syntax and keeps the
  // silent fall-through. The arm must abort or say something.
  const offenders = [];
  for (const file of _mdFiles()) {
    const text = _bashFences(_normalize(fs.readFileSync(file, "utf-8")));
    const vars = _answerVars(text);
    if (!vars.size) continue;
    for (const block of _caseBlocks(text)) {
      if (!vars.has(block.variable)) continue;
      const body = _ownBody(block, text);
      const star = /(^|\n)[ \t]*\(?[ \t]*\*\)([\s\S]*?)(;;|$)/.exec(body);
      if (!star) {
        offenders.push(_rel(file) + ' → case "$' + block.variable + '" (no *) arm)');
        continue;
      }
      if (!/(exit|return)\s|>&2/.test(star[2])) {
        offenders.push(_rel(file) + ' → case "$' + block.variable + '" (*) arm is a silent no-op)');
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these askuser case blocks let an unmatched answer through silently: ' + offenders.join(', '));
});

test('ADS-2: every offered option label is matched by a case arm', () => {
  // The defect this closes: add-todo/note offered "Re-run — overwrite existing
  // todo" as option 1 and had no arm for it, so picking the headline option hit
  // the `*)` abort. ADS-1 was green throughout — it checks syntax, not whether
  // what the dialog PROMISES is reachable.
  const offenders = [];
  for (const file of _mdFiles()) {
    const text = _bashFences(_normalize(fs.readFileSync(file, "utf-8")));
    for (const s of _specs(text)) {
      if (!s.parsed) continue;
      const labels = _labels(s.spec);
      if (!labels.length) continue;
      const block = _dispatchFor(s, text);
      if (!block) continue; // prose-routed — see KNOWN LIMITS.
      const arms = _arms(_ownBody(block, text)).filter((a) => a !== '*');
      for (const label of labels) {
        if (!arms.some((arm) => _armMatches(arm, label))) {
          offenders.push(_rel(file) + ':' + s.line + ' → "' + label + '" has no arm in case "$'
            + block.variable + '" [' + arms.join(', ') + ']');
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these dialogs offer an option no case arm can match — picking it hits the default arm: '
    + offenders.join('\n  '));
});

// The ONE spelling a `type:confirm` answer may be tested with. Rationale below.
const CONFIRM_TRUE = '^([Yy]([Ee][Ss])?|[Jj][Aa]?|[Tt]rue|1)$';

test('ADS-3: confirm answers are tested with the canonical truthy pattern', () => {
  // `type:confirm` returns a BOOLEAN from lib/runtime/_readline.cjs, which
  // bin/np-tools/askuser.cjs stringifies to "true"/"false". Under Claude Code's
  // native routing the SAME dialog yields "Yes"/"No" — every workflow's
  // "Askuser routing" section maps `confirm` → `options: [{label:"Yes"},
  // {label:"No"}]`. A `confirm` answer therefore has no single spelling, and any
  // `== "<literal>"` test is dead code under at least one runtime:
  //   * new-project.md tested `!= "Yes"`  → a shell "true" always exited 0, so
  //     "Archive and start fresh" was unreachable (the reported defect).
  //   * new-project.md tested `== "true"` → a Claude Code "Yes" silently skipped
  //     the codebase scan (same class, opposite direction, unreported).
  //   * research-phase.md tested `!= "yes"` → case-sensitive, so a "Yes" aborted
  //     research (same class, cited as the CORRECT model, also wrong).
  // Rather than enumerate spellings per site, pin one idiom and enforce it.
  const offenders = [];
  for (const file of _mdFiles()) {
    const text = _bashFences(_normalize(fs.readFileSync(file, "utf-8")));
    for (const v of _confirmVars(text)) {
      const cmp = new RegExp('\\$\\{?' + v + '\\}?"?\\s*(?:==|!=)\\s*[\'"]', 'g');
      if (cmp.test(text)) {
        offenders.push(_rel(file) + ' → $' + v + ' (confirm) uses ==/!= against a literal; '
          + 'use [[ "$' + v + '" =~ ' + CONFIRM_TRUE + ' ]]');
        continue;
      }
      // A confirm answer handed to a consumer that does its own coercion (a
      // node -e block, an --apply payload) is not a shell gate — nothing to
      // enforce. Only a var actually branched on in shell must use the idiom.
      const branched = new RegExp('\\[\\[\\s*!?\\s*"?\\$\\{?' + v + '\\}?"?\\s*(?:=~|==|!=)'
        + '|\\bif\\s+\\[\\s*"?\\$\\{?' + v + '\\}?"?\\s*(?:=|!=)');
      if (!branched.test(text)) continue;
      const canonical = new RegExp('\\$\\{?' + v + '\\}?"?\\s*=~\\s*'
        + CONFIRM_TRUE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!canonical.test(text)) {
        offenders.push(_rel(file) + ' → $' + v + ' (confirm) is branched on in shell but never '
          + 'with the canonical pattern ' + CONFIRM_TRUE);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these confirm gates cannot reliably see a "yes": ' + offenders.join('\n  '));
});

test('ADS-4: an if/elif chain dispatching an askuser answer has an else', () => {
  // The `case`-only lint was trivially side-stepped by writing the dispatch as
  // if/elif. Same silent fall-through, different keyword.
  const offenders = [];
  for (const file of _mdFiles()) {
    const text = _bashFences(_normalize(fs.readFileSync(file, "utf-8")));
    const vars = _answerVars(text);
    if (!vars.size) continue;
    const ifRe = /(^|\n)([ \t]*)if\s+(?:\[\[|\[)([\s\S]*?)\n\2fi\b/g;
    let m;
    while ((m = ifRe.exec(text)) !== null) {
      const chain = m[3];
      const touched = [...vars].filter((v) => new RegExp('\\$\\{?' + v + '\\b').test(chain));
      if (!touched.length) continue;
      if (!/\belif\b/.test(chain)) continue; // a plain if/fi guard is not a dispatch.
      if (!/(^|\n)\s*else\b/.test(chain)) {
        offenders.push(_rel(file) + ' → if/elif over $' + touched.join('/$') + ' has no else');
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these if/elif dispatches drop an unmatched answer: ' + offenders.join(', '));
});

test('ADS-5: verify-work never feeds a dialog label straight into record-sc', () => {
  // bin/np-tools/verify-work.cjs only accepts Pass|Fail|Defer|Pending. The
  // Pass-2 dialog offered "Re-investigate" and piped $CHOICE unfiltered into
  // `record-sc`, which throws `Invalid SC status`.
  const raw = fs.readFileSync(path.join(ROOT, 'workflows', 'verify-work.md'), 'utf-8');

  // The consumer's whitelist, by reference — not regexed out of its source, so a
  // reshape there cannot leave this assertion silently checking a stale set.
  const valid = require(path.join(ROOT, 'bin', 'np-tools', 'verify-work.cjs'))._VALID_SC_STATUSES;
  assert.ok(valid instanceof Set && valid.size,
    'bin/np-tools/verify-work.cjs no longer exports a non-empty _VALID_SC_STATUSES set');

  const text = _normalize(raw);
  for (const s of _specs(text)) {
    if (!s.parsed) continue;
    for (const label of _labels(s.spec)) {
      if (valid.has(label)) continue;
      // A label outside the whitelist may be offered, but only if a case block
      // routes it somewhere other than record-sc.
      const block = _dispatchFor(s, text);
      assert.ok(block, 'verify-work offers "' + label + '", which record-sc rejects ('
        + [...valid].join('|') + '), with no case block to route it away from record-sc');
      const arms = _arms(_ownBody(block, text)).filter((a) => a !== '*');
      assert.ok(arms.some((arm) => _armMatches(arm, label)),
        'verify-work offers "' + label + '" but no arm handles it — it would reach record-sc and throw');
    }
  }
  assert.doesNotMatch(text, /record-sc[^\n]*"\$CHOICE"/,
    'record-sc must receive a validated status variable, not the raw dialog answer $CHOICE');
});

test('ADS-6: validate-phase bounds the auditor re-run across shell-fence boundaries', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'workflows', 'validate-phase.md'), 'utf-8');
  const code = _bashFences(raw);
  assert.match(raw, /"label":\s*"Re-run np-nyquist-auditor"/, 'the option is offered');
  assert.match(code, /"Re-run np-nyquist-auditor"\)/, 'and must have a case arm');

  // The bound must live in the filesystem. A bare shell variable is lost the
  // moment the ACTION CONTRACT sends control back to the spawn block — that is
  // a separate ```bash fence, i.e. a separate shell process, so
  // `${VALIDATION_RETRIED:-0}` was unconditionally 0 and the bound never fired.
  assert.doesNotMatch(code, /VALIDATION_RETRIED/,
    'a shell variable cannot bound a retry that crosses a ```bash fence — persist the marker on disk');
  // Re-derivable means: no dependency on a variable set in an earlier fence
  // other than the ones the workflow already re-derives from the init payload.
  const marker = /VALIDATION_RETRY_MARKER="\$\{TMPDIR:-\/tmp\}\/np-validate-retried-\$\{MILESTONE_ID\}"/g;
  assert.equal((code.match(marker) || []).length, 2,
    'the marker path must be spelled out verbatim in BOTH fences that use it (Initialize + the gate) '
    + '— an inherited $VALIDATION_RETRY_MARKER is exactly the process-boundary bug being fixed');
  assert.match(code, /rm -f "\$VALIDATION_RETRY_MARKER"/,
    'the marker must be cleared at Initialize so a later invocation is not blocked by a stale one');
  assert.match(code, /if \[\[ -f "\$VALIDATION_RETRY_MARKER" \]\]/,
    'the gate must read the marker from disk');
});

test('ADS-7: the orphan guard cannot fall through into a wave', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'workflows', 'execute-phase.md'), 'utf-8');
  assert.match(raw, /unrecognised orphan-guard answer/,
    'the orphan guard must abort loudly rather than resume over a live checkpoint');
});
