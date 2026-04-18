const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./execute-plan.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [{
      id: 'v1.0', name: 'm1', phases: [
        { number: 6, name: 'Execution', slug: 'execution', goal: 'ship', depends_on: [],
          requirements: [], success_criteria: [], status: 'planned', plans: [] },
      ],
    }],
  };
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; return true; } }, get: () => b }; }

function _seedTwoPlans(sandbox) {
  const phaseDir = seedPhaseDir(sandbox, 6, 'execution', {
    '06-01-PLAN.md': '---\nphase: 6\nplan: 01\n---\n# p1\n',
    '06-02-PLAN.md': '---\nphase: 6\nplan: 02\n---\n# p2\n',
  });
  for (const id of ['06-01', '06-02']) {
    const tasksDir = path.join(phaseDir, 'tasks');
  }

  

  return phaseDir;
}

afterEach(cleanupAll);

test('XP-1: init <plan-id> emits single-plan payload', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  _seedTwoPlans(sandbox);
  const cap = _capture();
  subcmd.run(['init', '06-01'], { cwd: sandbox, stdout: cap.stub });
  const p = JSON.parse(cap.get().trim());
  assert.equal(p._workflow, 'execute-plan');
  assert.equal(p.plan_id, '06-01');
  assert.equal(p.phase, '06');
  assert.equal(p.padded, '06');
  assert.ok(p.plan_path.endsWith('06-01-PLAN.md'));
  assert.equal(p.executor_tier, 'sonnet');
});

test('XP-2: invalid plan-id format rejected', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['init', 'bogus'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-plan-invalid-id',
  );
});

test('XP-3: unknown plan throws', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  _seedTwoPlans(sandbox);
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['init', '06-99'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-plan-not-found',
  );
});

test('XP-4: init without plan-id throws', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['init'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'execute-plan-missing-id',
  );
});
