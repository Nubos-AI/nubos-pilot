'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./text-mode.cjs');

function _mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-text-mode-cli-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  return dir;
}

function _captureIO() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => { out.push(String(s)); return true; } },
    stderr: { write: (s) => { err.push(String(s)); return true; } },
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

function _clearClaudeEnv() {
  const saved = {};
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('text-mode CLI: default without config and without Claude env prints "false"', () => {
  const restore = _clearClaudeEnv();
  try {
    const dir = _mkSandbox();
    try {
      const io = _captureIO();
      const rc = subcmd.run([], { cwd: dir, stdout: io.stdout, stderr: io.stderr });
      assert.equal(rc, 0);
      assert.equal(io.stdoutText().trim(), 'false');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test('text-mode CLI: CLAUDECODE=1 prints "true"', () => {
  const restore = _clearClaudeEnv();
  try {
    process.env.CLAUDECODE = '1';
    const dir = _mkSandbox();
    try {
      const io = _captureIO();
      const rc = subcmd.run([], { cwd: dir, stdout: io.stdout, stderr: io.stderr });
      assert.equal(rc, 0);
      assert.equal(io.stdoutText().trim(), 'true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test('text-mode CLI: --json emits detail object', () => {
  const restore = _clearClaudeEnv();
  try {
    process.env.CLAUDECODE = '1';
    const dir = _mkSandbox();
    try {
      const io = _captureIO();
      const rc = subcmd.run(['--json'], { cwd: dir, stdout: io.stdout, stderr: io.stderr });
      assert.equal(rc, 0);
      const payload = JSON.parse(io.stdoutText().trim());
      assert.equal(payload.enabled, true);
      assert.equal(payload.source, 'runtime');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test('text-mode CLI: config workflow.text_mode=false wins over CLAUDECODE', () => {
  const restore = _clearClaudeEnv();
  try {
    process.env.CLAUDECODE = '1';
    const dir = _mkSandbox();
    try {
      fs.writeFileSync(
        path.join(dir, '.nubos-pilot', 'config.json'),
        JSON.stringify({ workflow: { text_mode: false } }),
      );
      const io = _captureIO();
      const rc = subcmd.run(['--json'], { cwd: dir, stdout: io.stdout, stderr: io.stderr });
      assert.equal(rc, 0);
      const payload = JSON.parse(io.stdoutText().trim());
      assert.equal(payload.enabled, false);
      assert.equal(payload.source, 'config');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test('text-mode CLI: unknown flag exits 1 with structured error', () => {
  const dir = _mkSandbox();
  try {
    const io = _captureIO();
    const rc = subcmd.run(['--wat'], { cwd: dir, stdout: io.stdout, stderr: io.stderr });
    assert.equal(rc, 1);
    const payload = JSON.parse(io.stderrText().trim());
    assert.equal(payload.code, 'text-mode-unknown-arg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
