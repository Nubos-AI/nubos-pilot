'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const messaging = require('./messaging.cjs');

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-messaging-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

function _readManifest(root) {
  const p = path.join(root, '.nubos-pilot', 'messages', 'manifest.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('MS-1: send writes inbox file and appends manifest entry', () => {
  const root = _sandbox();
  try {
    const res = messaging.send({
      from: 'np-critic',
      to: 'np-executor',
      phase: 'M016-S001-T0001',
      kind: 'notify',
      subject: 'style-finding',
      body: 'lint warning at line 42',
    }, root);

    assert.match(res.id, /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(fs.existsSync(res.path));
    assert.match(res.path, /messages\/inbox\/np-executor\//);

    const stored = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(stored.from, 'np-critic');
    assert.equal(stored.kind, 'notify');
    assert.equal(stored.phase, 'M016-S001-T0001');
    assert.equal(stored.expects_reply, false);
    assert.equal(stored.in_reply_to, null);

    const manifest = _readManifest(root);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].event, 'sent');
    assert.equal(manifest[0].id, res.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-2: response messages must set in_reply_to', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => messaging.send({
        from: 'np-executor', to: 'np-critic',
        phase: 'M016-S001-T0001', kind: 'response',
        subject: 'style-finding', body: 'fixed',
      }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-response-needs-in-reply-to',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-3: inbox returns ungelesen messages for agent, sorted chronologically', () => {
  const root = _sandbox();
  try {
    const a = messaging.send({ from: 'x', to: 'np-executor', phase: 'P', kind: 'notify', subject: 's1', body: 'b' }, root);
    const b = messaging.send({ from: 'x', to: 'np-executor', phase: 'P', kind: 'notify', subject: 's2', body: 'b' }, root);
    messaging.send({ from: 'x', to: 'other', phase: 'P', kind: 'notify', subject: 's3', body: 'b' }, root);

    const list = messaging.inbox('np-executor', {}, root);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, a.id);
    assert.equal(list[1].id, b.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-4: inbox kind filter', () => {
  const root = _sandbox();
  try {
    messaging.send({ from: 'x', to: 'a', phase: 'P', kind: 'notify', subject: 's', body: 'b' }, root);
    messaging.send({ from: 'x', to: 'a', phase: 'P', kind: 'request', subject: 's', body: 'b', expects_reply: true }, root);
    const requests = messaging.inbox('a', { kind: 'request' }, root);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, 'request');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-5: archive moves notify message from inbox to archive and logs event', () => {
  const root = _sandbox();
  try {
    const m = messaging.send({ from: 'x', to: 'a', phase: 'P', kind: 'notify', subject: 's', body: 'b' }, root);
    messaging.archive(m.id, root);
    assert.ok(!fs.existsSync(m.path));
    const archived = path.join(root, '.nubos-pilot', 'messages', 'archive', m.id + '.json');
    assert.ok(fs.existsSync(archived));
    const events = _readManifest(root).map((e) => e.event);
    assert.deepEqual(events, ['sent', 'archived']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-6: archive of request with expects_reply=true and no response fails', () => {
  const root = _sandbox();
  try {
    const req = messaging.send({
      from: 'np-critic', to: 'np-executor', phase: 'P',
      kind: 'request', subject: 'fix-x', body: 'please fix',
      expects_reply: true,
    }, root);
    assert.throws(
      () => messaging.archive(req.id, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-archive-without-reply',
    );
    assert.ok(fs.existsSync(req.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-7: archive of request succeeds once a response with in_reply_to was sent', () => {
  const root = _sandbox();
  try {
    const req = messaging.send({
      from: 'np-critic', to: 'np-executor', phase: 'P',
      kind: 'request', subject: 'fix-x', body: 'please fix',
      expects_reply: true,
    }, root);
    messaging.send({
      from: 'np-executor', to: 'np-critic', phase: 'P',
      kind: 'response', subject: 'fix-x', body: 'fixed',
      in_reply_to: req.id,
    }, root);
    messaging.archive(req.id, root);
    const archived = path.join(root, '.nubos-pilot', 'messages', 'archive', req.id + '.json');
    assert.ok(fs.existsSync(archived));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-8: archive on already-archived message fails with messages-already-archived', () => {
  const root = _sandbox();
  try {
    const m = messaging.send({ from: 'x', to: 'a', phase: 'P', kind: 'notify', subject: 's', body: 'b' }, root);
    messaging.archive(m.id, root);
    assert.throws(
      () => messaging.archive(m.id, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-already-archived',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-9: thread returns full reply chain in chronological order', () => {
  const root = _sandbox();
  try {
    const r1 = messaging.send({ from: 'a', to: 'b', phase: 'P', kind: 'request', subject: 's', body: 'q1', expects_reply: true }, root);
    const r2 = messaging.send({ from: 'b', to: 'a', phase: 'P', kind: 'response', subject: 's', body: 'a1', in_reply_to: r1.id }, root);
    const r3 = messaging.send({ from: 'a', to: 'b', phase: 'P', kind: 'request', subject: 's', body: 'q2', expects_reply: true, in_reply_to: r2.id }, root);

    const thread = messaging.thread(r2.id, root);
    const ids = thread.map((m) => m.id);
    assert.deepEqual(ids, [r1.id, r2.id, r3.id]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-10: pendingReplies returns expects_reply requests for a task, ungelesen only', () => {
  const root = _sandbox();
  try {
    messaging.send({ from: 'a', to: 'b', phase: 'task-A', kind: 'notify', subject: 's', body: 'b' }, root);
    const pendA = messaging.send({ from: 'a', to: 'b', phase: 'task-A', kind: 'request', subject: 's', body: 'b', expects_reply: true }, root);
    messaging.send({ from: 'a', to: 'b', phase: 'task-B', kind: 'request', subject: 's', body: 'b', expects_reply: true }, root);

    const pending = messaging.pendingReplies('task-A', root);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, pendA.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-11: parallel send with monotonic id generator produces distinct ids and filenames', () => {
  const root = _sandbox();
  try {
    const sent = [];
    for (let i = 0; i < 200; i++) {
      sent.push(messaging.send({
        from: 'x', to: 'a', phase: 'P', kind: 'notify', subject: 's', body: 'b',
      }, root));
    }
    const ids = new Set(sent.map((s) => s.id));
    assert.equal(ids.size, sent.length);
    for (const s of sent) assert.ok(fs.existsSync(s.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-12: kind validation rejects unknown verb', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => messaging.send({
        from: 'x', to: 'a', phase: 'P', kind: 'broadcast', subject: 's', body: 'b',
      }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-invalid-kind',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-13: from/to validation rejects empty or invalid agent slug', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => messaging.send({
        from: '', to: 'a', phase: 'P', kind: 'notify', subject: 's', body: 'b',
      }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-invalid-agent',
    );
    assert.throws(
      () => messaging.send({
        from: 'a', to: 'has spaces', phase: 'P', kind: 'notify', subject: 's', body: 'b',
      }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-invalid-agent',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-14: sweepTaskOnCommit moves all messages of a task into archive/by-task/<task>/', () => {
  const root = _sandbox();
  try {
    const a = messaging.send({ from: 'x', to: 'r', phase: 'task-X', kind: 'notify', subject: 's', body: 'b' }, root);
    const b = messaging.send({ from: 'x', to: 'r', phase: 'task-X', kind: 'request', subject: 's', body: 'b', expects_reply: true }, root);
    messaging.send({ from: 'x', to: 'r', phase: 'task-Y', kind: 'notify', subject: 's', body: 'b' }, root);
    messaging.send({ from: 'r', to: 'x', phase: 'task-X', kind: 'response', subject: 's', body: 'b', in_reply_to: b.id }, root);
    messaging.archive(a.id, root);

    const moved = messaging.sweepTaskOnCommit('task-X', root);
    assert.equal(moved, 3);

    const byTask = path.join(root, '.nubos-pilot', 'messages', 'archive', 'by-task', 'task-X');
    assert.ok(fs.existsSync(byTask));
    assert.equal(fs.readdirSync(byTask).length, 3);

    const remainingX = messaging.inbox('r', { phase: 'task-X' }, root);
    assert.equal(remainingX.length, 0);
    const remainingY = messaging.inbox('r', { phase: 'task-Y' }, root);
    assert.equal(remainingY.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-15: pendingReplies excludes already-archived requests', () => {
  const root = _sandbox();
  try {
    const req = messaging.send({ from: 'a', to: 'b', phase: 'P', kind: 'request', subject: 's', body: 'b', expects_reply: true }, root);
    messaging.send({ from: 'b', to: 'a', phase: 'P', kind: 'response', subject: 's', body: 'b', in_reply_to: req.id }, root);
    messaging.archive(req.id, root);
    assert.equal(messaging.pendingReplies('P', root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MS-16: round must be non-negative integer or null', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => messaging.send({
        from: 'a', to: 'b', phase: 'P', kind: 'notify', subject: 's', body: 'b', round: -1,
      }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-invalid-round',
    );
    assert.throws(
      () => messaging.send({
        from: 'a', to: 'b', phase: 'P', kind: 'notify', subject: 's', body: 'b', round: 1.5,
      }, root),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-invalid-round',
    );
    const ok = messaging.send({
      from: 'a', to: 'b', phase: 'P', kind: 'notify', subject: 's', body: 'b', round: 2,
    }, root);
    const stored = JSON.parse(fs.readFileSync(ok.path, 'utf-8'));
    assert.equal(stored.round, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
