'use strict';

const { NubosPilotError } = require('../../core.cjs');

const DEFAULTS = Object.freeze({
  minLength: 20,
  minDistinctChars: 4,
  wordRunRatio: 0.7,
  thresholds: Object.freeze({
    hex: 3.0,
    alnum: 3.6,
    base64: 4.0,
    base64url: 4.0,
    other: 3.5,
  }),
});

const HEX_RE = /^[0-9a-fA-F]+$/;
const ALNUM_RE = /^[A-Za-z0-9]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const LETTERS_RE = /^[A-Za-z]+$/;
const UUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const GIT_SHA_RE = /^(?:[0-9a-f]{7}|[0-9a-f]{8}|[0-9a-f]{40}|[0-9a-f]{64})$/;
const DATA_URI_RE = /^data:[A-Za-z]/;
const INTEGRITY_RE = /^sha(?:1|256|384|512)-/;
const LOCKFILE_NAME_RE = /(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|composer\.lock|Gemfile\.lock|Pipfile\.lock|poetry\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/;

const LOCKFILE_CONTEXTS = Object.freeze(['lockfile', 'lock', 'integrity']);

const ENCODED_IMAGE_PREFIXES = Object.freeze([
  'iVBORw0KGgo',
  '/9j/',
  'R0lGODdh',
  'R0lGODlh',
  'JVBERi0',
  'UklGRg',
  'PHN2Zw',
  'Qk1',
  'AAABAA',
  'SUkqAA',
  'TU0AK',
]);

const COMMON_WORDS = Object.freeze([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new',
  'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say',
  'she', 'too', 'use', 'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they',
  'know', 'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come',
  'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than',
  'them', 'well', 'were', 'what', 'quick', 'brown', 'jumps', 'lazy', 'dog', 'fox',
  'again', 'hello', 'world', 'password', 'secret', 'token', 'value', 'string',
  'number', 'object', 'array', 'function', 'return', 'export', 'default', 'import',
  'const', 'class', 'public', 'private', 'static', 'void', 'true', 'false', 'null',
  'name', 'type', 'data', 'test', 'list', 'item', 'user', 'admin', 'login', 'logout',
  'email', 'phone', 'address', 'city', 'state', 'country', 'first', 'last', 'middle',
  'title', 'description', 'content', 'message', 'error', 'warning', 'success',
  'failure', 'request', 'response', 'server', 'client', 'service', 'config',
  'setting', 'option', 'enable', 'disable', 'create', 'update', 'delete', 'insert',
  'select', 'where', 'order', 'group', 'limit', 'offset', 'count', 'total', 'index',
  'field', 'table', 'column', 'record', 'lorem', 'ipsum', 'dolor', 'amet', 'sit',
  'consectetur', 'adipiscing', 'elit', 'sed', 'tempor', 'magna', 'aliqua',
]);

function _requireString(value, code) {
  if (typeof value !== 'string') {
    throw new NubosPilotError(code, 'entropy helpers accept a string', { got: typeof value });
  }
  return value;
}

function shannon(str) {
  const s = _requireString(str, 'entropy-shannon-invalid-input');
  if (s.length === 0) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function classifyCharset(str) {
  const s = _requireString(str, 'entropy-charset-invalid-input');
  if (s.length === 0) return 'other';
  if (HEX_RE.test(s)) return 'hex';
  if (ALNUM_RE.test(s)) return 'alnum';
  if (BASE64URL_RE.test(s)) return 'base64url';
  if (BASE64_RE.test(s)) return 'base64';
  return 'other';
}

function _distinctChars(str) {
  return new Set(str).size;
}

function _isEncodedImage(str) {
  for (const prefix of ENCODED_IMAGE_PREFIXES) {
    if (str.startsWith(prefix)) return true;
  }
  return false;
}

function _isLockfileContext(opts) {
  if (typeof opts.context === 'string' && LOCKFILE_CONTEXTS.includes(opts.context)) return true;
  return typeof opts.filePath === 'string' && LOCKFILE_NAME_RE.test(opts.filePath.replace(/\\/g, '/'));
}

function _wordCoverage(str) {
  if (!LETTERS_RE.test(str)) return 0;
  const lower = str.toLowerCase();
  let covered = 0;
  let i = 0;
  while (i < lower.length) {
    let best = 0;
    for (const word of COMMON_WORDS) {
      if (word.length > best && lower.startsWith(word, i)) best = word.length;
    }
    if (best > 0) {
      covered += best;
      i += best;
    } else {
      i += 1;
    }
  }
  return covered / lower.length;
}

function _number(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isHighEntropy(str, opts) {
  const o = opts || {};
  const s = typeof str === 'string' ? str : '';
  const minLength = _number(o.minLength, DEFAULTS.minLength);
  if (s.length < minLength) return false;
  if (_distinctChars(s) < _number(o.minDistinctChars, DEFAULTS.minDistinctChars)) return false;
  if (UUID_RE.test(s)) return false;
  if (DATA_URI_RE.test(s)) return false;
  if (INTEGRITY_RE.test(s)) return false;
  if (_isEncodedImage(s)) return false;
  if (_isLockfileContext(o) && GIT_SHA_RE.test(s)) return false;
  if (_wordCoverage(s) >= _number(o.wordRunRatio, DEFAULTS.wordRunRatio)) return false;

  const charset = classifyCharset(s);
  const thresholds = o.thresholds && typeof o.thresholds === 'object' ? o.thresholds : null;
  const threshold = _number(
    thresholds ? thresholds[charset] : undefined,
    _number(DEFAULTS.thresholds[charset], DEFAULTS.thresholds.other),
  );
  return shannon(s) >= threshold;
}

module.exports = { shannon, isHighEntropy, classifyCharset, DEFAULTS };
