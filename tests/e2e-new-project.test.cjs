const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const newProject = require('../bin/np-tools/new-project.cjs');
const newMilestone = require('../bin/np-tools/new-milestone.cjs');

const _sandboxes = [];

function makeEmpty() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-e2e-newproj-'));
  _sandboxes.push(root);
  return root;
}

function _writeAnswers(root, name, answers) {
  const p = path.join(root, name + '.json');
  fs.writeFileSync(p, JSON.stringify(answers), 'utf-8');
  return p;
}

function _captureStdout() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

afterEach(() => {
  while (_sandboxes.length) {
    const p = _sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {  }
  }
});

test('E2E-NP-1: --apply happy path creates all 5 files + first phase dir', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'E2E Demo',
    core_value: 'Ship end-to-end proof.',
    primary_constraints: 'No deps; markdown-first',
    first_milestone_name: 'v1.0',
    first_phase_name: 'Kickoff Phase',
  });

  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });

  const expected = [
    '.nubos-pilot/PROJECT.md',
    '.nubos-pilot/REQUIREMENTS.md',
    '.nubos-pilot/roadmap.yaml',
    '.nubos-pilot/ROADMAP.md',
    '.nubos-pilot/STATE.md',
  ];
  for (const rel of expected) {
    assert.ok(fs.existsSync(path.join(sandbox, rel)), 'missing: ' + rel);
  }

  const phasesRoot = path.join(sandbox, '.nubos-pilot', 'phases');
  const entries = fs.readdirSync(phasesRoot);
  const phaseDir = entries.find((e) => e.startsWith('01-'));
  assert.ok(phaseDir, 'no 01-<slug>/ phase dir scaffolded');
  assert.ok(
    fs.existsSync(path.join(phasesRoot, phaseDir, '01-CONTEXT.md')),
    '01-CONTEXT.md missing',
  );
});

test('E2E-NP-2: PROJECT.md contains supplied project_name and core_value', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'My Specific Product',
    core_value: 'One sentence of truth about why this ships.',
    primary_constraints: 'c',
    first_milestone_name: 'v1.0',
    first_phase_name: 'First Phase',
  });
  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const raw = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  assert.ok(raw.includes('My Specific Product'), 'project_name not rendered');
  assert.ok(raw.includes('One sentence of truth about why this ships.'), 'core_value not rendered');
  assert.doesNotMatch(raw, /\{\{[a-z_]+\}\}/, 'unrendered placeholders remain');
});

test('E2E-NP-3: ROADMAP.md contains the first phase row', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'Demo',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'v1.0',
    first_phase_name: 'Kickoff Phase',
  });
  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const raw = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');

  

  assert.ok(raw.includes('kickoff-phase') || raw.includes('Kickoff Phase'),
    'ROADMAP.md missing first phase');
  assert.ok(raw.includes('01') || raw.includes('Phase 1') || raw.includes('phase 1'),
    'ROADMAP.md missing phase number');
});

test('E2E-NP-4: second invocation throws project-already-initialized', () => {
  const sandbox = makeEmpty();
  const a1 = _writeAnswers(sandbox, 'first', {
    project_name: 'X',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'v1.0',
    first_phase_name: 'First Phase',
  });
  newProject.run(['--apply', a1], { cwd: sandbox, stdout: _captureStdout().stub });

  const a2 = _writeAnswers(sandbox, 'second', {
    project_name: 'Different',
    core_value: 'w',
    primary_constraints: 'd',
    first_milestone_name: 'v1.0',
    first_phase_name: 'Phase Two',
  });
  let caught = null;
  try {
    newProject.run(['--apply', a2], { cwd: sandbox, stdout: _captureStdout().stub });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 're-init did not throw');
  assert.equal(caught.name, 'NubosPilotError');
  assert.equal(caught.code, 'project-already-initialized');
});

test('E2E-NP-5: new-milestone after new-project appends milestone + phase; PROJECT.md byte-equal', () => {
  const sandbox = makeEmpty();

  const initAnswers = _writeAnswers(sandbox, 'init', {
    project_name: 'Demo',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'v1.0',
    first_phase_name: 'First Phase',
  });
  newProject.run(['--apply', initAnswers], { cwd: sandbox, stdout: _captureStdout().stub });

  const projectMdPath = path.join(sandbox, '.nubos-pilot', 'PROJECT.md');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(projectMdPath)).digest('hex');

  const msAnswers = _writeAnswers(sandbox, 'ms', {
    milestone_name: 'v2.0',
    milestone_goal: 'second milestone goal',
    first_phase_name: 'Second Phase',
    create_req_prefix: false,
  });
  newMilestone.run(['--apply', msAnswers], { cwd: sandbox, stdout: _captureStdout().stub });

  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.milestones.length, 2);
  assert.equal(doc.milestones[1].id, 'v2-0');
  assert.equal(doc.milestones[1].phases.length, 1);

  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(projectMdPath)).digest('hex');
  assert.equal(afterHash, beforeHash, 'PROJECT.md was mutated by new-milestone — D-29 violation');
});

test('E2E-NP-6: STATE.md reflects current_phase=1 after new-project', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'Demo',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'v1.0',
    first_phase_name: 'First Phase',
  });
  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const { readState } = require('../lib/state.cjs');
  const st = readState(sandbox);
  assert.equal(st.frontmatter.current_phase, 1);
  assert.equal(st.frontmatter.milestone, 'v1-0');
});
