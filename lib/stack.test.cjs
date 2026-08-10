'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const stack = require('./stack.cjs');
const planLint = require('./plan-lint.cjs');

function _mkProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-stack-'));
  for (const [rel, body] of Object.entries(files || {})) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf-8');
  }
  return root;
}

test('STK-1: a bare directory detects no stack and no runner', () => {
  const r = _mkProject({});
  try {
    const out = stack.detectStack(r);
    assert.deepEqual(out.ids, []);
    assert.deepEqual(out.runners, []);
    assert.deepEqual(stack.lintCommands(r), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-2: a Go project yields Go linters, never PHP or TypeScript ones', () => {
  const r = _mkProject({ 'go.mod': 'module example.com/x\n' });
  try {
    assert.deepEqual(stack.detectStack(r).ids, ['go']);
    const lint = stack.lintCommands(r);
    assert.ok(lint.includes('golangci-lint'));
    assert.ok(!lint.includes('phpstan'), 'a Go project must not be linted with phpstan');
    assert.ok(!lint.includes('tsc'), 'a Go project must not be typechecked with tsc');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-3: a Rust project yields clippy', () => {
  const r = _mkProject({ 'Cargo.toml': '[package]\nname = "x"\n' });
  try {
    assert.deepEqual(stack.detectStack(r).ids, ['rust']);
    assert.ok(stack.lintCommands(r).includes('clippy'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-4: a polyglot project reports every stack it contains', () => {
  const r = _mkProject({
    'package.json': '{"name":"x"}',
    'composer.json': '{"name":"v/x"}',
    'pyproject.toml': '[project]\nname = "x"\n',
  });
  try {
    const ids = stack.detectStack(r).ids;
    assert.deepEqual(ids.slice().sort(), ['node', 'php', 'python']);
    const lint = stack.lintCommands(r);
    for (const c of ['eslint', 'tsc', 'pint', 'phpstan', 'ruff', 'mypy']) {
      assert.ok(lint.includes(c), 'expected ' + c);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-5: declared scripts are read per stack from the right manifest', () => {
  const r = _mkProject({
    'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
    'composer.json': JSON.stringify({ scripts: { 'test:unit': 'phpunit' } }),
  });
  try {
    const detected = stack.detectStack(r).stacks;
    const node = detected.find((s) => s.id === 'node');
    const php = detected.find((s) => s.id === 'php');
    assert.deepEqual(node.scripts, ['build', 'test']);
    assert.deepEqual(php.scripts, ['test:unit']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-6: task runners are detected independently of language stacks', () => {
  const r = _mkProject({ 'justfile': 'build:\n\techo hi\n', 'Makefile': 'all:\n\techo hi\n' });
  try {
    const out = stack.detectStack(r);
    assert.deepEqual(out.ids, []);
    assert.deepEqual(out.runners.map((x) => x.id).sort(), ['just', 'make']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-7: a malformed manifest degrades to no scripts instead of throwing', () => {
  const r = _mkProject({ 'package.json': '{ this is not json' });
  try {
    const detected = stack.detectStack(r).stacks;
    assert.deepEqual(detected.map((s) => s.id), ['node']);
    assert.deepEqual(detected[0].scripts, []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('STK-8: every command the stack table knows is allowed by plan-lint', () => {
  const missing = [];
  for (const c of stack.knownCommands()) {
    if (!planLint.VERIFY_ALLOWED_COMMANDS.has(c)) missing.push(c);
  }
  assert.deepEqual(missing, [], 'stack.cjs and plan-lint must not drift apart');
});

test('STK-9: every stack manifest is captured by the workspace scanner', () => {
  const manifests = stack.manifestFiles();
  for (const s of stack.STACKS) {
    for (const m of s.manifests) {
      assert.ok(manifests.has(m), 'manifest not captured: ' + m);
    }
  }
});
