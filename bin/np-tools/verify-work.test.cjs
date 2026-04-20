const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedMilestoneDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./verify-work.cjs');

function _roadmapWithSCs() {
  return {
    schema_version: 2,
    milestones: [
      {
        id: 'M006',
        number: 6,
        name: 'Execution',
        goal: '',
        requirements: [],
        success_criteria: ['Tasks commit atomically', 'Verification runs'],
        status: 'pending',
        slices: [],
      },
    ],
  };
}

function _capture() {
  let b = '';
  return { stub: { write: (s) => { b += s; return true; } }, get: () => b };
}

afterEach(cleanupAll);

test('VW-1: init emits payload with success_criteria + verifier_tier', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  const cap = _capture();
  const p = subcmd.run(['init', '6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p._workflow, 'verify-work');
  assert.equal(p.milestone, 6);
  assert.equal(p.milestone_id, 'M006');
  assert.equal(p.verifier_tier, 'sonnet');
  assert.deepEqual(p.success_criteria, ['Tasks commit atomically', 'Verification runs']);
  assert.ok(Array.isArray(p.draft_results));
  assert.equal(p.draft_results.length, 2);
  assert.ok(Array.isArray(p.slice_uat));
});

test('VW-2: emit-draft writes M<NNN>-VERIFICATION.md', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {});
  const cap = _capture();
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: cap.stub });
  const vp = path.join(mDir, 'M006-VERIFICATION.md');
  assert.ok(fs.existsSync(vp), 'expected ' + vp);
  const body = fs.readFileSync(vp, 'utf-8');
  assert.ok(body.includes('### SC-1:'));
  assert.ok(body.includes('### SC-2:'));
  assert.ok(body.includes('**Status:** Pending'));
  assert.match(body, /^# M006 — Execution — Verification$/m);
});

test('VW-3: record-sc updates a single SC status + sets classified_by=user', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  const body = fs.readFileSync(path.join(mDir, 'M006-VERIFICATION.md'), 'utf-8');
  assert.ok(body.includes('### SC-1: Tasks commit atomically\n- **Status:** Pass\n- **Classified by:** user'));
  assert.ok(body.includes('### SC-2: Verification runs\n- **Status:** Pending'));
});

test('VW-4: record-sc rejects unknown status', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  assert.throws(
    () => subcmd.run(['record-sc', '6', 'SC-1', 'Maybe'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-invalid-status',
  );
});

test('VW-5: record-sc before emit-draft → file-unreadable', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  assert.throws(
    () => subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-file-unreadable',
  );
});

test('VW-6: unknown verb throws', () => {
  const sandbox = makeSandbox();
  assert.throws(
    () => subcmd.run(['bogus'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-unknown-verb',
  );
});

test('VW-7: unknown milestone number throws verify-work-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  assert.throws(
    () => subcmd.run(['init', '99'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-not-found',
  );
});
