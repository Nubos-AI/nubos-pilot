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

test('DB-1: collectSnapshot returns only { milestones } shape', () => {
  const root = _sandbox();
  try {
    const snap = dashboard.collectSnapshot(root);
    assert.deepEqual(Object.keys(snap), ['milestones']);
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
    assert.deepEqual(m.slices[0].task_statuses, ['done', 'done', 'in-progress', 'pending', 'skipped']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-3: renderSnapshot prints milestone, slice, checkbox row', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth', status: 'active' });
    _writeTask(root, 1, 1, 1, 'done', 'Login');
    _writeTask(root, 1, 1, 2, 'pending', 'Logout');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    assert.match(out, /^nubos-pilot/);
    assert.match(out, /M001 — Auth/);
    assert.match(out, /\[active\]/);
    assert.match(out, /M001-S001/);
    assert.match(out, /1 done/);
    assert.match(out, /1 pending/);
    assert.match(out, /\[x\] \[ \]/);
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

test('DB-5: renderSnapshot with color=false emits no ANSI codes', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth' });
    _writeTask(root, 1, 1, 1, 'done', 'X');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    assert.equal(/\x1b\[/.test(out), false, 'render with color=false must not emit ANSI');
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

test('DB-8: empty slice (no tasks) renders "no tasks" indicator', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Empty' });
    fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks'), { recursive: true });
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    assert.match(out, /M001-S001/);
    assert.match(out, /no tasks/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-L1: renderSnapshot uses German labels when language=de', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth', status: 'active' });
    _writeTask(root, 1, 1, 1, 'done', 'Login');
    _writeTask(root, 1, 1, 2, 'in-progress', 'Logout');
    _writeTask(root, 1, 1, 3, 'pending', 'Reset');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false, language: 'de' });
    assert.match(out, /1 erledigt/);
    assert.match(out, /1 in Arbeit/);
    assert.match(out, /1 offen/);
    assert.equal(/\bdone\b/.test(out), false, 'must not leak English label');
    assert.equal(/in-progress/.test(out), false, 'must not leak English label');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-L2: renderSnapshot uses German "no milestones" line for de', () => {
  const root = _sandbox();
  try {
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false, language: 'de' });
    assert.match(out, /Noch keine Milestones/);
    assert.equal(/No milestones yet/.test(out), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-L3: empty slice renders German "keine Tasks" for de', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Empty' });
    fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks'), { recursive: true });
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false, language: 'de' });
    assert.match(out, /keine Tasks/);
    assert.equal(/no tasks/.test(out), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-L4: milestone without slices renders German "keine Slices geplant"', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'NoSlices' });
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false, language: 'de' });
    assert.match(out, /keine Slices geplant/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-L5: unknown language falls back to English labels', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth' });
    _writeTask(root, 1, 1, 1, 'done', 'X');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false, language: 'fr' });
    assert.match(out, /1 done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-L6: omitted language defaults to English (lib stays pure)', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 1, { name: 'Auth' });
    _writeTask(root, 1, 1, 1, 'done', 'X');
    const snap = dashboard.collectSnapshot(root);
    const out = dashboard.renderSnapshot(snap, { color: false });
    assert.match(out, /1 done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DB-9: multiple milestones render in numeric order', () => {
  const root = _sandbox();
  try {
    _writeMeta(root, 2, { name: 'Second' });
    _writeMeta(root, 1, { name: 'First' });
    _writeTask(root, 1, 1, 1, 'done', 'X');
    _writeTask(root, 2, 1, 1, 'pending', 'Y');
    const snap = dashboard.collectSnapshot(root);
    assert.equal(snap.milestones.length, 2);
    assert.equal(snap.milestones[0].id, 'M001');
    assert.equal(snap.milestones[1].id, 'M002');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
