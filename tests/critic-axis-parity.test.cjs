'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { SUPPORTED_CRITIC_AXES } = require('../lib/agents-registry.cjs');

function _walkMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(..._walkMarkdown(abs));
    else if (entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

// P1.2: the off-host critic branches each carried their own hardcoded axis list
// ["critic","style","tests","acceptance"]. It had already drifted — SUPPORTED_CRITIC_AXES
// also contains "economy", so a legitimate economy critic was rejected off-host while
// being accepted natively. mergeCriticOutputs is now the single fail-closed guard.
//
// P2.6: the original three regexes were literal transcriptions of the three
// spellings that happened to exist that day. They matched 2 of ~10 plausible
// forms — a single-quoted JS array, a no-quotes bash array, a reordered list, a
// pipe-separated prose list, a bash `case` pattern or a regex alternation all
// walked straight past — and the walk covered only workflows/ + agents/, leaving
// templates/ and the ~39 np-* skills unscanned. CAP-1 ran green while
// agents/np-critic.md carried the exact stale 3-axis list P1.2 set out to kill.
//
// The detector below is generated FROM the registry (so a new axis is covered
// the day it is added) and keys on the structural signal — three or more axis
// tokens in a row separated only by list punctuation — rather than on a
// remembered spelling.
//
// LIMIT, stated honestly: this is a lint over prose, and prose has no grammar to
// parse. It catches list-shaped enumerations; it cannot catch an axis list
// spread across a markdown table, split over sentences ("style. Also tests.
// Finally acceptance."), or paraphrased ("the style critic, the one for tests,
// and the acceptance pass"). It is a speed bump against drift, not a proof of
// its absence. The load-bearing guard is mergeCriticOutputs, which fails closed
// on an unknown axis at runtime; CAP-1 only keeps the docs from lying.
const AXIS_ALT = '(?:' + SUPPORTED_CRITIC_AXES.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
// Separators between list items: comma / pipe / slash / plus / "and", each
// optionally wrapped in the quotes and whitespace of whatever syntax carries it.
const SEP = '["\'`]?\\s*(?:,|\\||\\/|\\+|\\band\\b)\\s*["\'`]?';
const AXIS_LIST_RE = new RegExp('\\b' + AXIS_ALT + '\\b\\s*' + SEP + '\\s*' + AXIS_ALT + '\\b\\s*' + SEP + '\\s*' + AXIS_ALT + '\\b', 'i');

function _scannedMarkdown() {
  const out = [];
  for (const dir of ['workflows', 'agents', 'templates', 'skills']) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) out.push(..._walkMarkdown(abs));
  }
  return out;
}

// Quarantine, not exemption. Every entry is a KNOWN stale list that the widened
// detector found and that the current change-set may not touch (file ownership).
// An entry here is a debt with an address, not a blessing — deleting the entry
// must be part of fixing the file, and nothing may be added without a reason.
// Empty on purpose: every known offender has been reworded to point at
// SUPPORTED_CRITIC_AXES instead of re-listing the axes. CAP-1a below makes an
// entry that outlives its offender fail, so this map cannot rot into a hole.
const AXIS_LIST_ALLOWED = new Map();

test('CAP-1a: every quarantine entry names a file that still exists and still offends', () => {
  // A quarantine that outlives its offender is how an allowlist quietly becomes
  // a hole: the entry stays, someone else's new violation slides in behind it.
  for (const [rel, reason] of AXIS_LIST_ALLOWED) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), 'quarantined file is gone — delete the entry: ' + rel);
    assert.ok(AXIS_LIST_RE.test(fs.readFileSync(abs, 'utf-8')),
      rel + ' no longer hardcodes an axis list — delete its quarantine entry so the file is guarded again');
    assert.ok(reason && reason.length > 40, rel + ' needs a real reason, not a shrug');
  }
});

test('CAP-1: no workflow, agent, template or skill re-implements the critic axis list', () => {
  const offenders = [];
  for (const file of _scannedMarkdown()) {
    const rel = path.relative(ROOT, file);
    if (AXIS_LIST_ALLOWED.has(rel)) continue;
    const raw = fs.readFileSync(file, 'utf-8');
    const m = AXIS_LIST_RE.exec(raw);
    if (m) offenders.push(rel + ' → "' + m[0].replace(/\s+/g, ' ') + '"');
  }
  assert.deepEqual(offenders, [],
    'these files hardcode the critic axes instead of letting mergeCriticOutputs validate them: '
    + offenders.join(', '));
});

test('CAP-1b: the detector actually fires on the forms the old regexes missed (P2.6)', () => {
  // Guards the guard: without this, a CAP-1 that matches nothing at all is
  // indistinguishable from a clean tree — which is how the stale list survived.
  const bypasses = [
    '["critic","style","tests"]',            // the one form the old regex caught
    "['critic', 'style', 'tests']",          // single-quoted JS array
    'AXES=(critic style tests)',             // no-quotes bash array
    'tests, acceptance, style',              // reordered
    'critic|style|tests',                    // pipe-separated / regex alternation
    'critic/style/tests',                    // slash prose
    'style + tests + acceptance',            // plus-joined prose
    'style, tests and acceptance',           // prose comma list
    'case "$axis" in critic|style|tests)',   // bash case pattern
    '/^(critic|style|tests)$/',              // regex literal
    'grep -E "critic|style|tests"',          // grep alternation
    '"economy","style","tests"',             // a list built from the newer axis
  ];
  const missed = bypasses.filter((s) => !AXIS_LIST_RE.test(s));
  // The bash array form is space-separated only — documented as out of reach
  // rather than papered over with a rule that would flag ordinary prose.
  assert.deepEqual(missed, ['AXES=(critic style tests)'],
    'detector missed a list form it claims to cover: ' + missed.join(' | '));
});

test('CAP-1c: the detector does not fire on ordinary prose that mentions one axis (P2.6)', () => {
  const innocent = [
    'The tests axis flags a missing test.',
    'Run the style critic and read its findings.',
    'economy is opt-in via agents.economy.',
    'style and tests',                       // only two axes — not a list
    'executor / build-fixer / researcher',   // a different vocabulary entirely
  ];
  const falsePositives = innocent.filter((s) => AXIS_LIST_RE.test(s));
  assert.deepEqual(falsePositives, [],
    'detector fires on innocent prose — a lint nobody can satisfy gets deleted: '
    + falsePositives.join(' | '));
});

test('CAP-2: the economy axis is supported — the list the workflows used to hardcode was already stale', () => {
  assert.ok(SUPPORTED_CRITIC_AXES.includes('economy'),
    'economy is a real axis; any 4-item hardcoded list is wrong by construction');
  assert.equal(SUPPORTED_CRITIC_AXES.length, 5);
});

test('CAP-3: mergeCriticOutputs accepts every registry axis and rejects anything else', () => {
  const loop = require('../lib/nubosloop.cjs');
  for (const axis of SUPPORTED_CRITIC_AXES) {
    assert.deepEqual(loop.mergeCriticOutputs([{ critic: axis, findings: [] }]), [],
      'registry axis ' + axis + ' must be accepted');
  }
  assert.throws(() => loop.mergeCriticOutputs([{ critic: 'not-an-axis', findings: [] }]),
    (err) => err.code === 'critic-output-unknown-axis');
});

// P3.6: SEARCH_TOOLS carried two names that were never registered verbs
// (`search-knowledge`, `match-existing-learning`). Because they were absent from
// LEDGER_VERIFIED_SEARCH_TOOLS they were credited with no evidence at all — a
// Rule 9 free pass obtainable only by fabricating the string.
test('CAP-4: every SEARCH_TOOLS entry is a registered np-tools verb', () => {
  const { SEARCH_TOOLS } = require('../lib/nubosloop.cjs');
  const cmds = require('../bin/np-tools/_commands.cjs');
  const registered = new Set((cmds.COMMANDS || cmds).map((c) => c.name || c));
  for (const tool of SEARCH_TOOLS) {
    assert.ok(registered.has(tool),
      'SEARCH_TOOLS entry "' + tool + '" is not a registered verb — an agent could only log it by fabricating it');
  }
});

test('CAP-5: every SEARCH_TOOLS entry requires ledger evidence', () => {
  const { SEARCH_TOOLS, LEDGER_VERIFIED_SEARCH_TOOLS } = require('../lib/nubosloop.cjs');
  for (const tool of SEARCH_TOOLS) {
    assert.ok(LEDGER_VERIFIED_SEARCH_TOOLS.includes(tool),
      'search tool "' + tool + '" would be credited without evidence');
  }
});

// P2.7: lib/agents-registry.cjs defined a SECOND AUDITED_AGENTS — divergent (it
// listed np-critic) and consumed by nobody, while every real caller reads the
// one in lib/nubosloop-audit.cjs. Two disagreeing copies of a Rule-9 gate list
// is a trap: a future reader edits the dead one and believes the gate changed.
test('CAP-6: AUDITED_AGENTS has exactly one definition in lib/ (no divergent twin)', () => {
  const libDir = path.join(ROOT, 'lib');
  const definers = fs.readdirSync(libDir)
    .filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs'))
    .filter((f) => /^\s*const AUDITED_AGENTS\s*=/m.test(fs.readFileSync(path.join(libDir, f), 'utf-8')));
  assert.deepEqual(definers, ['nubosloop-audit.cjs'],
    'AUDITED_AGENTS must be defined exactly once (SSOT: lib/nubosloop-audit.cjs); found in: ' + definers.join(', '));
});

test('CAP-6b: the agents registry does not re-export an audited-agents list', () => {
  const registry = require('../lib/agents-registry.cjs');
  assert.equal(registry.AUDITED_AGENTS, undefined,
    'the registry must not carry a copy of the Rule-9 audit list — read it from lib/nubosloop-audit.cjs');
  // And the surviving SSOT is the one the loop actually enforces.
  const loop = require('../lib/nubosloop.cjs');
  const auditModule = require('../lib/nubosloop-audit.cjs');
  assert.equal(loop.AUDITED_AGENTS, auditModule.AUDITED_AGENTS,
    'nubosloop must re-export the audit module\'s list by reference, not a rebuilt copy');
});
