'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lang = require('./language.cjs');

function _mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-lang-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  return dir;
}

function _writeConfig(dir, obj) {
  fs.writeFileSync(path.join(dir, '.nubos-pilot', 'config.json'), JSON.stringify(obj, null, 2));
}

test('language: normalizeLanguage lowercases and trims', () => {
  assert.equal(lang.normalizeLanguage('DE'), 'de');
  assert.equal(lang.normalizeLanguage('  En  '), 'en');
  assert.equal(lang.normalizeLanguage(''), 'en');
  assert.equal(lang.normalizeLanguage(null), 'en');
});

test('language: buildDirective returns known de/en strings', () => {
  const de = lang.buildDirective('de');
  assert.match(de, /Sprache: \*\*Deutsch\.\*\*/);
  const en = lang.buildDirective('en');
  assert.match(en, /Language: \*\*English\.\*\*/);
});

test('language: buildDirective falls back to ISO-639 template for unknown code', () => {
  const fr = lang.buildDirective('fr');
  assert.match(fr, /ISO-639 language `fr`/);
});

test('language: readConfigLanguage returns null when no config', () => {
  const dir = _mkSandbox();
  try {
    assert.equal(lang.readConfigLanguage(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('language: readConfigLanguage returns normalized value from config', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { response_language: 'DE' });
    assert.equal(lang.readConfigLanguage(dir), 'de');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('language: readConfigLanguage returns null when response_language absent', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { runtime: 'claude' });
    assert.equal(lang.readConfigLanguage(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('language: resolveLanguage defaults to en when no project root', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'np-outside-'));
  try {
    assert.equal(lang.resolveLanguage(outside), 'en');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('language: resolveDirective uses config language', () => {
  const dir = _mkSandbox();
  try {
    _writeConfig(dir, { response_language: 'de' });
    assert.match(lang.resolveDirective(dir), /Sprache: \*\*Deutsch\.\*\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('language: readConfigLanguage throws on invalid JSON', () => {
  const dir = _mkSandbox();
  try {
    fs.writeFileSync(path.join(dir, '.nubos-pilot', 'config.json'), '{not json');
    assert.throws(
      () => lang.readConfigLanguage(dir),
      (err) => err && err.code === 'language-config-parse-error',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
