'use strict';

const { NubosPilotError } = require('../../core.cjs');

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const SKIP_LINE = Symbol('toml-skip-line');

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;

const NUMBER = /[+-]?[0-9][0-9_]*(?:\.[0-9][0-9_]*)?/y;

const ESCAPES = new Map([
  ['b', '\b'],
  ['t', '\t'],
  ['n', '\n'],
  ['f', '\f'],
  ['r', '\r'],
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
]);

function own(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
}

function setKey(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function isBoundary(ch) {
  return ch === undefined
    || ch === ' '
    || ch === '\t'
    || ch === '\n'
    || ch === '#'
    || ch === ','
    || ch === ']'
    || ch === '}';
}

function parseToml(text, opts) {
  const options = opts || {};
  const raw = text == null ? '' : String(text);
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > maxBytes) {
    throw new NubosPilotError(
      'toml-too-large',
      'TOML input of ' + bytes + ' bytes exceeds the ' + maxBytes + ' byte cap',
      { bytes, maxBytes },
    );
  }

  const src = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n/g, '\n');
  const end = src.length;
  const root = {};
  let pos = 0;
  let table = root;

  function bail() {
    throw SKIP_LINE;
  }

  function startsWith(token) {
    return src.startsWith(token, pos);
  }

  function skipSpaces() {
    while (pos < end && (src[pos] === ' ' || src[pos] === '\t')) pos += 1;
  }

  function skipComment() {
    if (src[pos] !== '#') return;
    while (pos < end && src[pos] !== '\n') pos += 1;
  }

  function skipToNextLine() {
    while (pos < end && src[pos] !== '\n') pos += 1;
    if (pos < end) pos += 1;
  }

  function skipTrivia() {
    for (;;) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n') { pos += 1; continue; }
      if (ch === '#') { skipComment(); continue; }
      return;
    }
  }

  function readHexEscape(digits) {
    const hex = src.slice(pos, pos + digits);
    if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) bail();
    const code = parseInt(hex, 16);
    if (code > 0x10ffff) bail();
    pos += digits;
    return String.fromCodePoint(code);
  }

  function readBasicString(multiline) {
    const delim = multiline ? '"""' : '"';
    pos += delim.length;
    if (multiline && src[pos] === '\n') pos += 1;
    let out = '';
    for (;;) {
      if (pos >= end) bail();
      if (startsWith(delim)) { pos += delim.length; return out; }
      const ch = src[pos];
      if (ch === '\n' && !multiline) bail();
      if (ch !== '\\') { out += ch; pos += 1; continue; }
      pos += 1;
      const esc = src[pos];
      if (esc === 'u') { pos += 1; out += readHexEscape(4); continue; }
      if (esc === 'U') { pos += 1; out += readHexEscape(8); continue; }
      if (multiline && (esc === '\n' || esc === ' ' || esc === '\t')) {
        while (pos < end && (src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\n')) pos += 1;
        continue;
      }
      if (!ESCAPES.has(esc)) bail();
      out += ESCAPES.get(esc);
      pos += 1;
    }
  }

  function readLiteralString(multiline) {
    const delim = multiline ? "'''" : "'";
    pos += delim.length;
    if (multiline && src[pos] === '\n') pos += 1;
    const from = pos;
    const close = src.indexOf(delim, pos);
    if (close === -1) bail();
    if (!multiline) {
      const newline = src.indexOf('\n', pos);
      if (newline !== -1 && newline < close) bail();
    }
    pos = close + delim.length;
    return src.slice(from, close);
  }

  function readString() {
    if (startsWith('"""')) return readBasicString(true);
    if (startsWith("'''")) return readLiteralString(true);
    if (src[pos] === '"') return readBasicString(false);
    if (src[pos] === "'") return readLiteralString(false);
    return bail();
  }

  function readNumber() {
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(src);
    if (!match) bail();
    pos = NUMBER.lastIndex;
    if (!isBoundary(src[pos])) bail();
    const value = Number(match[0].replace(/_/g, ''));
    if (!Number.isFinite(value)) bail();
    return value;
  }

  function readKey() {
    if (src[pos] === '"' || src[pos] === "'") return readString();
    const from = pos;
    while (pos < end && BARE_KEY_CHAR.test(src[pos])) pos += 1;
    if (pos === from) bail();
    return src.slice(from, pos);
  }

  function readArray() {
    pos += 1;
    const items = [];
    for (;;) {
      skipTrivia();
      if (pos >= end) bail();
      if (src[pos] === ']') { pos += 1; return items; }
      items.push(readValue());
      skipTrivia();
      if (src[pos] === ',') { pos += 1; continue; }
      if (src[pos] === ']') { pos += 1; return items; }
      bail();
    }
  }

  function readInlineTable() {
    pos += 1;
    const result = {};
    for (;;) {
      skipTrivia();
      if (pos >= end) bail();
      if (src[pos] === '}') { pos += 1; return result; }
      const key = readKey();
      skipSpaces();
      if (src[pos] !== '=') bail();
      pos += 1;
      skipSpaces();
      setKey(result, key, readValue());
      skipTrivia();
      if (src[pos] === ',') { pos += 1; continue; }
      if (src[pos] === '}') { pos += 1; return result; }
      bail();
    }
  }

  function readValue() {
    const ch = src[pos];
    if (ch === '"' || ch === "'") return readString();
    if (ch === '[') return readArray();
    if (ch === '{') return readInlineTable();
    if (startsWith('true') && isBoundary(src[pos + 4])) { pos += 4; return true; }
    if (startsWith('false') && isBoundary(src[pos + 5])) { pos += 5; return false; }
    return readNumber();
  }

  function readKeyPath() {
    const parts = [readKey()];
    for (;;) {
      skipSpaces();
      if (src[pos] !== '.') return parts;
      pos += 1;
      skipSpaces();
      parts.push(readKey());
    }
  }

  function descend(parts) {
    let node = root;
    for (const part of parts) {
      let child = own(node, part);
      if (Array.isArray(child)) child = child[child.length - 1];
      if (child === null || typeof child !== 'object') {
        child = {};
        setKey(node, part, child);
      }
      node = child;
    }
    return node;
  }

  function openTableHeader() {
    pos += 1;
    skipSpaces();
    const parts = readKeyPath();
    skipSpaces();
    if (src[pos] !== ']') bail();
    pos += 1;
    table = descend(parts);
  }

  function openArrayTableHeader() {
    pos += 2;
    skipSpaces();
    const parts = readKeyPath();
    skipSpaces();
    if (!startsWith(']]')) bail();
    pos += 2;
    const key = parts[parts.length - 1];
    const parent = descend(parts.slice(0, -1));
    let entries = own(parent, key);
    if (!Array.isArray(entries)) {
      entries = [];
      setKey(parent, key, entries);
    }
    const entry = {};
    entries.push(entry);
    table = entry;
  }

  function readAssignment() {
    const key = readKey();
    skipSpaces();
    if (src[pos] !== '=') bail();
    pos += 1;
    skipSpaces();
    setKey(table, key, readValue());
  }

  while (pos < end) {
    skipTrivia();
    if (pos >= end) break;
    const lineStart = pos;
    try {
      if (startsWith('[[')) openArrayTableHeader();
      else if (src[pos] === '[') openTableHeader();
      else readAssignment();
      skipSpaces();
      skipComment();
      if (pos < end && src[pos] !== '\n') skipToNextLine();
    } catch (err) {
      if (err !== SKIP_LINE) throw err;
      pos = lineStart;
      skipToNextLine();
    }
  }

  return root;
}

module.exports = { parseToml };
