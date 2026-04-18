const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./autonomous.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [{ id: 'v1.0', name: 'm1', phases: [
      { number: 6, name: 'Execution', slug: 'execution', goal: '', depends_on: [],
        requirements: [], success_criteria: [], status: 'planned', plans: [] },
    ]}],
  };
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; return true; } }, get: () => b }; }

afterEach(cleanupAll);

test('AU-1: advancement-blocked when rule 3 + skipped-only wave (Pitfall 6 Guard)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const phaseDir = seedPhaseDir(sandbox, 6, 'execution', {
    '06-CONTEXT.md': '# ctx',
    '06-01-PLAN.md': '---\nphase: 6\nplan: 01\n---\n# p\n',
  });

  fs.mkdirSync(path.join(phaseDir, 'tasks'), { recursive: true });
  const taskMd = [
    '---', 'id: 06-01-T01', 'phase: 6', 'plan: "06-01"', 'type: auto',
    'status: skipped', 'tier: sonnet', 'owner: np-executor', 'wave: 1',
    'depends_on: []', 'files_modified: []', 'autonomous: true',
    'must_haves:', '  truths: []', '---', '',
  ].join('\n');
  fs.writeFileSync(path.join(phaseDir, 'tasks', '06-01-T01.md'), taskMd, 'utf-8');

  const cap = _capture();
  const p = subcmd.run(['6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p.status, 'advancement-blocked');
  assert.equal(p.reason, 'rule-3-null-task');
});

test('AU-2: ok status when gate is not rule-3-null-task', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());

  seedPhaseDir(sandbox, 6, 'execution', {});
  const cap = _capture();
  const p = subcmd.run(['6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p.status, 'ok');
  assert.equal(p.gate.rule, 1);
});

test('AU-3: accepts `init <phase>` verb form', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 6, 'execution', {});
  const cap = _capture();
  const p = subcmd.run(['init', '6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p.status, 'ok');
});

test('AU-4: missing phase arg → autonomous-invalid-phase', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run([], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'autonomous-invalid-phase',
  );
});
