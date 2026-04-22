const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./research-phase.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'M003',
        number: 3,
        name: 'Three',
        goal: 'Goal of milestone 3',
        requirements: ['R-1', 'R-2'],
        success_criteria: ['SC-1'],
        status: 'pending',
        slices: [],
      },
      {
        id: 'M005',
        number: 5,
        name: 'Five',
        goal: 'Goal of milestone 5',
        requirements: ['PLAN-03'],
        status: 'pending',
        slices: [],
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

test('RP-1: run(["3"]) on milestone 3 returns payload with all required keys', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.milestone, 3);
  assert.equal(payload.milestone_id, 'M003');
  assert.ok(payload.milestone_dir.endsWith(path.join('milestones', 'M003')));
  assert.ok(payload.milestone_research_path.endsWith(path.join('M003', 'M003-RESEARCH.md')));
  assert.equal(payload.goal, 'Goal of milestone 3');
  assert.deepEqual(payload.requirements, ['R-1', 'R-2']);
  assert.equal(payload.has_research, false);
  assert.equal(typeof payload.tools_available, 'object');
  assert.equal(typeof payload.tools_available.WebFetch, 'boolean');
  assert.equal(typeof payload.tools_available.Context7, 'boolean');
  assert.ok('agent_skills' in payload);
  assert.ok(Array.isArray(payload.slice_research));
});

test('RP-2: has_research=true iff {milestone_dir}/{milestone_id}-RESEARCH.md exists', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const mDir = path.join(sandbox, '.nubos-pilot', 'milestones', 'M003');
  fs.mkdirSync(mDir, { recursive: true });
  fs.writeFileSync(path.join(mDir, 'M003-RESEARCH.md'), '# Research stub\n');
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_research, true);
});

test('RP-3: tools_available defaults to {true,true} when env vars + config absent (optimistic default)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  _clearEnv();
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, true);
  assert.equal(payload.tools_available.Context7, true);
});

test('RP-4: NP_TOOLS_WEBFETCH=1 and NP_TOOLS_CONTEXT7=1 keep both true', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  process.env.NP_TOOLS_WEBFETCH = '1';
  process.env.NP_TOOLS_CONTEXT7 = '1';
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, true);
  assert.equal(payload.tools_available.Context7, true);
});

test('RP-4b: NP_TOOLS_WEBFETCH=0 and NP_TOOLS_CONTEXT7=0 flip both booleans to false', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  process.env.NP_TOOLS_WEBFETCH = '0';
  process.env.NP_TOOLS_CONTEXT7 = '0';
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, false);
  assert.equal(payload.tools_available.Context7, false);
});

test('RP-4c: config.workflow.research_tools overrides default when env absent', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const configPath = path.join(sandbox, '.nubos-pilot', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workflow: { research_tools: { WebFetch: false, Context7: true } },
  }));
  _clearEnv();
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, false);
  assert.equal(payload.tools_available.Context7, true);
});

test('RP-4d: env var wins over config (env=1 overrides config=false)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const configPath = path.join(sandbox, '.nubos-pilot', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    workflow: { research_tools: { WebFetch: false, Context7: false } },
  }));
  process.env.NP_TOOLS_WEBFETCH = '1';
  const cap = _captureStdout();
  subcmd.run(['5'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.tools_available.WebFetch, true);
  assert.equal(payload.tools_available.Context7, false);
});

test('RP-4e: _resolveToolFlag: "true"/"false" strings handled', () => {
  assert.equal(subcmd._resolveToolFlag('true', false, false), true);
  assert.equal(subcmd._resolveToolFlag('false', true, true), false);
  assert.equal(subcmd._resolveToolFlag(undefined, undefined, true), true);
  assert.equal(subcmd._resolveToolFlag(undefined, false, true), false);
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
  big.milestones[0].requirements = huge;
  seedRoadmapYaml(sandbox, big);
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const out = cap.get().trim();
  assert.ok(out.startsWith('@file:'), 'large payload produced @file: pointer');
  const tmpPath = out.slice('@file:'.length);
  const body = fs.readFileSync(tmpPath, 'utf-8');
  const payload = JSON.parse(body);
  assert.equal(payload.milestone, 3);
  assert.ok(payload.requirements.length >= 2000);
  fs.unlinkSync(tmpPath);
});
