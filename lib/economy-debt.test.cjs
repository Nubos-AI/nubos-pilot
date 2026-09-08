'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const debt = require('./economy-debt.cjs');

const _sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-economy-debt-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(root);
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('ED-1: addEntry writes an open entry and returns was_new=true', () => {
  const cwd = makeSandbox();
  const e = debt.addEntry(
    { file: 'src/foo.ts', line: 42, category: 'over-engineering', note: 'Single-use factory — inline it.' },
    cwd,
  );
  assert.equal(e.was_new, true);
  assert.equal(e.status, 'open');
  assert.equal(e.category, 'over-engineering');
  assert.equal(e.file, 'src/foo.ts');
  assert.equal(e.line, 42);
  assert.match(e.id, /^[0-9a-f]{7}$/);
  assert.ok(fs.existsSync(e.path));
});

test('ED-2: addEntry is idempotent — identical input does not duplicate', () => {
  const cwd = makeSandbox();
  const first = debt.addEntry(
    { file: 'a.ts', line: 1, category: 'shrinkable', note: 'manual reduce -> Array.reduce' },
    cwd,
  );
  const second = debt.addEntry(
    { file: 'a.ts', line: 1, category: 'shrinkable', note: 'manual reduce -> Array.reduce' },
    cwd,
  );
  assert.equal(first.id, second.id);
  assert.equal(second.was_new, false);
  assert.equal(debt.listEntries('open', cwd).length, 1);
});

test('ED-3: addEntry rejects a category outside the four economy routes', () => {
  const cwd = makeSandbox();
  assert.throws(
    () => debt.addEntry({ file: 'a.ts', category: 'security', note: 'x' }, cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'economy-debt-invalid-category',
  );
});

test('ED-4: addEntry rejects an empty note', () => {
  const cwd = makeSandbox();
  assert.throws(
    () => debt.addEntry({ file: 'a.ts', category: 'shrinkable', note: '  ' }, cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'economy-debt-missing-note',
  );
});

test('ED-5: line defaults to 0 (file-level) when omitted', () => {
  const cwd = makeSandbox();
  const e = debt.addEntry({ file: 'a.ts', category: 'native-duplication', note: 'reimplements framework helper' }, cwd);
  assert.equal(e.line, 0);
  const parsed = debt.listEntries('open', cwd)[0];
  assert.equal(parsed.line, 0);
});

test('ED-6: listEntries sorts oldest-first and round-trips note + fields', () => {
  const cwd = makeSandbox();
  debt.addEntry({ file: 'a.ts', line: 5, category: 'shrinkable', note: 'first' }, cwd);
  debt.addEntry({ file: 'b.ts', line: 9, category: 'over-engineering', note: 'second' }, cwd);
  const list = debt.listEntries('open', cwd);
  assert.equal(list.length, 2);
  assert.equal(list[0].note, 'first');
  assert.equal(list[1].note, 'second');
  assert.equal(list[1].category, 'over-engineering');
  assert.equal(list[1].line, 9);
});

test('ED-7: resolveEntry moves open -> resolved and stamps resolved time', () => {
  const cwd = makeSandbox();
  const e = debt.addEntry({ file: 'a.ts', line: 1, category: 'stdlib-reinvention', note: 'hand-rolled clamp' }, cwd);
  const r = debt.resolveEntry(e.id, cwd);
  assert.equal(r.status, 'resolved');
  assert.match(r.resolved, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(debt.listEntries('open', cwd).length, 0);
  assert.equal(debt.listEntries('resolved', cwd).length, 1);
  assert.equal(debt.listEntries('all', cwd).length, 1);
  assert.ok(!fs.existsSync(e.path));
});

test('ED-8: resolveEntry throws economy-debt-not-found for an unknown id', () => {
  const cwd = makeSandbox();
  assert.throws(
    () => debt.resolveEntry('deadbee', cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'economy-debt-not-found',
  );
});

test('ED-9: listEntries rejects an invalid status', () => {
  const cwd = makeSandbox();
  assert.throws(
    () => debt.listEntries('bogus', cwd),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'economy-debt-invalid-status',
  );
});

test('ED-10: empty ledger lists as []', () => {
  const cwd = makeSandbox();
  assert.deepEqual(debt.listEntries('open', cwd), []);
  assert.deepEqual(debt.listEntries('all', cwd), []);
});

test('ED-11: ECONOMY_CATEGORIES matches the four canonical economy routes', () => {
  assert.deepEqual(
    debt.ECONOMY_CATEGORIES.slice().sort(),
    ['native-duplication', 'over-engineering', 'shrinkable', 'stdlib-reinvention'],
  );
});
