const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./ai-integration-phase.cjs');

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
            requirements: ['R-01'],
            success_criteria: ['AI-SPEC produced'],
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

test('AIP-1: run(["init", "9"]) returns payload with expected shape', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const dir = seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.phase, '9');
  assert.equal(payload.padded, '09');
  assert.equal(payload.phase_dir, dir);
  assert.equal(
    payload.ai_spec_path,
    path.join(dir, '09-AI-SPEC.md'),
  );
  assert.equal(payload.has_ai_spec, false);
  assert.match(payload.template_path, /templates\/AI-SPEC\.md$/);
});

test('AIP-2: agents.* declares the 4 AI-integration subagents', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.deepEqual(payload.agents, {
    framework_selector: 'np-framework-selector',
    ai_researcher: 'np-ai-researcher',
    domain_researcher: 'np-domain-researcher',
    eval_planner: 'np-eval-planner',
  });
});

test('AIP-3: has_ai_spec=true when {padded}-AI-SPEC.md exists', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {
    '09-AI-SPEC.md': '# AI Spec\n',
  });
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_ai_spec, true);
});

test('AIP-4: runtime field populated from lib/runtime detect()', () => {
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

test('AIP-5: missing phase arg exits with usage error', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _capture();
  let errBuf = '';
  const errStub = { write: (s) => { errBuf += s; return true; } };
  const code = subcmd.run([], { cwd: sandbox, stdout: cap.stub, stderr: errStub });
  assert.equal(code, 1);
  assert.match(errBuf, /Usage/);
});

test('AIP-6: phase not in roadmap produces NubosPilotError JSON on stderr', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _capture();
  let errBuf = '';
  const errStub = { write: (s) => { errBuf += s; return true; } };
  const code = subcmd.run(['99'], { cwd: sandbox, stdout: cap.stub, stderr: errStub });
  assert.equal(code, 1);
  const parsed = JSON.parse(errBuf.trim());
  assert.equal(parsed.code, 'ai-integration-phase-not-found');
});
