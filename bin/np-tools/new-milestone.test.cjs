const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const newProject = require('./new-project.cjs');
const subcmd = require('./new-milestone.cjs');

const _sandboxes = [];

function makeEmptySandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-newms-'));
  _sandboxes.push(root);
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    const p = _sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {  }
  }
});

function _captureStdout() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

function _seedInitializedProject(root) {
  const answers = {
    project_name: 'Demo',
    core_value: 'ship',
    primary_constraints: 'nodejs',
    first_milestone_name: 'v1.0',
    first_phase_name: 'First Phase',
  };
  const p = path.join(root, 'init-answers.json');
  fs.writeFileSync(p, JSON.stringify(answers), 'utf-8');
  newProject.run(['--apply', p], { cwd: root, stdout: _captureStdout().stub });
  fs.unlinkSync(p);
}

function _writeAnswers(root, answers, name) {
  const p = path.join(root, (name || 'ms-answers') + '.json');
  fs.writeFileSync(p, JSON.stringify(answers), 'utf-8');
  return p;
}

function _baseMsAnswers() {
  return {
    milestone_name: 'v2.0',
    milestone_goal: 'second milestone',
    first_phase_name: 'Second Phase',
    create_req_prefix: false,
  };
}

test('NM-1: run([]) emits interview JSON with 4 questions', () => {
  const sandbox = makeEmptySandbox();
  const cap = _captureStdout();
  subcmd.run([], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.mode, 'interview');
  const keys = payload.questions.map((q) => q.key);
  for (const expected of [
    'milestone_name',
    'milestone_goal',
    'first_phase_name',
    'create_req_prefix',
  ]) {
    assert.ok(keys.includes(expected), 'interview missing ' + expected);
  }
});

test('NM-2: --apply without PROJECT.md throws project-not-initialized', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseMsAnswers());
  assert.throws(
    () => subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'project-not-initialized',
  );
});

test('NM-3: --apply on initialized project appends milestone + phase', () => {
  const sandbox = makeEmptySandbox();
  _seedInitializedProject(sandbox);
  const answersPath = _writeAnswers(sandbox, _baseMsAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const YAML = require('yaml');
  const rm = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(rm.milestones.length, 2, 'roadmap.yaml should have 2 milestones');
  assert.equal(rm.milestones[1].id, 'v2-0'); 
  assert.equal(rm.milestones[1].phases.length, 1);
});

test('NM-4: --apply does NOT touch PROJECT.md (byte-equal before/after) — D-29', () => {
  const sandbox = makeEmptySandbox();
  _seedInitializedProject(sandbox);
  const projectMdPath = path.join(sandbox, '.nubos-pilot', 'PROJECT.md');
  const beforeBytes = fs.readFileSync(projectMdPath);
  const beforeHash = crypto.createHash('sha256').update(beforeBytes).digest('hex');

  const answersPath = _writeAnswers(sandbox, _baseMsAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });

  const afterBytes = fs.readFileSync(projectMdPath);
  const afterHash = crypto.createHash('sha256').update(afterBytes).digest('hex');
  assert.equal(afterHash, beforeHash, 'PROJECT.md bytes changed — D-29 violation');
});

test('NM-5: duplicate milestone_name throws roadmap-duplicate-milestone', () => {
  const sandbox = makeEmptySandbox();
  _seedInitializedProject(sandbox);

  
  const answers = Object.assign({}, _baseMsAnswers(), { milestone_name: 'v1.0' });
  const answersPath = _writeAnswers(sandbox, answers);
  assert.throws(
    () => subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-duplicate-milestone',
  );
});

test('NM-6: create_req_prefix=true appends H2 section to REQUIREMENTS.md', () => {
  const sandbox = makeEmptySandbox();
  _seedInitializedProject(sandbox);
  const reqPath = path.join(sandbox, '.nubos-pilot', 'REQUIREMENTS.md');
  const before = fs.readFileSync(reqPath, 'utf-8');
  assert.doesNotMatch(before, /## v2\.0 Requirements/);

  const answers = Object.assign({}, _baseMsAnswers(), { create_req_prefix: true });
  const answersPath = _writeAnswers(sandbox, answers);
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });

  const after = fs.readFileSync(reqPath, 'utf-8');
  assert.match(after, /## v2\.0 Requirements/);
});

test('NM-7: create_req_prefix=false leaves REQUIREMENTS.md byte-equal', () => {
  const sandbox = makeEmptySandbox();
  _seedInitializedProject(sandbox);
  const reqPath = path.join(sandbox, '.nubos-pilot', 'REQUIREMENTS.md');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(reqPath)).digest('hex');

  const answersPath = _writeAnswers(sandbox, _baseMsAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });

  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(reqPath)).digest('hex');
  assert.equal(afterHash, beforeHash);
});

test('NM-8: STATE.md milestone pointer advances to new milestone id', () => {
  const sandbox = makeEmptySandbox();
  _seedInitializedProject(sandbox);
  const answersPath = _writeAnswers(sandbox, _baseMsAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const { readState } = require('../../lib/state.cjs');
  const st = readState(sandbox);
  assert.equal(st.frontmatter.milestone, 'v2-0');

  assert.equal(typeof st.frontmatter.current_phase, 'number');
  assert.ok(st.frontmatter.current_phase >= 1);
});
