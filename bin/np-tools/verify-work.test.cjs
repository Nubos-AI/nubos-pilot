const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./verify-work.cjs');

function _roadmapWithSCs() {
  return {
    schema_version: 1,
    milestones: [{ id: 'v1.0', name: 'm1', phases: [
      { number: 6, name: 'Execution', slug: 'execution', goal: '', depends_on: [],
        requirements: [], success_criteria: ['Tasks commit atomically', 'Verification runs'],
        status: 'planned', plans: [] },
    ]}],
  };
}

function _capture() { let b = ''; return { stub: { write: (s) => { b += s; return true; } }, get: () => b }; }

afterEach(cleanupAll);

test('VW-1: init emits payload with success_criteria + verifier_tier', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedPhaseDir(sandbox, 6, 'execution', {});
  const cap = _capture();
  const p = subcmd.run(['init', '6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p._workflow, 'verify-work');
  assert.equal(p.verifier_tier, 'sonnet');
  assert.deepEqual(p.success_criteria, ['Tasks commit atomically', 'Verification runs']);
  assert.ok(Array.isArray(p.draft_results));
  assert.equal(p.draft_results.length, 2);
});

test('VW-2: emit-draft writes VERIFICATION.md', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const phaseDir = seedPhaseDir(sandbox, 6, 'execution', {});
  const cap = _capture();
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: cap.stub });
  const vp = path.join(phaseDir, '06-VERIFICATION.md');
  assert.ok(fs.existsSync(vp));
  const body = fs.readFileSync(vp, 'utf-8');
  assert.ok(body.includes('### SC-1:'));
  assert.ok(body.includes('### SC-2:'));
  assert.ok(body.includes('**Status:** Pending'));
});

test('VW-3: record-sc updates a single SC status + sets classified_by=user', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const phaseDir = seedPhaseDir(sandbox, 6, 'execution', {});
  const cap1 = _capture();
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: cap1.stub });
  const cap2 = _capture();
  subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: cap2.stub });
  const body = fs.readFileSync(path.join(phaseDir, '06-VERIFICATION.md'), 'utf-8');
  assert.ok(body.includes('### SC-1: Tasks commit atomically\n- **Status:** Pass\n- **Classified by:** user'));

  assert.ok(body.includes('### SC-2: Verification runs\n- **Status:** Pending'));
});

test('VW-4: record-sc rejects unknown status', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedPhaseDir(sandbox, 6, 'execution', {});
  const cap1 = _capture();
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: cap1.stub });
  const cap2 = _capture();
  assert.throws(
    () => subcmd.run(['record-sc', '6', 'SC-1', 'Maybe'], { cwd: sandbox, stdout: cap2.stub }),
    (err) => err && err.code === 'verify-work-invalid-status',
  );
});

test('VW-5: record-sc before emit-draft → file-unreadable', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedPhaseDir(sandbox, 6, 'execution', {});
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'verify-work-file-unreadable',
  );
});

test('VW-6: unknown verb throws', () => {
  const sandbox = makeSandbox();
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['bogus'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.code === 'verify-work-unknown-verb',
  );
});
