'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildIndex, writeIndex, readIndex, search, indexStats, _tokenize } = require('./knowledge.cjs');

function _scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-knowledge-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001'), { recursive: true });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'codebase'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'PROJECT.md'),
    '# Project\n\nThe authentication system uses JWT tokens for session security.\n');
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'milestones', 'M001', 'M001-CONTEXT.md'),
    '# M001 Context\n\nLocked: jose@6 for JWT verification, no hand-rolled crypto allowed.\n');
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'S001-PLAN.md'),
    '# S001 Plan\n\nTask 1: install jose. Task 2: verify token signature.\n');
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'codebase', 'auth.md'),
    '# Auth Module\n\nPath: app/Auth/\nExternal Deps: jose, argon2.\n');
  return root;
}

test('tokenize strips stopwords + short tokens', () => {
  const t = _tokenize('The JWT token is verified using jose');
  assert.ok(t.includes('jwt'));
  assert.ok(t.includes('token'));
  assert.ok(t.includes('jose'));
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('is'));
});

test('buildIndex covers PROJECT + milestones + codebase', () => {
  const cwd = _scratch();
  const idx = buildIndex(cwd);
  assert.equal(idx.version, 1);
  assert.equal(idx.total_files, 4);
  assert.ok(idx.total_chunks >= 4);
  assert.ok(idx.df['jose'] >= 2);
});

test('writeIndex + readIndex round-trip', () => {
  const cwd = _scratch();
  const idx = buildIndex(cwd);
  const dest = writeIndex(idx, cwd);
  assert.ok(fs.existsSync(dest));
  const back = readIndex(cwd);
  assert.equal(back.version, idx.version);
  assert.equal(back.total_files, idx.total_files);
});

test('search ranks JWT-related chunks high', () => {
  const cwd = _scratch();
  const res = search('jwt jose', cwd);
  assert.ok(res.total_hits >= 2);
  assert.ok(res.hits[0].score > 0);
  assert.match(res.hits[0].rel_path, /M001|PROJECT/);
});

test('search auto-builds index if missing', () => {
  const cwd = _scratch();
  const res = search('authentication', cwd);
  assert.ok(res.total_hits >= 1);
  assert.ok(readIndex(cwd) !== null);
});

test('search empty query returns 0 hits without crash', () => {
  const cwd = _scratch();
  const res = search('the', cwd);
  assert.equal(res.total_hits, 0);
});

test('indexStats groups by top-level dir', () => {
  const cwd = _scratch();
  buildIndex(cwd);
  writeIndex(buildIndex(cwd), cwd);
  const s = indexStats(cwd);
  assert.equal(s.exists, true);
  assert.ok(s.groups.milestones);
  assert.ok(s.groups.codebase);
});
