const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const layout = require('./layout.cjs');

const _sandboxes = [];
function mkSandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'np-layout-'));
  fs.mkdirSync(path.join(d, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(d);
  return d;
}
afterEach(() => {
  while (_sandboxes.length) {
    const d = _sandboxes.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('LAYOUT-1: id widths — milestone 3, slice 3, task 4', () => {
  assert.equal(layout.mId(1), 'M001');
  assert.equal(layout.sId(42), 'S042');
  assert.equal(layout.tId(7), 'T0007');
  assert.equal(layout.tId(999), 'T0999');
  assert.equal(layout.tId(1234), 'T1234');
  assert.equal(layout.sliceFullId(2, 7), 'M002-S007');
  assert.equal(layout.taskFullId(2, 7, 12), 'M002-S007-T0012');
});

test('LAYOUT-2: parse round-trips for all id types', () => {
  assert.equal(layout.parseMId('M001'), 1);
  assert.equal(layout.parseSId('S042'), 42);
  assert.equal(layout.parseTId('T0007'), 7);
  assert.deepEqual(layout.parseSliceFullId('M002-S007'), { milestone: 2, slice: 7 });
  assert.deepEqual(layout.parseTaskFullId('M002-S007-T0012'), { milestone: 2, slice: 7, task: 12 });
});

test('LAYOUT-3: invalid id shape throws', () => {
  assert.throws(() => layout.parseMId('foo'),     (e) => e.code === 'layout-invalid-id');
  assert.throws(() => layout.parseTId('T001'),    (e) => e.code === 'layout-invalid-id'); // 3 digits rejected
  assert.throws(() => layout.parseTaskFullId('M001-S001-T001'), (e) => e.code === 'layout-invalid-id');
});

test('LAYOUT-4: slugify normalizes names', () => {
  assert.equal(layout.slugify('Login Page'), 'login-page');
  assert.equal(layout.slugify('  Auth & Basic UI  '), 'auth-basic-ui');
});

test('LAYOUT-5: path helpers return expected LAYOUT-v2 layout (no slug in slice/task dir)', () => {
  const root = mkSandbox();
  const np = path.join(root, '.nubos-pilot');
  assert.equal(layout.milestonesRoot(root), path.join(np, 'milestones'));
  assert.equal(layout.milestoneDir(1, root), path.join(np, 'milestones', 'M001'));
  assert.equal(layout.milestoneContextPath(1, root), path.join(np, 'milestones', 'M001', 'M001-CONTEXT.md'));
  assert.equal(layout.milestoneRoadmapPath(1, root), path.join(np, 'milestones', 'M001', 'M001-ROADMAP.md'));
  assert.equal(layout.milestoneMetaPath(1, root), path.join(np, 'milestones', 'M001', 'M001-META.json'));
  assert.equal(layout.slicesRoot(1, root), path.join(np, 'milestones', 'M001', 'slices'));
  assert.equal(layout.sliceDir(1, 2, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002'));
  assert.equal(layout.slicePlanPath(1, 2, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002', 'S002-PLAN.md'));
  assert.equal(layout.sliceUatPath(1, 2, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002', 'S002-UAT.md'));
  assert.equal(layout.tasksRoot(1, 2, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002', 'tasks'));
  assert.equal(layout.taskDir(1, 2, 5, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002', 'tasks', 'T0005'));
  assert.equal(layout.taskPlanPath(1, 2, 5, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002', 'tasks', 'T0005', 'T0005-PLAN.md'));
  assert.equal(layout.taskSummaryPath(1, 2, 5, root),
    path.join(np, 'milestones', 'M001', 'slices', 'S002', 'tasks', 'T0005', 'T0005-SUMMARY.md'));
});

test('LAYOUT-6: create + find milestone/slice/task round-trip', () => {
  const root = mkSandbox();
  const mDir = layout.createMilestoneDir(1, root);
  assert.ok(fs.existsSync(mDir));
  assert.ok(fs.existsSync(path.join(mDir, 'slices')));
  assert.equal(layout.findMilestoneDir(1, root), mDir);

  const sDir = layout.createSliceDir(1, 1, root);
  assert.ok(fs.existsSync(sDir));
  assert.ok(fs.existsSync(path.join(sDir, 'tasks')));
  assert.equal(layout.findSliceDir(1, 1, root), sDir);

  const tDir = layout.createTaskDir(1, 1, 1, root);
  assert.ok(fs.existsSync(tDir));
  assert.equal(path.basename(tDir), 'T0001');
  assert.equal(layout.findTaskDir(1, 1, 1, root), tDir);
});

test('LAYOUT-7: listMilestones + listSlices + listTasks return sorted entries', () => {
  const root = mkSandbox();
  layout.createMilestoneDir(2, root);
  layout.createMilestoneDir(1, root);
  const ms = layout.listMilestones(root);
  assert.deepEqual(ms.map((m) => m.id), ['M001', 'M002']);

  layout.createSliceDir(1, 2, root);
  layout.createSliceDir(1, 1, root);
  const slices = layout.listSlices(1, root);
  assert.deepEqual(slices.map((s) => s.id), ['S001', 'S002']);
  assert.deepEqual(slices.map((s) => s.full_id), ['M001-S001', 'M001-S002']);

  layout.createTaskDir(1, 1, 2, root);
  layout.createTaskDir(1, 1, 1, root);
  const tasks = layout.listTasks(1, 1, root);
  assert.deepEqual(tasks.map((t) => t.id), ['T0001', 'T0002']);
  assert.deepEqual(tasks.map((t) => t.full_id), ['M001-S001-T0001', 'M001-S001-T0002']);
});

test('LAYOUT-8: task dir contains PLAN.md + SUMMARY.md paths derived from dir name', () => {
  const root = mkSandbox();
  layout.createMilestoneDir(1, root);
  layout.createSliceDir(1, 1, root);
  layout.createTaskDir(1, 1, 3, root);
  fs.writeFileSync(path.join(layout.taskDir(1, 1, 3, root), 'T0003-PLAN.md'), '---\nid: "M001-S001-T0003"\n---\n');
  const tasks = layout.listTasks(1, 1, root);
  assert.equal(tasks.length, 1);
  assert.ok(tasks[0].plan_path.endsWith(path.join('T0003', 'T0003-PLAN.md')));
  assert.ok(tasks[0].summary_path.endsWith(path.join('T0003', 'T0003-SUMMARY.md')));
});

test('LAYOUT-9: createSliceDir idempotent (does not recreate)', () => {
  const root = mkSandbox();
  layout.createMilestoneDir(1, root);
  const first = layout.createSliceDir(1, 1, root);
  const second = layout.createSliceDir(1, 1, root);
  assert.equal(first, second);
});

test('LAYOUT-10: findMilestoneDir returns null when not present', () => {
  const root = mkSandbox();
  assert.equal(layout.findMilestoneDir(1, root), null);
  assert.equal(layout.findSliceDir(1, 1, root), null);
  assert.equal(layout.findTaskDir(1, 1, 1, root), null);
});
