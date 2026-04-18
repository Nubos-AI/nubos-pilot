const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./research-phase.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'first',
        phases: [
          {
            number: 3,
            name: 'Three',
            slug: 'three',
            goal: 'Goal of phase 3',
            depends_on: [],
            requirements: ['R-1', 'R-2'],
            success_criteria: ['SC-1'],
            status: 'pending',
            plans: [],
          },
          {
            number: 5,
            name: 'Five',
            slug: 'five-planning',
            goal: 'Goal of phase 5',
            depends_on: [4],
            requirements: ['PLAN-03'],
            success_criteria: [],
            status: 'pending',
            plans: [],
          },
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

function _clearEnv() {
  delete process.env.NP_TOOLS_WEBFETCH;
  delete process.env.NP_TOOLS_CONTEXT7;
}

afterEach(() => {
  _clearEnv();
  cleanupAll();
});

test('RP-1: run(["3"]) on phase 3 returns payload with all required keys', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'three', {});
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.phase, 3);
  assert.equal(payload.padded, '03');
  assert.ok(payload.phase_dir.endsWith(path.join('phases', '03-three')));
  assert.equal(payload.goal, 'Goal of phase 3');
  assert.deepEqual(payload.requirements, ['R-1', 'R-2']);
  assert.equal(payload.has_research, false);
  assert.equal(typeof payload.tools_available, 'object');
  assert.equal(typeof payload.tools_available.WebFetch, 'boolean');
  assert.equal(typeof payload.tools_available.Context7, 'boolean');
  assert.ok('agent_skills' in payload);
});

test('RP-2: has_research=true iff {phase_dir}/{padded}-RESEARCH.md exists', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'three', { '03-RESEARCH.md': '# Research stub\n' });
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_research, true);
});

test('RP-3: tools_available defaults to {false,false} when env vars absent', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 5, 'five-planning', {});
  _clearEnv();
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, false);
  assert.equal(payload.tools_available.Context7, false);
});

test('RP-4: NP_TOOLS_WEBFETCH=1 and NP_TOOLS_CONTEXT7=1 flip both booleans', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 5, 'five-planning', {});
  process.env.NP_TOOLS_WEBFETCH = '1';
  process.env.NP_TOOLS_CONTEXT7 = '1';
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, true);
  assert.equal(payload.tools_available.Context7, true);
});

test('RP-5: missing phase number throws research-phase-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  assert.throws(
    () => subcmd.run(['99'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'research-phase-not-found',
  );
});

test('RP-6: non-integer arg throws research-invalid-phase-arg', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  assert.throws(
    () => subcmd.run(['bad'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'research-invalid-phase-arg',
  );
});

test('RP-7: oversized payload emits @file: pointer', () => {
  const sandbox = makeSandbox();

  const big = _baseRoadmap();
  const huge = Array.from({ length: 2000 }, (_, i) => 'REQ-' + i + '-very-long-requirement-identifier-padded');
  big.milestones[0].phases[0].requirements = huge;
  seedRoadmapYaml(sandbox, big);
  seedPhaseDir(sandbox, 3, 'three', {});
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const out = cap.get().trim();
  assert.ok(out.startsWith('@file:'), 'large payload produced @file: pointer');
  const tmpPath = out.slice('@file:'.length);
  const body = fs.readFileSync(tmpPath, 'utf-8');
  const payload = JSON.parse(body);
  assert.equal(payload.phase, 3);
  assert.ok(payload.requirements.length >= 2000);
  fs.unlinkSync(tmpPath);
});
