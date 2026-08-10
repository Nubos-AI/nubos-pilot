'use strict';

const MIN_BLOCK_BYTES = 2048;
const MAX_RATIO = 0.9;

const JSON_MIN_ITEMS = 20;
const JSON_KEEP_HEAD = 5;
const JSON_KEEP_TAIL = 3;
const JSON_TARGET_RATIO = 0.3;

const SEARCH_MAX_FILES = 15;
const SEARCH_MAX_PER_FILE = 5;
const SEARCH_MAX_TOTAL = 30;

const DIFF_CONTEXT = 2;

const CODE_SIG_RE = /(^|[\s(])(function|class|def|func|fn|interface|struct|impl|enum|namespace|trait|module|public|private|protected|static|async|export|import|const|let|var|type)\b|=>\s*\{|\)\s*\{\s*$/;
const CODE_OPEN_RE = /\{\s*$/;
const CODE_KEEP_RE = /\b(throw|TODO|FIXME|XXX|HACK)\b/i;
const CODE_MIN_LINES = 15;
const CODE_ISH_RE = /[{}]|;\s*$/;
const CODE_ISH_RATIO = 0.6;

const PY_HEADER_RE = /^\s*(@|async\s+def\s|def\s|class\s|if\s|elif\s|else\b|for\s|while\s|with\s|try\b|except\b|finally\b)/;
const PY_KEEP_RE = /\b(raise|assert|TODO|FIXME|XXX|HACK)\b/;
const PY_SIG_RE = /^\s*(@|async\s+def\s|def\s|class\s)/;

const PROSE_MIN_BYTES = 800;
const PROSE_MIN_SENTENCES = 8;
const PROSE_KEEP_HEAD = 3;
const PROSE_KEEP_TAIL = 2;
const PROSE_TARGET_RATIO = 0.4;
const PROSE_ALPHA_RATIO = 0.6;
const PROSE_CRITICAL_RE = /\b(ERROR|FAIL(ED|URE)?|FATAL|WARN(ING)?|TODO|FIXME|XXX|HACK|must|important|note|caveat|deprecated|do not|never|always)\b/i;

const ERROR_RE = /\b(ERROR|FAIL(ED|URE)?|FATAL|Exception|Traceback|panic|AssertionError|assert(ion)? failed)\b/i;
const STACK_RE = /^\s+(at\s|File "|\.{3}|[A-Za-z_$][\w$.]*\s*\()/;
const WARN_RE = /\bWARN(ING)?\b/i;
const SEARCH_LINE_RE = /^(.+?):(\d+):/;
const SEARCH_DETECT_RE = /^(?:[^\s:]*\/[^\s:]*|[^\s:]+\.[A-Za-z0-9]+):(\d+):/;
const VALUE_ERROR_RE = /\b(error|fail|fatal|exception|denied|invalid|timeout)\b/i;
const GUTTER_RE = /^\s*\d+\t/;

function _bytes(s) {
  return Buffer.byteLength(s, 'utf-8');
}

function _maskLiterals(line) {
  return line
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '')
    .replace(/#.*$/, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function _maskedLines(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map(_maskLiterals);
}

function _indentWidth(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

function _looksLikePython(lines) {
  let nonEmpty = 0;
  let braces = 0;
  let hasSig = false;
  let colonHdr = false;
  for (const l of lines) {
    if (!l.trim()) continue;
    nonEmpty += 1;
    braces += (_maskLiterals(l).match(/[{}]/g) || []).length;
    if (PY_SIG_RE.test(l)) hasSig = true;
    if (/:\s*$/.test(l) && PY_HEADER_RE.test(l)) colonHdr = true;
  }
  if (nonEmpty < CODE_MIN_LINES || !hasSig || !colonHdr) return false;
  return braces <= nonEmpty * 0.1;
}

function _splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function _looksLikeProse(text) {
  if (_bytes(text) < PROSE_MIN_BYTES) return false;
  if (_splitSentences(text).length < PROSE_MIN_SENTENCES) return false;
  const alpha = (text.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  const compact = text.replace(/\s/g, '');
  if (!compact.length) return false;
  return alpha >= compact.length * PROSE_ALPHA_RATIO;
}

function _degutter(text) {
  const lines = text.split('\n');
  let hits = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (!l) continue;
    nonEmpty += 1;
    if (GUTTER_RE.test(l)) hits += 1;
  }
  if (nonEmpty === 0 || hits < nonEmpty * 0.8) return text;
  return lines.map((l) => l.replace(GUTTER_RE, '')).join('\n');
}

function marker(hash, note) {
  return '⟦elided:' + hash + ' ' + note + ' · retrieve: nubos elision-get ' + hash + '⟧';
}

function _marker(hash, dropped, unit, summary) {
  const note = dropped + ' ' + unit + ' elided' + (summary ? ' · ' + summary : '');
  return marker(hash, note);
}

function _gapNote(n, unit) {
  return '… ' + n + ' ' + unit + (n === 1 ? '' : 's') + ' elided …';
}

function _renderGaps(items, keepIdx, joiner, unit) {
  const out = [];
  let gap = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (keepIdx.has(i)) {
      if (gap > 0) { out.push(_gapNote(gap, unit)); gap = 0; }
      out.push(items[i]);
    } else {
      gap += 1;
    }
  }
  if (gap > 0) out.push(_gapNote(gap, unit));
  return out.join(joiner);
}

function detectType(text) {
  if (typeof text !== 'string' || !text.length) return 'plain';
  const t = _degutter(text);
  const trimmed = t.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return 'json-array';
      return 'plain';
    } catch { return _detectNonJson(t); }
  }
  return _detectNonJson(t);
}

function _looksLikeCode(lines) {
  if (lines.length < CODE_MIN_LINES) return false;
  let openBlocks = 0;
  let codeish = 0;
  let nonEmpty = 0;
  let open = 0;
  let close = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    nonEmpty += 1;
    const masked = _maskLiterals(l);
    if (CODE_OPEN_RE.test(masked)) openBlocks += 1;
    open += (masked.match(/\{/g) || []).length;
    close += (masked.match(/\}/g) || []).length;
    if (CODE_SIG_RE.test(l) || CODE_ISH_RE.test(l)) codeish += 1;
  }
  if (openBlocks < 1 || nonEmpty === 0) return false;
  if (Math.abs(open - close) > 2) return false;
  return codeish >= nonEmpty * CODE_ISH_RATIO;
}

function _detectNonJson(text) {
  if (/^---\s/m.test(text) && /^\+\+\+\s/m.test(text) && /^@@ /m.test(text)) return 'diff';
  const lines = text.split('\n');
  let searchHits = 0;
  for (const l of lines) if (SEARCH_DETECT_RE.test(l)) searchHits += 1;
  if (searchHits >= 5 && searchHits >= lines.length * 0.5) return 'search';
  if (_looksLikeCode(lines) || _looksLikePython(lines)) return 'code';
  let errLines = 0;
  for (const l of lines) if (ERROR_RE.test(l) || WARN_RE.test(l)) errLines += 1;
  if (lines.length >= 10 && errLines >= 1) return 'log';
  if (_looksLikeProse(text)) return 'prose';
  return 'plain';
}

function _isErrorItem(item) {
  if (item == null) return false;
  if (typeof item === 'string') return VALUE_ERROR_RE.test(item);
  if (typeof item === 'object') {
    for (const k of Object.keys(item)) {
      const v = item[k];
      if (typeof v === 'string' && VALUE_ERROR_RE.test(v)) return true;
      if (typeof v === 'string' && VALUE_ERROR_RE.test(k)) return true;
    }
    if (VALUE_ERROR_RE.test(Object.keys(item).join(' '))) return true;
  }
  return false;
}

function crushJsonArray(text) {
  let arr;
  try { arr = JSON.parse(text); }
  catch { return null; }
  if (!Array.isArray(arr) || arr.length < JSON_MIN_ITEMS) return null;
  const keep = new Set();
  let flagged = 0;
  for (let i = 0; i < arr.length; i += 1) if (_isErrorItem(arr[i])) { keep.add(i); flagged += 1; }
  for (let i = 0; i < Math.min(JSON_KEEP_HEAD, arr.length); i += 1) keep.add(i);
  for (let i = Math.max(0, arr.length - JSON_KEEP_TAIL); i < arr.length; i += 1) keep.add(i);
  const target = Math.max(keep.size, Math.ceil(arr.length * JSON_TARGET_RATIO));
  if (target < arr.length) {
    const step = arr.length / (target - keep.size + 1 || 1);
    for (let s = step; keep.size < target && s < arr.length; s += step) {
      keep.add(Math.floor(s));
    }
  }
  if (keep.size >= arr.length) return null;
  const kept = [];
  const indices = Array.from(keep).sort((a, b) => a - b);
  for (const i of indices) kept.push(arr[i]);
  return {
    compressed: JSON.stringify(kept), dropped: arr.length - kept.length, unit: 'items',
    summary: flagged ? flagged + ' flagged kept' : 'head+tail+sample kept',
  };
}

function _renderKept(lines, keepIdx) {
  return _renderGaps(lines, keepIdx, '\n', 'line');
}

function crushLog(text) {
  const lines = text.split('\n');
  const keep = new Set();
  let errKept = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (ERROR_RE.test(lines[i]) || STACK_RE.test(lines[i])) {
      keep.add(i);
      errKept += 1;
      if (i > 0) keep.add(i - 1);
      if (i + 1 < lines.length) keep.add(i + 1);
    }
  }
  for (let i = 0; i < Math.min(3, lines.length); i += 1) keep.add(i);
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i += 1) keep.add(i);
  if (keep.size >= lines.length) return null;
  return {
    compressed: _renderKept(lines, keep), dropped: lines.length - keep.size, unit: 'lines',
    summary: errKept ? errKept + ' error/stack line' + (errKept === 1 ? '' : 's') + ' kept' : 'head+tail kept',
  };
}

function crushSearch(text) {
  const lines = text.split('\n');
  const byFile = new Map();
  const order = [];
  let parsed = 0;
  for (const l of lines) {
    const m = l.match(SEARCH_LINE_RE);
    if (!m) continue;
    parsed += 1;
    const file = m[1];
    if (!byFile.has(file)) { byFile.set(file, []); order.push(file); }
    byFile.get(file).push(l);
  }
  if (!parsed) return null;
  const errorFiles = order.filter((f) => byFile.get(f).some((l) => VALUE_ERROR_RE.test(l)));
  const headFiles = order.slice(0, SEARCH_MAX_FILES);
  const files = headFiles.slice();
  for (const f of errorFiles) if (!files.includes(f)) files.push(f);
  const out = [];
  let kept = 0;
  for (const file of files) {
    const hits = byFile.get(file);
    const errs = hits.filter((l) => VALUE_ERROR_RE.test(l));
    const rest = hits.filter((l) => !VALUE_ERROR_RE.test(l));
    let sampled;
    if (rest.length <= SEARCH_MAX_PER_FILE) {
      sampled = rest;
    } else {
      sampled = [rest[0]];
      const mid = rest.slice(1, -1);
      const step = mid.length / (SEARCH_MAX_PER_FILE - 1 || 1);
      for (let s = step; sampled.length < SEARCH_MAX_PER_FILE - 1 && s < mid.length; s += step) {
        sampled.push(mid[Math.floor(s)]);
      }
      sampled.push(rest[rest.length - 1]);
    }
    for (const h of errs) { out.push(h); kept += 1; }
    for (const h of sampled) { if (kept >= SEARCH_MAX_TOTAL) break; out.push(h); kept += 1; }
  }
  if (kept >= parsed && files.length === order.length) return null;
  return {
    compressed: out.join('\n'), dropped: parsed - kept, unit: 'matches',
    summary: files.length + '/' + order.length + ' files' + (errorFiles.length ? ', ' + errorFiles.length + ' with errors' : ''),
  };
}

function crushDiff(text) {
  const lines = text.split('\n');
  const keep = new Set();
  let changed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const isChange = /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l);
    if (/^(\+\+\+|---|@@|diff |index )/.test(l) || /^[+-]/.test(l)) {
      keep.add(i);
      if (isChange) changed += 1;
      for (let d = 1; d <= DIFF_CONTEXT; d += 1) {
        if (i - d >= 0 && /^[ ]/.test(lines[i - d])) keep.add(i - d);
        if (i + d < lines.length && /^[ ]/.test(lines[i + d])) keep.add(i + d);
      }
    }
  }
  if (keep.size >= lines.length) return null;
  return {
    compressed: _renderKept(lines, keep), dropped: lines.length - keep.size, unit: 'lines',
    summary: 'all ' + changed + ' changed line' + (changed === 1 ? '' : 's') + ' kept',
  };
}

function crushPython(text) {
  const lines = text.split('\n');
  const keep = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (_indentWidth(l) === 0 || PY_HEADER_RE.test(l) || PY_KEEP_RE.test(l) || ERROR_RE.test(l)) {
      keep.add(i);
    }
  }
  for (let i = 0; i < Math.min(2, lines.length); i += 1) keep.add(i);
  for (let i = Math.max(0, lines.length - 2); i < lines.length; i += 1) keep.add(i);
  if (keep.size >= lines.length) return null;
  let defs = 0;
  for (const i of keep) if (PY_SIG_RE.test(lines[i])) defs += 1;
  return {
    compressed: _renderKept(lines, keep), dropped: lines.length - keep.size, unit: 'lines',
    summary: defs + ' def/class kept',
  };
}

function crushCode(text) {
  const lines = text.split('\n');
  if (_looksLikePython(lines)) return crushPython(text);
  const masked = _maskedLines(text);
  const keep = new Set();
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const m = masked[i] || '';
    const opens = (m.match(/\{/g) || []).length;
    const closes = (m.match(/\}/g) || []).length;
    const structural = opens !== closes;
    if (depth === 0 || structural || CODE_KEEP_RE.test(l) || ERROR_RE.test(l)) keep.add(i);
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  for (let i = 0; i < Math.min(2, lines.length); i += 1) keep.add(i);
  for (let i = Math.max(0, lines.length - 2); i < lines.length; i += 1) keep.add(i);
  if (keep.size >= lines.length) return null;
  let sigs = 0;
  for (const i of keep) if (CODE_SIG_RE.test(lines[i])) sigs += 1;
  return {
    compressed: _renderKept(lines, keep), dropped: lines.length - keep.size, unit: 'lines',
    summary: sigs + ' signature' + (sigs === 1 ? '' : 's') + ' kept',
  };
}

function crushProse(text) {
  const sents = _splitSentences(text);
  if (sents.length < PROSE_MIN_SENTENCES) return null;
  const keep = new Set();
  for (let i = 0; i < Math.min(PROSE_KEEP_HEAD, sents.length); i += 1) keep.add(i);
  for (let i = Math.max(0, sents.length - PROSE_KEEP_TAIL); i < sents.length; i += 1) keep.add(i);
  for (let i = 0; i < sents.length; i += 1) if (PROSE_CRITICAL_RE.test(sents[i])) keep.add(i);
  const target = Math.max(keep.size, Math.ceil(sents.length * PROSE_TARGET_RATIO));
  if (target < sents.length) {
    const step = sents.length / (target - keep.size + 1 || 1);
    for (let s = step; keep.size < target && s < sents.length; s += step) keep.add(Math.floor(s));
  }
  if (keep.size >= sents.length) return null;
  let key = 0;
  for (let i = 0; i < sents.length; i += 1) if (keep.has(i) && PROSE_CRITICAL_RE.test(sents[i])) key += 1;
  return {
    compressed: _renderGaps(sents, keep, ' ', 'sentence'), dropped: sents.length - keep.size, unit: 'sentences',
    summary: key ? key + ' key sentence' + (key === 1 ? '' : 's') + ' kept' : 'head+tail kept',
  };
}

const _CRUSHERS = {
  'json-array': crushJsonArray,
  log: crushLog,
  search: crushSearch,
  diff: crushDiff,
  code: crushCode,
  prose: crushProse,
};

function compressBlock(text, opts) {
  const o = opts || {};
  const minBytes = Number.isFinite(o.minBlockBytes) ? o.minBlockBytes : MIN_BLOCK_BYTES;
  const unchanged = { compressed: text, ratio: 1, dropped: 0, type: 'plain', changed: false };
  if (typeof text !== 'string' || _bytes(text) < minBytes) return unchanged;
  const work = _degutter(text);
  const type = detectType(work);
  const crusher = _CRUSHERS[type];
  if (!crusher) return Object.assign({}, unchanged, { type });
  const result = crusher(work);
  if (!result) return Object.assign({}, unchanged, { type });
  const ratio = text.length ? result.compressed.length / text.length : 1;
  if (ratio > MAX_RATIO) return Object.assign({}, unchanged, { type });
  let body = result.compressed;
  if (typeof o.store === 'function') {
    const hash = o.store(text, type);
    if (!hash) return Object.assign({}, unchanged, { type });
    body = body + '\n' + _marker(hash, result.dropped, result.unit, result.summary);
  }
  return { compressed: body, ratio, dropped: result.dropped, type, changed: true };
}

const _FENCE_RE = /(```[^\n]*\n)([\s\S]*?)(\n```)/g;

function compressPrompt(blob, opts) {
  const o = opts || {};
  if (typeof blob !== 'string' || !blob.length) {
    return { text: blob, stats: { bytes_before: 0, bytes_after: 0, blocks_compressed: 0 } };
  }
  const before = _bytes(blob);
  let blocks = 0;
  const text = blob.replace(_FENCE_RE, (full, open, inner, close) => {
    const res = compressBlock(inner, o);
    if (!res.changed) return full;
    blocks += 1;
    return open + res.compressed + close;
  });
  return {
    text,
    stats: { bytes_before: before, bytes_after: _bytes(text), blocks_compressed: blocks },
  };
}

function crushLogToBudget(text, maxBytes) {
  if (typeof text !== 'string') return '';
  if (_bytes(text) <= maxBytes) return text;
  const lines = text.split('\n');
  const errIdx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (ERROR_RE.test(lines[i]) || STACK_RE.test(lines[i])) errIdx.push(i);
  }
  const keep = new Set();
  let used = 0;
  const budget = Math.max(256, maxBytes - 80);
  for (let j = errIdx.length - 1; j >= 0; j -= 1) {
    const i = errIdx[j];
    const cost = _bytes(lines[i]) + 1;
    if (used + cost > budget * 0.6) break;
    keep.add(i);
    used += cost;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (keep.has(i)) continue;
    const cost = _bytes(lines[i]) + 1;
    if (used + cost > budget) break;
    keep.add(i);
    used += cost;
  }
  let out = _renderKept(lines, keep);
  while (_bytes(out) > maxBytes && out.length) {
    const nl = out.indexOf('\n');
    if (nl < 0) return out.slice(0, maxBytes);
    out = out.slice(nl + 1);
  }
  return out;
}

module.exports = {
  MIN_BLOCK_BYTES,
  MAX_RATIO,
  marker,
  detectType,
  crushJsonArray,
  crushLog,
  crushSearch,
  crushDiff,
  crushCode,
  crushPython,
  crushProse,
  compressBlock,
  compressPrompt,
  crushLogToBudget,
};
