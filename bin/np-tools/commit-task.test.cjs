const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./commit-task.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ct-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], { stdio: 'pipe' });
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

function seedPlanAndTask(root, planId, taskId, filesModified) {
  // planId format: M006-S001 (ignored param compat); taskId: M006-S001-T0001
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  if (!m) throw new Error('bad taskId: ' + taskId);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });

  const fm = [
    '---',
    `id: ${taskId}`,
    `milestone: ${mId}`,
    `slice: ${mId}-${sId}`,
    'type: execute',
    'status: in-progress',
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified:',
    ...filesModified.map((f) => `  - ${f}`),
    'autonomous: true',
    'must_haves:',
    '  truths: []',
    '---',
    '',
    '# Task: demo',
  ].join('\n');
  const taskPath = path.join(taskDir, tId + '-PLAN.md');
  fs.writeFileSync(taskPath, fm, 'utf-8');
  return { taskDir, taskPath };
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

// Seed a checkpoint that satisfies the full Nubosloop gate (sequence-integrity).
// A real loop accumulates evidence on the envelope; the gate refuses unless
// every required marker is present. Tests that exercise game-paths build their
// own partial fixtures.
function seedLoopReadyCheckpoint(root, taskId, extra) {
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', taskId + '.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  const base = {
    schema_version: 1,
    task_id: taskId,
    status: 'pre-commit',
    files_touched: [],
    nubosloop: {
      round: 1,
      cache_hit: false,
      last_phase: 'commit',
      last_action: 'commit',
      verify_exit_code: 0,
      findings: [],
      committed_at: '2026-05-04T12:00:00Z',
    },
  };
  // Allow the test to override individual fields (incl. nubosloop sub-fields).
  const merged = Object.assign({}, base, extra || {});
  if (extra && extra.nubosloop) {
    merged.nubosloop = Object.assign({}, base.nubosloop, extra.nubosloop);
  }
  fs.writeFileSync(cpPath, JSON.stringify(merged), 'utf-8');
  return cpPath;
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('CT-1: commit-task requires a task id', () => {
  const root = makeRepo();
  const cap = _capture();
  assert.throws(
    () => subcmd.run([], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'commit-task-missing-id',
  );
});

test('CT-2: commit-task rejects invalid TASK_ID format (defense-in-depth)', () => {
  const root = makeRepo();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['bad/id'], { cwd: root, stdout: cap.stub }),
    (err) => err && err.code === 'commit-task-invalid-id',
  );
});

test('CT-3: commit-task emits JSON with sha + files on success', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0001', ['src/a.ts']);
  seedLoopReadyCheckpoint(root, 'M006-S001-T0001');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    subcmd.run(['M006-S001-T0001'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.task_id, 'M006-S001-T0001');
  assert.ok(/^[0-9a-f]{40}$/.test(payload.sha));
  assert.deepEqual(payload.files, ['src/a.ts']);
  assert.equal(payload.nubosloop_bypassed, false);

  const subject = execFileSync('git', ['-C', root, 'log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
  assert.ok(subject.startsWith('task(M006-S001-T0001):'), 'subject: ' + subject);
});

test('CT-3b: subject strips the duplicated task-id prefix from the H1 heading', () => {
  const root = makeRepo();
  const taskId = 'M006-S001-T0050';
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, tId + '-PLAN.md'), [
    '---',
    `id: ${taskId}`,
    `milestone: ${mId}`,
    `slice: ${mId}-${sId}`,
    'type: execute',
    'status: in-progress',
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified:',
    '  - src/a.ts',
    'autonomous: true',
    'must_haves: {}',
    '---',
    '',
    `# ${taskId} — wire the outcome feedback loop`,
    '',
    '<action>',
    'Add the OutcomeRecorder service and persist verdicts.',
    '</action>',
    '',
    '<acceptance_criteria>',
    '- Verdicts persist across restarts',
    '- API returns 201 on record',
    '</acceptance_criteria>',
  ].join('\n'), 'utf-8');
  seedLoopReadyCheckpoint(root, taskId);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    subcmd.run([taskId], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  const subject = execFileSync('git', ['-C', root, 'log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
  assert.equal(subject, `task(${taskId}): wire the outcome feedback loop`,
    'subject must not repeat the task id after the colon');
  const fullBody = execFileSync('git', ['-C', root, 'log', '-n', '1', '--format=%b'], { encoding: 'utf-8' });
  assert.match(fullBody, /Add the OutcomeRecorder service/, 'body should carry the <action> intent');
  assert.match(fullBody, /Acceptance:/);
  assert.match(fullBody, /Verdicts persist across restarts/);
  assert.match(fullBody, new RegExp('Task: ' + taskId));
  assert.match(fullBody, /Files: src\/a\.ts/);
});

test('CT-3c: test-writer files recorded in nubosloop.tdd_tests are folded into the commit', () => {
  const root = makeRepo();
  const taskId = 'M006-S001-T0060';
  seedPlanAndTask(root, '06-01', taskId, ['src/a.ts']);
  seedLoopReadyCheckpoint(root, taskId, { nubosloop: { tdd_tests: ['tests/a.test.ts'] } });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'tests', 'a.test.ts'), 'test("a", () => {});\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try {
    subcmd.run([taskId], { cwd: root, stdout: _capture().stub });
  } finally {
    process.chdir(prev);
  }
  const committed = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf-8' });
  assert.match(committed, /src\/a\.ts/, 'production file must be committed');
  assert.match(committed, /tests\/a\.test\.ts/, 'tdd test file must be committed even though it is not in files_modified');
});

test('CT-3d: degenerate task name falls back to the id instead of an empty subject', () => {
  const root = makeRepo();
  const taskId = 'M006-S001-T0061';
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const taskDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, tId + '-PLAN.md'), [
    '---',
    `id: ${taskId}`,
    `milestone: ${mId}`,
    `slice: ${mId}-${sId}`,
    'type: execute', 'status: in-progress', 'tier: sonnet', 'owner: np-executor',
    'wave: 1', 'depends_on: []',
    'files_modified:', '  - src/a.ts',
    'autonomous: true', 'must_haves: {}',
    '---', '',
    `# ${taskId} — `,
  ].join('\n'), 'utf-8');
  seedLoopReadyCheckpoint(root, taskId);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try {
    subcmd.run([taskId], { cwd: root, stdout: _capture().stub });
  } finally {
    process.chdir(prev);
  }
  const subject = execFileSync('git', ['-C', root, 'log', '-n', '1', '--format=%s'], { encoding: 'utf-8' }).trim();
  assert.equal(subject, `task(${taskId}): ${taskId}`, 'empty name must fall back to the id, never a bare colon');
});

test('CT-3e: commit body Files: lists only committed paths, not gitignored ones', () => {
  const root = makeRepo();
  const taskId = 'M006-S001-T0062';
  seedPlanAndTask(root, '06-01', taskId, ['src/a.ts', 'build/out.js']);
  seedLoopReadyCheckpoint(root, taskId);
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n', 'utf-8');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'build', 'out.js'), 'noise', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  try {
    subcmd.run([taskId], { cwd: root, stdout: _capture().stub });
  } finally {
    process.chdir(prev);
  }
  const fullBody = execFileSync('git', ['-C', root, 'log', '-n', '1', '--format=%b'], { encoding: 'utf-8' });
  assert.match(fullBody, /Files: src\/a\.ts/);
  assert.doesNotMatch(fullBody, /build\/out\.js/, 'gitignored path must not be advertised in the body');
});

test('CT-4: commit-task SOFT-SKIPS when every files_modified entry is gitignored (artifacts-gitignored terminator)', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0002', ['build/out.js']);
  seedLoopReadyCheckpoint(root, 'M006-S001-T0002');
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n', 'utf-8');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'out.js'), 'noise', 'utf-8');
  const before = execFileSync('git', ['-C', root, 'log', '--format=%H'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).length;
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  let payload;
  try {
    payload = subcmd.run(['M006-S001-T0002'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  assert.equal(payload.ok, true);
  assert.equal(payload.committed, false);
  assert.equal(payload.skip_reason, 'artifacts-gitignored');
  assert.deepEqual(payload.files_ignored, ['build/out.js']);
  const after = execFileSync('git', ['-C', root, 'log', '--format=%H'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).length;
  assert.equal(after, before, 'soft-skip must not produce a commit');
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0002.json');
  assert.equal(fs.existsSync(cpPath), false, 'checkpoint must be deleted on terminal skip (symmetric to commit success)');
});

test('CT-4b: commit-task commits the tracked subset on mixed paths (artifacts + real source)', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0003', ['src/a.ts', '.nubos-pilot/codebase/modules/x.md']);
  seedLoopReadyCheckpoint(root, 'M006-S001-T0003');
  fs.writeFileSync(path.join(root, '.gitignore'), '.nubos-pilot/codebase/\n', 'utf-8');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;', 'utf-8');
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'codebase', 'modules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'codebase', 'modules', 'x.md'), '# X', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  let payload;
  try {
    payload = subcmd.run(['M006-S001-T0003'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  assert.equal(payload.ok, true);
  assert.equal(payload.committed, true);
  assert.deepEqual(payload.files_committed, ['src/a.ts']);
  assert.deepEqual(payload.files_ignored, ['.nubos-pilot/codebase/modules/x.md']);
  assert.ok(/^[0-9a-f]{40}$/.test(payload.sha));
  const stat = execFileSync('git', ['-C', root, 'show', '--stat', '--format=', 'HEAD'], { encoding: 'utf-8' });
  assert.match(stat, /src\/a\.ts/);
  assert.doesNotMatch(stat, /codebase\/modules\/x\.md/);
});

test('CT-5: commit-task unknown task id → task-not-found', () => {
  const root = makeRepo();
  // Loop gate runs BEFORE task lookup (no checkpoint seeded), so we expect
  // the bypass-violation here, not the task-not-found error. Using --bypass
  // so we exercise the unknown-task path instead.
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S099-T0099', '--bypass-nubosloop'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-not-found',
  );
});

test('CT-6: empty files_modified falls back to checkpoint.files_touched', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0010', []);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
  // Checkpoint must satisfy the loop gate AND carry files_touched.
  seedLoopReadyCheckpoint(root, 'M006-S001-T0010', { files_touched: ['src/b.ts'] });
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    subcmd.run(['M006-S001-T0010'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.files_source, 'checkpoint');
  assert.deepEqual(payload.files, ['src/b.ts']);
});

test('CT-7: empty files_modified AND no checkpoint → commit-task-no-files', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0011', []);
  // No checkpoint → gate would normally refuse first; bypass to reach the
  // no-files path that this test exercises.
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0011', '--bypass-nubosloop'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-no-files',
  );
});

test('CT-8: refuse commit when no checkpoint exists (Nubosloop gate)', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0020', ['src/c.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n', 'utf-8');
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0020'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-loop-bypass-violation' && err.details && err.details.reason === 'no-checkpoint',
  );
});

test('CT-9: refuse commit when nubosloop.last_phase ≠ commit', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0021', ['src/d.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'd.ts'), 'export const d = 4;\n', 'utf-8');
  // Checkpoint exists but loop only made it to verifying — gate must refuse.
  seedLoopReadyCheckpoint(root, 'M006-S001-T0021', {
    nubosloop: { last_phase: 'verifying', last_action: 'verify-green' },
  });
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0021'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-loop-bypass-violation'
      && err.details && err.details.reason === 'last-phase-mismatch'
      && err.details.observed_last_phase === 'verifying',
  );
});

test('CT-12: refuse gamed commit (last_phase=commit but no verify_exit_code)', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0030', ['src/g.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'g.ts'), 'export const g = 7;\n', 'utf-8');
  // Simulates an agent that ran ONLY `loop-run-round --phase commit` to game
  // the gate, without going through preflight/post-executor/post-critics.
  // verify_exit_code is undefined → post-executor never ran.
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0030.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({
    schema_version: 1,
    task_id: 'M006-S001-T0030',
    status: 'pre-commit',
    files_touched: [],
    nubosloop: { last_phase: 'commit', last_action: 'commit', committed_at: '2026-05-04T12:00:00Z' },
  }), 'utf-8');
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0030'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-loop-bypass-violation'
      && err.details && err.details.reason === 'post-executor-not-green',
  );
});

test('CT-13: refuse gamed commit when verify ran but post-critics findings missing', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0031', ['src/h.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'h.ts'), 'export const h = 8;\n', 'utf-8');
  // verify ran (exit_code=0) but critics never produced findings — agent
  // skipped the critic-schwarm step.
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0031.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({
    schema_version: 1,
    task_id: 'M006-S001-T0031',
    status: 'pre-commit',
    files_touched: [],
    nubosloop: {
      last_phase: 'commit', last_action: 'commit',
      verify_exit_code: 0, // post-executor ran
      committed_at: '2026-05-04T12:00:00Z',
      // findings: missing → post-critics never ran
    },
  }), 'utf-8');
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0031'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-loop-bypass-violation'
      && err.details && err.details.reason === 'post-critics-missing',
  );
});

test('CT-13b: refuse gamed commit when post-critics produced non-empty findings', () => {
  // `evaluateLoop` only routes `next_action=commit` when findings.length===0.
  // The earlier shape-only gate accepted any array — a critic that returned
  // open issues still passed if the orchestrator stamped --phase commit on
  // top. Mirror the evaluator's invariant: non-empty findings = refuse.
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0033', ['src/j.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'j.ts'), 'export const j = 10;\n', 'utf-8');
  seedLoopReadyCheckpoint(root, 'M006-S001-T0033', {
    nubosloop: { findings: [{ category: 'todo-marker', file: 'src/j.ts', line: 1, severity: 'fail' }] },
  });
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0033'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-loop-bypass-violation'
      && err.details && err.details.reason === 'post-critics-not-converged',
  );
});

test('CT-14: refuse when verify-red was recorded (post-executor failed)', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0032', ['src/i.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'i.ts'), 'export const i = 9;\n', 'utf-8');
  // Loop reached commit-stamp somehow but verify was red — must refuse.
  seedLoopReadyCheckpoint(root, 'M006-S001-T0032', {
    nubosloop: { verify_exit_code: 1 },
  });
  const cap = _capture();
  const stderr = _capture();
  assert.throws(
    () => subcmd.run(['M006-S001-T0032'], { cwd: root, stdout: cap.stub, stderr: stderr.stub }),
    (err) => err && err.code === 'commit-task-loop-bypass-violation'
      && err.details && err.details.reason === 'post-executor-not-green'
      && err.details.observed_verify_exit_code === 1,
  );
});

test('CT-15: bypass on gamed commit logs precise reason in stderr', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0033', ['src/j.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'j.ts'), 'export const j = 10;\n', 'utf-8');
  const cpPath = path.join(root, '.nubos-pilot', 'checkpoints', 'M006-S001-T0033.json');
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  fs.writeFileSync(cpPath, JSON.stringify({
    schema_version: 1, task_id: 'M006-S001-T0033', status: 'pre-commit', files_touched: [],
    nubosloop: { last_phase: 'commit', last_action: 'commit', committed_at: 'z' },
  }), 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  const stderr = _capture();
  try {
    subcmd.run(['M006-S001-T0033', '--bypass-nubosloop'], { cwd: root, stdout: cap.stub, stderr: stderr.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.nubosloop_bypassed, true);
  assert.match(stderr.get(), /reason=post-executor-not-green/);
  assert.match(stderr.get(), /missing=verify_exit_code=0/);
});

test('CT-10: --bypass-nubosloop allows single-pass commit and warns on stderr', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0022', ['src/e.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'e.ts'), 'export const e = 5;\n', 'utf-8');
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  const stderr = _capture();
  try {
    subcmd.run(['M006-S001-T0022', '--bypass-nubosloop'], { cwd: root, stdout: cap.stub, stderr: stderr.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.nubosloop_bypassed, true);
  assert.match(stderr.get(), /WARNING: commit-task M006-S001-T0022 bypassing Nubosloop gate/);
  assert.match(stderr.get(), /observed=no-checkpoint/);
});

test('CT-11: --bypass-nubosloop on partial loop state stamps the bypass reason', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0023', ['src/f.ts']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'f.ts'), 'export const f = 6;\n', 'utf-8');
  seedLoopReadyCheckpoint(root, 'M006-S001-T0023', {
    nubosloop: { last_phase: 'post-critics', last_action: 'executor' },
  });
  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  const stderr = _capture();
  try {
    subcmd.run(['M006-S001-T0023', '--bypass-nubosloop'], { cwd: root, stdout: cap.stub, stderr: stderr.stub });
  } finally {
    process.chdir(prev);
  }
  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  assert.equal(payload.nubosloop_bypassed, true);
  assert.match(stderr.get(), /observed=post-critics/);
});

// P3.3: --cwd targets a slice worktree. `cd` is not usable by the caller because
// every workflow invocation uses the repo-relative .nubos-pilot/bin/np-tools.cjs
// path, which does not resolve from inside a worktree.
test('CT-CWD-1: --cwd commits into the given working tree, not process.cwd()', () => {
  const target = makeRepo();
  const caller = makeRepo();
  seedPlanAndTask(target, '06-01', 'M006-S001-T0001', ['src/a.ts']);
  seedLoopReadyCheckpoint(target, 'M006-S001-T0001');
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(target, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');

  const prev = process.cwd();
  process.chdir(caller);
  const cap = _capture();
  try {
    subcmd.run(['M006-S001-T0001', '--cwd', target], { cwd: target, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }

  const payload = JSON.parse(cap.get());
  assert.equal(payload.ok, true);
  const targetLog = execFileSync('git', ['-C', target, 'log', '--oneline'], { encoding: 'utf-8' });
  assert.match(targetLog, /M006-S001-T0001/, 'commit must land in the --cwd tree');
  const callerLog = execFileSync('git', ['-C', caller, 'log', '--oneline'], { encoding: 'utf-8' });
  assert.ok(!/M006-S001-T0001/.test(callerLog), 'and never on the calling branch');
});

test('CT-CWD-2: --cwd <dir> is not mistaken for the task id positional', () => {
  const root = makeRepo();
  seedPlanAndTask(root, '06-01', 'M006-S001-T0001', ['src/a.ts']);
  seedLoopReadyCheckpoint(root, 'M006-S001-T0001');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');

  const prev = process.cwd();
  process.chdir(root);
  const cap = _capture();
  try {
    // --cwd BEFORE the id: its value must not be picked up as the positional.
    subcmd.run(['--cwd', root, 'M006-S001-T0001'], { cwd: root, stdout: cap.stub });
  } finally {
    process.chdir(prev);
  }
  assert.equal(JSON.parse(cap.get()).task_id, 'M006-S001-T0001');
});
