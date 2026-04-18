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
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {  }
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
    first_milestone_name: 'v1.0',
    first_phase_name: 'Foundation Phase',
  };
}

function _writeAnswers(root, answers) {
  const p = path.join(root, 'answers.json');
  fs.writeFileSync(p, JSON.stringify(answers), 'utf-8');
  return p;
}

test('NP-1: run([]) emits interview JSON with all 5 questions', () => {
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
    'first_phase_name',
  ]) {
    assert.ok(keys.includes(expected), 'interview missing ' + expected);
  }
  for (const q of payload.questions) {
    assert.ok(typeof q.question === 'string' && q.question.length > 0);
    assert.ok(typeof q.type === 'string');
  }
});

test('NP-2: --apply creates all 5 files + scaffolds first phase dir', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  const cap = _captureStdout();
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: cap.stub });

  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'PROJECT.md')), 'PROJECT.md missing');
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'REQUIREMENTS.md')), 'REQUIREMENTS.md missing');
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml')), 'roadmap.yaml missing');
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'ROADMAP.md')), 'ROADMAP.md missing');
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'STATE.md')), 'STATE.md missing');

  const phasesRoot = path.join(sandbox, '.nubos-pilot', 'phases');
  const entries = fs.readdirSync(phasesRoot);
  const phaseDir = entries.find((e) => e.startsWith('01-'));
  assert.ok(phaseDir, 'phases/01-<slug>/ not scaffolded');
  assert.ok(
    fs.existsSync(path.join(phasesRoot, phaseDir, '01-CONTEXT.md')),
    '01-CONTEXT.md placeholder missing',
  );
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

test('NP-6: slugifies first_phase_name; strips non [a-z0-9-]', () => {
  const sandbox = makeEmptySandbox();
  const answers = Object.assign({}, _baseAnswers(), {
    first_phase_name: 'Foo Bar! 2',
  });
  const answersPath = _writeAnswers(sandbox, answers);
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const phasesRoot = path.join(sandbox, '.nubos-pilot', 'phases');
  const entries = fs.readdirSync(phasesRoot);
  const phaseDir = entries.find((e) => e.startsWith('01-'));
  assert.equal(phaseDir, '01-foo-bar-2');
});

test('NP-7: empty-after-slugify first_phase_name throws invalid-slug', () => {
  const sandbox = makeEmptySandbox();
  const answers = Object.assign({}, _baseAnswers(), {
    first_phase_name: '!!!@@@###',
  });
  const answersPath = _writeAnswers(sandbox, answers);
  assert.throws(
    () => subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'invalid-slug',
  );
});

test('NP-8: STATE.md seeded with milestone + current_phase:1 + status', () => {
  const sandbox = makeEmptySandbox();
  const answersPath = _writeAnswers(sandbox, _baseAnswers());
  subcmd.run(['--apply', answersPath], { cwd: sandbox, stdout: _captureStdout().stub });
  const { readState } = require('../../lib/state.cjs');
  const st = readState(sandbox);
  assert.ok(st.frontmatter.milestone, 'STATE.md missing milestone');
  assert.equal(st.frontmatter.current_phase, 1);
  assert.equal(st.frontmatter.current_plan, null);
});
