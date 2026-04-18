const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./ui-phase.cjs');

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
            requirements: ['R-02'],
            success_criteria: ['UI-SPEC produced'],
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

test('UIP-1: run(["init", "9"]) returns expected payload shape', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const dir = seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.phase, '9');
  assert.equal(payload.padded, '09');
  assert.equal(payload.phase_dir, dir);
  assert.equal(payload.ui_spec_path, path.join(dir, '09-UI-SPEC.md'));
  assert.equal(payload.has_ui_spec, false);
  assert.match(payload.template_path, /templates\/UI-SPEC\.md$/);
  assert.equal(payload.max_iterations, 2);
});

test('UIP-2: agents declares ui_researcher + ui_checker', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.deepEqual(payload.agents, {
    ui_researcher: 'np-ui-researcher',
    ui_checker: 'np-ui-checker',
  });
});

test('UIP-3: has_ui_spec=true when {padded}-UI-SPEC.md exists', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', { '09-UI-SPEC.md': '# UI\n' });
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.has_ui_spec, true);
});

test('UIP-4: runtime populated via detect() and config override', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 9, 'feature-set', {});
  fs.writeFileSync(
    path.join(sandbox, '.nubos-pilot', 'config.json'),
    JSON.stringify({ runtime: 'opencode' }),
    'utf-8',
  );
  const cap = _capture();
  subcmd.run(['9'], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.runtime, 'opencode');
});

test('UIP-5: missing phase arg returns usage error', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const cap = _capture();
  let errBuf = '';
  const code = subcmd.run([], {
    cwd: sandbox, stdout: cap.stub,
    stderr: { write: (s) => { errBuf += s; return true; } },
  });
  assert.equal(code, 1);
  assert.match(errBuf, /Usage/);
});

test('UIP-6: unknown phase produces ui-phase-not-found error', () => {
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
  assert.equal(parsed.code, 'ui-phase-not-found');
});
