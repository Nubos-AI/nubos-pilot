const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./plan-milestone-gaps.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'first',
        phases: [
          { number: 1, name: 'One', slug: 'one', goal: '', depends_on: [], requirements: [], success_criteria: [], status: 'done', plans: [] },
          { number: 7, name: 'Seven', slug: 'seven', goal: '', depends_on: [6], requirements: [], success_criteria: [], status: 'done', plans: [] },
        ],
      },
    ],
  };
}

function _captureStdout() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

afterEach(cleanupAll);

test('CMD-1: no flags → JSON payload with mode=scan', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  subcmd.run([], { cwd: sandbox, stdout: cap.stub });
  const raw = cap.get().trim();
  assert.ok(!raw.startsWith('@file:'), 'small payload emitted inline');
  const payload = JSON.parse(raw);
  assert.equal(payload.milestoneId, 'v1.0');
  assert.equal(payload.mode, 'scan');
  assert.ok(Array.isArray(payload.gaps));
  assert.equal(payload.insertAfter, null);
  assert.ok('agent_skills' in payload);
});

test('CMD-2: --from audit-file → mode=from-file, gaps populated', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const auditPath = path.join(sandbox, 'audit.md');
  fs.copyFileSync(
    path.join(__dirname, '..', '..', 'tests', 'fixtures', 'gaps', 'audit-from-file.md'),
    auditPath,
  );
  const cap = _captureStdout();
  subcmd.run(['--from', auditPath], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.mode, 'from-file');
  assert.equal(payload.gaps.length, 2);
  for (const g of payload.gaps) assert.equal(g.source_phase, 7);
});

test('CMD-3: --from /etc/passwd → throws gaps-invalid-audit-path', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  assert.throws(
    () => subcmd.run(['--from', '/etc/passwd'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'gaps-invalid-audit-path',
  );
});

test('CMD-4: --insert-after 7 → payload.insertAfter === 7', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  subcmd.run(['--insert-after', '7'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.insertAfter, 7);
});

test('CMD-5: --insert-after abc → throws invalid-insert-after', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  assert.throws(
    () => subcmd.run(['--insert-after', 'abc'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'invalid-insert-after',
  );
});

test('CMD-6: oversized payload emits @file:<tmp> pointer', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());

  
  const big = Array.from({ length: 2000 }, (_, i) =>
    '- [ ] checkbox item number ' + i + ' with filler padding to grow bytes',
  ).join('\n');
  seedPhaseDir(sandbox, 3, 'foo', { '03-VERIFICATION.md': big });
  const cap = _captureStdout();
  subcmd.run([], { cwd: sandbox, stdout: cap.stub });
  const out = cap.get().trim();
  assert.ok(out.startsWith('@file:'), 'large payload produced @file: pointer');
  const tmpPath = out.slice('@file:'.length);
  const body = fs.readFileSync(tmpPath, 'utf-8');
  const payload = JSON.parse(body);
  assert.equal(payload.mode, 'scan');
  assert.ok(payload.gaps.length >= 2000);
  fs.unlinkSync(tmpPath);
});

test('CMD-7: milestoneId defaults to first milestone when STATE.md absent', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  subcmd.run([], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.milestoneId, 'v1.0');
});
