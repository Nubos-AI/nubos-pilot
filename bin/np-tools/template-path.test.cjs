'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const cli = require('./template-path.cjs');
const { resolveTemplatePath, PACKAGE_TEMPLATES_DIR } = cli;

function makeSink() {
  const chunks = [];
  const w = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

test('TPL-1: resolves VALIDATION to absolute path in package templates dir', () => {
  const out = resolveTemplatePath('VALIDATION');
  assert.ok(path.isAbsolute(out));
  assert.ok(out.startsWith(PACKAGE_TEMPLATES_DIR + path.sep));
  assert.ok(fs.existsSync(out));
});

test('TPL-2: accepts nested name like milestone/CONTEXT', () => {
  const out = resolveTemplatePath('milestone/CONTEXT');
  assert.ok(fs.existsSync(out));
  assert.match(out, /templates[/\\]milestone[/\\]CONTEXT\.md$/);
});

test('TPL-3: appends .md when extension absent', () => {
  const out = resolveTemplatePath('VALIDATION');
  assert.ok(out.endsWith('.md'));
});

test('TPL-4: keeps explicit extension', () => {
  const out = resolveTemplatePath('VALIDATION.md');
  assert.ok(out.endsWith('VALIDATION.md'));
  assert.doesNotMatch(out, /\.md\.md$/);
});

test('TPL-5: rejects traversal ..', () => {
  assert.throws(
    () => resolveTemplatePath('../etc/passwd'),
    (err) => err && err.code === 'template-invalid-name',
  );
});

test('TPL-6: rejects empty segments', () => {
  assert.throws(
    () => resolveTemplatePath('milestone//CONTEXT'),
    (err) => err && err.code === 'template-invalid-name',
  );
});

test('TPL-7: rejects non-existent template with template-not-found', () => {
  assert.throws(
    () => resolveTemplatePath('NONEXISTENT'),
    (err) => err && err.code === 'template-not-found',
  );
});

test('TPL-8: CLI prints path and exits 0 for valid template', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = cli.run(['VALIDATION'], { stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  assert.ok(fs.existsSync(stdout.toString()));
});

test('TPL-9: CLI emits error JSON and exits 1 for missing template', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = cli.run(['NOPE'], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"template-not-found"/);
});

test('TPL-10: CLI with no args prints usage to stderr and exits 1', () => {
  const stdout = makeSink();
  const stderr = makeSink();
  const code = cli.run([], { stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});
