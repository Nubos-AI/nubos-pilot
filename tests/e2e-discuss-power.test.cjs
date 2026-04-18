const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedPhaseDir, cleanupAll } =
  require('./helpers/fixture.cjs');

const subcmd = require('../bin/np-tools/discuss-phase-power.cjs');

const TEMPLATE =
  '# Phase {{phase}} Context (padded={{padded}})\n\n' +
  '## Domain\n{{domain_text}}\n\n' +
  '## Decisions\n{{decisions_text}}\n\n' +
  '## Canonical References\n{{canonical_refs_text}}\n\n' +
  '## Code Context\n{{code_context_text}}\n\n' +
  '## Specifics\n{{specifics_text}}\n\n' +
  '## Deferred\n{{deferred_text}}\n';

function _seedTemplate(sandbox) {
  const dir = path.join(sandbox, '.nubos-pilot', 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CONTEXT.md'), TEMPLATE, 'utf-8');
}

function _capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

function _qpath(sandbox) {
  return path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );
}

function _ctxPath(sandbox) {
  return path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-CONTEXT.md'
  );
}

afterEach(cleanupAll);

test('E1: init on fresh phase dir creates QUESTIONS.json with expected schema', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);

  subcmd.run(['init', '5'], { cwd: sandbox, stdout: _capture().stub });

  const doc = JSON.parse(fs.readFileSync(_qpath(sandbox), 'utf-8'));
  assert.equal(doc.phase, 5);
  assert.equal(doc.padded, '05');
  assert.equal(doc.mode, 'power');
  assert.equal(doc.answers_status, 'pending');
  assert.ok(Array.isArray(doc.questions) && doc.questions.length >= 6);
  for (const q of doc.questions) {
    assert.ok(q.id && q.area && q.question);
    assert.equal(q.answer, null);
  }
});

test('E2: finalize with fully-answered fixture writes CONTEXT.md with answer substrings', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'discuss', 'power-questions-sample.json'),
    'utf-8'
  );
  fs.writeFileSync(_qpath(sandbox), fixture, 'utf-8');

  subcmd.run(['finalize', '5'], { cwd: sandbox, stdout: _capture().stub });

  const ctx = fs.readFileSync(_ctxPath(sandbox), 'utf-8');

  const expectedSubstrings = [
    'power-mode file-UI',
    'No HTML companion',
    'atomicWriteFileSync',
    'loadTemplate',
    'any editor',
    'deferred indefinitely',
  ];
  for (const s of expectedSubstrings) {
    assert.ok(ctx.includes(s), 'CONTEXT.md missing substring: ' + s);
  }
});

test('E3: finalize before answering throws power-finalize-incomplete with pending_ids', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: _capture().stub });

  assert.throws(
    () => subcmd.run(['finalize', '5'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err.name === 'NubosPilotError'
      && err.code === 'power-finalize-incomplete'
      && Array.isArray(err.details.pending_ids)
      && err.details.pending_ids.length > 0
      && err.details.pending_ids.every((id) => /^Q-\d+$/.test(id)),
  );
});

test('E4: after finalize, QUESTIONS.json answers_status is "finalized"', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'discuss', 'power-questions-sample.json'),
    'utf-8'
  );
  fs.writeFileSync(_qpath(sandbox), fixture, 'utf-8');

  subcmd.run(['finalize', '5'], { cwd: sandbox, stdout: _capture().stub });

  const doc = JSON.parse(fs.readFileSync(_qpath(sandbox), 'utf-8'));
  assert.equal(doc.answers_status, 'finalized');
});

test('E5: refresh on half-filled QUESTIONS.json emits stats with answered ≈ total/2', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: _capture().stub });

  const doc = JSON.parse(fs.readFileSync(_qpath(sandbox), 'utf-8'));
  const half = Math.floor(doc.questions.length / 2);
  for (let i = 0; i < half; i++) doc.questions[i].answer = 'filled';
  fs.writeFileSync(_qpath(sandbox), JSON.stringify(doc, null, 2), 'utf-8');

  const cap = _capture();
  subcmd.run(['refresh', '5'], { cwd: sandbox, stdout: cap.stub });
  const stats = JSON.parse(cap.get().trim());
  assert.equal(stats.total_questions, doc.questions.length);
  assert.equal(stats.answered, half);
  assert.equal(stats.pending, doc.questions.length - half);

  assert.ok(!fs.existsSync(_ctxPath(sandbox)));
});
