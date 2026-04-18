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
  const p = checkpoint.checkpointPath('06-01-T01', root);
  assert.equal(p, path.join(root, '.nubos-pilot', 'checkpoints', '06-01-T01.json'));
});

test('CP-3: startTask writes checkpoint file with D-07 schema fields', () => {
  const root = makeSandbox();
  const cp = checkpoint.startTask({ id: '06-01-T01', phase: 6, plan: '06-01', wave: 1 }, root);
  const onDisk = JSON.parse(fs.readFileSync(checkpoint.checkpointPath('06-01-T01', root), 'utf-8'));
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.task_id, '06-01-T01');
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
  checkpoint.startTask({ id: '06-01-T02', phase: 6, plan: '06-01', wave: 1 }, root);
  const state = readState(root);
  assert.equal(state.frontmatter.current_task, '06-01-T02');
  assert.equal(state.frontmatter.current_plan, '06-01');
  assert.equal(state.frontmatter.current_phase, 6);
});

test('CP-5: startTask creates checkpoints/ directory if missing', () => {
  const root = makeSandbox();

  assert.equal(fs.existsSync(path.join(root, '.nubos-pilot', 'checkpoints')), false);
  checkpoint.startTask({ id: '06-01-T03', phase: 6, plan: '06-01', wave: 1 }, root);
  assert.equal(fs.existsSync(path.join(root, '.nubos-pilot', 'checkpoints')), true);
});

test('CP-6: readCheckpoint returns parsed JSON for an existing checkpoint', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: '06-01-T04', phase: 6, plan: '06-01', wave: 1 }, root);
  const cp = checkpoint.readCheckpoint('06-01-T04', root);
  assert.equal(cp.task_id, '06-01-T04');
  assert.equal(cp.schema_version, 1);
});

test('CP-7: readCheckpoint returns null for nonexistent task (ENOENT graceful)', () => {
  const root = makeSandbox();
  assert.equal(checkpoint.readCheckpoint('06-01-T99', root), null);
});

test('CP-8: writeCheckpoint merges partial patch and bumps last_update', async () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: '06-01-T05', phase: 6, plan: '06-01', wave: 1 }, root);
  const before = checkpoint.readCheckpoint('06-01-T05', root);

  await new Promise((r) => setTimeout(r, 5));
  checkpoint.writeCheckpoint('06-01-T05', {
    files_touched: ['lib/git.cjs'],
    resume_hint: 'continue from line 42',
  }, root);
  const after = checkpoint.readCheckpoint('06-01-T05', root);
  assert.deepEqual(after.files_touched, ['lib/git.cjs']);
  assert.equal(after.resume_hint, 'continue from line 42');
  assert.equal(after.task_id, '06-01-T05'); 
  assert.equal(after.schema_version, 1);    
  assert.notEqual(after.last_update, before.last_update);
});

test('CP-9: writeCheckpoint on missing checkpoint creates a new one with schema_version=1', () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'checkpoints'), { recursive: true });
  checkpoint.writeCheckpoint('06-01-T06', { task_id: '06-01-T06', status: 'in-progress' }, root);
  const cp = checkpoint.readCheckpoint('06-01-T06', root);
  assert.equal(cp.schema_version, 1);
  assert.equal(cp.task_id, '06-01-T06');
});

test('CP-10: deleteCheckpoint removes file', () => {
  const root = makeSandbox();
  checkpoint.startTask({ id: '06-01-T07', phase: 6, plan: '06-01', wave: 1 }, root);
  checkpoint.deleteCheckpoint('06-01-T07', root);
  assert.equal(checkpoint.readCheckpoint('06-01-T07', root), null);
});

test('CP-11: deleteCheckpoint on nonexistent file is a graceful no-op (ENOENT swallowed)', () => {
  const root = makeSandbox();
  assert.doesNotThrow(() => checkpoint.deleteCheckpoint('06-01-T99', root));
});

test('CP-12: listCheckpoints returns sorted absolute paths; empty on missing dir', () => {
  const root = makeSandbox();
  assert.deepEqual(checkpoint.listCheckpoints(root), []);
  checkpoint.startTask({ id: '06-01-T09', phase: 6, plan: '06-01', wave: 1 }, root);
  checkpoint.startTask({ id: '06-01-T08', phase: 6, plan: '06-01', wave: 1 }, root);
  const list = checkpoint.listCheckpoints(root);
  assert.equal(list.length, 2);

  assert.ok(list[0].endsWith('06-01-T08.json'));
  assert.ok(list[1].endsWith('06-01-T09.json'));
});

test('CP-13: startTask serializes concurrent writes — final STATE matches one of the writers, no torn JSON', async () => {
  const root = makeSandbox();

  
  await Promise.all([
    Promise.resolve().then(() => checkpoint.startTask({ id: '06-01-T20', phase: 6, plan: '06-01', wave: 1 }, root)),
    Promise.resolve().then(() => checkpoint.startTask({ id: '06-01-T21', phase: 6, plan: '06-01', wave: 1 }, root)),
  ]);
  const state = readState(root);

  assert.ok(['06-01-T20', '06-01-T21'].includes(state.frontmatter.current_task));

  const cp20 = checkpoint.readCheckpoint('06-01-T20', root);
  const cp21 = checkpoint.readCheckpoint('06-01-T21', root);
  assert.equal(cp20.task_id, '06-01-T20');
  assert.equal(cp21.task_id, '06-01-T21');
});
