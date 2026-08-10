'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { projectStateDir, NubosPilotError } = require('./core.cjs');
const { slugify } = require('./layout.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');

// The economy-debt ledger records simplifications a reviewer chose to DEFER
// rather than fix now — the manual twin of the in-loop Economy critic
// (agents.economy ∈ {full,ultra}). It exists so "later" does not become "never":
// /np:simplify-review surfaces over-build, and what is not fixed this round is
// harvested here. Categories mirror the canonical four economy routes in
// lib/nubosloop.cjs::ROUTE_TABLE and agents/np-critic-economy.md — keep in sync.
const ECONOMY_CATEGORIES = Object.freeze([
  'over-engineering',
  'stdlib-reinvention',
  'native-duplication',
  'shrinkable',
]);

const STATUSES = Object.freeze(['open', 'resolved']);
const MAX_NOTE_LENGTH = 500;
const ID_LENGTH = 7;

function debtRoot(cwd) {
  return path.join(projectStateDir(cwd || process.cwd()), 'economy-debt');
}

function statusDir(status, cwd) {
  return path.join(debtRoot(cwd), status);
}

function _entryId(file, line, category, note) {
  const key = String(file) + ':' + String(line) + ':' + String(category) + ':' + String(note);
  return crypto.createHash('sha1').update(key, 'utf-8').digest('hex').slice(0, ID_LENGTH);
}

function _composeMd(entry) {
  const fm = [
    '---',
    'id: ' + entry.id,
    'category: ' + entry.category,
    'file: ' + entry.file,
    'line: ' + entry.line,
    'created: ' + entry.created,
    'status: ' + entry.status,
  ];
  if (entry.resolved) fm.push('resolved: ' + entry.resolved);
  fm.push('---');
  return fm.join('\n') + '\n' + entry.note + '\n';
}

function _parseEntry(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const lineRaw = frontmatter.line;
  const lineNum = Number.parseInt(lineRaw, 10);
  return {
    id: frontmatter.id != null ? String(frontmatter.id) : '',
    category: frontmatter.category != null ? String(frontmatter.category) : '',
    file: frontmatter.file != null ? String(frontmatter.file) : '',
    line: Number.isFinite(lineNum) ? lineNum : 0,
    created: frontmatter.created != null ? String(frontmatter.created) : '',
    resolved: frontmatter.resolved != null ? String(frontmatter.resolved) : '',
    status: frontmatter.status != null ? String(frontmatter.status) : '',
    note: String(body || '').trim(),
    path: filePath,
  };
}

function _validateInput(input) {
  const file = input && input.file != null ? String(input.file).trim() : '';
  const note = input && input.note != null ? String(input.note).trim() : '';
  const category = input && input.category != null ? String(input.category).trim() : '';
  if (!note) {
    throw new NubosPilotError(
      'economy-debt-missing-note',
      'economy-debt entry requires a non-empty note',
      {},
    );
  }
  if (note.length > MAX_NOTE_LENGTH) {
    throw new NubosPilotError(
      'economy-debt-note-too-long',
      'economy-debt note must be <= ' + MAX_NOTE_LENGTH + ' chars',
      { length: note.length },
    );
  }
  if (!ECONOMY_CATEGORIES.includes(category)) {
    throw new NubosPilotError(
      'economy-debt-invalid-category',
      'economy-debt category must be one of: ' + ECONOMY_CATEGORIES.join(', '),
      { category, valid: ECONOMY_CATEGORIES.slice() },
    );
  }
  let line = 0;
  if (input && input.line != null && String(input.line).trim() !== '') {
    line = Number.parseInt(input.line, 10);
    if (!Number.isFinite(line) || line < 0) {
      throw new NubosPilotError(
        'economy-debt-invalid-line',
        'economy-debt line must be a non-negative integer',
        { line: input.line },
      );
    }
  }
  return { file, note, category, line };
}

/**
 * Append a deferred-simplification entry to the open ledger. Idempotent: an
 * identical (file, line, category, note) maps to the same id and is not
 * duplicated — a re-harvest of the same finding is a no-op, returning the
 * existing entry with `created: false`.
 * @returns {{id, category, file, line, created, status, path, was_new: boolean}}
 */
function addEntry(input, cwd) {
  const { file, note, category, line } = _validateInput(input);
  const id = _entryId(file, line, category, note);
  const openDir = statusDir('open', cwd);
  const resolvedDir = statusDir('resolved', cwd);
  const slug = slugify(note).slice(0, 48) || 'entry';
  const fileName = id + '-' + slug + '.md';

  // already open, or already resolved — either way this finding is on record
  const existingOpen = _findById(id, 'open', cwd);
  if (existingOpen) return Object.assign({}, _parseEntry(existingOpen), { was_new: false });
  const existingResolved = _findById(id, 'resolved', cwd);
  if (existingResolved) return Object.assign({}, _parseEntry(existingResolved), { was_new: false });

  fs.mkdirSync(openDir, { recursive: true });
  const entry = {
    id,
    category,
    file,
    line,
    created: new Date().toISOString(),
    status: 'open',
    note,
  };
  const target = path.join(openDir, fileName);
  fs.writeFileSync(target, _composeMd(entry), 'utf-8');
  void resolvedDir;
  return Object.assign({}, entry, { path: target, was_new: true });
}

function _findById(id, status, cwd) {
  const dir = statusDir(status, cwd);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.endsWith('.md') && n.slice(0, ID_LENGTH) === id);
  return hit ? path.join(dir, hit) : null;
}

/**
 * List ledger entries. status: 'open' | 'resolved' | 'all'. Sorted by created
 * ascending (oldest debt first — the longest-deferred is the most urgent).
 */
function listEntries(status, cwd) {
  const want = status || 'open';
  const dirs = want === 'all' ? STATUSES.slice() : [want];
  if (want !== 'all' && !STATUSES.includes(want)) {
    throw new NubosPilotError(
      'economy-debt-invalid-status',
      "economy-debt status must be 'open', 'resolved', or 'all'",
      { status: want },
    );
  }
  const out = [];
  for (const d of dirs) {
    const dir = statusDir(d, cwd);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      out.push(_parseEntry(path.join(dir, n)));
    }
  }
  out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return out;
}

/**
 * Mark an open entry resolved: stamp `resolved` + flip status, then move the
 * file from open/ to resolved/. Throws economy-debt-not-found if no open entry
 * carries the id.
 */
function resolveEntry(id, cwd) {
  const wanted = String(id || '').trim();
  if (!wanted) {
    throw new NubosPilotError('economy-debt-missing-id', 'resolve requires an entry id', {});
  }
  const src = _findById(wanted, 'open', cwd);
  if (!src) {
    throw new NubosPilotError(
      'economy-debt-not-found',
      'no open economy-debt entry with id: ' + wanted,
      { id: wanted },
    );
  }
  const entry = _parseEntry(src);
  entry.resolved = new Date().toISOString();
  entry.status = 'resolved';
  const resolvedDir = statusDir('resolved', cwd);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const target = path.join(resolvedDir, path.basename(src));
  fs.writeFileSync(target, _composeMd(entry), 'utf-8');
  fs.rmSync(src);
  return Object.assign({}, entry, { path: target });
}

module.exports = {
  ECONOMY_CATEGORIES,
  STATUSES,
  MAX_NOTE_LENGTH,
  debtRoot,
  statusDir,
  addEntry,
  listEntries,
  resolveEntry,
  _entryId,
  _parseEntry,
  _composeMd,
};
