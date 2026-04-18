const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./reset-slice.cjs');
const cp = require('../../lib/checkpoint.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rs-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'init'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: 6
current_plan: "06-01"
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

# State
`, 'utf-8');
  _repos.push(root);
  return root;
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('RS-1: reset-slice with no current_task → undo-dirty-tree', () => {
  const root = makeRepo();
  assert.throws(
    () => subcmd.run([], { cwd: root, stdout: _capture().stub }),
    (err) => err && err.code === 'undo-dirty-tree',
  );
});

test('RS-2: reset-slice restores files and emits payload', () => {
  const root = makeRepo();

  const phaseDir = path.join(root, '.nubos-pilot', 'phases', '06-demo');
  const tasksDir = path.join(phaseDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, '06-01-T05.md'), [
    '---', 'id: 06-01-T05', 'phase: 6', 'plan: "06-01"', 'type: auto',
    'status: in-progress', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified:', '  - src/r.ts',
    'autonomous: true', 'must_haves:', '  truths: []', '---', '', '# T',
  ].join('\n'), 'utf-8');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'r.ts'), 'baseline\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try {
    execFileSync('git', ['add', 'src/r.ts'], { stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { stdio: 'pipe' });
    cp.startTask({ id: '06-01-T05', phase: 6, plan: '06-01', wave: 1 }, root);
    cp.writeCheckpoint('06-01-T05', { files_touched: ['src/r.ts'] }, root);
    fs.writeFileSync(path.join(root, 'src', 'r.ts'), 'dirty\n', 'utf-8');
    const cap = _capture();
    subcmd.run([], { cwd: root, stdout: cap.stub });
    const payload = JSON.parse(cap.get());
    assert.equal(payload.ok, true);
    assert.equal(payload.task_id, '06-01-T05');
    assert.deepEqual(payload.restored_paths, ['src/r.ts']);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'r.ts'), 'utf-8'), 'baseline\n');
  } finally {
    process.chdir(prev);
  }
});
