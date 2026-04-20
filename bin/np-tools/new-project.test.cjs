const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const subcmd = require('./new-project.cjs');

const _sandboxes = [];

function makeEmptySandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-newproj-'));
  _sandboxes.push(root);
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    const p = _sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

function _captureStdout() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

function _baseAnswers() {
  return {
    project_name: 'Demo Project',
    core_value: 'Ship demos fast.',
    primary_constraints: 'Node 22; markdown-first',
    first_milestone_name: 'Auth & Basic UI',
    first_milestone_goal: 'Ship login and basic profile page',
  };
}

function _writeAnswers(root, answers) {
  const p = path.join(root, 'answers.json');
  fs.writeFileSync(p, JSON.stringify(answers), 'utf-8');
  return p;
}

test('NP-1: run([]) emits interview JSON with project + milestone questions', () => {
  const sandbox = makeEmptySandbox();
  const cap = _captureStdout();
  subcmd.run([], { cwd: sandbox, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.mode, 'interview');
  assert.ok(Array.isArray(payload.questions));
  const keys = payload.questions.map((q) => q.key);
  for (const expected of [
    'project_name',
    'core_value',
    'primary_constraints',
    'first_milestone_name',
    'first_milestone_goal',
  ]) {
    assert.ok(keys.includes(expected), 'interview missing ' + expected);
  }
  for (const q of payload.questions) {
    assert.ok(typeof q.question === 'string' && q.question.length > 0);
    assert.ok(typeof q.type === 'string');
  }
});

test('NP-2: --apply creates nubos-pilot milestone directory with CONTEXT/ROADMAP/META', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  const cap = _captureStdout();
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: cap.stub });

  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'PROJECT.md')));
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'REQUIREMENTS.md')));
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml')));
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'STATE.md')));

  const mDir = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001');
  assert.ok(fs.existsSync(mDir), 'milestones/M001 missing');
  assert.ok(fs.existsSync(path.join(mDir, 'M001-CONTEXT.md')));
  assert.ok(fs.existsSync(path.join(mDir, 'M001-ROADMAP.md')));
  assert.ok(fs.existsSync(path.join(mDir, 'M001-META.json')));
  assert.ok(fs.existsSync(path.join(mDir, 'slices')));
});

test('NP-3: PROJECT.md is rendered with user-supplied values', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  const cap = _captureStdout();
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: cap.stub });
  const raw = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  assert.match(raw, /Demo Project/);
  assert.match(raw, /Ship demos fast\./);
  assert.match(raw, /Node 22/);
  assert.doesNotMatch(raw, /\{\{[a-z_]+\}\}/);
});

test('NP-4: second invocation throws project-already-initialized', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const diffAnswers = Object.assign({}, _baseAnswers(), { project_name: 'Other' });
  const diffPath = _writeAnswers(sandbox, diffAnswers);
  assert.throws(
    () => subcmd.run(['--apply', diffPath], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'project-already-initialized',
  );
});

test('NP-5: shell-metachar project_name is stored literally, no files outside .nubos-pilot', () => {
  const sandbox = makeEmptySandbox();
  const evil = Object.assign({}, _baseAnswers(), {
    project_name: '; rm -rf /tmp/definitely-not-there ; echo PWND',
  });
  const answersPath = _writeAnswers(sandbox, evil);
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const raw = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  assert.match(raw, /rm -rf/);
  const entries = fs.readdirSync(sandbox).sort();
  assert.deepEqual(entries, ['.nubos-pilot', 'answers.json']);
});

test('NP-6: roadmap.yaml contains milestone M001 with slices array', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const YAML = require('yaml');
  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.schema_version, 2);
  assert.equal(doc.milestones.length, 1);
  assert.equal(doc.milestones[0].id, 'M001');
  assert.equal(doc.milestones[0].number, 1);
  assert.equal(doc.milestones[0].name, 'Auth & Basic UI');
  assert.ok(Array.isArray(doc.milestones[0].slices));
  assert.equal(doc.milestones[0].slices.length, 0);
});

test('NP-7: missing first_milestone_goal/first_phase_name throws answers-missing-field', () => {
  const sandbox = makeEmptySandbox();
  const answers = Object.assign({}, _baseAnswers());
  delete answers.first_milestone_goal;
  const answersPath = _writeAnswers(sandbox, answers);
  assert.throws(
    () => subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'answers-missing-field',
  );
});

test('NP-8: STATE.md seeded with milestone=M001 + milestone_number=1', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const { readState } = require('../../lib/state.cjs');
  const st = readState(sandbox);
  assert.equal(st.frontmatter.milestone, 'M001');
  assert.equal(st.frontmatter.milestone_number, 1);
  assert.equal(st.frontmatter.current_slice, null);
  assert.equal(st.frontmatter.current_task, null);
});

test('NP-9: backwards compat — accepts legacy first_phase_name as goal fallback', () => {
  const sandbox = makeEmptySandbox();
  const answers = Object.assign({}, _baseAnswers());
  delete answers.first_milestone_goal;
  answers.first_phase_name = 'Legacy phase-name';
  const answersPath = _writeAnswers(sandbox, answers);
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const YAML = require('yaml');
  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.milestones[0].goal, 'Legacy phase-name');
});
