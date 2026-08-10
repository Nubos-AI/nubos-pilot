const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const _roots = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function createSandboxProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-smoke-ct-'));
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
  _roots.push(root);
  return root;
}

function seedTask(root, taskId, files) {
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, tId + '-PLAN.md'), [
    '---',
    `id: ${taskId}`, `milestone: ${mId}`, `slice: ${mId}-${sId}`, 'type: execute',
    'status: in-progress', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified:',
    ...files.map((f) => `  - ${f}`),
    'autonomous: true', 'must_haves:', '  truths: []', '---', '', '# Task',
  ].join('\n'), 'utf-8');
}

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('SMOKE-CT-1: commit-task SOFT-SKIPS when all files_modified are gitignored (exit 0, no commit, structured payload)', () => {
  const root = createSandboxProject();

  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n', 'utf-8');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'out.js'), 'noise', 'utf-8');
  seedTask(root, 'M006-S001-T0001', ['build/out.js']);

  const cpDir = path.join(root, '.nubos-pilot', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  fs.writeFileSync(path.join(cpDir, 'M006-S001-T0001.json'), JSON.stringify({
    schema_version: 1,
    task_id: 'M006-S001-T0001',
    status: 'pre-commit',
    files_touched: [],
    nubosloop: {
      last_phase: 'commit', last_action: 'commit', committed_at: '2026-05-04T12:00:00Z',
      verify_exit_code: 0, findings: [],
    },
  }), 'utf-8');

  const commitsBefore = execFileSync('git', ['-C', root, 'log', '--format=%H'], { encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean).length;

  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'np-tools.cjs'), 'commit-task', 'M006-S001-T0001'], {
    cwd: root,
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, 'expected exit 0 for soft-skip; got ' + res.status + ' stderr=' + res.stderr);
  const payload = JSON.parse(res.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.committed, false);
  assert.equal(payload.skip_reason, 'artifacts-gitignored');
  assert.deepEqual(payload.files_ignored, ['build/out.js']);

  const commitsAfter = execFileSync('git', ['-C', root, 'log', '--format=%H'], { encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean).length;
  assert.equal(commitsAfter, commitsBefore, 'no new commit on soft-skip');
});
