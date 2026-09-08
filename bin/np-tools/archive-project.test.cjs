'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const subcmd = require('./archive-project.cjs');
const layout = require('../../lib/layout.cjs');

const _sandboxes = [];

function _completeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-arc-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# Demo\n\nbody\n', 'utf-8');
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    YAML.stringify({
      schema_version: 2,
      milestones: [{ id: 'M001', number: 1, name: 'a', status: 'done', success_criteria: ['x'], slices: [] }],
    }),
    'utf-8',
  );
  const mDir = layout.milestoneDir(1, root);
  fs.mkdirSync(mDir, { recursive: true });
  fs.writeFileSync(path.join(mDir, 'M001-VERIFICATION.md'),
    '**Milestone Status:** verified\n### SC-1: x\n- **Status:** Pass\n- **Classified by:** np-verifier\n- **Evidence:** abc\n', 'utf-8');
  fs.writeFileSync(path.join(mDir, 'M001-VALIDATION.md'),
    '- REQ-01: COVERED\n', 'utf-8');
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

test('AP-1: status verb returns project_exists + completion', () => {
  const sb = _completeSandbox();
  const cap = _capture();
  subcmd.run(['status'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.project_exists, true);
  assert.equal(payload.completion.complete, true);
});

test('AP-2: do verb archives a complete project', () => {
  const sb = _completeSandbox();
  const cap = _capture();
  subcmd.run(['do'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.ok(payload.archive_dir.includes('archive'));
  assert.ok(fs.existsSync(path.join(payload.archive_dir, 'ARCHIVE.json')));
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'PROJECT.md')), false);
});

test('AP-3: list verb returns archives in newest-first order', () => {
  const sb = _completeSandbox();
  subcmd.run(['do'], { cwd: sb, stdout: _capture().stub });
  const cap = _capture();
  subcmd.run(['list'], { cwd: sb, stdout: cap.stub });
  const items = JSON.parse(cap.get().trim());
  assert.equal(items.length, 1);
  assert.equal(items[0].completion_status, 'complete');
});

test('AP-4: unknown verb throws', () => {
  const sb = _completeSandbox();
  assert.throws(
    () => subcmd.run(['nope'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'archive-project-unknown-verb',
  );
});

test('AP-5: read verb returns archived file content', () => {
  const sb = _completeSandbox();
  const cap1 = _capture();
  subcmd.run(['do'], { cwd: sb, stdout: cap1.stub });
  const archiveResult = JSON.parse(cap1.get().trim());
  const archiveName = path.basename(archiveResult.archive_dir);
  const cap2 = _capture();
  subcmd.run(['read', '--name', archiveName, '--rel', 'PROJECT.md'], { cwd: sb, stdout: cap2.stub });
  assert.match(cap2.get(), /# Demo/);
});

test('AP-6: read verb refuses missing flags', () => {
  const sb = _completeSandbox();
  subcmd.run(['do'], { cwd: sb, stdout: _capture().stub });
  assert.throws(
    () => subcmd.run(['read'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'archive-read-missing-name',
  );
});

test('AP-7: --no-carry-over skips archive copy but leaves originals in place', () => {
  const sb = _completeSandbox();
  fs.mkdirSync(path.join(sb, '.nubos-pilot', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(sb, '.nubos-pilot', 'memory', 'x.md'), 'hi', 'utf-8');
  const cap = _capture();
  subcmd.run(['do', '--no-carry-over'], { cwd: sb, stdout: cap.stub });
  const payload = JSON.parse(cap.get().trim());
  assert.deepEqual(payload.carried_over, []);
  assert.equal(fs.existsSync(path.join(sb, '.nubos-pilot', 'memory', 'x.md')), true);
  assert.equal(fs.existsSync(path.join(payload.archive_dir, 'memory')), false);
});
