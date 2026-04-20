const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./scan-codebase.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sc-'));
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
    text: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('')),
  };
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('SC-1: throws when .nubos-pilot missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sc-bare-'));
  _sandboxes.push(dir);
  assert.throws(
    () => subcmd.run([], { cwd: dir, stdout: captureStdout().stub }),
    (err) => err.code === 'scan-codebase-not-initialized',
  );
});

test('SC-2: emits plan with modules, stats, and writes INDEX.md + stubs + manifest', () => {
  const root = makeSandbox();
  write(root, 'src/auth/login.js', 'export function login(){}');
  write(root, 'src/auth/session.js', 'export class Session{}');
  write(root, 'src/billing/invoice.js', 'export function invoice(){}');

  const cap = captureStdout();
  subcmd.run(['--project-name', 'Demo'], { cwd: root, stdout: cap.stub });
  const out = cap.json();

  assert.equal(out.mode, 'plan');
  assert.ok(out.stats.file_count >= 3);
  assert.ok(Array.isArray(out.modules));
  const ids = out.modules.map((m) => m.id).sort();
  assert.ok(ids.includes('src-auth'));
  assert.ok(ids.includes('src-billing'));

  assert.ok(fs.existsSync(path.join(root, '.nubos-pilot', 'codebase', 'INDEX.md')));
  assert.ok(fs.existsSync(path.join(root, '.nubos-pilot', 'codebase', '.hashes.json')));
  assert.ok(fs.existsSync(path.join(root, '.nubos-pilot', 'codebase', 'modules', 'src-auth.md')));

  const indexMd = fs.readFileSync(path.join(root, '.nubos-pilot', 'codebase', 'INDEX.md'), 'utf-8');
  assert.ok(indexMd.includes('Demo'));
});

test('SC-3: module stub contains facts in frontmatter even before prose', () => {
  const root = makeSandbox();
  write(root, 'src/auth/login.js', [
    'import bcrypt from "bcrypt";',
    'export function login(){}',
    'export class Session {}',
  ].join('\n'));

  const cap = captureStdout();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const stub = fs.readFileSync(
    path.join(root, '.nubos-pilot', 'codebase', 'modules', 'src-auth.md'),
    'utf-8',
  );
  assert.ok(stub.startsWith('---\n'));
  assert.ok(stub.includes('module_id: src-auth'));
  assert.ok(stub.includes('symbols:'));
  assert.ok(stub.includes('- login'));
  assert.ok(stub.includes('- Session'));
  assert.ok(stub.includes('external_deps:'));
  assert.ok(stub.includes('- bcrypt'));
  assert.ok(stub.includes('_TBD'));
});

test('SC-4: apply-prose merges prose sections into existing stub', () => {
  const root = makeSandbox();
  write(root, 'src/auth/login.js', 'export function login(){}');

  const initialCap = captureStdout();
  subcmd.run([], { cwd: root, stdout: initialCap.stub });

  const proseFile = path.join(root, '.nubos-pilot', 'prose-auth.json');
  fs.writeFileSync(proseFile, JSON.stringify({
    description: 'Login flow',
    purpose: 'Authenticates the user.',
    key_concepts: ['Session token issued on success'],
    public_api: '`login(user)` returns a Session',
    invariants: ['No plaintext passwords'],
    gotchas: ['bcrypt cost from env'],
  }));

  const cap = captureStdout();
  subcmd.run(['--apply-prose', '--module', 'src-auth', '--prose-file', proseFile], {
    cwd: root,
    stdout: cap.stub,
  });
  const out = cap.json();
  assert.equal(out.mode, 'apply-prose');
  assert.equal(out.module_id, 'src-auth');

  const doc = fs.readFileSync(
    path.join(root, '.nubos-pilot', 'codebase', 'modules', 'src-auth.md'),
    'utf-8',
  );
  assert.ok(doc.includes('description: Login flow'));
  assert.ok(doc.includes('Authenticates the user.'));
  assert.ok(doc.includes('Session token issued on success'));
  assert.ok(doc.includes('bcrypt cost from env'));
});

test('SC-5: apply-prose requires --module and --prose-file', () => {
  const root = makeSandbox();
  write(root, 'src/a.js', 'x');
  subcmd.run([], { cwd: root, stdout: captureStdout().stub });

  assert.throws(
    () => subcmd.run(['--apply-prose'], { cwd: root, stdout: captureStdout().stub }),
    (err) => err.code === 'scan-codebase-missing-module',
  );
  assert.throws(
    () => subcmd.run(['--apply-prose', '--module', 'src'], {
      cwd: root, stdout: captureStdout().stub,
    }),
    (err) => err.code === 'scan-codebase-missing-prose',
  );
});

test('SC-6: apply-prose with unknown module throws', () => {
  const root = makeSandbox();
  write(root, 'src/a.js', 'x');
  subcmd.run([], { cwd: root, stdout: captureStdout().stub });

  const proseFile = path.join(root, 'p.json');
  fs.writeFileSync(proseFile, JSON.stringify({ description: 'x' }));
  assert.throws(
    () => subcmd.run(
      ['--apply-prose', '--module', 'does-not-exist', '--prose-file', proseFile],
      { cwd: root, stdout: captureStdout().stub },
    ),
    (err) => err.code === 'scan-codebase-module-not-found',
  );
});
