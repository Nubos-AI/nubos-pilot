'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handoff = require('./handoff.cjs');

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-handoff-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M001'), { recursive: true });
  return root;
}

test('HO-1: writeHandoff creates a file with correct frontmatter and returns id', () => {
  const root = _sandbox();
  try {
    const res = handoff.writeHandoff({
      from: 'np-executor',
      to: 'np-verifier',
      topic: 'Feature Flag X',
      milestone: 'M001',
      slice: 'M001-S002',
      body: 'I hardcoded the flag for now.',
    }, root);
    assert.match(res.id, /^[a-f0-9]{8}$/);
    assert.ok(fs.existsSync(res.path));
    assert.match(res.path, /M001\/handoffs\//);
    const raw = fs.readFileSync(res.path, 'utf-8');
    assert.match(raw, /from_agent: "?np-executor"?/);
    assert.match(raw, /to_agent: "?np-verifier"?/);
    assert.match(raw, /status: "?open"?/);
    assert.match(raw, /I hardcoded the flag/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-2: writeHandoff without milestone writes under global handoffs/', () => {
  const root = _sandbox();
  try {
    const res = handoff.writeHandoff({
      from: 'np-researcher',
      to: '*',
      topic: 'General finding',
      body: 'x',
    }, root);
    assert.match(res.path, /\.nubos-pilot\/handoffs\//);
    assert.doesNotMatch(res.path, /milestones\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-3: listHandoffs with for-filter returns addressed + broadcast', () => {
  const root = _sandbox();
  try {
    handoff.writeHandoff({ from: 'a', to: 'verifier', topic: 'to-verifier', milestone: 'M001' }, root);
    handoff.writeHandoff({ from: 'a', to: 'planner', topic: 'to-planner', milestone: 'M001' }, root);
    handoff.writeHandoff({ from: 'a', to: '*', topic: 'broadcast', milestone: 'M001' }, root);
    const list = handoff.listHandoffs({ for: 'verifier' }, root);
    const topics = list.map((h) => h.topic);
    assert.deepEqual(topics.sort(), ['broadcast', 'to-verifier'].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-4: listHandoffs with status filter', () => {
  const root = _sandbox();
  try {
    const a = handoff.writeHandoff({ from: 'x', to: 'y', topic: 'one', milestone: 'M001' }, root);
    handoff.writeHandoff({ from: 'x', to: 'y', topic: 'two', milestone: 'M001' }, root);
    handoff.setHandoffStatus(a.id, 'acted', root);
    const open = handoff.listHandoffs({ status: 'open' }, root);
    const acted = handoff.listHandoffs({ status: 'acted' }, root);
    assert.equal(open.length, 1);
    assert.equal(acted.length, 1);
    assert.equal(open[0].topic, 'two');
    assert.equal(acted[0].topic, 'one');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-5: setHandoffStatus rewrites status field in place', () => {
  const root = _sandbox();
  try {
    const { id, path: p } = handoff.writeHandoff({ from: 'a', to: 'b', topic: 't', milestone: 'M001' }, root);
    handoff.setHandoffStatus(id, 'read', root);
    const raw = fs.readFileSync(p, 'utf-8');
    assert.match(raw, /status: read/);
    assert.doesNotMatch(raw, /status: open/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-6: setHandoffStatus rejects invalid status', () => {
  const root = _sandbox();
  try {
    const { id } = handoff.writeHandoff({ from: 'a', to: 'b', topic: 't', milestone: 'M001' }, root);
    assert.throws(
      () => handoff.setHandoffStatus(id, 'bogus', root),
      (err) => err.name === 'NubosPilotError' && err.code === 'handoff-invalid-status',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-7: setHandoffStatus on missing id throws handoff-not-found', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => handoff.setHandoffStatus('deadbeef', 'acted', root),
      (err) => err.name === 'NubosPilotError' && err.code === 'handoff-not-found',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-8: readHandoff returns body and metadata for an existing id', () => {
  const root = _sandbox();
  try {
    const body = 'Line one.\nLine two.';
    const { id } = handoff.writeHandoff({
      from: 'a',
      to: 'b',
      topic: 'x',
      milestone: 'M001',
      body,
    }, root);
    const rec = handoff.readHandoff(id, root);
    assert.equal(rec.id, id);
    assert.equal(rec.topic, 'x');
    assert.match(rec.body, /Line one\./);
    assert.match(rec.body, /Line two\./);
    assert.equal(rec.milestone, 'M001');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-9: writeHandoff validates agent-name format', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => handoff.writeHandoff({ from: '', to: 'b', topic: 't' }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'handoff-invalid-agent',
    );
    assert.throws(
      () => handoff.writeHandoff({ from: 'a', to: 'has space', topic: 't' }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'handoff-invalid-agent',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-10: writeHandoff requires topic', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => handoff.writeHandoff({ from: 'a', to: 'b', topic: '' }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'handoff-missing-topic',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-11: listHandoffs without milestone scans all milestones + global', () => {
  const root = _sandbox();
  try {
    fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M002'), { recursive: true });
    handoff.writeHandoff({ from: 'a', to: 'b', topic: 'in-m1', milestone: 'M001' }, root);
    handoff.writeHandoff({ from: 'a', to: 'b', topic: 'in-m2', milestone: 'M002' }, root);
    handoff.writeHandoff({ from: 'a', to: 'b', topic: 'global' }, root);
    const all = handoff.listHandoffs({}, root);
    const topics = all.map((h) => h.topic).sort();
    assert.deepEqual(topics, ['global', 'in-m1', 'in-m2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-12: listHandoffs with global=true skips milestone scopes', () => {
  const root = _sandbox();
  try {
    handoff.writeHandoff({ from: 'a', to: 'b', topic: 'in-m1', milestone: 'M001' }, root);
    handoff.writeHandoff({ from: 'a', to: 'b', topic: 'global' }, root);
    const globals = handoff.listHandoffs({ global: true }, root);
    assert.equal(globals.length, 1);
    assert.equal(globals[0].topic, 'global');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-13: listHandoffs sort order is chronological', () => {
  const root = _sandbox();
  try {
    const a = handoff.writeHandoff({ from: 'a', to: 'b', topic: 'first', milestone: 'M001' }, root);
    const b = handoff.writeHandoff({ from: 'a', to: 'b', topic: 'second', milestone: 'M001' }, root);
    const list = handoff.listHandoffs({}, root);
    const order = list.map((h) => h.topic);
    const firstIdx = order.indexOf('first');
    const secondIdx = order.indexOf('second');
    assert.ok(firstIdx !== -1 && secondIdx !== -1);
    assert.ok(firstIdx < secondIdx, 'first must come before second');
    assert.ok(a.created_at <= b.created_at);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HO-14: STATUS_ENUM covers open, read, acted, archived', () => {
  assert.ok(handoff.STATUS_ENUM.has('open'));
  assert.ok(handoff.STATUS_ENUM.has('read'));
  assert.ok(handoff.STATUS_ENUM.has('acted'));
  assert.ok(handoff.STATUS_ENUM.has('archived'));
  assert.equal(handoff.STATUS_ENUM.size, 4);
});
