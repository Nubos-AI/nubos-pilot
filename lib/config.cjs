'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { projectStateDir, findProjectRoot, NubosPilotError } = require('./core.cjs');

function configPath(cwd) {
  return path.join(projectStateDir(cwd), 'config.json');
}

function _stripBom(s) {
  while (s && s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s;
}

function _redactPath(p) {
  return p ? path.basename(p) : p;
}

function _validateFile(p) {
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw new NubosPilotError(
      'config-unreadable',
      'config.json not stat-able (' + (err && err.code) + ')',
      { file: _redactPath(p), cause: err && err.code },
    );
  }
  if (!stat.isFile()) {
    throw new NubosPilotError(
      'config-not-a-file',
      'config.json is not a regular file',
      { file: _redactPath(p), kind: stat.isDirectory() ? 'directory' : 'other' },
    );
  }
  return true;
}

function _parseConfig(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new NubosPilotError(
      'config-unreadable',
      'config.json not readable (' + (err && err.code) + ')',
      { file: _redactPath(p), cause: err && err.code },
    );
  }
  raw = _stripBom(raw);
  if (raw.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NubosPilotError(
      'config-invalid-json',
      'config.json invalid JSON: ' + (err && err.message),
      { file: _redactPath(p), cause: 'json-parse-error' },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NubosPilotError(
      'config-invalid-shape',
      'config.json top-level must be an object',
      { file: _redactPath(p), received: Array.isArray(parsed) ? 'array' : typeof parsed },
    );
  }
  return parsed;
}

const _readConfigCache = new Map();
function _cacheGet(p) {
  const entry = _readConfigCache.get(p);
  if (!entry) return null;
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs === entry.mtimeMs && st.size === entry.size) return entry.value;
  } catch { /* fall through to re-read */ }
  return null;
}
function _cacheSet(p, value) {
  try {
    const st = fs.statSync(p);
    _readConfigCache.set(p, { value, mtimeMs: st.mtimeMs, size: st.size });
  } catch { /* unable to stat — skip caching */ }
}
function _resetConfigCacheForTests() {
  _readConfigCache.clear();
}

function readConfig(cwd) {
  const p = configPath(cwd);
  if (!_validateFile(p)) return {};
  const cached = _cacheGet(p);
  if (cached) return cached;
  const parsed = _parseConfig(p);
  _warnOnSchemaViolations(parsed, p);
  _cacheSet(p, parsed);
  return parsed;
}

let _schemaWarnedOnce = new Set();
function _warnOnSchemaViolations(parsed, configFilePath) {
  let warnings;
  try {
    const schema = require('./config-schema.cjs');
    warnings = schema.validateConfig(parsed);
  } catch { return; }
  if (!warnings || warnings.length === 0) return;
  let log;
  try { log = require('./logger.cjs').child('config'); }
  catch { return; }
  for (const w of warnings) {
    const dedupeKey = w.kind + ':' + w.path;
    if (_schemaWarnedOnce.has(dedupeKey)) continue;
    _schemaWarnedOnce.add(dedupeKey);
    log.warn('config-schema violation — value ignored or coerced', {
      event: 'config-schema-violation',
      file: _redactPath(configFilePath),
      ...w,
    });
  }
}

function _resetSchemaWarnedOnceForTests() {
  _schemaWarnedOnce = new Set();
}

const _PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function readConfigPath(cwd, dottedPath, fallback) {
  const cfg = readConfig(cwd);
  const segments = dottedPath.split('.');
  let cur = cfg;
  for (const seg of segments) {
    if (_PROTOTYPE_KEYS.has(seg)) return fallback;
    if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg];
    } else {
      return fallback;
    }
  }
  return cur === undefined ? fallback : cur;
}

const _CONFIG_PARSE_CODES = new Set([
  'config-invalid-json',
  'config-invalid-shape',
  'config-not-a-file',
  'config-unreadable',
]);

function tryReadConfigPath(cwd, dottedPath, fallback, opts) {
  const onWarn = opts && typeof opts.onWarn === 'function' ? opts.onWarn : _defaultWarn;
  try {
    return readConfigPath(cwd, dottedPath, fallback);
  } catch (err) {
    if (err && err.code === 'not-in-project') return fallback;
    if (err && _CONFIG_PARSE_CODES.has(err.code)) {
      onWarn({ code: err.code, message: err.message, path: dottedPath, fallback });
      return fallback;
    }
    throw err;
  }
}

let _warnedOnce = new Set();
function _defaultWarn(info) {
  const key = info.code + ':' + info.path;
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  try {
    require('./logger.cjs').child('config').warn('config.json unusable, using fallback', {
      event: 'config-fallback',
      code: info.code,
      config_path: info.path,
      hint: 'fix .nubos-pilot/config.json to silence this warning',
    });
  } catch {}
}

function _resetWarnedOnceForTests() {
  _warnedOnce = new Set();
}

function readConfigGraceful(cwd, parseErrorCode) {
  let root;
  try {
    root = findProjectRoot(cwd || process.cwd());
  } catch (err) {
    if (err && err.code === 'not-in-project') return null;
    throw err;
  }
  const p = path.join(root, '.nubos-pilot', 'config.json');
  if (!_validateFile(p)) return null;
  try {
    return _parseConfig(p);
  } catch (err) {
    if (err && _CONFIG_PARSE_CODES.has(err.code)) {
      throw new NubosPilotError(parseErrorCode, err.message, err.details || { cause: err.code });
    }
    throw err;
  }
}

function coerceBool(raw) {
  if (raw === true || raw === false) return raw;
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

module.exports = {
  configPath,
  readConfig,
  readConfigPath,
  readConfigGraceful,
  tryReadConfigPath,
  coerceBool,
  _CONFIG_PARSE_CODES,
  _resetWarnedOnceForTests,
  _resetSchemaWarnedOnceForTests,
  _resetConfigCacheForTests,
};
