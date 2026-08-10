const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./discuss-phase.cjs');

function _clearClaudeEnv() {
  const saved = {};
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'M003',
        number: 3,
        name: 'Observability',
        goal: 'Ship structured logging + metrics',
        requirements: ['OBS-01'],
        success_criteria: ['Logs emit JSON'],
        status: 'pending',
        slices: [],
      },
      {
        id: 'M007',
        number: 7,
        name: 'Seven',
        goal: 'Milestone seven goal',
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

afterEach(cleanupAll);

test('DP-1: run(["3"]) on valid milestone returns JSON payload with expected shape', () => {
  const restore = _clearClaudeEnv();
  try {
    const sandbox = makeSandbox();
    seedRoadmapYaml(sandbox, _baseRoadmap());
    const cap = _captureStdout();
    subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
    const raw = cap.get().trim();
    assert.ok(!raw.startsWith('@file:'));
    const payload = JSON.parse(raw);
    assert.equal(payload.milestone, 3);
    assert.equal(payload.milestone_id, 'M003');
    assert.ok(payload.milestone_dir.endsWith(path.join('.nubos-pilot', 'milestones', 'M003')));
    assert.ok(payload.milestone_context_path.endsWith(path.join('M003', 'M003-CONTEXT.md')));
    assert.equal(payload.milestone_name, 'Observability');
    assert.equal(payload.has_context, false);
    assert.equal(payload.has_milestone_dir, false);
    assert.equal(payload.goal, 'Ship structured logging + metrics');
    assert.deepEqual(payload.requirements, ['OBS-01']);
    assert.ok('agent_skills' in payload);
    assert.equal(payload.mode, 'adaptive');
    assert.equal(payload.text_mode, false);
    assert.equal(payload.text_mode_source, 'default');
  } finally {
    restore();
  }
});

test('DP-1b: CLAUDECODE=1 no longer flips text_mode (Claude Code uses AskUserQuestion)', () => {
  const restore = _clearClaudeEnv();
  try {
    process.env.CLAUDECODE = '1';
    const sandbox = makeSandbox();
    seedRoadmapYaml(sandbox, _baseRoadmap());
    const cap = _captureStdout();
    subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
    const payload = JSON.parse(cap.get().trim());
    assert.equal(payload.text_mode, false);
    assert.equal(payload.text_mode_source, 'default');
  } finally {
    restore();
  }
});

test('DP-1c: config workflow.text_mode=false wins over CLAUDECODE', () => {
  const restore = _clearClaudeEnv();
  try {
    process.env.CLAUDECODE = '1';
    const sandbox = makeSandbox();
    seedRoadmapYaml(sandbox, _baseRoadmap());
    fs.writeFileSync(
      path.join(sandbox, '.nubos-pilot', 'config.json'),
      JSON.stringify({ workflow: { text_mode: false } }),
    );
    const cap = _captureStdout();
    subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
    const payload = JSON.parse(cap.get().trim());
    assert.equal(payload.text_mode, false);
    assert.equal(payload.text_mode_source, 'config');
  } finally {
    restore();
  }
});

test('DP-2: run(["nonexistent"]) throws discuss-invalid-phase-arg', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  assert.throws(
    () => subcmd.run(['nonexistent'], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'discuss-invalid-phase-arg',
  );
});

test('DP-3: run(["99"]) where milestone not in roadmap throws discuss-phase-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  assert.throws(
    () => subcmd.run(['99'], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'discuss-phase-not-found',
  );
});

test('DP-4: existing M<NNN>-CONTEXT.md flips has_context=true', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const mDir = path.join(sandbox, '.nubos-pilot', 'milestones', 'M003');
  fs.mkdirSync(mDir, { recursive: true });
  fs.writeFileSync(path.join(mDir, 'M003-CONTEXT.md'), '# existing context\n');
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_context, true);
  assert.equal(payload.has_milestone_dir, true);
});

test('DP-5: --assumptions flag sets mode=assumptions', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _captureStdout();
  subcmd.run(['3', '--assumptions'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.mode, 'assumptions');
});

test('DP-6: decimal milestone numbers rejected (milestones are integers)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  assert.throws(
    () => subcmd.run(['7.1'], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'discuss-invalid-phase-arg',
  );
});

test('DP-7: oversized payload emits @file:<tmp> pointer', () => {
  const sandbox = makeSandbox();
  const big = _baseRoadmap();
  const filler = [];
  for (let i = 0; i < 1200; i++) {
    filler.push('REQ-' + i + '-with-additional-padding-to-grow-bytes-effectively');
  }
  big.milestones[0].requirements = filler;
  seedRoadmapYaml(sandbox, big);
  const cap = _captureStdout();
  subcmd.run(['3'], { cwd: sandbox, stdout: cap.stub });
  const out = cap.get().trim();
  assert.ok(out.startsWith('@file:'), 'large payload produced @file: pointer');
  const tmpPath = out.slice('@file:'.length);
  const body = fs.readFileSync(tmpPath, 'utf-8');
  const payload = JSON.parse(body);
  assert.equal(payload.milestone, 3);
  fs.unlinkSync(tmpPath);
});
