const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const doctor = require('./doctor.cjs');
const scanCodebase = require('./scan-codebase.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-doc-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(dir);
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stub: { write: (s) => chunks.push(String(s)), end: () => {} },
    json: () => JSON.parse(chunks.join('')),
  };
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('DOC-1: flags codebase-not-scanned when INDEX.md missing', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export {};');
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('codebase-not-scanned'));
});

test('DOC-2: no codebase issue when scanned and source unchanged', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(!ids.includes('codebase-not-scanned'));
  assert.ok(!ids.includes('codebase-manifest-stale'));
});

test('DOC-3: flags codebase-manifest-stale after source changes', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){ /* v2 */ }');
  fs.writeFileSync(path.join(root, 'new.js'), 'export function b(){}');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const stale = out.issues.find((i) => i.id === 'codebase-manifest-stale');
  assert.ok(stale, 'expected codebase-manifest-stale');
  assert.ok(stale.details.changed >= 1);
  assert.ok(stale.details.added >= 1);
});

test('DOC-4: flags codebase-tbd-docs for modules with _TBD Purpose', async () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const tbd = out.issues.find((i) => i.id === 'codebase-tbd-docs');
  assert.ok(tbd, 'expected codebase-tbd-docs');
  assert.ok(tbd.details.count >= 1);
});

test('DOC-5: no tbd flag after prose applied', async () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const proseFile = path.join(root, 'p.json');
  fs.writeFileSync(proseFile, JSON.stringify({
    description: 'A module',
    purpose: 'Provides function a.',
    key_concepts: ['just one thing'],
    public_api: '`a()`',
    invariants: [],
    gotchas: [],
  }));
  scanCodebase.run(['--apply-prose', '--module', 'src', '--prose-file', proseFile], {
    cwd: root, stdout: captureStdout().stub,
  });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const tbd = out.issues.find((i) => i.id === 'codebase-tbd-docs');
  assert.ok(!tbd, 'expected no codebase-tbd-docs');
});
