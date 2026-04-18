const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const git = require('../../lib/git.cjs');
const { listCheckpoints } = require('../../lib/checkpoint.cjs');

const _roots = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function createSandboxProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-e2e-xp-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'init'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), `---
schema_version: 2
milestone: m1
milestone_name: m1
current_phase: 1
current_plan: "01-01"
current_task: null
last_updated: "2026-04-15T00:00:00Z"
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 1
  completed_plans: 0
  percent: 0
session:
  stopped_at: null
  resume_file: null
  last_activity: null
---

# State
`, 'utf-8');

  fs.writeFileSync(path.join(root, '.nubos-pilot', 'roadmap.yaml'), `milestones:
  - id: m1
    name: m1
    phases:
      - number: 1
        name: smoke
        slug: smoke
        goal: "smoke test"
        status: pending
        requirements: []
        success_criteria: []
        plans:
          - "01-01"
`, 'utf-8');

  fs.writeFileSync(path.join(root, '.nubos-pilot', 'ROADMAP.md'),
    '# Roadmap\n\n## Phase 1: smoke\n', 'utf-8');

  const phaseDir = path.join(root, '.nubos-pilot', 'phases', '01-smoke');
  const tasksDir = path.join(phaseDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'),
    '---\nphase: 1\nplan: "01-01"\n---\n\n# Plan\n', 'utf-8');
  for (const id of ['01-01-T01', '01-01-T02']) {
    fs.writeFileSync(path.join(tasksDir, id + '.md'), [
      '---',
      `id: ${id}`, 'phase: 1', 'plan: "01-01"', 'type: auto',
      'status: in-progress', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
      'depends_on: []', `files_modified:`,
      `  - src/${id}.ts`,
      'autonomous: true', 'must_haves:', '  truths: []', '---', '',
      `# Task: ${id}`,
    ].join('\n'), 'utf-8');
  }
  _roots.push(root);
  return root;
}

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('E2E-XP-1: init execute-phase emits waves payload with 2 tasks in wave 1', () => {
  const root = createSandboxProject();
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'np-tools.cjs'), 'init', 'execute-phase', 'init', '1'], {
    cwd: root,
    encoding: 'utf-8',
  });
  assert.equal(res.status, 0, 'init exit non-zero. stderr=' + res.stderr);
  let stdout = res.stdout || '';

  if (stdout.startsWith('@file:')) {
    stdout = fs.readFileSync(stdout.slice(6), 'utf-8');
  }
  const payload = JSON.parse(stdout);
  assert.equal(payload._workflow, 'execute-phase');
  assert.ok(Array.isArray(payload.plans), 'plans missing');
  assert.equal(payload.plans.length, 1);
  assert.equal(payload.plans[0].task_count, 2);
  assert.deepEqual(payload.plans[0].waves, [['01-01-T01', '01-01-T02']]);
});

test('E2E-XP-2: simulate executor commit loop — one commit per task, statuses → done', () => {
  const root = createSandboxProject();
  const prev = process.cwd();
  process.chdir(root);
  try {

    for (const id of ['01-01-T01', '01-01-T02']) {
      const file = `src/${id}.ts`;
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, file), `export const ${id.replace(/-/g, '_')} = 1;\n`, 'utf-8');
      git.commitTask(id, [file], `task(${id}): demo`);
    }

    const commits = git.listTaskCommits('01-01');
    assert.equal(commits.length, 2, 'expected 2 task commits, got ' + commits.length);

    const subjects = execFileSync('git', ['log', '--format=%s'], { encoding: 'utf-8' })
      .trim().split('\n').filter((l) => l.startsWith('task(01-01-'));
    assert.equal(subjects.length, 2);

    
    const cps = listCheckpoints(root);
    assert.equal(cps.length, 0);
  } finally {
    process.chdir(prev);
  }
});
