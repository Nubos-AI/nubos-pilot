'use strict';

const { NubosPilotError } = require('../../../core.cjs');

const MAX_DEPTH = 24;
const MAX_STEPS = 200000;
const MAX_RAW = 200;
const SKIPPED_BLOCK_TYPES = Object.freeze(['dynamic']);
const SKIPPED_ATTRIBUTES = Object.freeze(['for_each', 'count']);
const IDENT_START_RE = /[A-Za-z_]/;
const IDENT_RE = /[A-Za-z0-9_-]/;
const NUMBER_RE = /^[-+]?(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/;
const FOR_EXPRESSION_RE = /^[[{]\s*for\b/;
const CALL_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*\(/;
const ESCAPES = Object.freeze({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' });

function _lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function _lineAt(ctx, index) {
  const starts = ctx.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function _warn(ctx, code) {
  if (!ctx.warnings.includes(code)) ctx.warnings.push(code);
}

function _unresolved(construct, raw) {
  const value = { unresolved: true, construct };
  if (typeof raw === 'string' && raw !== '') value.raw = raw.length > MAX_RAW ? raw.slice(0, MAX_RAW) : raw;
  return value;
}

function _isUnresolved(value) {
  return !!value && typeof value === 'object' && value.unresolved === true;
}

function _skipSpaces(ctx) {
  while (ctx.p < ctx.src.length && (ctx.src[ctx.p] === ' ' || ctx.src[ctx.p] === '\t' || ctx.src[ctx.p] === '\r')) ctx.p += 1;
}

function _skipToLineEnd(ctx) {
  const nl = ctx.src.indexOf('\n', ctx.p);
  ctx.p = nl < 0 ? ctx.src.length : nl + 1;
}

function _skipTrivia(ctx) {
  const src = ctx.src;
  while (ctx.p < src.length) {
    const ch = src[ctx.p];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { ctx.p += 1; continue; }
    if (ch === '#' || (ch === '/' && src[ctx.p + 1] === '/')) { _skipToLineEnd(ctx); continue; }
    if (ch === '/' && src[ctx.p + 1] === '*') {
      const end = src.indexOf('*/', ctx.p + 2);
      if (end < 0) { _warn(ctx, 'unterminated-comment'); ctx.p = src.length; continue; }
      ctx.p = end + 2;
      continue;
    }
    return;
  }
}

function _atValueTerminator(ctx) {
  const ch = ctx.src[ctx.p];
  if (ch === undefined) return true;
  if (ch === '\n' || ch === ',' || ch === ']' || ch === '}' || ch === ')' || ch === '#') return true;
  return ch === '/' && (ctx.src[ctx.p + 1] === '/' || ctx.src[ctx.p + 1] === '*');
}

function _readIdentifier(ctx) {
  const src = ctx.src;
  if (ctx.p >= src.length || !IDENT_START_RE.test(src[ctx.p])) return null;
  const start = ctx.p;
  while (ctx.p < src.length && IDENT_RE.test(src[ctx.p])) ctx.p += 1;
  return src.slice(start, ctx.p);
}

function _readInterpolation(ctx) {
  const src = ctx.src;
  const start = ctx.p;
  ctx.p += 2;
  let depth = 1;
  while (ctx.p < src.length && depth > 0) {
    const ch = src[ctx.p];
    if (ch === '"') { _readQuoted(ctx); continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '\n' && depth > 0) { _warn(ctx, 'unterminated-interpolation'); break; }
    ctx.p += 1;
  }
  return src.slice(start, ctx.p);
}

function _readQuoted(ctx) {
  const src = ctx.src;
  ctx.p += 1;
  let value = '';
  let interpolated = false;
  let terminated = false;
  while (ctx.p < src.length) {
    const ch = src[ctx.p];
    if (ch === '\\') {
      const next = src[ctx.p + 1];
      if (next === undefined) { ctx.p += 1; break; }
      value += ESCAPES[next] === undefined ? next : ESCAPES[next];
      ctx.p += 2;
      continue;
    }
    if (ch === '"') { ctx.p += 1; terminated = true; break; }
    if (ch === '\n') break;
    if ((ch === '$' || ch === '%') && src[ctx.p + 1] === ch && src[ctx.p + 2] === '{') {
      value += ch + '{';
      ctx.p += 3;
      continue;
    }
    if ((ch === '$' || ch === '%') && src[ctx.p + 1] === '{') {
      interpolated = true;
      value += _readInterpolation(ctx);
      continue;
    }
    value += ch;
    ctx.p += 1;
  }
  return { value, interpolated, terminated };
}

function _dedent(lines) {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const leading = /^[ \t]*/.exec(line)[0].length;
    if (leading < indent) indent = leading;
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => line.slice(indent));
}

function _readHeredoc(ctx) {
  const src = ctx.src;
  ctx.p += 2;
  let indented = false;
  if (src[ctx.p] === '-') { indented = true; ctx.p += 1; }
  const quoted = src[ctx.p] === '"';
  if (quoted) ctx.p += 1;
  const delimiter = _readIdentifier(ctx);
  if (quoted && src[ctx.p] === '"') ctx.p += 1;
  if (!delimiter) {
    _warn(ctx, 'malformed-heredoc');
    _skipToLineEnd(ctx);
    return { value: '', interpolated: false, terminated: false };
  }
  _skipToLineEnd(ctx);
  const lines = [];
  let terminated = false;
  while (ctx.p < src.length) {
    const nl = src.indexOf('\n', ctx.p);
    const end = nl < 0 ? src.length : nl;
    const line = src.slice(ctx.p, end);
    ctx.p = nl < 0 ? src.length : nl + 1;
    if (line.trim() === delimiter) { terminated = true; break; }
    lines.push(line);
  }
  if (!terminated) _warn(ctx, 'unterminated-heredoc');
  const body = (indented ? _dedent(lines) : lines).join('\n');
  return { value: body, interpolated: /(?:^|[^$])\$\{/.test(body), terminated };
}

function _consumeRegion(ctx) {
  const src = ctx.src;
  const start = ctx.p;
  let depth = 0;
  while (ctx.p < src.length) {
    const ch = src[ctx.p];
    if (ch === '"') { _readQuoted(ctx); continue; }
    if (ch === '<' && src[ctx.p + 1] === '<') { _readHeredoc(ctx); continue; }
    if (ch === '/' && src[ctx.p + 1] === '*') {
      const end = src.indexOf('*/', ctx.p + 2);
      ctx.p = end < 0 ? src.length : end + 2;
      continue;
    }
    if (depth === 0 && (ch === '#' || (ch === '/' && src[ctx.p + 1] === '/'))) break;
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; ctx.p += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
      ctx.p += 1;
      continue;
    }
    if (depth === 0 && (ch === '\n' || ch === ',')) break;
    ctx.p += 1;
  }
  return src.slice(start, ctx.p).trim();
}

function _consumeBracketed(ctx) {
  const src = ctx.src;
  const start = ctx.p;
  let depth = 0;
  while (ctx.p < src.length) {
    const ch = src[ctx.p];
    if (ch === '"') { _readQuoted(ctx); continue; }
    if (ch === '<' && src[ctx.p + 1] === '<') { _readHeredoc(ctx); continue; }
    if (ch === '#' || (ch === '/' && src[ctx.p + 1] === '/')) { _skipToLineEnd(ctx); continue; }
    if (ch === '/' && src[ctx.p + 1] === '*') {
      const end = src.indexOf('*/', ctx.p + 2);
      ctx.p = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; ctx.p += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      ctx.p += 1;
      if (depth <= 0) break;
      continue;
    }
    ctx.p += 1;
  }
  if (depth > 0) _warn(ctx, 'unclosed-block');
  return src.slice(start, ctx.p);
}

function _finishValue(ctx, value) {
  _skipSpaces(ctx);
  if (_atValueTerminator(ctx)) return value;
  const raw = _consumeRegion(ctx);
  const construct = raw.startsWith('?') ? 'ternary' : 'expression';
  _warn(ctx, 'unresolved-construct:' + construct);
  return _isUnresolved(value) ? value : _unresolved(construct, raw);
}

function _parseList(ctx, depth) {
  const src = ctx.src;
  ctx.p += 1;
  const out = [];
  for (;;) {
    if ((ctx.steps += 1) > MAX_STEPS) throw new Error('hcl-step-limit');
    _skipTrivia(ctx);
    if (ctx.p >= src.length) { _warn(ctx, 'unclosed-list'); return out; }
    if (src[ctx.p] === ']') { ctx.p += 1; return out; }
    if (src[ctx.p] === ',') { ctx.p += 1; continue; }
    const before = ctx.p;
    out.push(_parseValue(ctx, depth + 1));
    if (ctx.p === before) { _warn(ctx, 'unparsable-list-element'); ctx.p += 1; }
  }
}

function _parseMap(ctx, depth) {
  const src = ctx.src;
  ctx.p += 1;
  const out = {};
  for (;;) {
    if ((ctx.steps += 1) > MAX_STEPS) throw new Error('hcl-step-limit');
    _skipTrivia(ctx);
    if (ctx.p >= src.length) { _warn(ctx, 'unclosed-map'); return out; }
    if (src[ctx.p] === '}') { ctx.p += 1; return out; }
    if (src[ctx.p] === ',') { ctx.p += 1; continue; }
    const key = src[ctx.p] === '"' ? _readQuoted(ctx).value : _readIdentifier(ctx);
    if (!key) { _warn(ctx, 'unparsable-map-key'); _skipToLineEnd(ctx); continue; }
    _skipTrivia(ctx);
    if (src[ctx.p] !== '=' && src[ctx.p] !== ':') { _warn(ctx, 'map-entry-without-value'); continue; }
    ctx.p += 1;
    out[key] = _parseValue(ctx, depth + 1);
  }
}

function _parseValue(ctx, depth) {
  const src = ctx.src;
  _skipTrivia(ctx);
  if (ctx.p >= src.length) {
    _warn(ctx, 'missing-value');
    return _unresolved('malformed');
  }
  if (depth > ctx.maxDepth) {
    _warn(ctx, 'nesting-too-deep');
    return _unresolved('malformed', _consumeRegion(ctx));
  }
  const ch = src[ctx.p];
  if (ch === '"') {
    const quoted = _readQuoted(ctx);
    if (!quoted.terminated) _warn(ctx, 'unterminated-string');
    if (quoted.interpolated) {
      _warn(ctx, 'unresolved-construct:interpolation');
      return _finishValue(ctx, _unresolved('interpolation', quoted.value));
    }
    return _finishValue(ctx, quoted.value);
  }
  if (ch === '<' && src[ctx.p + 1] === '<') {
    const heredoc = _readHeredoc(ctx);
    if (heredoc.interpolated) {
      _warn(ctx, 'unresolved-construct:interpolation');
      return _unresolved('interpolation', heredoc.value);
    }
    return heredoc.value;
  }
  if (FOR_EXPRESSION_RE.test(src.slice(ctx.p, ctx.p + 8))) {
    const raw = _consumeBracketed(ctx);
    _warn(ctx, 'unresolved-construct:for_expression');
    return _unresolved('for_expression', raw);
  }
  if (ch === '[') return _finishValue(ctx, _parseList(ctx, depth));
  if (ch === '{') return _finishValue(ctx, _parseMap(ctx, depth));
  if (/[0-9]/.test(ch) || ((ch === '-' || ch === '+') && /[0-9]/.test(src[ctx.p + 1] || ''))) {
    const m = NUMBER_RE.exec(src.slice(ctx.p));
    if (m) {
      ctx.p += m[0].length;
      return _finishValue(ctx, Number(m[0]));
    }
  }
  if (IDENT_START_RE.test(ch)) {
    const start = ctx.p;
    const word = _readIdentifier(ctx);
    const rest = src.slice(ctx.p);
    if ((word === 'true' || word === 'false' || word === 'null') && !/^\s*[(.[]/.test(rest)) {
      return _finishValue(ctx, word === 'null' ? null : word === 'true');
    }
    ctx.p = start;
    const isCall = CALL_RE.test(src.slice(start));
    const raw = _consumeRegion(ctx);
    const construct = isCall ? 'function_call' : 'reference';
    _warn(ctx, 'unresolved-construct:' + construct + ':' + word);
    return _unresolved(construct, raw);
  }
  const raw = _consumeRegion(ctx);
  if (raw === '') {
    _warn(ctx, 'missing-value');
    _skipToLineEnd(ctx);
    return _unresolved('malformed');
  }
  _warn(ctx, 'unresolved-construct:expression');
  return _unresolved('expression', raw);
}

function _parseBody(ctx, depth, expectClose, attributes, blocks) {
  const src = ctx.src;
  for (;;) {
    if ((ctx.steps += 1) > MAX_STEPS) throw new Error('hcl-step-limit');
    _skipTrivia(ctx);
    if (ctx.p >= src.length) {
      if (expectClose) _warn(ctx, 'unclosed-block');
      return;
    }
    if (src[ctx.p] === '}') {
      ctx.p += 1;
      if (!expectClose) _warn(ctx, 'unexpected-closing-brace');
      return;
    }
    if (src[ctx.p] === ',' || src[ctx.p] === ';') { ctx.p += 1; continue; }
    const line = _lineAt(ctx, ctx.p);
    const name = src[ctx.p] === '"' ? _readQuoted(ctx).value : _readIdentifier(ctx);
    if (!name) {
      _warn(ctx, 'unexpected-character');
      _skipToLineEnd(ctx);
      continue;
    }
    _skipSpaces(ctx);
    if (src[ctx.p] === '=' && src[ctx.p + 1] !== '=') {
      ctx.p += 1;
      if (SKIPPED_ATTRIBUTES.includes(name)) {
        _skipTrivia(ctx);
        const raw = _consumeRegion(ctx);
        _warn(ctx, 'unresolved-construct:' + name);
        attributes[name] = _unresolved(name, raw);
        continue;
      }
      attributes[name] = _parseValue(ctx, depth);
      continue;
    }
    const labels = [];
    for (;;) {
      _skipSpaces(ctx);
      if (src[ctx.p] === '"') { labels.push(_readQuoted(ctx).value); continue; }
      if (ctx.p < src.length && IDENT_START_RE.test(src[ctx.p])) { labels.push(_readIdentifier(ctx)); continue; }
      break;
    }
    if (src[ctx.p] !== '{') {
      _warn(ctx, 'missing-block-body');
      _skipToLineEnd(ctx);
      continue;
    }
    if (SKIPPED_BLOCK_TYPES.includes(name)) {
      _warn(ctx, 'skipped-block:' + name);
      _consumeBracketed(ctx);
      continue;
    }
    if (depth + 1 > ctx.maxDepth) {
      _warn(ctx, 'nesting-too-deep');
      _consumeBracketed(ctx);
      continue;
    }
    ctx.p += 1;
    const block = { type: name, labels, attributes: {}, blocks: [], line };
    blocks.push(block);
    _parseBody(ctx, depth + 1, true, block.attributes, block.blocks);
  }
}

function parseHcl(text, opts) {
  if (text != null && typeof text !== 'string') {
    throw new NubosPilotError(
      'scan-hcl-invalid-input',
      'parseHcl expects string input (got: ' + typeof text + ')',
      { type: typeof text },
    );
  }
  const o = opts || {};
  const src = String(text == null ? '' : text);
  const ctx = {
    src,
    lineStarts: _lineStarts(src),
    warnings: [],
    maxDepth: Number.isInteger(o.maxDepth) && o.maxDepth > 0 ? o.maxDepth : MAX_DEPTH,
    p: 0,
    steps: 0,
  };
  const blocks = [];
  const topLevelAttributes = {};
  try {
    _parseBody(ctx, 0, false, topLevelAttributes, blocks);
  } catch {
    _warn(ctx, 'parser-aborted');
  }
  if (Object.keys(topLevelAttributes).length) _warn(ctx, 'top-level-attribute');
  return { blocks, warnings: ctx.warnings };
}

module.exports = { parseHcl };
