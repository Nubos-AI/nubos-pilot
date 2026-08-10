'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handler = require('./slice-plan.cjs');
const { _resetParseRoadmapCacheForTests } = require('../../lib/roadmap.cjs');

function _ctx(cwd) {
  const out = [];
  const err = [];
  return {
    ctx: { cwd, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

function _project(roadmap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sp-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'roadmap.yaml'), roadmap, 'utf-8');
  _resetParseRoadmapCacheForTests();
  return root;
}

function _cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const CONDITIONAL = [
  'schema_version: 3',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: Migration',
  '    status: in-progress',
  '    slices:',
  '      - id: S001',
  '        name: migrate',
  '        status: done',
  '      - id: S002',
  '        name: verify the migration',
  '        status: pending',
  '        when:',
  '          slice: S001',
  '          status: done',
  '      - id: S003',
  '        name: rollback',
  '        status: pending',
  '        when:',
  '          slice: S001',
  '          status: pending',
  '',
].join('\n');

test('SP-1: no args prints usage and exits non-zero; --help exits zero', () => {
  const a = _ctx();
  assert.equal(handler.run([], a.ctx), 1);
  assert.match(a.out(), /Usage:/);
  const b = _ctx();
  assert.equal(handler.run(['--help'], b.ctx), 0);
  assert.match(b.out(), /three-valued/);
});

test('SP-2: plan reports run, skip and wait per slice', () => {
  const root = _project(CONDITIONAL);
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['plan', '1', '--json'], c.ctx), 0);
    const plan = JSON.parse(c.out());
    assert.deepEqual(plan.runnable, ['S001', 'S002']);
    assert.deepEqual(plan.skipped, ['S003']);
    assert.equal(plan.ok, true);
  } finally {
    _cleanup(root);
  }
});

test('SP-3: a slice whose predecessor has not finished waits rather than being skipped', () => {
  const root = _project(CONDITIONAL.replace('        status: done\n      - id: S002', '        status: pending\n      - id: S002'));
  try {
    const c = _ctx(root);
    handler.run(['plan', '1', '--json'], c.ctx);
    const plan = JSON.parse(c.out());
    assert.ok(plan.waiting.includes('S002'), 'got: ' + JSON.stringify(plan.waiting));
    assert.ok(!plan.skipped.includes('S002'), 'an unfinished predecessor must not skip the slice');
  } finally {
    _cleanup(root);
  }
});

test('SP-4: the human output names the reason for each conditional slice', () => {
  const root = _project(CONDITIONAL);
  try {
    const c = _ctx(root);
    handler.run(['plan', '1'], c.ctx);
    assert.match(c.out(), /run\s+S001/);
    assert.match(c.out(), /run\s+S002\s+\(all_of satisfied\)/);
    assert.match(c.out(), /skip\s+S003/);
  } finally {
    _cleanup(root);
  }
});

test('SP-5: plan requires a milestone and reports an unknown one', () => {
  const root = _project(CONDITIONAL);
  try {
    const missing = _ctx(root);
    assert.equal(handler.run(['plan'], missing.ctx), 1);
    assert.match(missing.err(), /slice-plan-missing-milestone/);

    const unknown = _ctx(root);
    assert.equal(handler.run(['plan', '9'], unknown.ctx), 1);
    assert.match(unknown.err(), /slice-plan-milestone-not-found/);
  } finally {
    _cleanup(root);
  }
});

test('SP-6: an unresolvable condition exits non-zero and is neither run nor skipped', () => {
  // A gate that opens when it breaks is not a gate: the milestone must be refused,
  // not executed with the condition ignored.
  const root = _project(CONDITIONAL.replace('          slice: S001\n          status: pending', '          slice: S099\n          status: done'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['plan', '1', '--json'], c.ctx), 1);
    const plan = JSON.parse(c.out());
    assert.equal(plan.ok, false);
    assert.ok(!plan.runnable.includes('S003'));
    assert.ok(!plan.skipped.includes('S003'));
    assert.match(c.err(), /slice-condition-unknown-slice/);
  } finally {
    _cleanup(root);
  }
});

test('SP-7: lint passes on a clean document', () => {
  const root = _project(CONDITIONAL);
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['lint'], c.ctx), 0);
    assert.match(c.out(), /ok:/);
  } finally {
    _cleanup(root);
  }
});

test('SP-8: lint fails and reports the finding on a broken reference', () => {
  const root = _project(CONDITIONAL.replace('          slice: S001\n          status: pending', '          slice: S099\n          status: done'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['lint'], c.ctx), 1);
    assert.match(c.err(), /slice-condition-unknown-slice/);
    assert.match(c.err(), /depends_on/, 'the finding should point at the right mechanism');
  } finally {
    _cleanup(root);
  }
});

test('SP-9: lint --json returns the findings structurally', () => {
  const root = _project(CONDITIONAL.replace('          slice: S001\n          status: pending', '          slice: S003\n          status: done'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['lint', '--json'], c.ctx), 1);
    const res = JSON.parse(c.out());
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.code === 'slice-condition-self-reference'));
  } finally {
    _cleanup(root);
  }
});

test('SP-10: a conditional roadmap declaring schema_version 2 is refused on read', () => {
  const root = _project(CONDITIONAL.replace('schema_version: 3', 'schema_version: 2'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['plan', '1'], c.ctx), 1);
    assert.match(c.err(), /roadmap-conditional-requires-v3/);
  } finally {
    _cleanup(root);
  }
});

test('SP-11: an unconditional roadmap plans every slice as run', () => {
  const root = _project([
    'schema_version: 2',
    'milestones:',
    '  - id: M001',
    '    number: 1',
    '    status: pending',
    '    slices:',
    '      - id: S001',
    '        status: pending',
    '      - id: S002',
    '        status: pending',
    '',
  ].join('\n'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['plan', '1', '--json'], c.ctx), 0);
    const plan = JSON.parse(c.out());
    assert.deepEqual(plan.runnable, ['S001', 'S002']);
    assert.equal(plan.slices.every((s) => s.conditional === false), true);
  } finally {
    _cleanup(root);
  }
});

test('SP-12: an unknown verb lists the allowed set', () => {
  const root = _project(CONDITIONAL);
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['frobnicate'], c.ctx), 1);
    assert.match(c.err(), /slice-plan-unknown-verb/);
  } finally {
    _cleanup(root);
  }
});

test('SP-20: a milestone that can never be decided exits non-zero instead of looping', () => {
  const root = _project([
    'schema_version: 3',
    'milestones:',
    '  - id: M001',
    '    number: 1',
    '    name: Deadlock',
    '    status: in-progress',
    '    slices:',
    '      - id: S001',
    '        status: pending',
    '        when:',
    '          slice: S002',
    '          status: done',
    '      - id: S002',
    '        status: pending',
    '        when:',
    '          slice: S001',
    '          status: done',
    '',
  ].join('\n'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['plan', '1', '--json'], c.ctx), 1);
    assert.match(c.err(), /slice-plan-stalled/);
    assert.equal(JSON.parse(c.out()).stalled, true);
  } finally { _cleanup(root); }
});

test('SP-21: a slice skipped in this pass settles its dependents in the same pass', () => {
  const root = _project([
    'schema_version: 3',
    'milestones:',
    '  - id: M001',
    '    number: 1',
    '    name: Fallback',
    '    status: in-progress',
    '    slices:',
    '      - id: S001',
    '        status: done',
    '      - id: S002',
    '        status: pending',
    '        when:',
    '          slice: S001',
    '          status_not: done',
    '      - id: S003',
    '        status: pending',
    '        when:',
    '          slice: S002',
    '          status: done',
    '',
  ].join('\n'));
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['plan', '1', '--json'], c.ctx), 0);
    const plan = JSON.parse(c.out());
    assert.deepEqual(plan.skipped, ['S002', 'S003']);
    assert.deepEqual(plan.waiting, []);
    assert.equal(plan.stalled, false);
  } finally { _cleanup(root); }
});
