const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./discuss-phase.cjs');

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
            name: 'Observability',
            slug: 'observability',
            goal: 'Ship structured logging + metrics',
            depends_on: [],
            requirements: ['OBS-01'],
            success_criteria: ['Logs emit JSON'],
            status: 'planned',
            plans: [],
          },
          {
            number: 7,
            name: 'Seven',
            slug: 'seven',
            goal: 'Phase seven goal',
            depends_on: [],
            requirements: [],
            success_criteria: [],
            status: 'planned',
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

afterEach(cleanupAll);

test('DP-1: run(["3"]) on valid phase returns JSON payload with expected shape', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'observability', {});
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const raw = cap.get().trim();
  assert.ok(!raw.startsWith('@file:'));
  const payload = JSON.parse(raw);
  assert.equal(payload.phase_number, '3');
  assert.equal(payload.padded, '03');
  assert.ok(payload.phase_dir.endsWith('03-observability'));
  assert.equal(payload.phase_name, 'Observability');
  assert.equal(payload.has_context, false);
  assert.equal(payload.goal, 'Ship structured logging + metrics');
  assert.deepEqual(payload.requirements, ['OBS-01']);
  assert.ok('agent_skills' in payload);
  assert.equal(payload.mode, 'adaptive');
});

test('DP-2: run(["nonexistent"]) throws discuss-invalid-phase-arg', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  assert.throws(
    () => subcmd.run(['nonexistent'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'discuss-invalid-phase-arg',
  );
});

test('DP-3: run(["99"]) where phase not in roadmap throws discuss-phase-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  assert.throws(
    () => subcmd.run(['99'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'discuss-phase-not-found',
  );
});

test('DP-4: existing CONTEXT.md flips has_context=true', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'observability', {
    '03-CONTEXT.md': '# existing context\n',
  });
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_context, true);
});

test('DP-5: --assumptions flag sets mode=assumptions', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'observability', {});
  const cap = _captureStdout();
  subcmd.run(['3', '--assumptions'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.mode, 'assumptions');
});

test('DP-6: decimal phase number 7.1 accepted; 7.1 not in roadmap falls through to phase-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();

  
  assert.throws(
    () => subcmd.run(['7.1'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'discuss-phase-not-found',
  );
});

test('DP-7: oversized payload emits @file:<tmp> pointer', () => {
  const sandbox = makeSandbox();
  const big = _baseRoadmap();

  const filler = [];
  for (let i = 0; i < 1200; i++) {
    filler.push('REQ-' + i + '-with-additional-padding-to-grow-bytes-effectively');
  }
  big.milestones[0].phases[0].requirements = filler;
  seedRoadmapYaml(sandbox, big);
  seedPhaseDir(sandbox, 3, 'observability', {});
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const out = cap.get().trim();
  assert.ok(out.startsWith('@file:'), 'large payload produced @file: pointer');
  const tmpPath = out.slice('@file:'.length);
  const body = fs.readFileSync(tmpPath, 'utf-8');
  const payload = JSON.parse(body);
  assert.equal(payload.phase_number, '3');
  fs.unlinkSync(tmpPath);
});
