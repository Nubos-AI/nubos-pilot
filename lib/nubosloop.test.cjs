'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const loop = require('./nubosloop.cjs');
const checkpoint = require('./checkpoint.cjs');
const learnings = require('./learnings.cjs');

function _mkRoot(cfg) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-loop-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot'), { recursive: true });
  if (cfg !== undefined) {
    fs.writeFileSync(path.join(r, '.nubos-pilot', 'config.json'), JSON.stringify(cfg), 'utf-8');
  }
  fs.mkdirSync(path.join(r, '.nubos-pilot', 'checkpoints'), { recursive: true });
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: null\ncurrent_plan: null\ncurrent_task: null\n---\n',
    'utf-8',
  );
  return r;
}

test('NL-1: resolveLoopOpts default maxRounds=3', () => {
  const r = _mkRoot();
  try {
    const o = loop.resolveLoopOpts(r);
    assert.equal(o.maxRounds, 3);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-2: resolveLoopOpts reads config override', () => {
  const r = _mkRoot({ loop: { maxRounds: 5 } });
  try {
    const o = loop.resolveLoopOpts(r);
    assert.equal(o.maxRounds, 5);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-3: resolveLoopOpts clamps maxRounds to [1, 100] (single-critic revision raised cap from 10)', () => {
  const r = _mkRoot({ loop: { maxRounds: 999 } });
  try { assert.equal(loop.resolveLoopOpts(r).maxRounds, 100); }
  finally { fs.rmSync(r, { recursive: true, force: true }); }
  const r2 = _mkRoot({ loop: { maxRounds: 0 } });
  try { assert.equal(loop.resolveLoopOpts(r2).maxRounds, 1); }
  finally { fs.rmSync(r2, { recursive: true, force: true }); }
  const r3 = _mkRoot({ loop: { maxRounds: 25 } });
  try { assert.equal(loop.resolveLoopOpts(r3).maxRounds, 25); }
  finally { fs.rmSync(r3, { recursive: true, force: true }); }
});

test('NL-4: mergeCriticOutputs deduplicates findings by file/line/category fingerprint', () => {
  const merged = loop.mergeCriticOutputs([
    {
      critic: 'style',
      findings: [{ category: 'todo-marker', file: 'src/foo.php', line: 10, severity: 'fail' }],
    },
    {
      critic: 'tests',
      findings: [{ category: 'todo-marker', file: 'src/foo.php', line: 10, severity: 'fail' }],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].confirmed_by.sort(), ['style', 'tests']);
});

test('NL-5: mergeCriticOutputs sorts by 2-of-3 priority then severity', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'style', findings: [{ category: 'todo-marker', file: 'a.php', line: 1, severity: 'nit' }] },
    {
      critic: 'tests',
      findings: [
        { category: 'missing-test', file: 'b.php', line: 2, severity: 'fail' },
        { category: 'todo-marker', file: 'a.php', line: 1, severity: 'nit' },
      ],
    },
  ]);
  assert.equal(merged[0].confirmed_by.length, 2);
  assert.equal(merged[1].confirmed_by.length, 1);
});

test('NL-6: routeFindings — information-missing → researcher', () => {
  const findings = loop.mergeCriticOutputs([
    { critic: 'acceptance', findings: [{ category: 'information-missing', file: '-', remediation: 'Need API spec.' }] },
  ]);
  const r = loop.routeFindings(findings);
  assert.equal(r.next_destination, 'researcher');
  assert.equal(r.buckets.researcher.length, 1);
});

test('NL-7: routeFindings — question-to-user beats researcher', () => {
  const findings = loop.mergeCriticOutputs([
    { critic: 'acceptance', findings: [
      { category: 'information-missing', file: '-' },
      { category: 'question-to-user', file: '-' },
    ] },
  ]);
  const r = loop.routeFindings(findings);
  assert.equal(r.next_destination, 'askuser');
});

test('NL-8: routeFindings — locked-decision-violation → plan-checker', () => {
  const findings = loop.mergeCriticOutputs([
    { critic: 'acceptance', findings: [{ category: 'locked-decision-violation', file: '-' }] },
  ]);
  const r = loop.routeFindings(findings);
  assert.equal(r.next_destination, 'plan-checker');
});

test('NL-9: routeFindings — empty list → next_destination commit', () => {
  const r = loop.routeFindings([]);
  assert.equal(r.next_destination, 'commit');
  assert.equal(r.stuck, false);
});

test('NL-10: routeFindings — stuck-detected category → stuck', () => {
  const findings = loop.mergeCriticOutputs([
    { critic: 'acceptance', findings: [{ category: 'stuck-detected' }] },
  ]);
  const r = loop.routeFindings(findings);
  assert.equal(r.next_destination, 'stuck');
  assert.equal(r.stuck, true);
});

test('NL-11: evaluateLoop — round 1, zero findings → commit', () => {
  const out = loop.evaluateLoop({ round: 1 }, [
    { critic: 'style', findings: [] },
    { critic: 'tests', findings: [] },
    { critic: 'acceptance', findings: [], criteria: [] },
  ], { maxRounds: 3 });
  assert.equal(out.next_action, 'commit');
  assert.equal(out.stuck, false);
});

test('NL-12: evaluateLoop — round 3 with findings → stuck', () => {
  const out = loop.evaluateLoop({ round: 3 }, [
    { critic: 'style', findings: [{ category: 'todo-marker', file: 'a', line: 1, severity: 'fail' }] },
  ], { maxRounds: 3 });
  assert.equal(out.next_action, 'stuck');
  assert.equal(out.stuck, true);
});

test('NL-13: evaluateLoop — round 1 with executor-bound findings → executor', () => {
  const out = loop.evaluateLoop({ round: 1 }, [
    { critic: 'style', findings: [{ category: 'todo-marker', file: 'a', line: 1, severity: 'fail' }] },
  ], { maxRounds: 3 });
  assert.equal(out.next_action, 'executor');
  assert.equal(out.stuck, false);
});

test('NL-14: recordLoopState/readLoopState round-trip', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 2, last_action: 'researcher' }, r);
    const state = loop.readLoopState('M001-S001-T0001', r);
    assert.equal(state.round, 2);
    assert.equal(state.last_action, 'researcher');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-15: autoLogLearning logs to local store when enabled (default)', () => {
  const r = _mkRoot();
  try {
    loop.autoLogLearning('M001-S001-T0001', { pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    const list = learnings.listLearnings(r);
    assert.equal(list.length, 1);
    assert.equal(list[0].occurrence, 1);
    assert.deepEqual(list[0].task_ids, ['M001-S001-T0001']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-16: autoLogLearning skipped when auto_log_learning=false', () => {
  const r = _mkRoot({ auto_log_learning: false });
  try {
    const result = loop.autoLogLearning('M001-S001-T0001', { pattern: 'x y z', outcome: 'ok' }, r);
    assert.equal(result, null);
    assert.equal(learnings.listLearnings(r).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-17: ROUTE_TABLE covers every documented finding category', () => {
  const expected = [
    'style', 'dead-code', 'dangling-thread', 'todo-marker', 'import-hygiene',
    'comment-hygiene', 'lint-violation', 'critic-error', 'rule-9-violation',
    'missing-test', 'edge-case-gap',
    'weak-assertion', 'silenced-failure', 'test-naming', 'non-deterministic',
    'verify-mismatch', 'unmet-criterion', 'scope-creep', 'information-missing',
    'over-engineering', 'stdlib-reinvention', 'native-duplication', 'shrinkable',
    'infrastructure-mismatch',
    'question-to-user', 'locked-decision-violation', 'stuck-detected',
  ];
  for (const c of expected) {
    assert.ok(loop.ROUTE_TABLE[c], 'route for ' + c + ' missing');
  }
});

test('NL-17b: infrastructure-mismatch routes to plan-checker (Gap #8)', () => {
  const findings = loop.mergeCriticOutputs([
    {
      critic: 'acceptance',
      findings: [{
        category: 'infrastructure-mismatch',
        file: '-',
        severity: 'fail',
        remediation: 'composer requires php ^8.5, container runs 8.4',
      }],
    },
  ]);
  const r = loop.routeFindings(findings);
  assert.equal(r.next_destination, 'plan-checker');
  assert.equal(r.buckets['plan-checker'].length, 1);
});

test('NL-18: full loop trace — fail round 1, fix in round 2, commit + auto-log', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    const round1 = loop.evaluateLoop({ round: 1 }, [
      { critic: 'style', findings: [{ category: 'todo-marker', file: 'a', line: 1, severity: 'fail' }] },
      { critic: 'tests', findings: [] },
      { critic: 'acceptance', findings: [], criteria: [] },
    ], { maxRounds: 3 });
    assert.equal(round1.next_action, 'executor');
    loop.recordLoopState('M001-S001-T0001', { round: 1, last_action: round1.next_action }, r);

    const round2 = loop.evaluateLoop({ round: 2 }, [
      { critic: 'style', findings: [] },
      { critic: 'tests', findings: [] },
      { critic: 'acceptance', findings: [], criteria: [] },
    ], { maxRounds: 3 });
    assert.equal(round2.next_action, 'commit');

    loop.autoLogLearning('M001-S001-T0001', { pattern: 'remove TODO marker before commit', outcome: 'verified' }, r);
    assert.equal(learnings.listLearnings(r).length, 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-19: mergeCriticOutputs REFUSES an invalid critic name instead of dropping its findings (P1.2)', () => {
  assert.throws(() => loop.mergeCriticOutputs([
    { critic: 'style', findings: [{ category: 'todo-marker', file: 'a', line: 1 }] },
    { critic: 'rogue', findings: [{ category: 'todo-marker', file: 'a', line: 1 }] },
  ]), (err) => err.code === 'critic-output-unknown-axis' && /rogue/.test(err.message));
});

test('NL-19b: the agent name is not the axis — np-critic-style must not pass silently (P1.2)', () => {
  assert.throws(() => loop.mergeCriticOutputs([
    { critic: 'np-critic-style', findings: [{ category: 'todo-marker', file: 'a', line: 1, severity: 'fail' }] },
  ]), (err) => err.code === 'critic-output-unknown-axis');
});

test('NL-19c: every supported axis is accepted, including economy (P1.2)', () => {
  for (const axis of loop.SUPPORTED_CRITICS) {
    const merged = loop.mergeCriticOutputs([{ critic: axis, findings: [] }]);
    assert.deepEqual(merged, [], 'axis ' + axis + ' must be accepted');
  }
});

test('NL-19d: the verdict envelope must not be merged as a findings report (P1.2)', () => {
  assert.throws(() => loop.mergeCriticOutputs([
    {
      critic: 'critic', task_id: 'M001-S001-T0001', round: 1,
      verdict: 'issues_found', blockers_count: 3,
      report_path: '.nubos-pilot/.tmp/r/critic-M001-S001-T0001-r1.json',
    },
  ]), (err) => err.code === 'critic-output-is-envelope');
});

test('NL-19e: the full report keeps its verdict field — verdict is not an envelope marker (P1.2)', () => {
  const merged = loop.mergeCriticOutputs([
    {
      critic: 'critic', task_id: 'M001-S001-T0001', round: 1,
      criteria: [], findings: [], verdict: 'passed',
    },
  ]);
  assert.deepEqual(merged, []);
});

test('NL-19f: a critic report with neither findings nor criteria is refused (P1.2)', () => {
  assert.throws(() => loop.mergeCriticOutputs([{ critic: 'style' }]),
    (err) => err.code === 'critic-output-no-findings');
});

test('NL-19g: a finding that is not an object is REFUSED, never silently dropped (P2.1)', () => {
  assert.throws(() => loop.mergeCriticOutputs([
    { critic: 'critic', findings: ['BLOCKER: hardcoded secret in auth.js'] },
  ]), (err) => err.code === 'critic-output-malformed-finding'
    && /BLOCKER/.test(err.message));
});

test('NL-19h: every non-object finding shape fails closed (P2.1)', () => {
  for (const bad of [1, null, 'x', true, ['nested']]) {
    assert.throws(() => loop.mergeCriticOutputs([{ critic: 'style', findings: [bad] }]),
      (err) => err.code === 'critic-output-malformed-finding',
      'findings:[' + JSON.stringify(bad) + '] must not shrink to zero findings');
  }
});

test('NL-19i: a malformed finding cannot route the loop to commit (P2.1 end-to-end)', () => {
  assert.throws(() => loop.evaluateLoop({ round: 1 }, [
    { critic: 'critic', findings: [1, 2, 3] },
  ], { maxRounds: 3 }), (err) => err.code === 'critic-output-malformed-finding');
});

test('NL-19j: a findings value that is not an array is REFUSED (P2.1)', () => {
  assert.throws(() => loop.mergeCriticOutputs([
    { critic: 'critic', findings: 'BLOCKER: secret', criteria: [{ id: 'SC-1', verdict: 'Satisfied' }] },
  ]), (err) => err.code === 'critic-output-findings-not-an-array');
});

test('NL-19k: a criteria value that is not an array is REFUSED (P2.1)', () => {
  assert.throws(() => loop.mergeCriticOutputs([
    { critic: 'acceptance', findings: [], criteria: 'SC-1: Unsatisfied' },
  ]), (err) => err.code === 'critic-output-criteria-not-an-array');
});

test('NL-19l: a criteria-only report with an empty criteria array asserts nothing → refused (P2.1)', () => {
  assert.throws(() => loop.mergeCriticOutputs([{ critic: 'acceptance', criteria: [] }]),
    (err) => err.code === 'critic-output-empty-criteria');
});

test('NL-RA-3f: a criterion that is not an object is REFUSED, never skipped (P2.1)', () => {
  for (const bad of [null, 'SC-1: Unsatisfied', 42]) {
    assert.throws(() => loop.mergeCriticOutputs([
      { critic: 'acceptance', findings: [], criteria: [bad] },
    ]), (err) => err.code === 'critic-output-malformed-criterion',
    'criteria:[' + JSON.stringify(bad) + '] must not pass the gate');
  }
});

test('NL-RA-6: an Unsatisfied criterion on a non-acceptance axis is NOT dropped (P2.2)', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'style', criteria: [{ id: 'SC-1', verdict: 'Unsatisfied' }] },
  ]);
  assert.equal(merged.length, 1, 'the guard admitted this report; its criteria must be consumed');
  assert.equal(merged[0].category, 'unmet-criterion');
});

test('NL-RA-6b: every axis promotes criteria — guard and consumer agree (P2.2)', () => {
  for (const axis of loop.SUPPORTED_CRITICS) {
    const evaluated = loop.evaluateLoop({ round: 1 }, [
      { critic: axis, criteria: [{ id: 'SC-1', verdict: 'Unsatisfied' }] },
    ], { maxRounds: 3 });
    assert.notEqual(evaluated.next_action, 'commit',
      'axis ' + axis + ': an Unsatisfied criterion must never route to commit');
  }
});

test('NL-28: evaluateLoop refuses to conclude anything from zero reports (P2.4)', () => {
  assert.throws(() => loop.evaluateLoop({ round: 1 }, [], { maxRounds: 3 }),
    (err) => err.code === 'nubosloop-no-evidence');
  assert.throws(() => loop.evaluateLoop({ round: 1 }, [], { maxRounds: 3, auditFindings: [] }),
    (err) => err.code === 'nubosloop-no-evidence');
});

test('NL-28b: audit findings alone are evidence — the audit-only path stays open (P2.4)', () => {
  const out = loop.evaluateLoop({ round: 1 }, [], {
    maxRounds: 3,
    auditFindings: [{ category: 'rule-9-violation', file: '-', severity: 'fail', remediation: 'x' }],
  });
  assert.equal(out.next_action, 'executor');
});

test('NL-20: mergeCriticOutputs invalid input → TypeError', () => {
  assert.throws(() => loop.mergeCriticOutputs(null), TypeError);
  assert.throws(() => loop.mergeCriticOutputs('x'), TypeError);
});

test('NL-21: aggregateLoopMetrics tallies rounds, routes, findings, stuck/commit counters', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    checkpoint.startTask({ id: 'M001-S001-T0002' }, r);
    checkpoint.startTask({ id: 'M001-S001-T0003' }, r);
    loop.recordLoopState('M001-S001-T0001', {
      round: 1, last_action: 'commit',
      findings: [],
    }, r);
    loop.recordLoopState('M001-S001-T0002', {
      round: 2, last_action: 'commit',
      findings: [{ category: 'todo-marker' }],
    }, r);
    loop.recordLoopState('M001-S001-T0003', {
      round: 3, last_action: 'stuck',
      findings: [{ category: 'unmet-criterion' }, { category: 'todo-marker' }],
    }, r);

    const m = loop.aggregateLoopMetrics(r);
    assert.equal(m.tasks_with_loop, 3);
    assert.equal(m.total_rounds, 6);
    assert.equal(m.average_rounds, 2.0);
    assert.equal(m.commit_count, 2);
    assert.equal(m.stuck_count, 1);
    assert.equal(m.route_distribution.commit, 2);
    assert.equal(m.route_distribution.stuck, 1);
    assert.equal(m.finding_categories['todo-marker'], 2);
    assert.equal(m.finding_categories['unmet-criterion'], 1);
    assert.equal(m.rounds_histogram[1], 1);
    assert.equal(m.rounds_histogram[2], 1);
    assert.equal(m.rounds_histogram[3], 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-22: aggregateLoopMetrics returns zero shape on empty checkpoint dir', () => {
  const r = _mkRoot();
  try {
    const m = loop.aggregateLoopMetrics(r);
    assert.equal(m.tasks_with_loop, 0);
    assert.equal(m.average_rounds, 0);
    assert.equal(m.stuck_count, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-23: aggregateLoopMetrics tolerates malformed checkpoint files', () => {
  const r = _mkRoot();
  try {
    fs.writeFileSync(path.join(r, '.nubos-pilot', 'checkpoints', 'broken.json'), 'NOT JSON');
    const m = loop.aggregateLoopMetrics(r);
    assert.equal(m.tasks_with_loop, 0);
    assert.equal(m.corrupt_checkpoints.length, 1);
    assert.equal(m.corrupt_checkpoints[0].reason, 'invalid-task-id-filename');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-23b: aggregateLoopMetrics reports parse + schema corruption distinctly', () => {
  const r = _mkRoot();
  try {
    const dir = path.join(r, '.nubos-pilot', 'checkpoints');
    fs.writeFileSync(path.join(dir, 'M001-S001-T0001.json'), '{ malformed');
    fs.writeFileSync(
      path.join(dir, 'M001-S001-T0002.json'),
      JSON.stringify({ schema_version: 99, task_id: 'M001-S001-T0002' }),
    );
    checkpoint.startTask({ id: 'M001-S001-T0003' }, r);
    loop.recordLoopState('M001-S001-T0003', { round: 1, last_action: 'commit' }, r);
    const m = loop.aggregateLoopMetrics(r);
    assert.equal(m.tasks_with_loop, 1, 'good checkpoint still aggregated');
    assert.equal(m.commit_count, 1);
    assert.equal(m.corrupt_checkpoints.length, 2);
    const reasons = m.corrupt_checkpoints.map((c) => c.reason).sort();
    assert.ok(reasons.includes('checkpoint-version-mismatch'), 'schema mismatch surfaced: ' + reasons.join(','));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-24: aggregateLoopMetrics histogram bound matches loop.maxRounds (default 3)', () => {
  const r = _mkRoot();
  try {
    const m = loop.aggregateLoopMetrics(r);
    const buckets = Object.keys(m.rounds_histogram).map(Number).sort((a, b) => a - b);
    assert.deepEqual(buckets, [1, 2, 3]);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-25: aggregateLoopMetrics histogram extends to configured maxRounds=10', () => {
  const r = _mkRoot({ loop: { maxRounds: 10 } });
  try {
    const m = loop.aggregateLoopMetrics(r);
    const buckets = Object.keys(m.rounds_histogram).map(Number).sort((a, b) => a - b);
    assert.deepEqual(buckets, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-26: aggregateLoopMetrics returns consistent values across calls (no in-process cache after R24)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1, last_action: 'commit' }, r);
    const a = loop.aggregateLoopMetrics(r);
    const b = loop.aggregateLoopMetrics(r);
    assert.deepEqual(a, b, 'two reads of the same checkpoint state must produce equal metrics');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-27: _normalizeFinding routes unknown categories to "stuck" with audit flag', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'style', findings: [{ category: 'mystery-category', file: 'a', line: 1 }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].route, 'stuck');
  assert.equal(merged[0].unknown_category, true);
  const r = loop.routeFindings(merged);
  assert.equal(r.next_destination, 'stuck');
  assert.equal(r.stuck, true);
});

test('NL-RA-1: mergeCriticOutputs auto-promotes Unsatisfied criterion to unmet-criterion finding', () => {
  const merged = loop.mergeCriticOutputs([
    {
      critic: 'acceptance',
      criteria: [{ id: 'SC-1', verdict: 'Unsatisfied', evidence: 'no test asserts the 401 case' }],
      findings: [],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].category, 'unmet-criterion');
  assert.equal(merged[0].route, 'executor');
});

test('NL-RA-2: mergeCriticOutputs auto-promotes Information-Missing criterion to information-missing finding', () => {
  const merged = loop.mergeCriticOutputs([
    {
      critic: 'acceptance',
      criteria: [{ id: 'SC-2', verdict: 'Information-Missing', missing_info: 'GetAG webhook spec' }],
      findings: [],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].category, 'information-missing');
  assert.equal(merged[0].route, 'researcher');
});

test('NL-RA-3: Satisfied criterion is NOT promoted', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'acceptance', criteria: [{ id: 'SC-3', verdict: 'Satisfied', evidence: 'tests pass' }], findings: [] },
  ]);
  assert.equal(merged.length, 0);
});

test('NL-RA-3b: a lowercase verdict is NOT read as satisfied (P1.3 fail-closed)', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'acceptance', criteria: [{ id: 'SC-3', verdict: 'unsatisfied' }], findings: [] },
  ]);
  assert.equal(merged.length, 1, 'only the exact string "Satisfied" may pass the gate');
  assert.equal(merged[0].category, 'unmet-criterion');
  assert.match(merged[0].remediation, /unrecognised verdict/);
});

test('NL-RA-3c: an unknown verdict vocabulary fails closed (P1.3)', () => {
  for (const verdict of ['Partially-Satisfied', 'SATISFIED', 'ok', '', null, undefined]) {
    const merged = loop.mergeCriticOutputs([
      { critic: 'acceptance', criteria: [{ id: 'SC-9', verdict }], findings: [] },
    ]);
    assert.equal(merged.length, 1,
      'verdict ' + JSON.stringify(verdict) + ' must not be treated as satisfied');
    assert.equal(merged[0].category, 'unmet-criterion');
  }
});

test('NL-RA-3d: an unknown verdict names itself so the failure is diagnosable, not just blocking (P1.3)', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'acceptance', criteria: [{ id: 'SC-4', verdict: 'Partially-Satisfied' }], findings: [] },
  ]);
  assert.match(merged[0].remediation, /Partially-Satisfied/, 'the offending verdict must appear');
  assert.match(merged[0].remediation, /Satisfied.*Unsatisfied.*Information-Missing/,
    'the accepted vocabulary must be stated');
});

test('NL-RA-3e: an unknown verdict cannot route the loop to commit (P1.3 end-to-end)', () => {
  const evaluated = loop.evaluateLoop({ round: 1 }, [
    { critic: 'acceptance', criteria: [{ id: 'SC-5', verdict: 'Partially-Satisfied' }], findings: [] },
  ], { maxRounds: 3 });
  assert.notEqual(evaluated.next_action, 'commit',
    'an unmet criterion behind an unknown verdict must never reach commit');
});

test('NL-RA-4: auto-promotion does not dedupe when remediations differ — both findings retained', () => {
  const merged = loop.mergeCriticOutputs([
    {
      critic: 'acceptance',
      criteria: [{ id: 'SC-1', verdict: 'Unsatisfied' }],
      findings: [{
        category: 'unmet-criterion', criterion_id: 'SC-1', file: 'tests/AuthTest.php',
        line: 42, severity: 'fail', remediation: 'add 401 case',
      }],
    },
  ]);
  assert.equal(merged.length, 2, 'distinct remediations → distinct findings');
  const cats = merged.map((f) => f.category);
  assert.deepEqual(cats.sort(), ['unmet-criterion', 'unmet-criterion']);
});

test('NL-RA-5: critic-error category routes to stuck (loud, not silent executor)', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'style', findings: [{ category: 'critic-error', file: '-', severity: 'fail', remediation: 'diff unparseable' }] },
  ]);
  const r = loop.routeFindings(merged);
  assert.equal(r.next_destination, 'stuck');
  assert.equal(r.stuck, true);
});

test('NL-ROUTE-1: routeFindings throws on unknown bucket (R5 from fourth review)', () => {
  assert.throws(
    () => loop.routeFindings([{ category: 'mystery', route: 'mystery-bucket', severity: 'fail' }]),
    (err) => err && err.code === 'nubosloop-unknown-route',
  );
});

test('NL-AUDIT-1: auditToolUse persists log + flags rule-9-violation when no search tool invoked', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'Edit', 'Bash'], r);
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'rule-9-no-search-tool-invoked');
    assert.deepEqual(out.search_calls, []);
    const log = loop.readToolUseAudit('M001-S001-T0001', r);
    assert.equal(log.length, 1);
    assert.equal(log[0].agent, 'np-executor');
    assert.equal(log[0].audited, true);
    assert.equal(log[0].violation, 'rule-9-no-search-tool-invoked');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-2: "search-knowledge" is not a search tool — it never was a verb (P3.6)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    const out = loop.auditToolUse(
      'M001-S001-T0001', 'np-executor',
      ['Read', 'search-knowledge', 'Edit'],
      r,
    );
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'rule-9-no-search-tool-invoked');
    assert.deepEqual(out.search_calls, []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-2b: a knowledge-search claim needs the caller\'s OWN ledger entry (P3.6)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt', r, 'np-researcher');
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['knowledge-search'], r);
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'rule-9-search-tool-unverified',
      'another agent\'s search must not credit this spawn');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-2c: the agent\'s own ledger entry credits it (P3.6)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt', r, 'np-researcher');
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt', r, 'np-executor');
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['knowledge-search'], r);
    assert.equal(out.ok, true);
    assert.equal(out.violation, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-2d: legacy agent-less evidence (whole round pre-upgrade) credits the audited agent', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt', r);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['knowledge-search'], r);
    assert.equal(out.ok, true);
    assert.equal(out.violation, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-2e: once any agented entry exists for the round, legacy entries stop crediting others', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt', r);
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt', r, 'np-researcher');
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['knowledge-search'], r);
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'rule-9-search-tool-unverified',
      'a post-upgrade round with agented evidence must not credit the executor off a legacy entry');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-3: non-audited agent (e.g. np-planner) does not trigger violation even without search', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-planner', ['Read', 'Write'], r);
    assert.equal(out.ok, true);
    assert.equal(out.violation, null);
    const log = loop.readToolUseAudit('M001-S001-T0001', r);
    assert.equal(log[0].audited, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-4: rule-9-violation category routes to executor', () => {
  const merged = loop.mergeCriticOutputs([
    {
      critic: 'acceptance',
      findings: [{ category: 'rule-9-violation', file: '-', severity: 'fail', remediation: 'invoke search-knowledge before writing code' }],
    },
  ]);
  const r = loop.routeFindings(merged);
  assert.equal(r.next_destination, 'executor');
});

test('NL-SEC-1: _normalizeFinding rejects __proto__ as category (no proto-chain bypass)', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'style', findings: [{ category: '__proto__', severity: 'fail', remediation: 'evil' }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].route, 'stuck');
  assert.equal(merged[0].unknown_category, true);
});

test('NL-SEC-2: _normalizeFinding rejects "constructor" as category', () => {
  const merged = loop.mergeCriticOutputs([
    { critic: 'tests', findings: [{ category: 'constructor', severity: 'fail', remediation: 'evil' }] },
  ]);
  assert.equal(merged[0].route, 'stuck');
  assert.equal(merged[0].unknown_category, true);
});

test('NL-AUDIT-6: auditToolUse stamps current round on each entry', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read'], r);
    assert.equal(out.round, 2);
    const log = loop.readToolUseAudit('M001-S001-T0001', r);
    assert.equal(log[0].round, 2);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-7: auditFindingsForRound emits rule-9-violation finding; mark prevents next-round re-fire', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'Edit'], r);
    loop.recordSearchEvidence('M001-S001-T0001', 'q', r, 'np-researcher');
    loop.auditToolUse('M001-S001-T0001', 'np-researcher', ['knowledge-search'], r);
    const r1 = loop.auditFindingsForRound('M001-S001-T0001', 1, r);
    assert.equal(r1.length, 1);
    assert.equal(r1[0].category, 'rule-9-violation');
    assert.equal(r1[0].severity, 'fail');
    assert.match(r1[0].remediation, /np-executor/);
    const marked = loop.markAuditsRoutedForRound('M001-S001-T0001', 1, r);
    assert.equal(marked, 1);
    loop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-build-fixer', ['Bash'], r);
    const r2 = loop.auditFindingsForRound('M001-S001-T0001', 2, r);
    assert.equal(r2.length, 1, 'round-1 violation marked routed → only build-fixer surfaces');
    assert.match(r2[0].remediation, /np-build-fixer/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-11: unrouted Rule-9 violation from prior round CARRIES FORWARD (Gap #1)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'Edit'], r);
    loop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-build-fixer', ['Bash'], r);
    const r2 = loop.auditFindingsForRound('M001-S001-T0001', 2, r);
    assert.equal(r2.length, 2, 'unrouted round-1 violation MUST carry forward into round-2 routing');
    const remediations = r2.map((f) => f.remediation).join('|');
    assert.match(remediations, /np-executor/);
    assert.match(remediations, /np-build-fixer/);
    const carried = r2.find((f) => /np-executor/.test(f.remediation));
    assert.match(carried.remediation, /Carried forward from round 1/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-12: markAuditsRoutedForRound is idempotent and only marks unrouted violations', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read'], r);
    loop.recordSearchEvidence('M001-S001-T0001', 'q', r, 'np-researcher');
    loop.auditToolUse('M001-S001-T0001', 'np-researcher', ['knowledge-search'], r);
    assert.equal(loop.markAuditsRoutedForRound('M001-S001-T0001', 1, r), 1);
    assert.equal(loop.markAuditsRoutedForRound('M001-S001-T0001', 1, r), 0);
    const audits = loop.readToolUseAudit('M001-S001-T0001', r);
    const exec = audits.find((a) => a.agent === 'np-executor');
    const rsh = audits.find((a) => a.agent === 'np-researcher');
    assert.equal(exec.routed_in_round, 1);
    assert.equal(rsh.routed_in_round, undefined);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-13: assertSpawnsCountForRound — k-of-k researcher gate (Gap #6)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-researcher', ['search-knowledge'], r);
    let v = loop.assertSpawnsCountForRound('M001-S001-T0001', 'np-researcher', 3, 1, r);
    assert.equal(v.satisfied, false);
    assert.equal(v.found, 1);
    assert.equal(v.required, 3);
    loop.auditToolUse('M001-S001-T0001', 'np-researcher', ['search-knowledge'], r);
    loop.auditToolUse('M001-S001-T0001', 'np-researcher', ['search-knowledge'], r);
    v = loop.assertSpawnsCountForRound('M001-S001-T0001', 'np-researcher', 3, 1, r);
    assert.equal(v.satisfied, true);
    assert.equal(v.found, 3);
    v = loop.assertSpawnsCountForRound('M001-S001-T0001', 'np-researcher', 1, 2, r);
    assert.equal(v.satisfied, false);
    assert.equal(v.found, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-14: auditToolUse flags rule-9-search-tool-unverified when knowledge-search is claimed without ledger evidence', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'knowledge-search', 'Edit'], r);
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'rule-9-search-tool-unverified');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-15: recordSearchEvidence backs a knowledge-search claim for the same round', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    const ev = loop.recordSearchEvidence('M001-S001-T0001', 'jwt verify', r, 'np-executor');
    assert.equal(ev.round, 1);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'knowledge-search'], r);
    assert.equal(out.ok, true);
    assert.equal(out.violation, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-16: search evidence is round-scoped — round-1 evidence does not credit round 2', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.recordSearchEvidence('M001-S001-T0001', 'jwt verify', r);
    loop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
    const out = loop.auditToolUse('M001-S001-T0001', 'np-build-fixer', ['Read', 'knowledge-search'], r);
    assert.equal(out.ok, false);
    assert.equal(out.violation, 'rule-9-search-tool-unverified');
    assert.equal(loop.searchEvidenceForRound('M001-S001-T0001', 1, r).length, 1);
    assert.equal(loop.searchEvidenceForRound('M001-S001-T0001', 2, r).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-17: auditFindingsForRound emits the unverified-specific remediation', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    loop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
    loop.auditToolUse('M001-S001-T0001', 'np-executor', ['knowledge-search'], r);
    const findings = loop.auditFindingsForRound('M001-S001-T0001', 1, r);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, 'rule-9-violation');
    assert.match(findings[0].remediation, /no knowledge-search evidence was recorded/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-8: auditFindingsForRound rejects bad input cleanly (returns [])', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    assert.deepEqual(loop.auditFindingsForRound('../bad', 1, r), []);
    assert.deepEqual(loop.auditFindingsForRound('M001-S001-T0001', 0, r), []);
    assert.deepEqual(loop.auditFindingsForRound('M001-S001-T0001', 'NaN', r), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-AUDIT-9: evaluateLoop with auditFindings routes rule-9-violation through to executor', () => {
  const auditFindings = [{
    category: 'rule-9-violation',
    severity: 'fail',
    file: '-',
    line: null,
    remediation: 'np-executor shipped without searching',
  }];
  const result = loop.evaluateLoop({ round: 1 }, [], { maxRounds: 3, auditFindings });
  assert.equal(result.next_action, 'executor');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'rule-9-violation');
  assert.equal(result.findings[0].critic, 'audit');
  assert.deepEqual(result.findings[0].confirmed_by, ['audit']);
});

test('NL-AUDIT-10: evaluateLoop dedupes audit findings against critic findings by fingerprint', () => {
  const criticOut = {
    critic: 'tests',
    findings: [{ category: 'rule-9-violation', file: '-', severity: 'fail', remediation: 'np-executor shipped without searching' }],
  };
  const auditFindings = [{
    category: 'rule-9-violation',
    severity: 'fail',
    file: '-',
    line: null,
    remediation: 'np-executor shipped without searching',
  }];
  const result = loop.evaluateLoop({ round: 1 }, [criticOut], { maxRounds: 3, auditFindings });
  assert.equal(result.findings.length, 1, 'duplicate fingerprint should collapse');
});

test('NL-AUDIT-5: auditToolUse rejects invalid taskId / agent / log', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
    assert.throws(
      () => loop.auditToolUse('../bad', 'np-executor', [], r),
      (err) => err && err.code === 'nubosloop-audit-invalid-task-id',
    );
    assert.throws(
      () => loop.auditToolUse('M001-S001-T0001', '', [], r),
      (err) => err && err.code === 'nubosloop-audit-invalid-agent',
    );
    assert.throws(
      () => loop.auditToolUse('M001-S001-T0001', 'np-executor', 'not-an-array', r),
      (err) => err && err.code === 'nubosloop-audit-invalid-log',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-1: preflightCacheLookup returns hit shape when learning matches', async () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    const out = await loop.preflightCacheLookup('use jose for jwt verification', { threshold: 0.5, minOccurrence: 3 }, r);
    assert.ok(out.hit, 'expected hit');
    assert.equal(out.bypass_swarm, true);
    assert.ok(out.hit.similarity >= 0.5);
    assert.equal(out.cache_miss_reason, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-2: preflightCacheLookup returns null hit when no learning matches', async () => {
  const r = _mkRoot();
  try {
    const out = await loop.preflightCacheLookup('totally unrelated query', {}, r);
    assert.equal(out.hit, null);
    assert.equal(out.bypass_swarm, false);
    assert.equal(out.cache_miss_reason, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-4: preflightCacheLookup propagates hard failures (corrupt store)', async () => {
  const r = _mkRoot();
  try {
    const learningsPath = learnings._storePath(r);
    fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
    fs.writeFileSync(learningsPath, 'NOT JSON', 'utf-8');
    await assert.rejects(
      loop.preflightCacheLookup('x', {}, r),
      (err) => err && err.code === 'learnings-store-corrupt',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-5: preflightCacheLookup rejects empty query', async () => {
  const r = _mkRoot();
  try {
    await assert.rejects(
      loop.preflightCacheLookup('', {}, r),
      (err) => err && err.code === 'nubosloop-preflight-invalid-query',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-6: preflightCacheLookup populates swarm.spawn_specs on cache miss (k entries, identical input, distinct seed_delta)', async () => {
  const r = _mkRoot();
  try {
    const out = await loop.preflightCacheLookup('install Cashier 16 with Sanctum auth', { taskId: 'M001-S001-T0001' }, r);
    assert.equal(out.bypass_swarm, false);
    assert.ok(out.swarm, 'swarm block must be present on miss');
    assert.equal(out.swarm.bypass_swarm, false);
    assert.equal(out.swarm.k, 3);
    assert.ok(Array.isArray(out.swarm.spawn_specs));
    assert.equal(out.swarm.spawn_specs.length, 3);
    const inputs = out.swarm.spawn_specs.map((s) => JSON.stringify(s.input));
    assert.equal(new Set(inputs).size, 1, 'every spawn_spec must carry the IDENTICAL input — topic-split is the bug this guards');
    assert.equal(out.swarm.spawn_specs[0].input.task_query, 'install Cashier 16 with Sanctum auth');
    assert.equal(out.swarm.spawn_specs[0].input.task_id, 'M001-S001-T0001');
    const deltas = out.swarm.spawn_specs.map((s) => s.seed_delta);
    assert.equal(new Set(deltas).size, 3, 'each spawn_spec must carry a DISTINCT seed_delta');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-7: preflightCacheLookup still emits swarm block on cache hit (orchestrator may bypass; payload stays symmetric)', async () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    const out = await loop.preflightCacheLookup('use jose for jwt verification', { threshold: 0.5, minOccurrence: 3 }, r);
    assert.equal(out.bypass_swarm, true);
    assert.ok(out.swarm);
    assert.equal(out.swarm.bypass_swarm, true);
    assert.ok(out.swarm.cache_hit);
    assert.equal(out.swarm.spawn_specs.length, 3);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-8: preflightCacheLookup honors swarm.research.k from config', async () => {
  const r = _mkRoot({ swarm: { research: { k: 5 } } });
  try {
    const out = await loop.preflightCacheLookup('whatever query', {}, r);
    assert.equal(out.swarm.k, 5);
    assert.equal(out.swarm.spawn_specs.length, 5);
    const deltas = out.swarm.spawn_specs.map((s) => s.seed_delta);
    assert.equal(new Set(deltas).size, 5);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-28: persisted tokens field is reused on match (no re-tokenize)', () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    const list = learnings.listLearnings(r);
    assert.ok(Array.isArray(list[0].tokens), 'tokens must be persisted on first log');
    assert.ok(list[0].tokens.length > 0);
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'still works' }, r);
    const list2 = learnings.listLearnings(r);
    assert.equal(list2.length, 1);
    assert.equal(list2[0].occurrence, 2);
    assert.deepEqual(list2[0].tokens, list[0].tokens);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-BYPASS-1: a weak cache hit is advisory context and does NOT bypass the swarm', async () => {
  const r = _mkRoot();
  try {
    learnings.logLearning(
      { pattern: 'prefer partial unique indexes for temporal rows with valid_to null', outcome: 'verified' },
      r,
    );
    const out = await loop.preflightCacheLookup('temporal rows indexes', { threshold: 0.2 }, r);
    assert.ok(out.hit, 'the hit is still surfaced as advisory context');
    assert.ok(out.hit.similarity < 0.5, 'fixture must produce a sub-bypass similarity');
    assert.equal(out.bypass_swarm, false, 'a weak hit must never skip the researcher swarm');
    assert.equal(out.cache_miss_reason.code, 'cache-hit-below-bypass-threshold');
    assert.equal(out.swarm.bypass_swarm, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-BYPASS-2: a strong cache hit still bypasses the swarm', async () => {
  const r = _mkRoot();
  try {
    learnings.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
    const out = await loop.preflightCacheLookup('use jose for jwt verification', {}, r);
    assert.ok(out.hit);
    assert.ok(out.hit.similarity >= 0.5);
    assert.equal(out.bypass_swarm, true);
    assert.equal(out.cache_miss_reason, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NL-PF-BYPASS-3: a repeatedly failed learning never reaches the bypass path', async () => {
  const r = _mkRoot();
  try {
    for (let i = 0; i < 3; i += 1) {
      learnings.logLearning({ pattern: 'use jsonwebtoken for jwt verification', outcome: 'failed' }, r);
    }
    const out = await loop.preflightCacheLookup('use jsonwebtoken for jwt verification', {}, r);
    assert.equal(out.hit, null, 'the confidence gate drops it before the bypass decision');
    assert.equal(out.bypass_swarm, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
