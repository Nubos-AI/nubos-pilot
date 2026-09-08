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

test('E2E-NP-1: --apply happy path creates PROJECT + REQUIREMENTS + roadmap.yaml + STATE + nubos-pilot milestone dir', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'E2E Demo',
    core_value: 'Ship end-to-end proof.',
    primary_constraints: 'No deps; markdown-first',
    first_milestone_name: 'Kickoff Milestone',
    first_milestone_goal: 'Ship the kickoff prototype',
  });

  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });

  const expected = [
    '.nubos-pilot/PROJECT.md',
    '.nubos-pilot/REQUIREMENTS.md',
    '.nubos-pilot/roadmap.yaml',
    '.nubos-pilot/STATE.md',
  ];
  for (const rel of expected) {
    assert.ok(fs.existsSync(path.join(sandbox, rel)), 'missing: ' + rel);
  }

  const mDir = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001');
  assert.ok(fs.existsSync(mDir), 'milestones/M001 missing');
  assert.ok(fs.existsSync(path.join(mDir, 'M001-CONTEXT.md')));
  assert.ok(fs.existsSync(path.join(mDir, 'M001-ROADMAP.md')));
  assert.ok(fs.existsSync(path.join(mDir, 'M001-META.json')));
  assert.ok(fs.existsSync(path.join(mDir, 'slices')));
});

test('E2E-NP-2: PROJECT.md contains supplied project_name and core_value', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'My Specific Product',
    core_value: 'One sentence of truth about why this ships.',
    primary_constraints: 'c',
    first_milestone_name: 'First Milestone',
    first_milestone_goal: 'g',
  });
  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const raw = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  assert.ok(raw.includes('My Specific Product'), 'project_name not rendered');
  assert.ok(raw.includes('One sentence of truth about why this ships.'), 'core_value not rendered');
  assert.doesNotMatch(raw, /\{\{[a-z_]+\}\}/, 'unrendered placeholders remain');
});

test('E2E-NP-3: roadmap.yaml records the first milestone with slices: []', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'Demo',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'Kickoff Milestone',
    first_milestone_goal: 'Ship kickoff',
  });
  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.schema_version, 2);
  assert.equal(doc.milestones.length, 1);
  assert.equal(doc.milestones[0].id, 'M001');
  assert.equal(doc.milestones[0].name, 'Kickoff Milestone');
  assert.ok(Array.isArray(doc.milestones[0].slices));
  assert.equal(doc.milestones[0].slices.length, 0);
});

test('E2E-NP-4: second invocation throws project-already-initialized', () => {
  const sandbox = makeEmpty();
  const a1 = _writeAnswers(sandbox, 'first', {
    project_name: 'X',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'First',
    first_milestone_goal: 'g',
  });
  newProject.run(['--apply', a1], { cwd: sandbox, stdout: _captureStdout().stub });

  const a2 = _writeAnswers(sandbox, 'second', {
    project_name: 'Different',
    core_value: 'w',
    primary_constraints: 'd',
    first_milestone_name: 'Second',
    first_milestone_goal: 'g2',
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

test('E2E-NP-5: new-milestone after new-project appends nubos-pilot milestone dir; PROJECT.md byte-equal', () => {
  const sandbox = makeEmpty();

  const initAnswers = _writeAnswers(sandbox, 'init', {
    project_name: 'Demo',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'First Milestone',
    first_milestone_goal: 'g',
  });
  newProject.run(['--apply', initAnswers], { cwd: sandbox, stdout: _captureStdout().stub });

  const projectMdPath = path.join(sandbox, '.nubos-pilot', 'PROJECT.md');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(projectMdPath)).digest('hex');

  const msAnswers = _writeAnswers(sandbox, 'ms', {
    milestone_name: 'Second Milestone',
    milestone_goal: 'second milestone goal',
    create_req_prefix: false,
  });
  newMilestone.run(['--apply', msAnswers], { cwd: sandbox, stdout: _captureStdout().stub });

  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  const added = doc.milestones.find((m) => m && m.name === 'Second Milestone');
  assert.ok(added, 'Second Milestone not found in roadmap');
  assert.ok(Array.isArray(added.slices));
  const mDir = path.join(sandbox, '.nubos-pilot', 'milestones', added.id);
  assert.ok(fs.existsSync(path.join(mDir, added.id + '-CONTEXT.md')));
  assert.ok(fs.existsSync(path.join(mDir, added.id + '-ROADMAP.md')));
  assert.ok(fs.existsSync(path.join(mDir, added.id + '-META.json')));

  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(projectMdPath)).digest('hex');
  assert.equal(afterHash, beforeHash, 'PROJECT.md was mutated by new-milestone — D-29 violation');
});

test('E2E-NP-6: STATE.md reflects milestone=M001 and milestone_number=1 after new-project', () => {
  const sandbox = makeEmpty();
  const answersPath = _writeAnswers(sandbox, 'answers', {
    project_name: 'Demo',
    core_value: 'v',
    primary_constraints: 'c',
    first_milestone_name: 'First Milestone',
    first_milestone_goal: 'g',
  });
  newProject.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const { readState } = require('../lib/state.cjs');
  const st = readState(sandbox);
  assert.equal(st.frontmatter.milestone, 'M001');
  assert.equal(st.frontmatter.milestone_number, 1);
});
