const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const state = require('./state.cjs');

const CANONICAL_STATE_MD =
  '---\n' +
  'schema_version: 1\n' +
  'current_phase: 2\n' +
  'current_plan: 02-02\n' +
  'last_updated: 2026-04-14T19:30:00Z\n' +
  '---\n' +
  '\n' +
  '# nubos-pilot State\n' +
  '\n' +
  '(freeform prose body)\n';

const sandboxes = [];

function makeSandbox(initialStateMd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-test-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'));
  if (initialStateMd !== null && initialStateMd !== undefined) {
    fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), initialStateMd);
  }
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  while (sandboxes.length) {
    const p = sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

test('R1: readState on seeded v1 STATE.md auto-migrates to v2 shape', () => {
  const root = makeSandbox(CANONICAL_STATE_MD);
  const s = state.readState(root);
  assert.equal(s.frontmatter.schema_version, 2, 'v1 inputs are read back as v2');
  assert.equal(s.frontmatter.current_phase, 2);
  assert.equal(s.frontmatter.current_plan, '02-02');
  assert.equal(s.frontmatter.current_task, null, 'v1 migration defaults current_task to null');
  assert.equal(s.frontmatter.last_updated, '2026-04-14T19:30:00Z');
  assert.ok(s.frontmatter.progress && typeof s.frontmatter.progress === 'object', 'progress block filled');
  assert.ok(s.frontmatter.session && typeof s.frontmatter.session === 'object', 'session block filled');
  assert.match(s.body, /nubos-pilot State/);
});

test('R2: writeState(next) + readState() round-trip preserves frontmatter (v2)', () => {
  const root = makeSandbox(CANONICAL_STATE_MD);
  const cur = state.readState(root);
  const next = {
    ...cur,
    frontmatter: { ...cur.frontmatter, current_phase: 42 },
  };
  state.writeState(next, root);
  const back = state.readState(root);
  assert.equal(back.frontmatter.current_phase, 42);
  assert.equal(back.frontmatter.schema_version, 2);
  assert.equal(back.frontmatter.current_plan, '02-02');
});

test('R3: write then re-read reproduces identical state (stable round-trip)', () => {
  const root = makeSandbox(CANONICAL_STATE_MD);
  const first = state.readState(root);
  state.writeState(first, root);
  const afterWrite = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  const second = state.readState(root);
  state.writeState(second, root);
  const afterWrite2 = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  assert.equal(afterWrite, afterWrite2, 'serialize(parse(serialize(parse(x)))) is stable');
});

test('R4: parseState on input without frontmatter throws schema-version-mismatch', () => {
  const root = makeSandbox('no frontmatter here just body text\n');
  assert.throws(
    () => state.readState(root),
    (err) => err && err.code === 'schema-version-mismatch',
  );
});

test('R5: parseState on unsupported schema_version (e.g. 3) throws schema-version-mismatch with supported list', () => {
  const bad =
    '---\n' +
    'schema_version: 3\n' +
    'current_phase: null\n' +
    'current_plan: null\n' +
    'last_updated: 2026-04-14T00:00:00Z\n' +
    '---\n\nbody\n';
  const root = makeSandbox(bad);
  assert.throws(
    () => state.readState(root),
    (err) => {
      return err
        && err.code === 'schema-version-mismatch'
        && err.details
        && err.details.got === 3
        && Array.isArray(err.details.supported)
        && err.details.supported.includes(1)
        && err.details.supported.includes(2);
    },
  );
});

test('R5b: parseState accepts schema_version:2 natively (milestone-schema progress)', () => {
  const v2 =
    '---\n' +
    'schema_version: 2\n' +
    'milestone: M001\n' +
    'milestone_name: Foundation\n' +
    'current_phase: 3\n' +
    'current_plan: 03-04\n' +
    'current_task: null\n' +
    'last_updated: "2026-04-15T00:00:00Z"\n' +
    'progress:\n' +
    '  total_milestones: 10\n' +
    '  completed_milestones: 2\n' +
    '  total_slices: 12\n' +
    '  completed_slices: 6\n' +
    '  total_tasks: 50\n' +
    '  completed_tasks: 30\n' +
    '  percent: 60\n' +
    'session:\n' +
    '  stopped_at: null\n' +
    '  resume_file: null\n' +
    '  last_activity: "2026-04-15T00:00:00Z"\n' +
    '---\n\nbody\n';
  const root = makeSandbox(v2);
  const s = state.readState(root);
  assert.equal(s.frontmatter.schema_version, 2);
  assert.equal(s.frontmatter.current_phase, 3);
  assert.equal(s.frontmatter.current_plan, '03-04');
  assert.equal(s.frontmatter.progress.total_milestones, 10);
  assert.equal(s.frontmatter.progress.percent, 60);
  assert.equal(s.frontmatter.session.last_activity, '2026-04-15T00:00:00Z');
});

test('R5b2: parseState strips legacy phase/plan progress keys (Schema-Drift defense)', () => {
  const legacy =
    '---\n' +
    'schema_version: 2\n' +
    'progress:\n' +
    '  total_phases: 99\n' +
    '  total_milestones: 3\n' +
    '  percent: 50\n' +
    '---\n\nbody\n';
  const root = makeSandbox(legacy);
  const s = state.readState(root);
  assert.equal(s.frontmatter.progress.total_milestones, 3);
  assert.equal(s.frontmatter.progress.percent, 50);
  assert.ok(!('total_phases' in s.frontmatter.progress), 'legacy total_phases must be stripped');
  assert.ok(!('total_plans' in s.frontmatter.progress), 'legacy total_plans must be stripped');
});

test('R5c: nested progress/session serialize as block and round-trip losslessly', () => {
  const v2 =
    '---\n' +
    'schema_version: 2\n' +
    'milestone: M004\n' +
    'current_slice: M004-S001\n' +
    'current_task: M004-S001-T0003\n' +
    'last_updated: "2026-04-15T00:00:00Z"\n' +
    'progress:\n' +
    '  total_milestones: 10\n' +
    '  completed_milestones: 3\n' +
    '  total_slices: 13\n' +
    '  completed_slices: 10\n' +
    '  total_tasks: 50\n' +
    '  completed_tasks: 30\n' +
    '  percent: 77\n' +
    'session:\n' +
    '  stopped_at: "mid-plan"\n' +
    '  resume_file: .planning/phases/04-base/04-01-PLAN.md\n' +
    '  last_activity: "2026-04-15T00:00:00Z"\n' +
    '---\n\nbody\n';
  const root = makeSandbox(v2);
  const first = state.readState(root);
  state.writeState(first, root);
  const after = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');

  assert.match(after, /\nprogress:\n  total_milestones: 10\n/);
  assert.match(after, /\nsession:\n  stopped_at: /);
  const back = state.readState(root);
  assert.equal(back.frontmatter.progress.completed_slices, 10);
  assert.equal(back.frontmatter.progress.percent, 77);
  assert.equal(back.frontmatter.session.resume_file, '.planning/phases/04-base/04-01-PLAN.md');
});

test('R5d: serializeState with a non-object progress/session emits the default block, never a corrupt scalar', () => {
  const md = state.serializeState({
    frontmatter: {
      schema_version: 2,
      current_phase: 1,
      progress: 'oops-not-an-object',
      session: 42,
    },
    body: 'body\n',
  });
  assert.doesNotMatch(md, /^progress: /m);
  assert.doesNotMatch(md, /^session: /m);
  assert.match(md, /\nprogress:\n  total_milestones: 0\n/);
  assert.match(md, /\nsession:\n  stopped_at: null\n/);
  const back = state.parseState(md);
  assert.equal(back.frontmatter.progress.percent, 0);
  assert.equal(back.frontmatter.session.resume_file, null);
});

test('R6: frontmatter scalar types — number / string / null / quoted-string (v1 migrates to v2)', () => {
  const raw =
    '---\n' +
    'schema_version: 1\n' +
    'current_phase: 7\n' +
    'current_plan: null\n' +
    'last_updated: "2026-04-14T00:00:00Z"\n' +
    '---\n\nbody\n';
  const root = makeSandbox(raw);
  const s = state.readState(root);
  assert.strictEqual(s.frontmatter.schema_version, 2);
  assert.strictEqual(s.frontmatter.current_phase, 7);
  assert.strictEqual(s.frontmatter.current_plan, null);
  assert.strictEqual(s.frontmatter.last_updated, '2026-04-14T00:00:00Z');
});

test('R7: CANONICAL_KEYS exports the full v2 key list (incl. milestone/slice keys)', () => {
  for (const k of ['schema_version', 'milestone', 'milestone_number', 'milestone_name', 'current_phase', 'current_plan', 'current_slice', 'current_task', 'last_updated', 'progress', 'session']) {
    assert.ok(state.CANONICAL_KEYS.includes(k), `missing ${k}`);
  }
});

test('R7b: serializeState emits milestone_number and current_slice in canonical order', () => {
  const md = state.serializeState({
    frontmatter: {
      schema_version: 2,
      milestone: 'M001',
      milestone_number: 1,
      milestone_name: 'Foundation',
      current_slice: 'M001-S001',
      current_task: 'M001-S001-T0001',
    },
    body: '\n',
  });
  const idxMilestone = md.indexOf('\nmilestone:');
  const idxNumber = md.indexOf('\nmilestone_number:');
  const idxSlice = md.indexOf('\ncurrent_slice:');
  const idxTask = md.indexOf('\ncurrent_task:');
  assert.ok(idxMilestone < idxNumber, 'milestone before milestone_number');
  assert.ok(idxSlice < idxTask, 'current_slice before current_task');
});

test('R7c: _defaultProgress uses milestone/slice/task counters (not phase/plan)', () => {
  const md = state.serializeState({
    frontmatter: { schema_version: 2, progress: null },
    body: '\n',
  });
  assert.match(md, /\nprogress:\n  total_milestones: 0\n/);
  assert.doesNotMatch(md, /total_phases:/);
});

test('PR1: statePath(sandboxRoot) equals <root>/.nubos-pilot/STATE.md', () => {
  const root = makeSandbox(CANONICAL_STATE_MD);
  const p = state.statePath(root);
  assert.equal(p, path.join(root, '.nubos-pilot', 'STATE.md'));
});

test('PR2: readState with no .nubos-pilot ancestor surfaces not-in-project error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-noproj-'));
  sandboxes.push(root);
  assert.throws(
    () => state.readState(root),
    (err) => err && err.code === 'not-in-project',
  );
});

test('C1: two concurrent mutateState calls — final STATE is one of the two writes, atomic', async () => {
  const root = makeSandbox(CANONICAL_STATE_MD);
  let counter = 0;
  const mutatorA = (s) => {
    counter++;
    return { ...s, frontmatter: { ...s.frontmatter, current_phase: 10, last_updated: '2030-01-01T00:00:00Z' } };
  };
  const mutatorB = (s) => {
    counter++;
    return { ...s, frontmatter: { ...s.frontmatter, current_phase: 20, last_updated: '2030-02-02T00:00:00Z' } };
  };
  await Promise.all([
    Promise.resolve().then(() => state.mutateState(mutatorA, root)),
    Promise.resolve().then(() => state.mutateState(mutatorB, root)),
  ]);
  assert.equal(counter, 2, 'both mutators ran exactly once');
  const final = state.readState(root);
  assert.ok(
    final.frontmatter.current_phase === 10 || final.frontmatter.current_phase === 20,
    'final phase is one of the two writes (not mixed)',
  );
  if (final.frontmatter.current_phase === 10) {
    assert.equal(final.frontmatter.last_updated, '2030-01-01T00:00:00Z', 'timestamp matches chosen phase (A)');
  } else {
    assert.equal(final.frontmatter.last_updated, '2030-02-02T00:00:00Z', 'timestamp matches chosen phase (B)');
  }
});

test('C2: 10-iteration stress — every iteration passes C1 assertions', async () => {
  for (let i = 0; i < 10; i++) {
    const root = makeSandbox(CANONICAL_STATE_MD);
    let counter = 0;
    const a = (s) => { counter++; return { ...s, frontmatter: { ...s.frontmatter, current_phase: 10, last_updated: '2030-01-01T00:00:00Z' } }; };
    const b = (s) => { counter++; return { ...s, frontmatter: { ...s.frontmatter, current_phase: 20, last_updated: '2030-02-02T00:00:00Z' } }; };
    await Promise.all([
      Promise.resolve().then(() => state.mutateState(a, root)),
      Promise.resolve().then(() => state.mutateState(b, root)),
    ]);
    assert.equal(counter, 2, `iteration ${i}: both mutators ran`);
    const f = state.readState(root);
    assert.ok(f.frontmatter.current_phase === 10 || f.frontmatter.current_phase === 20, `iteration ${i}: clean one-of-two`);
  }
});

test('C3: mutateState releases lock when mutator throws (subsequent writeState succeeds)', () => {
  const root = makeSandbox(CANONICAL_STATE_MD);
  const throwing = () => { throw new Error('boom'); };
  assert.throws(() => state.mutateState(throwing, root), /boom/);
  const start = Date.now();
  const next = { ...state.readState(root), frontmatter: { schema_version: 1, current_phase: 99, current_plan: 'x', last_updated: '2030-03-03T00:00:00Z' } };
  state.writeState(next, root);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `writeState completed in ${elapsed}ms (lock was released)`);
  const back = state.readState(root);
  assert.equal(back.frontmatter.current_phase, 99);
});
