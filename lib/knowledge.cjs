'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { projectStateDir, atomicWriteFileSync, NubosPilotError, withFileLock } = require('./core.cjs');

const INDEX_VERSION = 1;
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 8;
const MAX_RESULTS_DEFAULT = 10;
const SNIPPET_LINES = 6;

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','for','and','or','is','are','was','were',
  'be','as','by','at','it','this','that','these','those','with','from','into',
  'der','die','das','und','oder','von','zu','im','in','auf','für','nicht',
  'ist','sind','war','waren','sein','als','bei','an','mit','aus','nach',
]);

const INDEXED_GLOBS = [
  'PROJECT.md',
  'REQUIREMENTS.md',
  'RULES.md',
  'STATE.md',
  'codebase/*.md',
  'milestones/M*/*.md',
  'milestones/M*/slices/S*/*.md',
  'milestones/M*/slices/S*/tasks/T*/*.md',
  'todos/**/*.md',
  'threads/**/*.md',
  'notes/**/*.md',
];

function _stateDir(cwd) {
  return projectStateDir(cwd);
}

function _walkMarkdown(stateDir) {
  const out = [];
  if (!fs.existsSync(stateDir)) return out;

  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(stateDir, full);
      if (rel.startsWith('archive' + path.sep)) continue;
      if (rel.startsWith('checkpoints' + path.sep)) continue;
      if (rel.startsWith('worktrees' + path.sep)) continue;
      if (rel.startsWith('reports' + path.sep)) continue;
      if (rel.startsWith('.tmp' + path.sep)) continue;
      if (rel.startsWith('state' + path.sep)) continue;
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      out.push(full);
    }
  }
  walk(stateDir, 0);
  return out;
}

function _tokenize(text) {
  const lower = String(text).toLowerCase();
  const tokens = lower.match(/[a-z0-9][a-z0-9\-_]{1,}/g) || [];
  return tokens.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function _hash(content) {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
}

function _splitChunks(filePath, content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let id = 0;
  for (let start = 0; start < lines.length; start += (CHUNK_LINES - CHUNK_OVERLAP)) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const slice = lines.slice(start, end);
    const text = slice.join('\n');
    if (text.trim().length === 0) continue;
    chunks.push({
      chunk_id: id++,
      line_start: start + 1,
      line_end: end,
      text,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

function _docFromFile(stateDir, filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const stat = fs.statSync(filePath);
  const rel = path.relative(stateDir, filePath);
  const chunks = _splitChunks(filePath, content);
  const indexedChunks = chunks.map((c) => {
    const tokens = _tokenize(c.text);
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return {
      chunk_id: c.chunk_id,
      line_start: c.line_start,
      line_end: c.line_end,
      length: tokens.length,
      tf,
      preview: c.text.split('\n').slice(0, SNIPPET_LINES).join('\n'),
    };
  });
  return {
    rel_path: rel,
    mtime_ms: stat.mtimeMs,
    size: stat.size,
    sha: _hash(content),
    chunks: indexedChunks,
  };
}

function buildIndex(cwd) {
  const stateDir = _stateDir(cwd);
  const files = _walkMarkdown(stateDir);
  const docs = files.map((f) => _docFromFile(stateDir, f));
  const totalChunks = docs.reduce((n, d) => n + d.chunks.length, 0);
  const avgLen = totalChunks
    ? docs.reduce((n, d) => n + d.chunks.reduce((m, c) => m + c.length, 0), 0) / totalChunks
    : 0;
  const df = Object.create(null);
  for (const d of docs) {
    for (const c of d.chunks) {
      for (const term of Object.keys(c.tf)) df[term] = (df[term] || 0) + 1;
    }
  }
  return {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    state_dir: stateDir,
    total_files: docs.length,
    total_chunks: totalChunks,
    avg_chunk_length: Number(avgLen.toFixed(2)),
    df,
    docs,
  };
}

function _indexPath(cwd) {
  return path.join(_stateDir(cwd), 'state', 'knowledge-index.json');
}

function writeIndex(index, cwd) {
  const dest = _indexPath(cwd);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return withFileLock(dest, () => {
    atomicWriteFileSync(dest, JSON.stringify(index));
    return dest;
  });
}

function readIndex(cwd) {
  const dest = _indexPath(cwd);
  if (!fs.existsSync(dest)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(dest, 'utf-8'));
    if (!obj || obj.version !== INDEX_VERSION) return null;
    return obj;
  } catch { return null; }
}

function _bm25Score(terms, chunk, df, totalChunks, avgLen, k1 = 1.4, b = 0.75) {
  let score = 0;
  for (const term of terms) {
    const f = chunk.tf[term] || 0;
    if (f === 0) continue;
    const n = df[term] || 0;
    const idf = Math.log(1 + (totalChunks - n + 0.5) / (n + 0.5));
    const denom = f + k1 * (1 - b + b * (chunk.length / Math.max(1, avgLen)));
    score += idf * (f * (k1 + 1)) / (denom || 1);
  }
  return score;
}

function search(query, cwd, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(100, o.limit || MAX_RESULTS_DEFAULT));
  let index = readIndex(cwd);
  if (!index) {
    index = buildIndex(cwd);
    writeIndex(index, cwd);
  }
  const terms = _tokenize(query);
  if (terms.length === 0) {
    return { query, terms, total_hits: 0, hits: [], index_built_at: index.built_at };
  }
  const hits = [];
  for (const doc of index.docs) {
    for (const c of doc.chunks) {
      const score = _bm25Score(terms, c, index.df, index.total_chunks, index.avg_chunk_length);
      if (score > 0) {
        hits.push({
          rel_path: doc.rel_path,
          line_start: c.line_start,
          line_end: c.line_end,
          score: Number(score.toFixed(4)),
          preview: c.preview,
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return {
    query,
    terms,
    total_hits: hits.length,
    hits: hits.slice(0, limit),
    index_built_at: index.built_at,
    index_total_files: index.total_files,
    index_total_chunks: index.total_chunks,
  };
}

function indexStats(cwd) {
  const idx = readIndex(cwd);
  if (!idx) return { exists: false };
  const groups = Object.create(null);
  for (const d of idx.docs) {
    const top = d.rel_path.split(path.sep)[0] || '<root>';
    if (!groups[top]) groups[top] = { files: 0, chunks: 0, bytes: 0 };
    groups[top].files += 1;
    groups[top].chunks += d.chunks.length;
    groups[top].bytes += d.size;
  }
  return {
    exists: true,
    built_at: idx.built_at,
    total_files: idx.total_files,
    total_chunks: idx.total_chunks,
    avg_chunk_length: idx.avg_chunk_length,
    unique_terms: Object.keys(idx.df).length,
    groups,
  };
}

module.exports = {
  INDEX_VERSION,
  INDEXED_GLOBS,
  buildIndex,
  writeIndex,
  readIndex,
  search,
  indexStats,
  _tokenize,
  _splitChunks,
};
