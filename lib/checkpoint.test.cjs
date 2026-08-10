const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const checkpoint = require('./checkpoint.cjs');
const { readState } = require('./state.cjs');

const MIN_STATE = `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: null
current_plan: null
current_task: null
last_updated: "2026-04-15T00:00:00Z"
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
session:
  stopped_at: null
  resume_file: null
  last_activity: null
---

# Project State
`;

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cp-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), MIN_STATE, 'utf-8');
  _sandboxes.push(root);
  return root;
}

after(() => {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('CP-1: exports CHECKPOINT_SCHEMA_VERSION = 1 + the documented 6 functions', () => {
  assert.equal(checkpoint.CHECKPOINT_SCHEMA_VERSION, 1);
  for (const fn of [
    'startTask',
    'writeCheckpoint',
    'readCheckpoint',
    'deleteCheckpoint',
    'listCheckpoints',
    'checkpointPath',
  ]) {
    assert.equal(typeof checkpoint[fn], 'function', `missing export: ${fn}`);
  }
});

test('CP-2: checkpointPath resolves to .nubos-pilot/checkpoints/<id>.json', () => {
  const root = makeSandbox();
  const p = checkpoint.checkpointPath('M006-S001-T0001', root);
  assert.equal(p, path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0001.json'));
});

test('CP-3: startTask writes checkpoint file with D-07 schema fields', () => {
  const root = makeSandbox();
  const cp = checkpoint.startTask({ id: 'M006-S001-T0001', phase: 6, plan: '06-01', wave: 1 }, root);
  const onDisk = JSON.parse(fs.readFileSync(checkpoint.checkpointPath('M006-S001-T0001', root), 'utf-8'));
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.task_id, 'M006-S001-T0001');
  assert.equal(onDisk.phase, 6);
  assert.equal(onDisk.plan, '06-01');
  assert.equal(onDisk.wave, 1);
  assert.equal(onDisk.status, 'in-progress');
  assert.match(onDisk.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(onDisk.files_touched, []);
  assert.equal(onDisk.resume_hint, null);

  assert.equal(cp.task_id, onDisk.task_id);
});

test('CP-4: startTask updates STATE.md current_task/current_plan/current_phase atomically with checkpoint (D-08)', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M006-S001-T0002', phase: 6, plan: '06-01', wave: 1 }, root);
  const state = readState(root);
  assert.equal(state.frontmatter.current_task, 'M006-S001-T0002');
  assert.equal(state.frontmatter.current_plan, '06-01');
  assert.equal(state.frontmatter.current_phase, 6);
});

test('CP-5: startTask creates checkpoints/ directory if missing', () => {
  const root = makeSandbox();

  assert.equal(fs.existsSync(path.join(root, '.nubos-pilot', 'checkpoints')), false);
  checkpoint.startTask({ id: 'M006-S001-T0003', phase: 6, plan: '06-01', wave: 1 }, root);
  assert.equal(fs.existsSync(path.join(root, '.nubos-pilot', 'checkpoints')), true);
});

test('CP-6: readCheckpoint returns parsed JSON for an existing checkpoint', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M006-S001-T0004', phase: 6, plan: '06-01', wave: 1 }, root);
  const cp = checkpoint.readCheckpoint('M006-S001-T0004', root);
  assert.equal(cp.task_id, 'M006-S001-T0004');
  assert.equal(cp.schema_version, 1);
});

test('CP-7: readCheckpoint returns null for nonexistent task (ENOENT graceful)', () => {
  const root = makeSandbox();
  assert.equal(checkpoint.readCheckpoint('M006-S001-T0099', root), null);
});

test('CP-8: writeCheckpoint merges partial patch and bumps last_update', async () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M006-S001-T0005', phase: 6, plan: '06-01', wave: 1 }, root);
  const before = checkpoint.readCheckpoint('M006-S001-T0005', root);

  await new Promise((r) => setTimeout(r, 5));
  checkpoint.writeCheckpoint('M006-S001-T0005', {
    files_touched: ['lib/git.cjs'],
    resume_hint: 'continue from line 42',
  }, root);
  const after = checkpoint.readCheckpoint('M006-S001-T0005', root);
  assert.deepEqual(after.files_touched, ['lib/git.cjs']);
  assert.equal(after.resume_hint, 'continue from line 42');
  assert.equal(after.task_id, 'M006-S001-T0005'); 
  assert.equal(after.schema_version, 1);    
  assert.notEqual(after.last_update, before.last_update);
});

test('CP-9: writeCheckpoint on missing checkpoint creates a new one with schema_version=1', () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'checkpoints'), { recursive: true });
  checkpoint.writeCheckpoint('M006-S001-T0006', { task_id: 'M006-S001-T0006', status: 'in-progress' }, root);
  const cp = checkpoint.readCheckpoint('M006-S001-T0006', root);
  assert.equal(cp.schema_version, 1);
  assert.equal(cp.task_id, 'M006-S001-T0006');
});

test('CP-10: deleteCheckpoint removes file', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M006-S001-T0007', phase: 6, plan: '06-01', wave: 1 }, root);
  checkpoint.deleteCheckpoint('M006-S001-T0007', root);
  assert.equal(checkpoint.readCheckpoint('M006-S001-T0007', root), null);
});

test('CP-11: deleteCheckpoint on nonexistent file is a graceful no-op (ENOENT swallowed)', () => {
  const root = makeSandbox();
  assert.doesNotThrow(() => checkpoint.deleteCheckpoint('M006-S001-T0099', root));
});

test('CP-12: listCheckpoints returns sorted absolute paths; empty on missing dir', () => {
  const root = makeSandbox();
  assert.deepEqual(checkpoint.listCheckpoints(root), []);
  checkpoint.startTask({ id: 'M006-S001-T0009', phase: 6, plan: '06-01', wave: 1 }, root);
  checkpoint.startTask({ id: 'M006-S001-T0008', phase: 6, plan: '06-01', wave: 1 }, root);
  const list = checkpoint.listCheckpoints(root);
  assert.equal(list.length, 2);

  assert.ok(list[0].endsWith('M006-S001-T0008.json'));
  assert.ok(list[1].endsWith('M006-S001-T0009.json'));
});

test('CP-13: startTask serializes concurrent writes — final STATE matches one of the writers, no torn JSON', async () => {
  const root = makeSandbox();

  
  await Promise.all([
    Promise.resolve().then(() => checkpoint.startTask({ id: 'M006-S001-T0020', phase: 6, plan: '06-01', wave: 1 }, root)),
    Promise.resolve().then(() => checkpoint.startTask({ id: 'M006-S001-T0021', phase: 6, plan: '06-01', wave: 1 }, root)),
  ]);
  const state = readState(root);

  assert.ok(['M006-S001-T0020', 'M006-S001-T0021'].includes(state.frontmatter.current_task));

  const cp20 = checkpoint.readCheckpoint('M006-S001-T0020', root);
  const cp21 = checkpoint.readCheckpoint('M006-S001-T0021', root);
  assert.equal(cp20.task_id, 'M006-S001-T0020');
  assert.equal(cp21.task_id, 'M006-S001-T0021');
});

test('CP-RESTART-1: startTask preserves nubosloop block on re-execute (no wipe)', () => {
  const root = makeSandbox();
  // Run 1: start, record some loop state
  checkpoint.startTask({ id: 'M001-S001-T0001', phase: 1, plan: 'M001-S001', wave: 1 }, root);
  checkpoint.writeCheckpoint('M001-S001-T0001', {
    nubosloop: { round: 2, last_action: 'executor', findings: [{ category: 'todo-marker' }] },
    files_touched: ['src/foo.php'],
    resume_hint: 'mid-implementation',
  }, root);
  // Run 2: re-startTask (simulates /np:undo-task + re-execute)
  checkpoint.startTask({ id: 'M001-S001-T0001', phase: 1, plan: 'M001-S001', wave: 1 }, root);
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', root);
  // History preserved
  assert.equal(cp.nubosloop.round, 2);
  assert.equal(cp.nubosloop.last_action, 'executor');
  assert.equal(cp.nubosloop.findings.length, 1);
  assert.deepEqual(cp.files_touched, ['src/foo.php']);
  assert.equal(cp.resume_hint, 'mid-implementation');
  // Restart counter incremented + timestamp present
  assert.equal(cp.nubosloop.restart_count, 1);
  assert.match(cp.nubosloop.restarted_at, /^\d{4}-\d{2}-\d{2}T/);
  // Status reset to in-progress
  assert.equal(cp.status, 'in-progress');
});

test('CP-VER-1: writeCheckpoint throws checkpoint-version-mismatch when existing version > current', () => {
  const root = makeSandbox();
  // Seed a future-version checkpoint (simulates an older binary on a newer file)
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0001.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({
    schema_version: 99,
    task_id: 'M001-S001-T0001',
    status: 'in-progress',
    nubosloop: { round: 5, exotic_field_we_dont_understand: true },
  }), 'utf-8');
  assert.throws(
    () => checkpoint.writeCheckpoint('M001-S001-T0001', { status: 'verifying' }, root),
    (err) => err && err.code === 'checkpoint-version-mismatch'
      && err.details && err.details.expected === checkpoint.CHECKPOINT_SCHEMA_VERSION
      && err.details.got === 99,
  );
  // Original data must NOT be silently overwritten
  const onDisk = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
  assert.equal(onDisk.schema_version, 99);
  assert.equal(onDisk.nubosloop.round, 5);
});

test('CP-VER-2: mergeCheckpoint throws on future schema_version too', () => {
  const root = makeSandbox();
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0002.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({ schema_version: 99, task_id: 'M001-S001-T0002' }), 'utf-8');
  assert.throws(
    () => checkpoint.mergeCheckpoint('M001-S001-T0002', () => ({ x: 1 }), root),
    (err) => err && err.code === 'checkpoint-version-mismatch',
  );
});

test('CP-VER-3: same-version checkpoint passes', () => {
  const root = makeSandbox();
  const cp = checkpoint.startTask({ id: 'M001-S001-T0001' }, root);
  assert.equal(cp.schema_version, checkpoint.CHECKPOINT_SCHEMA_VERSION);
  // Round-trip writeCheckpoint at same version
  const merged = checkpoint.writeCheckpoint('M001-S001-T0001', { status: 'verifying' }, root);
  assert.equal(merged.schema_version, checkpoint.CHECKPOINT_SCHEMA_VERSION);
  assert.equal(merged.status, 'verifying');
});

test('CP-VER-5: populated checkpoint without schema_version throws schema-version-missing (R24/4)', () => {
  const root = makeSandbox();
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0099.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({ task_id: 'M001-S001-T0099', status: 'in-progress' }), 'utf-8');
  assert.throws(
    () => checkpoint.writeCheckpoint('M001-S001-T0099', {}, root),
    (err) => err && err.code === 'checkpoint-schema-version-missing',
  );
});

test('CP-VER-4: corrupt non-numeric schema_version throws checkpoint-schema-version-corrupt', () => {
  const root = makeSandbox();
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0003.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({ schema_version: 'oops', task_id: 'M001-S001-T0003' }), 'utf-8');
  assert.throws(
    () => checkpoint.writeCheckpoint('M001-S001-T0003', {}, root),
    (err) => err && err.code === 'checkpoint-schema-version-corrupt',
  );
});

test('CP-SEC-1: writeCheckpoint filters __proto__/constructor in existing-from-disk (proto-pollution defence)', () => {
  const root = makeSandbox();
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0050.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  // Simulate hostile checkpoint with __proto__ key smuggled in
  fs.writeFileSync(cpPath, JSON.stringify({
    schema_version: 1,
    task_id: 'M001-S001-T0050',
    status: 'in-progress',
    __proto__: { polluted: 'yes' },
  }), 'utf-8');
  const merged = checkpoint.writeCheckpoint('M001-S001-T0050', { status: 'verifying' }, root);
  assert.equal(merged.status, 'verifying');
  assert.equal(({}).polluted, undefined, 'Object.prototype must NOT be polluted');
  // Re-read and confirm no __proto__ pollution lands in subsequent merge cycle either
  const rereadMerged = checkpoint.mergeCheckpoint('M001-S001-T0050', () => ({ note: 'x' }), root);
  assert.equal(rereadMerged.note, 'x');
  assert.equal(({}).polluted, undefined);
});

test('CP-VER-6: readCheckpoint enforces schema check on read (R5/F-B from fifth review)', () => {
  const root = makeSandbox();
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0007.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  // Future-version file from a v2 binary; v1 binary must hard-fail on read.
  fs.writeFileSync(cpPath, JSON.stringify({ schema_version: 99, task_id: 'M001-S001-T0007' }), 'utf-8');
  assert.throws(
    () => checkpoint.readCheckpoint('M001-S001-T0007', root),
    (err) => err && err.code === 'checkpoint-version-mismatch',
  );
  // Populated-without-version is also rejected on read (symmetric with write paths).
  const cpPath2 = path.join(root, '.nubos-pilot', 'checkpoints', 'M001-S001-T0008.json');
  fs.writeFileSync(cpPath2, JSON.stringify({ task_id: 'M001-S001-T0008', status: 'in-progress' }), 'utf-8');
  assert.throws(
    () => checkpoint.readCheckpoint('M001-S001-T0008', root),
    (err) => err && err.code === 'checkpoint-schema-version-missing',
  );
});

test('CP-RESTART-2: startTask on fresh task — no prior, no restart fields', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M002-S001-T0001', phase: 2, plan: 'M002-S001', wave: 1 }, root);
  const cp = checkpoint.readCheckpoint('M002-S001-T0001', root);
  assert.equal(cp.nubosloop, undefined);
  assert.deepEqual(cp.files_touched, []);
  assert.equal(cp.resume_hint, null);
});

test('CP-PT-1: checkpointPath rejects ".." in taskId', () => {
  assert.throws(
    () => checkpoint.checkpointPath('../../STATE', '/tmp'),
    (err) => err && err.code === 'checkpoint-invalid-task-id',
  );
});

test('CP-PT-2: checkpointPath rejects empty/non-string taskId', () => {
  assert.throws(
    () => checkpoint.checkpointPath('', '/tmp'),
    (err) => err && err.code === 'checkpoint-invalid-task-id',
  );
  assert.throws(
    () => checkpoint.checkpointPath(null, '/tmp'),
    (err) => err && err.code === 'checkpoint-invalid-task-id',
  );
  assert.throws(
    () => checkpoint.checkpointPath({}, '/tmp'),
    (err) => err && err.code === 'checkpoint-invalid-task-id',
  );
});

test('CP-PT-3: checkpointPath rejects shell-special / wildcard taskIds', () => {
  const bad = [
    'M001-S001-T0001;rm -rf',
    'M001-S001-T0001 ',
    '../foo',
    'foo/bar',
    'M001-S001-T0001 evil',
    'M001-S001-T0001/../../STATE',
  ];
  for (const id of bad) {
    assert.throws(
      () => checkpoint.checkpointPath(id, '/tmp'),
      (err) => err && err.code === 'checkpoint-invalid-task-id',
      'taskId must be rejected: ' + JSON.stringify(id),
    );
  }
});

test('CP-PT-4: checkpointPath accepts canonical M<NNN>-S<NNN>-T<NNNN>', () => {
  const root = makeSandbox();
  const p = checkpoint.checkpointPath('M001-S001-T0001', root);
  assert.match(p, /\/checkpoints\/M001-S001-T0001\.json$/);
});

test('IDS-PT-1: TASK_ID_RE matches the canonical shape', () => {
  const { TASK_ID_RE } = require('../lib/ids.cjs');
  assert.equal(TASK_ID_RE.test('M001-S001-T0001'), true);
  assert.equal(TASK_ID_RE.test('M9999-S999-T99999'), true);
  assert.equal(TASK_ID_RE.test('m001-s001-t0001'), false);
  assert.equal(TASK_ID_RE.test('M01-S001-T0001'), false);
  assert.equal(TASK_ID_RE.test('M001-S99-T0001'), false);
});

test('CP-FT-1: finishTask clears current_task/phase/plan but preserves current_slice (slice has >1 task)', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M001-S001-T0001', phase: 1, plan: 1 }, root);
  const result = checkpoint.finishTask('M001-S001-T0001', root);
  assert.equal(result.state_cleared, true);
  assert.equal(result.task_id, 'M001-S001-T0001');
  const after = readState(root);
  assert.equal(after.frontmatter.current_task, null);
  assert.equal(after.frontmatter.current_phase, null);
  assert.equal(after.frontmatter.current_plan, null);
  assert.equal(after.frontmatter.current_slice, 'M001-S001', 'slice context survives finishTask');
  assert.equal(checkpoint.readCheckpoint('M001-S001-T0001', root), null);
});

test('CP-FT-5: startTask derives current_slice from canonical task.id automatically', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M001-S001-T0001', phase: 1, plan: 1 }, root);
  const s = readState(root);
  assert.equal(s.frontmatter.current_slice, 'M001-S001');
  assert.equal(s.frontmatter.current_task, 'M001-S001-T0001');
});

test('CP-FT-6: starting a task in a different slice overwrites current_slice', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M001-S001-T0001', phase: 1, plan: 1 }, root);
  checkpoint.startTask({ id: 'M001-S002-T0001', phase: 1, plan: 1 }, root);
  assert.equal(readState(root).frontmatter.current_slice, 'M001-S002');
});

test('CP-FT-7: explicit task.slice overrides derived slice', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M001-S001-T0001', slice: 'M001-S099' }, root);
  assert.equal(readState(root).frontmatter.current_slice, 'M001-S099');
});

test('CP-FT-2: finishTask does NOT clear STATE if current_task points elsewhere', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: 'M001-S001-T0001', phase: 1, plan: 1 }, root);
  checkpoint.startTask({ id: 'M001-S001-T0002', phase: 1, plan: 2 }, root);
  const result = checkpoint.finishTask('M001-S001-T0001', root);
  assert.equal(result.state_cleared, false);
  const after = readState(root);
  assert.equal(after.frontmatter.current_task, 'M001-S001-T0002');
});

test('CP-FT-3: finishTask is idempotent when checkpoint is already gone', () => {
  const root = makeSandbox();
  const result = checkpoint.finishTask('M001-S001-T0001', root);
  assert.equal(result.state_cleared, false);
  assert.equal(checkpoint.readCheckpoint('M001-S001-T0001', root), null);
});

test('CP-FT-4: finishTask rejects unsafe taskId', () => {
  const root = makeSandbox();
  assert.throws(
    () => checkpoint.finishTask('../etc/passwd', root),
    (err) => err && err.code === 'checkpoint-invalid-task-id',
  );
});
