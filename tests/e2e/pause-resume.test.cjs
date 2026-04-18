const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const { startTask } = require('../../lib/checkpoint.cjs');

const _roots = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function createSandboxProject(currentTask) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-e2e-pr-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const ct = currentTask == null ? 'null' : currentTask;
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: 6
current_plan: "06-01"
current_task: ${ct}
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

function runCli(args, cwd) {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'np-tools.cjs'), ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return res;
}

function parseStdout(res) {
  let out = res.stdout || '';
  if (out.startsWith('@file:')) out = fs.readFileSync(out.slice(6), 'utf-8');
  return JSON.parse(out);
}

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('E2E-PR-1: pause-work then init resume-work → status=resume', () => {
  const root = createSandboxProject('06-01-T01');

  
  startTask({ id: '06-01-T01', phase: 6, plan: '06-01', wave: 1 }, root);

  const pause = runCli(['init', 'pause-work'], root);
  assert.equal(pause.status, 0, 'pause stderr=' + pause.stderr);
  const pp = parseStdout(pause);
  assert.equal(pp.ok, true);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(pp.stopped_at));
  assert.equal(pp.resume_file, '.nubos-pilot/checkpoints/06-01-T01.json');

  const state = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  assert.match(state, /stopped_at: "?\d{4}-\d{2}-\d{2}T/);

  const resume = runCli(['init', 'resume-work'], root);
  assert.equal(resume.status, 0, 'resume stderr=' + resume.stderr);
  const rp = parseStdout(resume);
  assert.equal(rp.status, 'resume');
  assert.equal(rp.task_id, '06-01-T01');
  assert.ok(rp.checkpoint && rp.checkpoint.task_id === '06-01-T01');
});

test('E2E-PR-2: orphan when current_task=null but checkpoint files remain → status=orphan', () => {
  const root = createSandboxProject(null);
  startTask({ id: '06-01-T05', phase: 6, plan: '06-01', wave: 1 }, root);

  const sp = path.join(root, '.nubos-pilot', 'STATE.md');
  const body = fs.readFileSync(sp, 'utf-8').replace(/current_task:.*/, 'current_task: null');
  fs.writeFileSync(sp, body, 'utf-8');

  const resume = runCli(['init', 'resume-work'], root);
  assert.equal(resume.status, 0, 'resume stderr=' + resume.stderr);
  const rp = parseStdout(resume);
  assert.equal(rp.status, 'orphan');
  assert.ok(Array.isArray(rp.checkpoint_ids));
  assert.ok(rp.checkpoint_ids.includes('06-01-T05'));
});

test('E2E-PR-3: clean session with no checkpoints and null current_task → status=clean', () => {
  const root = createSandboxProject(null);
  const resume = runCli(['init', 'resume-work'], root);
  assert.equal(resume.status, 0, 'resume stderr=' + resume.stderr);
  const rp = parseStdout(resume);
  assert.equal(rp.status, 'clean');
});
