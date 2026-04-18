'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync } = require('../../lib/core.cjs');
const { askUser: defaultAskUser } = require('../../lib/askuser.cjs');
const queueMod = require('./queue.cjs');

const STATE_DIR_NAME = '.nubos-pilot';
const TRIAGE_OPTIONS = ['promote-to-todo', 'promote-to-phase', 'keep', 'drop'];

function _stateDir(cwd) {
  return path.join(path.resolve(cwd), STATE_DIR_NAME);
}

function _sanitizeId(id) {
  if (typeof id !== 'string' || id.length === 0) return 'item';
  const cleaned = id.replace(/[^a-z0-9\-_.]/gi, '_').slice(0, 100);
  return cleaned || 'item';
}

function _getQueueItems(cwd) {
  const chunks = [];
  const captureStdout = { write: (s) => { chunks.push(String(s)); return true; } };
  queueMod.run([], { cwd, stdout: captureStdout });
  try {
    const parsed = JSON.parse(chunks.join(''));
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function _applyPromoteToTodo(item, cwd, stderr) {
  const stateDir = _stateDir(cwd);
  const todosDir = path.join(stateDir, 'todos', 'pending');
  try { fs.mkdirSync(todosDir, { recursive: true }); } catch {}
  const safeName = _sanitizeId(item.id) + '.md';
  const target = path.join(todosDir, safeName);
  const body = `# ${item.title || item.id}\n\nSource: ${item.source}\n`;
  try {
    atomicWriteFileSync(target, body);
    return { id: item.id, action: 'promote-to-todo', path: target };
  } catch (err) {
    try { stderr.write(`[triage] promote-to-todo failed for ${item.id}: ${err.message}\n`); } catch {}
    return { id: item.id, action: 'promote-to-todo', error: err && err.message };
  }
}

function _applyDrop(item, cwd, stderr) {
  if (item.source !== 'todo') {
    try { stderr.write(`[triage] drop: manual drop required for source=${item.source}, skipped ${item.id}\n`); } catch {}
    return { id: item.id, action: 'drop', deferred: true };
  }
  const stateDir = _stateDir(cwd);
  const todosDir = path.join(stateDir, 'todos', 'pending');
  const explicit = item.path || path.join(todosDir, item.id);
  const resolved = path.resolve(explicit);
  const prefix = path.resolve(todosDir) + path.sep;
  if (!(resolved === path.resolve(todosDir) || resolved.startsWith(prefix))) {
    try { stderr.write(`[triage] drop refused: path outside todos/pending/ (${resolved})\n`); } catch {}
    return { id: item.id, action: 'drop', refused: true };
  }
  try {
    fs.unlinkSync(resolved);
    return { id: item.id, action: 'drop', path: resolved };
  } catch (err) {
    try { stderr.write(`[triage] drop failed for ${item.id}: ${err.message}\n`); } catch {}
    return { id: item.id, action: 'drop', error: err && err.message };
  }
}

function _applyTriage(item, value, cwd, stderr) {
  if (value === 'promote-to-todo') {
    if (item.source === 'todo') {
      try { stderr.write(`[triage] promote-to-todo is a no-op for existing todo ${item.id}\n`); } catch {}
      return { id: item.id, action: 'keep', note: 'already-todo' };
    }
    return _applyPromoteToTodo(item, cwd, stderr);
  }
  if (value === 'promote-to-phase') {
    try { stderr.write(`[triage] promote-to-phase requires manual step (Phase 10 UTIL-05) for ${item.id}\n`); } catch {}
    return { id: item.id, action: 'promote-to-phase', deferred: true };
  }
  if (value === 'drop') {
    return _applyDrop(item, cwd, stderr);
  }

  return { id: item.id, action: 'keep' };
}

async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const askUser = typeof context.askUser === 'function' ? context.askUser : defaultAskUser;

  const items = _getQueueItems(cwd);

  if (items.length === 0) {
    try { stderr.write('[triage] Queue leer — nichts zu triagen.\n'); } catch {}
    const payload = { ok: true, decisions: [] };
    stdout.write(JSON.stringify(payload));
    return payload;
  }

  const decisions = [];
  for (const item of items) {
    const answer = await askUser({
      type: 'select',
      question: `Triage: ${item.title || item.id}`,
      options: TRIAGE_OPTIONS.slice(),
      default: 'keep',
    });
    const value = answer && typeof answer.value === 'string' ? answer.value : 'keep';
    decisions.push(_applyTriage(item, value, cwd, stderr));
  }

  const payload = { ok: true, decisions };
  try { stdout.write(JSON.stringify(payload)); } catch (err) {
    throw new NubosPilotError('triage-emit-failed', err && err.message, {});
  }
  return payload;
}

module.exports = { run };
