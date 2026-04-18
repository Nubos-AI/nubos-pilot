const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./execute-phase.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [{
      id: 'v1.0', name: 'first', phases: [
        { number: 6, name: 'Execution', slug: 'execution', goal: 'ship', depends_on: [],
          requirements: ['EXEC-01'], success_criteria: ['tasks commit'], status: 'planned', plans: [] },
      ],
    }],
  };
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

function _seedPhaseWithPlan(sandbox) {
  const phaseDir = seedPhaseDir(sandbox, 6, 'execution', {
    '06-01-PLAN.md': '---\nphase: 6\nplan: 01\n---\n# plan\n',
  });
  const tasksDir = path.join(phaseDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskMd = [
    '---',
    'id: 06-01-T01',
    'phase: 6',
    'plan: "06-01"',
    'type: auto',
    'status: pending',
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified:',
    '  - src/a.ts',
    'autonomous: true',
    'must_haves:',
    '  truths: []',
    '---',
    '',
    '# Task',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, '06-01-T01.md'), taskMd, 'utf-8');
  return phaseDir;
}

afterEach(cleanupAll);

test('EP-1: init emits payload with waves + executor_tier=sonnet + phase_dir', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const phaseDir = _seedPhaseWithPlan(sandbox);
  const cap = _capture();
  subcmd.run(['init', '6'], { cwd: sandbox, stdout: cap.stub });
  const raw = cap.get().trim();
  assert.ok(!raw.startsWith('@file:'));
  const p = JSON.parse(raw);
  assert.equal(p._workflow, 'execute-phase');
  assert.equal(p.phase, '6');
  assert.equal(p.padded, '06');
  assert.equal(p.phase_dir, phaseDir);
  assert.equal(p.executor_tier, 'sonnet');
  assert.ok(Array.isArray(p.plans));
  assert.ok(p.plans.length >= 1);
  assert.ok(Array.isArray(p.plans[0].waves));
});

test('EP-2: init without phase arg throws validation', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['init'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-phase-invalid-phase-arg',
  );
});

test('EP-3: init rejects non-numeric phase', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['init', 'abc'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-phase-invalid-phase-arg',
  );
});

test('EP-4: execute-task verb emits task payload with files_modified', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  _seedPhaseWithPlan(sandbox);
  const cap = _capture();
  subcmd.run(['execute-task', '6', '06-01-T01'], { cwd: sandbox, stdout: cap.stub });
  const p = JSON.parse(cap.get().trim());
  assert.equal(p.task_id, '06-01-T01');
  assert.deepEqual(p.files_modified, ['src/a.ts']);
  assert.equal(p.executor_tier, 'sonnet');
});

test('EP-5: unknown verb throws', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['bogus'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-phase-unknown-verb',
  );
});
