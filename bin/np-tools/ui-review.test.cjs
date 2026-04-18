const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./ui-review.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'first',
        phases: [
          {
            number: 9,
            name: 'Feature Set',
            slug: 'feature-set',
            goal: 'Ship advanced workflows',
            depends_on: [],
            requirements: ['R-03'],
            success_criteria: ['UI review produced'],
            status: 'pending',
            plans: [],
          },
        ],
      },
    ],
  };
}

function _capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

afterEach(cleanupAll);

test('UIR-1: no SUMMARY.md → summary_present=false, has_ui_spec=false', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const dir = seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.phase, '9');
  assert.equal(payload.padded, '09');
  assert.equal(payload.phase_dir, dir);
  assert.equal(payload.ui_review_path, path.join(dir, '09-UI-REVIEW.md'));
  assert.equal(payload.summary_present, false);
  assert.equal(payload.has_ui_spec, false);
});

test('UIR-2: SUMMARY.md present flips summary_present true and sets summary_path', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const dir = seedPhaseDir(sandbox, 9, 'feature-set', {
    '09-SUMMARY.md': '# summary\n',
  });
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.summary_present, true);
  assert.equal(payload.summary_path, path.join(dir, '09-SUMMARY.md'));
});

test('UIR-3: UI-SPEC present flips has_ui_spec true', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {
    '09-SUMMARY.md': '# summary\n',
    '09-UI-SPEC.md': '# ui\n',
  });
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_ui_spec, true);
});

test('UIR-4: agents.ui_auditor declared', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.deepEqual(payload.agents, { ui_auditor: 'np-ui-auditor' });
});

test('UIR-5: runtime populated via detect()', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  fs.writeFileSync(
    path.join(sandbox, '.nubos-pilot', 'config.json'),
    JSON.stringify({ runtime: 'gemini' }),
    'utf-8',
  );
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.runtime, 'gemini');
});

test('UIR-6: missing phase returns ui-review-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _capture();
  let errBuf = '';
  const code = subcmd.run(['99'], {
    cwd: sandbox, stdout: cap.stub,
    stderr: { write: (s) => { errBuf += s; return true; } },
  });
  assert.equal(code, 1);
  const parsed = JSON.parse(errBuf.trim());
  assert.equal(parsed.code, 'ui-review-not-found');
});
