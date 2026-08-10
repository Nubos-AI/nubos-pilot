const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('./config.cjs');

const _sandboxes = [];

function makeSandbox(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-config-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  if (contents !== null) {
    fs.writeFileSync(path.join(dir, '.nubos-pilot', 'config.json'), contents, 'utf-8');
  }
  _sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (_sandboxes.length) {
    const d = _sandboxes.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

test('CFG-1: readConfig returns {} when config.json is missing', () => {
  const sandbox = makeSandbox(null);
  assert.deepEqual(config.readConfig(sandbox), {});
});

test('CFG-2: readConfig returns {} when file is empty', () => {
  const sandbox = makeSandbox('');
  assert.deepEqual(config.readConfig(sandbox), {});
});

test('CFG-3: readConfig returns parsed object on valid JSON', () => {
  const sandbox = makeSandbox('{"swarm":{"k":3},"commit_artifacts":false}');
  const cfg = config.readConfig(sandbox);
  assert.equal(cfg.swarm.k, 3);
  assert.equal(cfg.commit_artifacts, false);
});

test('CFG-4: readConfig throws config-invalid-json on parse error', () => {
  const sandbox = makeSandbox('{"swarm": {"k": 3,}}');
  assert.throws(
    () => config.readConfig(sandbox),
    (err) => err && err.code === 'config-invalid-json' && err.name === 'NubosPilotError',
  );
});

test('CFG-5: readConfig throws config-invalid-shape on top-level array', () => {
  const sandbox = makeSandbox('[1, 2, 3]');
  assert.throws(
    () => config.readConfig(sandbox),
    (err) => err && err.code === 'config-invalid-shape',
  );
});

test('CFG-6: readConfig throws config-invalid-shape on top-level scalar', () => {
  const sandbox = makeSandbox('"just a string"');
  assert.throws(
    () => config.readConfig(sandbox),
    (err) => err && err.code === 'config-invalid-shape',
  );
});

test('CFG-7: readConfig throws config-invalid-shape on top-level null', () => {
  const sandbox = makeSandbox('null');
  assert.throws(
    () => config.readConfig(sandbox),
    (err) => err && err.code === 'config-invalid-shape',
  );
});

test('CFG-8: readConfigPath propagates parse errors instead of returning fallback', () => {
  const sandbox = makeSandbox('{"broken');
  assert.throws(
    () => config.readConfigPath(sandbox, 'swarm.k', 42),
    (err) => err && err.code === 'config-invalid-json',
  );
});

test('CFG-9: readConfigPath returns fallback when missing key on valid config', () => {
  const sandbox = makeSandbox('{"swarm":{"k":3}}');
  assert.equal(config.readConfigPath(sandbox, 'memory.alpha', 0.6), 0.6);
});

test('CFG-10: readConfigPath returns nested value', () => {
  const sandbox = makeSandbox('{"workflow":{"commit_artifacts":false}}');
  assert.equal(config.readConfigPath(sandbox, 'workflow.commit_artifacts', true), false);
});

test('CFG-11: readConfigPath refuses to walk through __proto__', () => {
  const sandbox = makeSandbox('{}');
  assert.equal(config.readConfigPath(sandbox, '__proto__.polluted', 'fallback'), 'fallback');
});

test('CFG-12: readConfigGraceful returns null when not in a project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-no-project-'));
  _sandboxes.push(dir);
  assert.equal(config.readConfigGraceful(dir, 'test-err'), null);
});

test('CFG-13: readConfigGraceful throws structured error on parse fail', () => {
  const sandbox = makeSandbox('{nope}');
  assert.throws(
    () => config.readConfigGraceful(sandbox, 'caller-error-code'),
    (err) => err && err.code === 'caller-error-code',
  );
});

test('CFG-14: coerceBool handles common string forms', () => {
  assert.equal(config.coerceBool('true'), true);
  assert.equal(config.coerceBool('FALSE'), false);
  assert.equal(config.coerceBool('1'), true);
  assert.equal(config.coerceBool('off'), false);
  assert.equal(config.coerceBool(true), true);
  assert.equal(config.coerceBool(null), null);
  assert.equal(config.coerceBool('maybe'), null);
});

test('CFG-15: readConfig strips UTF-8 BOM before parsing', () => {
  const sandbox = makeSandbox('﻿{"swarm":{"k":5}}');
  assert.equal(config.readConfig(sandbox).swarm.k, 5);
});

test('CFG-16: readConfig throws config-not-a-file when config.json is a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-config-dir-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.nubos-pilot', 'config.json'), { recursive: true });
  _sandboxes.push(dir);
  assert.throws(
    () => config.readConfig(dir),
    (err) => err && err.code === 'config-not-a-file',
  );
});

test('CFG-17: details for FS errors carry basename only, never absolute paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-config-eaccess-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.nubos-pilot', 'config.json'), { recursive: true });
  _sandboxes.push(dir);
  try {
    config.readConfig(dir);
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'config-not-a-file');
    assert.equal(err.details.file, 'config.json');
    const detailStr = JSON.stringify(err.details);
    assert.ok(!detailStr.includes('/'), 'no path separators in details: ' + detailStr);
    assert.ok(!detailStr.includes(os.homedir()), 'no homedir in details: ' + detailStr);
  }
});

test('CFG-17b: invalid-json error message does not include absolute path', () => {
  const sandbox = makeSandbox('{ broken');
  try {
    config.readConfig(sandbox);
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'config-invalid-json');
    assert.ok(!err.message.includes('/'), 'message should not include path: ' + err.message);
  }
});

test('CFG-18: tryReadConfigPath returns fallback and warns when JSON is broken', () => {
  config._resetWarnedOnceForTests();
  const sandbox = makeSandbox('{ broken');
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += String(chunk); return true; };
  try {
    const v = config.tryReadConfigPath(sandbox, 'swarm.k', 'fallback-val');
    assert.equal(v, 'fallback-val');
    assert.match(warned, /config-invalid-json/);
    assert.match(warned, /swarm\.k/);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('CFG-19: tryReadConfigPath rate-limits stderr warnings per path', () => {
  config._resetWarnedOnceForTests();
  const sandbox = makeSandbox('{ broken');
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += String(chunk); return true; };
  try {
    config.tryReadConfigPath(sandbox, 'swarm.k', 1);
    config.tryReadConfigPath(sandbox, 'swarm.k', 1);
    config.tryReadConfigPath(sandbox, 'swarm.k', 1);
    const occurrences = warned.match(/config-invalid-json/g) || [];
    assert.equal(occurrences.length, 1);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('CFG-20: tryReadConfigPath returns fallback when not in a project (no warn)', () => {
  config._resetWarnedOnceForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-no-project-'));
  _sandboxes.push(dir);
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += String(chunk); return true; };
  try {
    const v = config.tryReadConfigPath(dir, 'memory.enabled', false);
    assert.equal(v, false);
    assert.equal(warned, '');
  } finally {
    process.stderr.write = origWrite;
  }
});

test('CFG-21: tryReadConfigPath passes through on valid config', () => {
  const sandbox = makeSandbox('{"memory":{"enabled":true,"alpha":0.7}}');
  assert.equal(config.tryReadConfigPath(sandbox, 'memory.enabled', false), true);
  assert.equal(config.tryReadConfigPath(sandbox, 'memory.alpha', 0.5), 0.7);
});

test('CFG-22: readConfigGraceful enforces shape (top-level array rejected)', () => {
  const sandbox = makeSandbox('[1,2,3]');
  assert.throws(
    () => config.readConfigGraceful(sandbox, 'caller-code'),
    (err) => err && err.code === 'caller-code',
  );
});

test('CFG-23: readConfigGraceful treats empty file as null (not array, not crash)', () => {
  const sandbox = makeSandbox('');
  assert.deepEqual(config.readConfigGraceful(sandbox, 'caller-code'), {});
});
