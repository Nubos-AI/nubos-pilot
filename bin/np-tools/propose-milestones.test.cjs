const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const newProject = require('./new-project.cjs');
const newMilestone = require('./new-milestone.cjs');
const subcmd = require('./propose-milestones.cjs');

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-propose-'));
  _sandboxes.push(root);
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    const p = _sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function _captureStdout() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

function _writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data), 'utf-8'); return p; }

function _seedProject(root) {
  const a = _writeJson(path.join(root, 'np.json'), {
    project_name: 'Demo', core_value: 'ship', primary_constraints: 'node22',
    first_milestone_name: 'Auth', first_phase_name: 'Login',
  });
  newProject.run(['--apply', a], { cwd: root, stdout: _captureStdout().stub });
}

function _addMilestone(root, name, goal) {
  const p = _writeJson(path.join(root, 'ms.json'), { milestone_name: name, milestone_goal: goal, create_req_prefix: false });
  newMilestone.run(['--apply', p], { cwd: root, stdout: _captureStdout().stub });
}

function _runInterview(root) {
  const cap = _captureStdout();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  return JSON.parse(cap.get());
}

function _runApply(root, operations) {
  const p = _writeJson(path.join(root, 'ops.json'), { operations });
  const cap = _captureStdout();
  subcmd.run(['--apply', p], { cwd: root, stdout: cap.stub });
  return JSON.parse(cap.get());
}

function _setStatus(root, id, status) {
  const rmPath = path.join(root, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(rmPath, 'utf-8'));
  const m = doc.milestones.find((x) => x && x.id === id);
  m.status = status;
  fs.writeFileSync(rmPath, YAML.stringify(doc, { indent: 2 }));
}

test('PM-1: interview without .nubos-pilot throws project-not-initialized', () => {
  const sandbox = makeSandbox();
  assert.throws(
    () => subcmd.run([], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.code === 'project-not-initialized',
  );
});

test('PM-2: interview emits classified milestones + project_has_tbd + next_milestone_number', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  _addMilestone(sandbox, 'Profile', 'ship profile');
  const payload = _runInterview(sandbox);
  assert.equal(payload.mode, 'interview');
  assert.ok(Array.isArray(payload.milestones));
  assert.equal(payload.milestones.length, 2);
  assert.equal(payload.next_milestone_number, 3);
  for (const m of payload.milestones) {
    assert.ok(['completed', 'active', 'discussed', 'empty'].includes(m.classification));
  }
});

test('PM-3: completed milestones are classified untouchable + guard blocks update/remove', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  _setStatus(sandbox, 'M001', 'done');
  const payload = _runInterview(sandbox);
  const m1 = payload.milestones.find((m) => m.id === 'M001');
  assert.equal(m1.classification, 'completed');
  assert.equal(m1.touchable, false);

  assert.throws(
    () => _runApply(sandbox, [{ type: 'remove', milestone_id: 'M001' }]),
    (err) => err.code === 'milestone-completed-untouchable',
  );
  assert.throws(
    () => _runApply(sandbox, [{ type: 'update', milestone_id: 'M001', new_goal: 'x' }]),
    (err) => err.code === 'milestone-completed-untouchable',
  );
});

test('PM-4: filled CONTEXT.md (no TBD markers) → discussed classification', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  // Adding a second milestone moves STATE pointer off M001, so M001 is no longer "active"
  _addMilestone(sandbox, 'Profile', 'ship profile');
  const ctx = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'M001-CONTEXT.md');
  fs.writeFileSync(ctx, '# M001\n<goal>\nShip auth.\n</goal>\n<decisions>\nUse Lucia.\n</decisions>\n');
  const payload = _runInterview(sandbox);
  const m1 = payload.milestones.find((m) => m.id === 'M001');
  assert.equal(m1.classification, 'discussed');
  assert.equal(m1.context.tbd_sections, 0);
  assert.ok(m1.context.has_content);
});

test('PM-5: apply add → appends new milestone + creates M<NNN>/ dir', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  const result = _runApply(sandbox, [
    { type: 'add', milestone_name: 'Profile', milestone_goal: 'ship profile' },
  ]);
  assert.equal(result.mode, 'apply');
  assert.equal(result.results[0].type, 'add');
  assert.equal(result.results[0].id, 'M002');
  const mDir = path.join(sandbox, '.nubos-pilot', 'milestones', 'M002');
  assert.ok(fs.existsSync(mDir));
  assert.ok(fs.existsSync(path.join(mDir, 'M002-CONTEXT.md')));
  assert.ok(fs.existsSync(path.join(mDir, 'M002-META.json')));
  assert.ok(fs.existsSync(path.join(mDir, 'slices')));
});

test('PM-6: apply update changes name/goal in roadmap without touching CONTEXT.md', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  const ctxPath = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'M001-CONTEXT.md');
  const ctxBefore = fs.readFileSync(ctxPath);
  _runApply(sandbox, [{ type: 'update', milestone_id: 'M001', new_name: 'Auth & Sessions' }]);
  const rm = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  const m1 = rm.milestones.find((m) => m.id === 'M001');
  assert.equal(m1.name, 'Auth & Sessions');
  assert.deepEqual(fs.readFileSync(ctxPath), ctxBefore);
});

test('PM-7: apply remove archives milestone dir + drops roadmap entry', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  _addMilestone(sandbox, 'Profile', 'ship profile');
  const srcDir = path.join(sandbox, '.nubos-pilot', 'milestones', 'M002');
  assert.ok(fs.existsSync(srcDir));

  _runApply(sandbox, [{ type: 'remove', milestone_id: 'M002' }]);

  assert.ok(!fs.existsSync(srcDir), 'milestone dir still exists after remove');
  const archRoot = path.join(sandbox, '.nubos-pilot', 'archive', 'milestones');
  assert.ok(fs.existsSync(archRoot));
  const archived = fs.readdirSync(archRoot);
  assert.ok(archived.some((name) => name.startsWith('M002-')));
  const rm = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.ok(!rm.milestones.some((m) => m && m.id === 'M002'));
});

test('PM-8: milestone with slices blocks modification unless confirm_force_modify=true', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  const rmPath = path.join(sandbox, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(rmPath, 'utf-8'));
  const m1 = doc.milestones.find((m) => m.id === 'M001');
  m1.slices = [{ id: 'S001', name: 'slice', status: 'pending', tasks: [] }];
  fs.writeFileSync(rmPath, YAML.stringify(doc, { indent: 2 }));

  assert.throws(
    () => _runApply(sandbox, [{ type: 'update', milestone_id: 'M001', new_name: 'x' }]),
    (err) => err.code === 'milestone-has-slices',
  );

  const result = _runApply(sandbox, [
    { type: 'update', milestone_id: 'M001', new_name: 'x', confirm_force_modify: true },
  ]);
  assert.equal(result.results[0].changed.to_name, 'x');
});

test('PM-9: multi-op batch (add + update + remove) applies all and returns summary', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  _addMilestone(sandbox, 'Profile', 'ship profile');
  _addMilestone(sandbox, 'Feed', 'ship feed');

  const result = _runApply(sandbox, [
    { type: 'add', milestone_name: 'Comments', milestone_goal: 'threaded comments' },
    { type: 'update', milestone_id: 'M002', new_goal: 'refined profile goal' },
    { type: 'remove', milestone_id: 'M003' },
  ]);

  assert.equal(result.results.length, 3);
  const rm = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  const ids = rm.milestones.filter((m) => m && m.id !== 'backlog').map((m) => m.id);
  assert.deepEqual(ids.sort(), ['M001', 'M002', 'M004']);
  const m2 = rm.milestones.find((m) => m.id === 'M002');
  assert.equal(m2.goal, 'refined profile goal');
});

test('PM-10: --apply does NOT touch PROJECT.md (D-29)', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  const p = path.join(sandbox, '.nubos-pilot', 'PROJECT.md');
  const before = fs.readFileSync(p);
  _runApply(sandbox, [{ type: 'add', milestone_name: 'X', milestone_goal: 'y' }]);
  assert.deepEqual(fs.readFileSync(p), before);
});

test('PM-11: invalid operation type throws invalid-operation-type', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  assert.throws(
    () => _runApply(sandbox, [{ type: 'reorder', milestone_id: 'M001' }]),
    (err) => err.code === 'invalid-operation-type',
  );
});

test('PM-12: add without name/goal throws answers-missing-field', () => {
  const sandbox = makeSandbox();
  _seedProject(sandbox);
  assert.throws(
    () => _runApply(sandbox, [{ type: 'add', milestone_name: '', milestone_goal: 'x' }]),
    (err) => err.code === 'answers-missing-field',
  );
});
