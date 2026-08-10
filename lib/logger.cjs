'use strict';

const os = require('node:os');
const path = require('node:path');


const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
const LEVEL_NAMES = Object.freeze(Object.keys(LEVELS).filter((k) => k !== 'silent'));

function _resolveLevel(name) {
  if (typeof name !== 'string') return LEVELS.info;
  const lower = name.toLowerCase();
  return LEVELS[lower] != null ? LEVELS[lower] : LEVELS.info;
}

const _HOME_PATTERNS = [
  os.homedir(),
];

const _STRING_REDACTORS = [
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { kind: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{16,}/g },
  { kind: 'aws-key-id', re: /AKIA[0-9A-Z]{12,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { kind: 'bearer', re: /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi },
  { kind: 'basic-auth', re: /(Basic\s+)[A-Za-z0-9+/=]{16,}/gi },
  { kind: 'url-userinfo', re: /([a-z]+:\/\/)[^\s/]+:[^\s/@]+@/gi },
];

function _redactString(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;
  for (const home of _HOME_PATTERNS) {
    if (home && home.length > 1) {
      const replaced = out.split(home).join('~');
      out = replaced;
    }
  }
  for (const r of _STRING_REDACTORS) {
    out = out.replace(r.re, (match, p1) =>
      p1 ? p1 + '[REDACTED:' + r.kind + ']' : '[REDACTED:' + r.kind + ']');
  }
  return out;
}

function _redactValue(v, seen) {
  if (v == null) return v;
  if (typeof v === 'string') return _redactString(v);
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return '[Buffer:' + v.length + ']';
  if (v instanceof RegExp) return String(v);
  if (typeof URL !== 'undefined' && v instanceof URL) return _redactString(v.toString());
  if (v instanceof Map) return Object.fromEntries(Array.from(v.entries(), ([k, val]) => [String(k), _redactValue(val, seen)]));
  if (v instanceof Set) return Array.from(v.values(), (x) => _redactValue(x, seen));
  if (seen.has(v)) return '[Circular]';
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => _redactValue(x, seen));
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = _redactValue(v[k], seen);
  }
  return out;
}

function _defaultSink(record) {
  try { process.stderr.write(JSON.stringify(record) + '\n'); }
  catch { /* fallback: drop — logger must never throw on its own output */ }
}

let _sink = _defaultSink;
let _envLevel = null;

function _currentLevel() {
  if (_envLevel != null) return _envLevel;
  return _resolveLevel(process.env.NUBOS_PILOT_LOG_LEVEL);
}

function setLevel(name) {
  _envLevel = _resolveLevel(name);
}

function resetLevel() {
  _envLevel = null;
}

function setSink(fn) {
  _sink = typeof fn === 'function' ? fn : _defaultSink;
}

function resetSink() {
  _sink = _defaultSink;
}

function _emit(level, msg, fields, scope) {
  const lvlValue = LEVELS[level];
  if (lvlValue == null || lvlValue < _currentLevel()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? _redactString(msg) : msg,
  };
  if (scope) record.scope = scope;
  if (fields && typeof fields === 'object') {
    const redacted = _redactValue(fields, new WeakSet());
    Object.assign(record, redacted);
  }
  _sink(record);
}

function _make(scope) {
  return {
    debug(msg, fields) { _emit('debug', msg, fields, scope); },
    info(msg, fields) { _emit('info', msg, fields, scope); },
    warn(msg, fields) { _emit('warn', msg, fields, scope); },
    error(msg, fields) { _emit('error', msg, fields, scope); },
    child(subScope) {
      const combined = scope ? scope + '.' + subScope : subScope;
      return _make(combined);
    },
  };
}

const _root = _make(null);

function child(scope) {
  return _root.child(scope);
}

function _captureSink() {
  const records = [];
  setSink((r) => records.push(r));
  return {
    records,
    restore: () => resetSink(),
  };
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  debug: _root.debug,
  info: _root.info,
  warn: _root.warn,
  error: _root.error,
  child,
  setLevel,
  resetLevel,
  setSink,
  resetSink,
  _captureSink,
  _redactString,
  _redactValue,
};
