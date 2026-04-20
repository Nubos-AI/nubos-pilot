const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedMilestoneDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./add-tests.cjs');

function _roadmap() {
  return {
    schema_version: 2,
    milestones: [
      {
        id: 'M006',
        number: 6,
        name: 'Execution',
        goal: '',
        requirements: [],
        success_criteria: ['a', 'b', 'c'],
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

function _seedVerification(sandbox) {
  const mDir = seedMilestoneDir(sandbox, 6, {});
  const v = [
    '# M006 — Execution — Verification',
    '',
    '**Verified:** 2026-04-15',
    '**Milestone Status:** deferred',
    '',
    '## Success Criteria',
    '',
    '### SC-1: First passes',
    '- **Status:** Pass',
    '- **Classified by:** user',
    '- **Evidence:** —',
    '',
    '### SC-2: Second fails',
    '- **Status:** Fail',
    '- **Classified by:** user',
    '- **Evidence:** —',
    '',
    '### SC-3: Deferred',
    '- **Status:** Defer',
    '- **Classified by:** user',
    '- **Evidence:** —',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(mDir, 'M006-VERIFICATION.md'), v, 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'package.json'), '{"name":"sandbox"}', 'utf-8');
  return mDir;
}

afterEach(cleanupAll);

test('AT-1: init emits pass_cases (1) and skip_cases (2) categorized', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  _seedVerification(sandbox);
  const cap = _capture();
  const p = subcmd.run(['init', '6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p.milestone, 6);
  assert.equal(p.milestone_id, 'M006');
  assert.equal(p.pass_cases.length, 1);
  assert.equal(p.skip_cases.length, 2);
  assert.ok(p.target_path.endsWith(path.join('test', 'uat', 'm006-execution.test.cjs')));
});

test('AT-2: emit writes node:test file with begin/end sentinels', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  _seedVerification(sandbox);
  const r = subcmd.run(['emit', '6'], { cwd: sandbox, stdout: _capture().stub });
  const body = fs.readFileSync(r.target_path, 'utf-8');
  assert.ok(body.includes('// >>> np:add-tests begin'));
  assert.ok(body.includes('// <<< np:add-tests end'));
  assert.ok(body.includes("test('SC-1: First passes'"));
  assert.ok(body.includes("test.skip('SC-2: Second fails'"));
  assert.ok(body.includes("test.skip('SC-3: Deferred'"));
  assert.ok(body.includes('M006'));
});

test('AT-3: sentinel preservation — user edits OUTSIDE block survive regeneration', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  _seedVerification(sandbox);
  subcmd.run(['emit', '6'], { cwd: sandbox, stdout: _capture().stub });
  const target = path.join(sandbox, 'test', 'uat', 'm006-execution.test.cjs');
  let body = fs.readFileSync(target, 'utf-8');
  const userTest = "// USER AUTHORED: do not delete\ntest('user: custom case', () => { assert.ok(1); });\n\n";
  body = userTest + body;
  fs.writeFileSync(target, body, 'utf-8');

  subcmd.run(['emit', '6'], { cwd: sandbox, stdout: _capture().stub });
  const after = fs.readFileSync(target, 'utf-8');
  assert.ok(after.includes('// USER AUTHORED: do not delete'), 'user content lost');
  assert.ok(after.includes("test('user: custom case'"), 'user test lost');
  assert.ok(after.includes('// >>> np:add-tests begin'));
});

test('AT-4: missing VERIFICATION.md → loud error', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 6, {});
  fs.writeFileSync(path.join(sandbox, 'package.json'), '{}', 'utf-8');
  assert.throws(
    () => subcmd.run(['init', '6'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'add-tests-verification-missing',
  );
});

test('AT-5: unknown verb throws', () => {
  const sandbox = makeSandbox();
  assert.throws(
    () => subcmd.run(['bogus'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'add-tests-unknown-verb',
  );
});
