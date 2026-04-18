'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseRoadmap } = require('../../lib/roadmap.cjs');
const { listPlans } = require('../../lib/plan.cjs');

const MAX_TITLE_LEN = 80;
const STATE_DIR_NAME = '.nubos-pilot';

function _stateDir(cwd) {

  
  return path.join(path.resolve(cwd), STATE_DIR_NAME);
}

function _truncate(s) {
  if (typeof s !== 'string') return '';
  const noHtmlComment = s.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (noHtmlComment.length <= MAX_TITLE_LEN) return noHtmlComment;
  return noHtmlComment.slice(0, MAX_TITLE_LEN - 1) + '…';
}

function _readFirstH1(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return path.basename(file); }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('# ')) return _truncate(line.slice(2));
  }
  return path.basename(file);
}

function _collectTodos(stateDir) {
  const todosDir = path.join(stateDir, 'todos', 'pending');
  if (!fs.existsSync(todosDir)) return [];
  const items = [];
  let entries;
  try { entries = fs.readdirSync(todosDir); } catch { return []; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(todosDir, name);
    items.push({
      source: 'todo',
      id: name,
      title: _readFirstH1(full),
      path: full,
    });
  }
  return items;
}

function _safeParseRoadmap(cwd) {
  try { return parseRoadmap(cwd); } catch { return null; }
}

function _paddedPhase(n) {
  const s = String(n);
  if (s.length >= 2) return s;
  return '0' + s;
}

function _collectBacklog(roadmap) {
  if (!roadmap || !Array.isArray(roadmap.phases)) return [];
  const items = [];
  for (const p of roadmap.phases) {
    const num = Number(p.number);
    if (!Number.isFinite(num) || num < 999) continue;
    items.push({
      source: 'backlog',
      id: String(p.number),
      title: _truncate(p.goal || p.name || String(p.number)),
    });
  }
  return items;
}

function _collectUat(roadmap, cwd) {
  if (!roadmap || !Array.isArray(roadmap.phases)) return [];
  const items = [];
  const phaseParentDirs = [
    path.join(path.resolve(cwd), STATE_DIR_NAME, 'phases'),
    path.join(path.resolve(cwd), '.planning', 'phases'),
  ];
  for (const p of roadmap.phases) {
    const padded = _paddedPhase(p.number);
    const candidateFiles = [];
    for (const parent of phaseParentDirs) {
      if (!fs.existsSync(parent)) continue;
      let dirs;
      try { dirs = fs.readdirSync(parent); } catch { continue; }
      const match = dirs.find((d) => d.startsWith(padded + '-'));
      if (!match) continue;
      const phaseDir = path.join(parent, match);
      candidateFiles.push(
        path.join(phaseDir, padded + '-VERIFICATION.md'),
        path.join(phaseDir, padded + '-UAT.md'),
      );
    }
    for (const file of candidateFiles) {
      if (!fs.existsSync(file)) continue;
      let raw;
      try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const lines = raw.split('\n');
      for (const line of lines) {
        if (!/^- \[ \]/.test(line)) continue;
        const title = _truncate(line.replace(/^- \[ \]\s*/, ''));
        const shortKey = (title || '').slice(0, 40).replace(/\s+/g, '-') || 'item';
        items.push({
          source: 'uat',
          id: padded + ':' + shortKey,
          title,
          file,
        });
      }
    }
  }
  return items;
}

function _collectUnplanned(roadmap, cwd) {
  if (!roadmap || !Array.isArray(roadmap.phases)) return [];
  const items = [];
  const phaseParentDirs = [
    path.join(path.resolve(cwd), STATE_DIR_NAME, 'phases'),
    path.join(path.resolve(cwd), '.planning', 'phases'),
  ];
  for (const p of roadmap.phases) {
    const num = Number(p.number);
    if (!Number.isFinite(num) || num >= 999) continue;
    const padded = _paddedPhase(p.number);
    let phaseDir = null;
    for (const parent of phaseParentDirs) {
      if (!fs.existsSync(parent)) continue;
      let dirs;
      try { dirs = fs.readdirSync(parent); } catch { continue; }
      const match = dirs.find((d) => d.startsWith(padded + '-'));
      if (match) { phaseDir = path.join(parent, match); break; }
    }
    if (!phaseDir) {
      items.push({
        source: 'unplanned-phase',
        id: String(p.number),
        title: _truncate(p.goal || p.name || String(p.number)),
      });
      continue;
    }
    const plans = listPlans(phaseDir);
    if (plans.length === 0) {
      items.push({
        source: 'unplanned-phase',
        id: String(p.number),
        title: _truncate(p.goal || p.name || String(p.number)),
      });
    }
  }
  return items;
}

function _fallbackMdRoadmap(cwd) {
  const candidates = [
    path.join(path.resolve(cwd), STATE_DIR_NAME, 'ROADMAP.md'),
    path.join(path.resolve(cwd), '.planning', 'ROADMAP.md'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const lines = raw.split('\n');
    const phases = [];
    let current = null;
    for (const line of lines) {
      const header = line.match(/^##\s+Phase\s+(\d+)/);
      if (header) {
        if (current) phases.push(current);
        current = { number: header[1], goal: '', name: '' };
        continue;
      }
      if (current && !current.goal) {
        const g = line.match(/^\s*-\s*goal:\s*(.+)$/);
        if (g) current.goal = g[1].trim();
      }
    }
    if (current) phases.push(current);
    if (phases.length > 0) return { phases };
  }
  return null;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;

  const stateDir = _stateDir(cwd);
  const items = [];

  items.push(..._collectTodos(stateDir));

  const roadmap = _safeParseRoadmap(cwd) || _fallbackMdRoadmap(cwd);
  if (roadmap) {
    items.push(..._collectBacklog(roadmap));
    items.push(..._collectUat(roadmap, cwd));
    items.push(..._collectUnplanned(roadmap, cwd));
  }

  const payload = { items };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };
