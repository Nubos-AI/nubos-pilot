'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tm = require('./text-mode.cjs');

function _mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-textmode-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  return dir;
}

function _writeConfig(dir, obj) {
  fs.writeFileSync(path.join(dir, '.nubos-pilot', 'config.json'), JSON.stringify(obj, null, 2));
}

test('text-mode: default without config or runtime env is false', () => {
  const dir = _mkSandbox();
  try {
    assert.equal(tm.resolveTextMode(dir, {}), false);
    const detail = tm.resolveTextModeDetail(dir, {});
    assert.deepEqual(detail, { enabled: false, source: 'default' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: CLAUDECODE=1 in env flips default to true', () => {
  const dir = _mkSandbox();
  try {
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: '1' }), true);
    const detail = tm.resolveTextModeDetail(dir, { CLAUDECODE: '1' });
    assert.deepEqual(detail, { enabled: true, source: 'runtime' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: CLAUDE_CODE_ENTRYPOINT non-empty flips to true', () => {
  const dir = _mkSandbox();
  try {
    assert.equal(tm.resolveTextMode(dir, { CLAUDE_CODE_ENTRYPOINT: 'cli' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: env value "0" or "false" does not flip', () => {
  const dir = _mkSandbox();
  try {
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: '0' }), false);
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: 'false' }), false);
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: '' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: config workflow.text_mode=true wins over absent runtime', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { workflow: { text_mode: true } });
    assert.equal(tm.resolveTextMode(dir, {}), true);
    assert.deepEqual(tm.resolveTextModeDetail(dir, {}), { enabled: true, source: 'config' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: config workflow.text_mode=false overrides CLAUDECODE runtime', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { workflow: { text_mode: false } });
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: '1' }), false);
    assert.deepEqual(
      tm.resolveTextModeDetail(dir, { CLAUDECODE: '1' }),
      { enabled: false, source: 'config' },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: config workflow.text_mode="true" string coerced to boolean', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { workflow: { text_mode: 'true' } });
    assert.equal(tm.resolveTextMode(dir, {}), true);
    _writeConfig(dir, { workflow: { text_mode: '0' } });
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: '1' }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: config missing workflow.text_mode falls through to runtime detection', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { response_language: 'de' });
    assert.equal(tm.resolveTextMode(dir, { CLAUDECODE: '1' }), true);
    assert.equal(tm.resolveTextMode(dir, {}), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: readConfigTextMode returns null outside project root', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'np-outside-'));
  try {
    assert.equal(tm.readConfigTextMode(outside), null);
    assert.equal(tm.resolveTextMode(outside, {}), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('text-mode: readConfigTextMode throws on invalid JSON', () => {
  const dir = _mkSandbox();
  try {
    fs.writeFileSync(path.join(dir, '.nubos-pilot', 'config.json'), '{not json');
    assert.throws(
      () => tm.readConfigTextMode(dir),
      (err) => err && err.code === 'text-mode-config-parse-error',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('text-mode: detectRuntimeTextMode honors multiple env keys', () => {
  assert.equal(tm.detectRuntimeTextMode({ CLAUDECODE: '1' }), true);
  assert.equal(tm.detectRuntimeTextMode({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), true);
  assert.equal(tm.detectRuntimeTextMode({ OTHER: '1' }), false);
  assert.equal(tm.detectRuntimeTextMode({}), false);
});
