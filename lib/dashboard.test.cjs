'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dashboard = require('./dashboard.cjs');

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dashboard-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

function _writeTask(root, mNum, sNum, tNum, status, name) {
  const mIdStr = 'M' + String(mNum).padStart(3, '0');
  const sIdStr = 'S' + String(sNum).padStart(3, '0');
  const tIdStr = 'T' + String(tNum).padStart(4, '0');
  const fullId = mIdStr + '-' + sIdStr + '-' + tIdStr;
  const dir = path.join(root, '.nubos-pilot', 'milestones', mIdStr, 'slices', sIdStr, 'tasks', tIdStr);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'id: "' + fullId + '"',
    'slice: "' + mIdStr + '-' + sIdStr + '"',
    'milestone: "' + mIdStr + '"',
    'type: execute',
    'status: ' + status,
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves: {}',
    '---',
    '',
    '# ' + fullId + ' — ' + name,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, tIdStr + '-PLAN.md'), fm, 'utf-8');
}

function _writeMeta(root, mNum, meta) {
  const mIdStr = 'M' + String(mNum).padStart(3, '0');
  const dir = path.join(root, '.nubos-pilot', 'milestones', mIdStr);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, mIdStr + '-META.json'), JSON.stringify(meta), 'utf-8');
}

test('DB-1: collectSnapshot returns a shape with all top-level keys', () => {
  const root = _sandbox();
  try {
    const snap = dashboard.collectSnapshot(root);
    for (const key of ['generated_at', 'project_root', 'git', 'state', 'milestones', 'worktrees', 'handoffs', 'worktree_isolation']) {
      assert.ok(key in snap, 'missing key: ' + key);
    }
    assert.equal(snap.project_root, root);
    assert.equal(Array.isArray(snap.milestones), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-2: collectSnapshot counts task statuses per slice', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth', status: 'active' });
    _writeTask(root, 1, 1, 1, 'done', 'A');
    _writeTask(root, 1, 1, 2, 'done', 'B');
    _writeTask(root, 1, 1, 3, 'in-progress', 'C');
    _writeTask(root, 1, 1, 4, 'pending', 'D');
    _writeTask(root, 1, 1, 5, 'skipped', 'E');
    const snap = dashboard.collectSnapshot(root);
    assert.equal(snap.milestones.length, 1);
    const m = snap.milestones[0];
    assert.equal(m.id, 'M001');
    assert.equal(m.name, 'Auth');
    assert.equal(m.slices.length, 1);
    assert.deepEqual(m.slices[0].counts, {
      total: 5, pending: 1, 'in-progress': 1, done: 2, skipped: 1, parked: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-3: renderSnapshot produces a non-empty string with key headings', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth', status: 'active' });
    _writeTask(root, 1, 1, 1, 'done', 'Login');
    _writeTask(root, 1, 1, 2, 'pending', 'Logout');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    assert.match(out, /nubos-pilot/);
    assert.match(out, /Milestones/);
    assert.match(out, /M001/);
    assert.match(out, /Auth/);
    assert.match(out, /Handoffs/);
    assert.match(out, /Refresh/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-4: renderSnapshot shows "No milestones yet" when none exist', () => {
  const root = _sandbox();
  try {
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    assert.match(out, /No milestones yet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-5: renderSnapshot with color=false emits no ANSI escape sequences', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth' });
    _writeTask(root, 1, 1, 1, 'done', 'X');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    const seen = /\x1b\[/.test(out);
    assert.equal(seen, false, 'renderSnapshot with color=false must not emit ANSI codes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-6: renderSnapshot with default color includes ANSI codes', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth' });
    _writeTask(root, 1, 1, 1, 'done', 'X');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap);
    assert.match(out, /\x1b\[/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-7: STATUS_GLYPHS covers all task-status enum values', () => {
  for (const s of ['pending', 'in-progress', 'done', 'skipped', 'parked']) {
    assert.ok(dashboard.STATUS_GLYPHS[s], 'missing glyph for ' + s);
  }
});

test('DB-8: collectSnapshot falls back to empty handoffs list on unreadable directory', () => {
  const root = _sandbox();
  try {
    const snap = dashboard.collectSnapshot(root);
    assert.equal(snap.handoffs.total, 0);
    assert.equal(snap.handoffs.open, 0);
    assert.deepEqual(snap.handoffs.recent, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-9: renderSnapshot shows worktree-isolation flag correctly', () => {
  const root = _sandbox();
  try {
    const snap1 = dashboard.collectSnapshot(root);
    const out1 = dashboard.renderSnapshot(snap1, { color: false });
    assert.match(out1, /Worktree isolation: off/);
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify({ workflow: { worktree_isolation: true } }),
      'utf-8',
    );
    const snap2 = dashboard.collectSnapshot(root);
    const out2 = dashboard.renderSnapshot(snap2, { color: false });
    assert.match(out2, /Worktree isolation: on/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
