'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const subcmd = require('./close-project.cjs');
const layout = require('../../lib/layout.cjs');

const _sandboxes = [];

function _sandbox(milestones, milestoneArtifacts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cp-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# Demo Project\n\nbody\n', 'utf-8');
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    YAML.stringify({ schema_version: 2, milestones }),
    'utf-8',
  );
  for (const m of (milestoneArtifacts || [])) {
    const mDir = layout.milestoneDir(m.number, root);
    fs.mkdirSync(mDir, { recursive: true });
    if (m.verification) fs.writeFileSync(path.join(mDir, 'M' + String(m.number).padStart(3, '0') + '-VERIFICATION.md'), m.verification, 'utf-8');
    if (m.validation) fs.writeFileSync(path.join(mDir, 'M' + String(m.number).padStart(3, '0') + '-VALIDATION.md'), m.validation, 'utf-8');
  }
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

function _capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

function _verified() {
  return '# M001\n\n**Verified:** 2026-05-11\n**Milestone Status:** verified\n\n## Success Criteria\n\n### SC-1: x\n- **Status:** Pass\n- **Classified by:** np-verifier\n- **Evidence:** abc\n';
}

function _validation() {
  return '# M001 Validation\n- REQ-01: COVERED\n';
}

test('CP-1: init returns completion payload', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const cap = _capture();
  subcmd.run(['init'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload._workflow, 'close-project');
  assert.equal(payload.project_exists, true);
  assert.equal(payload.completion.status, 'complete');
});

test('CP-2: write-summary writes PROJECT-SUMMARY.md', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const cap = _capture();
  subcmd.run(['write-summary'], { cwd: sb, stdout: cap.stub });
  const summaryPath = path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md');
  assert.ok(fs.existsSync(summaryPath));
  const md = fs.readFileSync(summaryPath, 'utf-8');
  assert.match(md, /Project Summary/);
});

test('CP-3: mark-completed sets project_status in roadmap.yaml', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  subcmd.run(['mark-completed'], { cwd: sb, stdout: _capture().stub });
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, 'completed');
});

test('CP-4: unknown verb throws NubosPilotError', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [],
  );
  assert.throws(
    () => subcmd.run(['frobnicate'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-unknown-verb',
  );
});

test('CP-5: check verb prints completion JSON', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
    [],
  );
  const cap = _capture();
  subcmd.run(['check'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.status, 'incomplete');
  assert.ok(payload.blockers.length > 0);
});

test('CP-CLOSE-1: close writes summary, flips status, leaves the project unarchived', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const cap = _capture();
  const result = subcmd.run(['close'], { cwd: sb, stdout: cap.stub });

  assert.equal(result.closed, true);
  assert.equal(result.archived, false);
  assert.equal(result.project_status, 'completed');
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md')), true);
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'archive')), false);
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, 'completed');
});

test('CP-CLOSE-2: close --archive carries the summary into the archive', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const cap = _capture();
  const result = subcmd.run(['close', '--archive'], { cwd: sb, stdout: cap.stub });

  assert.equal(result.closed, true);
  assert.equal(result.archived, true);
  assert.ok(result.archive.moved.includes('PROJECT-SUMMARY.md'));
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md')), false);
  assert.equal(fs.existsSync(path.join(result.archive.archive_dir, 'PROJECT-SUMMARY.md')), true);
});

test('CP-CLOSE-3: blockers refuse before writing anything', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
  );
  assert.throws(
    () => subcmd.run(['close'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-blocked' && err.details.blockers.length > 0,
  );
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md')), false);
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, undefined);
});

test('CP-CLOSE-4: --force closes past blockers', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
  );
  const result = subcmd.run(['close', '--force'], { cwd: sb, stdout: _capture().stub });
  assert.equal(result.closed, true);
  assert.equal(result.forced, true);
});

test('CP-CLOSE-5: a failed archive keeps the close and reports the gap', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  fs.mkdirSync(path.join(sb, '.nubos-pilot', 'brand-new-thing'), { recursive: true });
  const cap = _capture();

  assert.throws(
    () => subcmd.run(['close', '--archive'], { cwd: sb, stdout: cap.stub }),
    (err) => err.code === 'close-project-archive-failed',
  );

  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.closed, true);
  assert.equal(payload.archived, false);
  assert.equal(payload.archive_error, 'archive-unknown-state-artifact');
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, 'completed', 'the close must stand');
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md')), true);
});

test('CP-CLOSE-6: a forced close records forced=true in the archive manifest', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
  );
  const result = subcmd.run(['close', '--force', '--archive'], { cwd: sb, stdout: _capture().stub });
  assert.equal(result.archived, true);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(result.archive.archive_dir, 'ARCHIVE.json'), 'utf-8'),
  );
  assert.equal(manifest.forced, true, 'the flip to completed must not launder a forced close');
  assert.equal(manifest.completion_status, 'incomplete');
  assert.ok(manifest.blockers_at_archive.length > 0);
});

test('CP-CLOSE-7: --carry-over refuses to swallow the next flag', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  assert.throws(
    () => subcmd.run(['close', '--carry-over', '--archive'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-missing-flag-value',
  );
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md')), false);
});

test('CP-CLOSE-8: a mistyped flag refuses instead of silently skipping the archive', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  assert.throws(
    () => subcmd.run(['close', '--achive'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-unknown-flag',
  );
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT-SUMMARY.md')), false);
});

test('CP-CLOSE-9: a failing status flip names the summary it already wrote', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    [{ number: 1, verification: _verified(), validation: _validation() }],
  );
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.schema_version = 99;
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');

  assert.throws(
    () => subcmd.run(['close', '--force'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-status-flip-failed'
      && typeof err.details.summary_path === 'string',
  );
});

test('CP-CLOSE-10: mark-completed refuses on blockers instead of flipping silently', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
  );
  assert.throws(
    () => subcmd.run(['mark-completed'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'close-project-blocked' && err.details.verb === 'mark-completed',
  );
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, undefined);
});

test('CP-CLOSE-11: mark-completed --force still works', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
  );
  subcmd.run(['mark-completed', '--force'], { cwd: sb, stdout: _capture().stub });
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.project_status, 'completed');
});

test('CP-CLOSE-12: a recorded completed status does not mask real blockers', () => {
  const sb = _sandbox(
    [{ id: 'M001', number: 1, name: 'a', status: 'pending', success_criteria: ['x'], slices: [] }],
  );
  subcmd.run(['mark-completed', '--force'], { cwd: sb, stdout: _capture().stub });

  const after = subcmd.run(['check'], { cwd: sb, stdout: _capture().stub });
  assert.equal(after.complete, false, 'blockers must stay visible after a forced close');
  assert.equal(after.status, 'incomplete');
  assert.ok(after.blockers.length > 0);
  assert.equal(after.archivable, true, 'but the recorded close still authorizes archiving');
});
