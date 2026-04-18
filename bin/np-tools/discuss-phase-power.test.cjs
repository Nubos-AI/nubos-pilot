const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');

const subcmd = require('./discuss-phase-power.cjs');

const SAMPLE_TEMPLATE =
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
  fs.writeFileSync(path.join(dir, 'CONTEXT.md'), SAMPLE_TEMPLATE, 'utf-8');
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

afterEach(cleanupAll);

test('P1: init without prior QUESTIONS.json creates file with schema', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const cap = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub });
  const qpath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );
  assert.ok(fs.existsSync(qpath), 'QUESTIONS.json created');
  const doc = JSON.parse(fs.readFileSync(qpath, 'utf-8'));
  assert.equal(doc.phase, 5);
  assert.equal(doc.padded, '05');
  assert.equal(doc.mode, 'power');
  assert.equal(typeof doc.created, 'string');
  assert.ok(Array.isArray(doc.questions));
  assert.equal(doc.answers_status, 'pending');

  const areas = new Set(doc.questions.map((q) => q.area));
  for (const a of ['domain', 'decisions', 'canonical_refs', 'code_context', 'specifics', 'deferred']) {
    assert.ok(areas.has(a), 'area covered: ' + a);
  }
});

test('P2: init when QUESTIONS.json already exists throws power-questions-exist', () => {
  const sandbox = makeSandbox();
  const phaseDir = seedPhaseDir(sandbox, 5, 'planning-workflows-agents', {
    '05-QUESTIONS.json': '{}',
  });
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err.name === 'NubosPilotError' && err.code === 'power-questions-exist'
      && err.details && err.details.path && err.details.path.includes(phaseDir),
  );
});

test('P3: refresh emits stats JSON with totals per area', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const cap0 = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap0.stub });
  const qpath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );

  const doc = JSON.parse(fs.readFileSync(qpath, 'utf-8'));
  const dq = doc.questions.find((q) => q.area === 'domain');
  dq.answer = 'scoped';
  fs.writeFileSync(qpath, JSON.stringify(doc, null, 2), 'utf-8');

  const cap = _capture();
  subcmd.run(['refresh', '5'], { cwd: sandbox, stdout: cap.stub });
  const stats = JSON.parse(cap.get().trim());
  assert.equal(typeof stats.total_questions, 'number');
  assert.ok(stats.answered >= 1);
  assert.ok(stats.pending >= 0);
  assert.ok(stats.areas && typeof stats.areas === 'object');
  assert.ok(stats.areas.domain && typeof stats.areas.domain.total === 'number');
  assert.ok(typeof stats.areas.domain.answered === 'number');

  const ctxPath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-CONTEXT.md'
  );
  assert.ok(!fs.existsSync(ctxPath), 'refresh does not touch CONTEXT.md');
});

test('P4: finalize with all answers renders CONTEXT.md and marks finalized', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);

  const qpath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );
  const fixture = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tests', 'fixtures', 'discuss', 'power-questions-sample.json'),
    'utf-8'
  );
  fs.writeFileSync(qpath, fixture, 'utf-8');

  const cap = _capture();
  subcmd.run(['finalize', '5'], { cwd: sandbox, stdout: cap.stub });

  const ctxPath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-CONTEXT.md'
  );
  assert.ok(fs.existsSync(ctxPath), 'CONTEXT.md rendered');
  const ctx = fs.readFileSync(ctxPath, 'utf-8');
  assert.ok(ctx.includes('Phase 5'), 'phase header present');
  assert.ok(ctx.includes('power-mode file-UI'), 'domain answer substring');
  assert.ok(ctx.includes('No HTML companion'), 'decisions answer substring');

  const doc = JSON.parse(fs.readFileSync(qpath, 'utf-8'));
  assert.equal(doc.answers_status, 'finalized');
});

test('P5: finalize with pending answers throws power-finalize-incomplete', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const cap0 = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap0.stub });
  assert.throws(
    () => subcmd.run(['finalize', '5'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err.name === 'NubosPilotError'
      && err.code === 'power-finalize-incomplete'
      && err.details && Array.isArray(err.details.pending_ids)
      && err.details.pending_ids.length > 0,
  );
});

test('P6: explain returns question object with explain field populated', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const cap0 = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap0.stub });

  const cap = _capture();
  subcmd.run(['explain', '5', 'Q-01'], { cwd: sandbox, stdout: cap.stub });
  const body = JSON.parse(cap.get().trim());
  assert.equal(body.id, 'Q-01');
  assert.ok(typeof body.explain === 'string' && body.explain.length > 0);
});

test('P7: exit emits status JSON; does NOT delete QUESTIONS.json', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const cap0 = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap0.stub });
  const qpath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );

  const cap = _capture();
  subcmd.run(['exit', '5'], { cwd: sandbox, stdout: cap.stub });
  const body = JSON.parse(cap.get().trim());
  assert.equal(body.status, 'exited');
  assert.ok(fs.existsSync(qpath), 'QUESTIONS.json preserved after exit');
});

test('P8: HTML-ban regression — no HTML markers in source file', () => {
  const src = fs.readFileSync(path.join(__dirname, 'discuss-phase-power.cjs'), 'utf-8');
  const banned = [/<html/, /<!DOCTYPE/i, /showOpenFilePicker/, /FileSystemFileHandle/, /document\./];
  for (const re of banned) {
    assert.ok(!re.test(src), 'banned HTML marker found: ' + re);
  }
});

test('P9: writes use atomicWriteFileSync', () => {
  const src = fs.readFileSync(path.join(__dirname, 'discuss-phase-power.cjs'), 'utf-8');
  const occurrences = (src.match(/atomicWriteFileSync/g) || []).length;
  assert.ok(occurrences >= 2, 'atomicWriteFileSync used in ≥2 places, got ' + occurrences);
});

test('P10: concurrent refresh+finalize does not corrupt QUESTIONS.json', async () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);

  const qpath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );
  const fixture = fs.readFileSync(
    path.join(__dirname, '..', '..', 'tests', 'fixtures', 'discuss', 'power-questions-sample.json'),
    'utf-8'
  );
  fs.writeFileSync(qpath, fixture, 'utf-8');

  const results = await Promise.allSettled([
    Promise.resolve().then(() => subcmd.run(['refresh', '5'], { cwd: sandbox, stdout: _capture().stub })),
    Promise.resolve().then(() => subcmd.run(['finalize', '5'], { cwd: sandbox, stdout: _capture().stub })),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(fulfilled >= 1);
  const doc = JSON.parse(fs.readFileSync(qpath, 'utf-8'));
  assert.equal(doc.phase, 5);
  assert.ok(Array.isArray(doc.questions));
});

test('P11: init + explain full round-trip preserves question set', () => {
  const sandbox = makeSandbox();
  seedPhaseDir(sandbox, 5, 'planning-workflows-agents');
  _seedTemplate(sandbox);
  const cap0 = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap0.stub });
  const qpath = path.join(
    sandbox, '.nubos-pilot', 'phases', '05-planning-workflows-agents',
    '05-QUESTIONS.json'
  );
  const before = JSON.parse(fs.readFileSync(qpath, 'utf-8')).questions.length;

  const cap = _capture();
  subcmd.run(['explain', '5', 'Q-01'], { cwd: sandbox, stdout: cap.stub });

  const after = JSON.parse(fs.readFileSync(qpath, 'utf-8')).questions.length;
  assert.equal(before, after, 'explain does not add/remove questions');
});
