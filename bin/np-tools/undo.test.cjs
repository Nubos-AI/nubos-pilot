const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./undo.cjs');
const git = require('../../lib/git.cjs');

const _repos = [];

function makeRepoBase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-undo-cli-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'init'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
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

# State
`, 'utf-8');
  _repos.push(root);
  return root;
}

function seedAndCommit(root, planId, taskId, file) {
  const phaseDir = path.join(root, '.nubos-pilot', 'phases', planId.slice(0, 2) + '-demo');
  const tasksDir = path.join(phaseDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, taskId + '.md'), [
    '---',
    `id: ${taskId}`, `phase: ${Number(planId.slice(0, 2))}`, `plan: "${planId}"`,
    'type: auto', 'status: done', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified:', `  - ${file}`, 'autonomous: true',
    'must_haves:', '  truths: []', '---', '', '# Task',
  ].join('\n'), 'utf-8');
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'data\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try { git.commitTask(taskId, [file], 'task(' + taskId + '): demo'); }
  finally { process.chdir(prev); }
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('UN-CLI-1: undo missing arg', () => {
  assert.throws(
    () => subcmd.run([], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'undo-missing-arg',
  );
});

test('UN-CLI-2: undo invalid arg shape (T-06-18 injection guard)', () => {
  assert.throws(
    () => subcmd.run(['6; rm -rf /'], { cwd: process.cwd(), stdout: _capture().stub }),
    (err) => err && err.code === 'undo-invalid-arg',
  );
});

test('UN-CLI-3: undo plan reverts all task commits of the plan', () => {
  const root = makeRepoBase();
  seedAndCommit(root, '06-01', '06-01-T01', 'src/x.ts');
  seedAndCommit(root, '06-01', '06-01-T02', 'src/y.ts');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    subcmd.run(['06-01'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.target, '06-01');
  assert.equal(payload.reverted.length, 2);
});

test('UN-CLI-4: undo phase emits nothing-to-revert when no commits match', () => {
  const root = makeRepoBase();
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    subcmd.run(['7'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.message, 'nothing to revert');
  assert.equal(payload.reverted.length, 0);
});
