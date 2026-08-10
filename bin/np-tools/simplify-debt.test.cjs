'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const subcmd = require('./simplify-debt.cjs');

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-simplify-debt-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

function capture(fn) {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  let rc;
  try { rc = fn(); } finally { process.stdout.write = orig; }
  return { stdout: out.join(''), rc };
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('SD-1: add records an entry and reports was_new', () => {
  const cwd = makeSandbox();
  const { stdout, rc } = capture(() =>
    subcmd.run(['add', '--file', 'src/foo.ts', '--line', '42', '--category', 'over-engineering', '--note', 'inline the factory'], { cwd }),
  );
  assert.equal(rc, 0);
  const res = JSON.parse(stdout);
  assert.equal(res.ok, true);
  assert.equal(res.action, 'add');
  assert.equal(res.was_new, true);
  assert.equal(res.entry.category, 'over-engineering');
});

test('SD-2: add accepts the note as positional args', () => {
  const cwd = makeSandbox();
  const { stdout, rc } = capture(() =>
    subcmd.run(['add', '--category', 'shrinkable', 'collapse', 'this', 'loop'], { cwd }),
  );
  assert.equal(rc, 0);
  assert.equal(JSON.parse(stdout).entry.note, 'collapse this loop');
});

test('SD-3: list (default open) renders the ledger', () => {
  const cwd = makeSandbox();
  capture(() => subcmd.run(['add', '--file', 'a.ts', '--category', 'shrinkable', '--note', 'use reduce'], { cwd }));
  const { stdout, rc } = capture(() => subcmd.run(['list'], { cwd }));
  assert.equal(rc, 0);
  assert.match(stdout, /shrinkable/);
  assert.match(stdout, /1 open/);
});

test('SD-4: list --json emits structured entries', () => {
  const cwd = makeSandbox();
  capture(() => subcmd.run(['add', '--file', 'a.ts', '--category', 'shrinkable', '--note', 'x'], { cwd }));
  const { stdout } = capture(() => subcmd.run(['list', '--json'], { cwd }));
  const res = JSON.parse(stdout);
  assert.equal(res.count, 1);
  assert.equal(res.entries[0].category, 'shrinkable');
});

test('SD-5: no-arg defaults to list', () => {
  const cwd = makeSandbox();
  const { stdout, rc } = capture(() => subcmd.run([], { cwd }));
  assert.equal(rc, 0);
  assert.match(stdout, /empty|Lean already/i);
});

test('SD-6: resolve moves an entry to resolved', () => {
  const cwd = makeSandbox();
  const added = capture(() => subcmd.run(['add', '--file', 'a.ts', '--category', 'native-duplication', '--note', 'reuse helper'], { cwd }));
  const id = JSON.parse(added.stdout).entry.id;
  const { stdout, rc } = capture(() => subcmd.run(['resolve', id], { cwd }));
  assert.equal(rc, 0);
  assert.equal(JSON.parse(stdout).entry.status, 'resolved');
  const open = capture(() => subcmd.run(['list', '--json'], { cwd }));
  assert.equal(JSON.parse(open.stdout).count, 0);
});

test('SD-7: unknown verb throws', () => {
  const cwd = makeSandbox();
  assert.throws(
    () => subcmd.run(['frobnicate'], { cwd }),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'simplify-debt-unknown-verb',
  );
});
