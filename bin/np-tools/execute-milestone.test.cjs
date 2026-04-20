const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedMilestoneDir, seedSliceDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./execute-milestone.cjs');

function _roadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'M001',
        number: 1,
        name: 'Auth',
        goal: 'Ship login',
        slices: [
          { id: 'S001', name: 'Login Page' },
          { id: 'S002', name: 'Profile Page' },
        ],
      },
    ],
  };
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

function _taskPlanFile(id, slice, milestone, wave, tier, files) {
  return [
    '---',
    'id: ' + JSON.stringify(id),
    'slice: ' + JSON.stringify(slice),
    'milestone: ' + JSON.stringify(milestone),
    'type: execute',
    'status: pending',
    'tier: ' + JSON.stringify(tier),
    'wave: ' + wave,
    'depends_on: []',
    'files_modified:',
    ...files.map((f) => '  - ' + JSON.stringify(f)),
    'autonomous: true',
    'must_haves: {}',
    '---',
    '',
    '# ' + id + ' — Some task',
    '',
  ].join('\n');
}

function _seedTask(sandbox, mNum, sNum, tNum, files) {
  const mId = 'M' + String(mNum).padStart(3, '0');
  const sId = 'S' + String(sNum).padStart(3, '0');
  const tId = 'T' + String(tNum).padStart(4, '0');
  const fullId = mId + '-' + sId + '-' + tId;
  const slicePath = mId + '-' + sId;
  const dir = path.join(sandbox, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, tId + '-PLAN.md'), _taskPlanFile(fullId, slicePath, mId, sNum, 'sonnet', files || []));
  fs.writeFileSync(path.join(dir, tId + '-SUMMARY.md'), '---\nid: "' + fullId + '"\nstatus: pending\n---\n# ' + fullId + '\n');
  return fullId;
}

afterEach(cleanupAll);

test('EM-1: init returns waves ordered by slice number with tasks per wave', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  seedSliceDir(sandbox, 1, 1, {});
  seedSliceDir(sandbox, 1, 2, {});
  _seedTask(sandbox, 1, 1, 1, ['src/a.ts']);
  _seedTask(sandbox, 1, 1, 2, ['src/b.ts']);
  _seedTask(sandbox, 1, 2, 1, ['src/c.ts']);

  const cap = _capture();
  const payload = subcmd.run(['init', '1'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(payload.milestone, 1);
  assert.equal(payload.slice_count, 2);
  assert.equal(payload.total_tasks, 3);
  assert.equal(payload.waves.length, 2);
  assert.equal(payload.waves[0].wave, 1);
  assert.equal(payload.waves[0].task_count, 2);
  assert.equal(payload.waves[0].slice_full_id, 'M001-S001');
  assert.equal(payload.waves[1].wave, 2);
  assert.equal(payload.waves[1].task_count, 1);
  const t1 = payload.waves[0].tasks[0];
  assert.equal(t1.id, 'M001-S001-T0001');
  assert.equal(t1.tier, 'sonnet');
  assert.deepEqual(t1.files_modified, ['src/a.ts']);
});

test('EM-2: execute-task returns spawn payload for a given task full-id', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  seedSliceDir(sandbox, 1, 1, {});
  _seedTask(sandbox, 1, 1, 3, ['src/x.ts', 'src/y.ts']);
  const cap = _capture();
  const payload = subcmd.run(['execute-task', '1', 'M001-S001-T0003'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(payload.verb, 'execute-task');
  assert.equal(payload.task_id, 'M001-S001-T0003');
  assert.equal(payload.slice_full_id, 'M001-S001');
  assert.equal(payload.tier, 'sonnet');
  assert.ok(payload.plan_path.endsWith(path.join('T0003', 'T0003-PLAN.md')));
  assert.ok(payload.summary_path.endsWith(path.join('T0003', 'T0003-SUMMARY.md')));
  assert.deepEqual(payload.files_modified, ['src/x.ts', 'src/y.ts']);
});

test('EM-3: execute-task rejects mismatched milestone in full-id', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  seedSliceDir(sandbox, 1, 1, {});
  _seedTask(sandbox, 1, 1, 1, []);
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['execute-task', '1', 'M002-S001-T0001'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-milestone-task-milestone-mismatch',
  );
});

test('EM-4: execute-task rejects invalid id format', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['execute-task', '1', '01-01-T01'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-milestone-invalid-task-id',
  );
});

test('EM-5: init rejects unknown milestone number', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  assert.throws(
    () => subcmd.run(['init', '999'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'execute-milestone-not-found',
  );
});

test('EM-6: unknown verb throws', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  assert.throws(
    () => subcmd.run(['bogus', '1'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'execute-milestone-unknown-verb',
  );
});
