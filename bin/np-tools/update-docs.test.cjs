const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const scanCmd = require('./scan-codebase.cjs');
const subcmd = require('./update-docs.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ud-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(dir);
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function captureStdout() {
  const chunks = [];
  return {
    stub: { write: (s) => chunks.push(String(s)) },
    json: () => JSON.parse(chunks.join('')),
  };
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('UD-1: throws when .nubos-pilot missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ud-bare-'));
  _sandboxes.push(dir);
  assert.throws(
    () => subcmd.run([], { cwd: dir, stdout: captureStdout().stub }),
    (err) => err.code === 'update-docs-not-initialized',
  );
});

test('UD-2: detects added, changed, removed files against manifest', () => {
  const root = makeSandbox();
  write(root, 'src/auth/login.js', 'export function login(){}');
  write(root, 'src/billing/invoice.js', 'export function invoice(){}');
  scanCmd.run([], { cwd: root, stdout: captureStdout().stub });

  write(root, 'src/auth/login.js', 'export function login(){ /* v2 */ }');
  write(root, 'src/auth/session.js', 'export class Session {}');
  fs.unlinkSync(path.join(root, 'src/billing/invoice.js'));

  const cap = captureStdout();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const out = cap.json();

  assert.equal(out.mode, 'plan');
  assert.ok(out.diff_summary.changed >= 1);
  assert.ok(out.diff_summary.added >= 1);
  assert.ok(out.diff_summary.removed >= 1);

  const staleIds = out.stale_modules.map((m) => m.id);
  assert.ok(staleIds.includes('src-auth'));
});

test('UD-3: new module appears in added_modules and gets stub', () => {
  const root = makeSandbox();
  write(root, 'src/core/a.js', 'export function a(){}');
  scanCmd.run([], { cwd: root, stdout: captureStdout().stub });

  write(root, 'src/newmod/x.js', 'export function x(){}');

  const cap = captureStdout();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const out = cap.json();

  const addedIds = out.added_modules.map((m) => m.id);
  assert.ok(addedIds.includes('src-newmod'));
  assert.ok(fs.existsSync(path.join(root, '.nubos-pilot', 'codebase', 'modules', 'src-newmod.md')));
});

test('UD-4: removed module reported in removed_modules', () => {
  const root = makeSandbox();
  write(root, 'src/foo/a.js', 'export function a(){}');
  write(root, 'src/bar/b.js', 'export function b(){}');
  scanCmd.run([], { cwd: root, stdout: captureStdout().stub });

  fs.rmSync(path.join(root, 'src/bar'), { recursive: true, force: true });

  const cap = captureStdout();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const out = cap.json();
  const removedIds = out.removed_modules.map((m) => m.id);
  assert.ok(removedIds.includes('src-bar'));
});

test('UD-5: apply-prose writes prose into existing module doc', () => {
  const root = makeSandbox();
  write(root, 'src/auth/login.js', 'export function login(){}');
  scanCmd.run([], { cwd: root, stdout: captureStdout().stub });

  const proseFile = path.join(root, 'p.json');
  fs.writeFileSync(proseFile, JSON.stringify({
    description: 'Login',
    purpose: 'Auth users.',
    key_concepts: [],
    public_api: '`login()`',
    invariants: [],
    gotchas: [],
  }));

  const cap = captureStdout();
  subcmd.run(['--apply-prose', '--module', 'src-auth', '--prose-file', proseFile], {
    cwd: root, stdout: cap.stub,
  });
  const out = cap.json();
  assert.equal(out.mode, 'apply-prose');
  const doc = fs.readFileSync(
    path.join(root, '.nubos-pilot', 'codebase', 'modules', 'src-auth.md'),
    'utf-8',
  );
  assert.ok(doc.includes('description: Login'));
  assert.ok(doc.includes('Auth users.'));
});
