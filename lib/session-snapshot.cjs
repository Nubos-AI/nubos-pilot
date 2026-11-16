'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { projectStateDir, atomicWriteFileSync, withFileLock } = require('./core.cjs');
const { readState } = require('./state.cjs');

const SNAPSHOT_VERSION = 1;

function _snapshotPath(cwd) {
  return path.join(projectStateDir(cwd), 'state', 'session-snapshot.json');
}

function _safeReadState(cwd) {
  try { return readState(cwd); } catch { return null; }
}

function _listOpenHandoffs(cwd) {
  const dir = path.join(projectStateDir(cwd), 'handoffs');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  function walk(d, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let txt = '';
      try { txt = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      const m = txt.match(/^---[\s\S]*?status:\s*(open|read)[\s\S]*?---/);
      if (!m) continue;
      out.push({
        id: path.basename(e.name, '.md'),
        rel_path: path.relative(projectStateDir(cwd), full),
        status: m[1],
      });
    }
  }
  walk(dir, 0);
  return out;
}

function _listCheckpoints(cwd) {
  const dir = path.join(projectStateDir(cwd), 'checkpoints');
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));
}

function captureSnapshot(cwd, opts) {
  const root = cwd || process.cwd();
  const state = _safeReadState(root);
  const fm = state && state.frontmatter ? state.frontmatter : {};
  const lastCommits = (opts && Array.isArray(opts.lastCommits)) ? opts.lastCommits : [];
  return {
    version: SNAPSHOT_VERSION,
    captured_at: new Date().toISOString(),
    milestone: fm.milestone || null,
    milestone_name: fm.milestone_name || null,
    current_task: fm.current_task || null,
    progress: fm.progress || null,
    last_commits: lastCommits,
    open_handoffs: _listOpenHandoffs(root),
    checkpoint_ids: _listCheckpoints(root),
  };
}

function writeSnapshot(snapshot, cwd) {
  const root = cwd || process.cwd();
  const dest = _snapshotPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return withFileLock(dest, () => {
    atomicWriteFileSync(dest, JSON.stringify(snapshot, null, 2));
    return dest;
  });
}

function readSnapshot(cwd) {
  const root = cwd || process.cwd();
  const dest = _snapshotPath(root);
  if (!fs.existsSync(dest)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(dest, 'utf-8'));
    if (!obj || obj.version !== SNAPSHOT_VERSION) return null;
    return obj;
  } catch { return null; }
}

module.exports = { SNAPSHOT_VERSION, captureSnapshot, writeSnapshot, readSnapshot };
