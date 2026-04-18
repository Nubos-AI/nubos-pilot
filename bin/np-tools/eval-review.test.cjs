const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./eval-review.cjs');

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
            requirements: ['R-04'],
            success_criteria: ['Eval review produced'],
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

test('EVR-1: State A — both AI-SPEC and SUMMARY present', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {
    '09-AI-SPEC.md': '# ai\n',
    '09-SUMMARY.md': '# sum\n',
  });
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.state, 'A');
  assert.equal(payload.has_ai_spec, true);
  assert.equal(payload.summary_present, true);
});

test('EVR-2: State B — only SUMMARY present', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {
    '09-SUMMARY.md': '# sum\n',
  });
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.state, 'B');
  assert.equal(payload.has_ai_spec, false);
  assert.equal(payload.summary_present, true);
});

test('EVR-3: State C — neither file present', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.state, 'C');
  assert.equal(payload.has_ai_spec, false);
  assert.equal(payload.summary_present, false);
});

test('EVR-4: payload declares eval_auditor agent + standard fields', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const dir = seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.deepEqual(payload.agents, { eval_auditor: 'np-eval-auditor' });
  assert.equal(payload.eval_review_path, path.join(dir, '09-EVAL-REVIEW.md'));
  assert.equal(payload.summary_path, path.join(dir, '09-SUMMARY.md'));
  assert.equal(payload.ai_spec_path, path.join(dir, '09-AI-SPEC.md'));
});

test('EVR-5: runtime populated via detect()', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  fs.writeFileSync(
    path.join(sandbox, '.nubos-pilot', 'config.json'),
    JSON.stringify({ runtime: 'claude' }),
    'utf-8',
  );
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.runtime, 'claude');
});

test('EVR-6: unknown phase → eval-review-not-found', () => {
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
  assert.equal(parsed.code, 'eval-review-not-found');
});
