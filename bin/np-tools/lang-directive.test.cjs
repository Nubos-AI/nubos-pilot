'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const subcmd = require('./lang-directive.cjs');

function _capture() {
  let out = '';
  let err = '';
  const stdout = { write: (s) => { out += s; return true; } };
  const stderr = { write: (s) => { err += s; return true; } };
  return { stdout, stderr, getOut: () => out, getErr: () => err };
}

function _mkProject(language) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-lang-cli-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  const cfg = language ? { response_language: language } : {};
  fs.writeFileSync(path.join(dir, '.nubos-pilot', 'config.json'), JSON.stringify(cfg));
  return dir;
}

test('lang-directive: default prints plain directive text', () => {
  const dir = _mkProject('de');
  try {
    const cap = _capture();
    const rc = subcmd.run([], { cwd: dir, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(rc, 0);
    assert.match(cap.getOut(), /Sprache: \*\*Deutsch\.\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lang-directive: --json emits language+directive payload', () => {
  const dir = _mkProject('de');
  try {
    const cap = _capture();
    const rc = subcmd.run(['--json'], { cwd: dir, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(rc, 0);
    const parsed = JSON.parse(cap.getOut());
    assert.equal(parsed.language, 'de');
    assert.match(parsed.directive, /Sprache: \*\*Deutsch\.\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lang-directive: --lang overrides config', () => {
  const dir = _mkProject('de');
  try {
    const cap = _capture();
    const rc = subcmd.run(['--lang', 'en'], { cwd: dir, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(rc, 0);
    assert.match(cap.getOut(), /Language: \*\*English\.\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lang-directive: defaults to en when no config entry', () => {
  const dir = _mkProject(null);
  try {
    const cap = _capture();
    const rc = subcmd.run([], { cwd: dir, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(rc, 0);
    assert.match(cap.getOut(), /Language: \*\*English\.\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lang-directive: unknown arg returns error code', () => {
  const dir = _mkProject(null);
  try {
    const cap = _capture();
    const rc = subcmd.run(['--nope'], { cwd: dir, stdout: cap.stdout, stderr: cap.stderr });
    assert.equal(rc, 1);
    const parsed = JSON.parse(cap.getErr().trim());
    assert.equal(parsed.code, 'lang-directive-unknown-arg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
