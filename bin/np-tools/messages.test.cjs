'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const send = require('./messages-send.cjs');
const inbox = require('./messages-inbox.cjs');
const archiveCmd = require('./messages-archive.cjs');
const thread = require('./messages-thread.cjs');

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-messages-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

function _capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  stream.text = () => Buffer.concat(chunks).toString('utf-8');
  return stream;
}

test('MSC-1: messages-send writes inbox file and prints id JSON', () => {
  const root = _sandbox();
  try {
    const out = _capture();
    const exit = send.run(
      ['--from', 'np-critic', '--to', 'np-executor',
       '--phase', 'M016-S001-T0001', '--kind', 'notify',
       '--subject', 'style', '--body', 'lint warning'],
      { cwd: root, stdout: out },
    );
    assert.equal(exit, 0);
    const parsed = JSON.parse(out.text());
    assert.match(parsed.id, /^\d+-/);
    assert.ok(fs.existsSync(parsed.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-2: messages-send --body-file reads body from disk', () => {
  const root = _sandbox();
  try {
    const bodyFile = path.join(root, 'body.txt');
    fs.writeFileSync(bodyFile, 'multi\nline\nbody', 'utf-8');
    const out = _capture();
    send.run(
      ['--from', 'a', '--to', 'b', '--phase', 'P', '--kind', 'notify',
       '--subject', 's', '--body-file', bodyFile],
      { cwd: root, stdout: out },
    );
    const parsed = JSON.parse(out.text());
    const stored = JSON.parse(fs.readFileSync(parsed.path, 'utf-8'));
    assert.equal(stored.body, 'multi\nline\nbody');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-3: messages-send --expects-reply sets the flag', () => {
  const root = _sandbox();
  try {
    const out = _capture();
    send.run(
      ['--from', 'a', '--to', 'b', '--phase', 'P', '--kind', 'request',
       '--subject', 's', '--body', 'q', '--expects-reply'],
      { cwd: root, stdout: out },
    );
    const parsed = JSON.parse(out.text());
    const stored = JSON.parse(fs.readFileSync(parsed.path, 'utf-8'));
    assert.equal(stored.expects_reply, true);
    assert.equal(stored.kind, 'request');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-4: messages-inbox lists messages for an agent as JSON array', () => {
  const root = _sandbox();
  try {
    const sendOut = _capture();
    send.run(
      ['--from', 'a', '--to', 'b', '--phase', 'P', '--kind', 'notify',
       '--subject', 's', '--body', 'hi'],
      { cwd: root, stdout: sendOut },
    );
    const inboxOut = _capture();
    const exit = inbox.run(['--agent', 'b'], { cwd: root, stdout: inboxOut });
    assert.equal(exit, 0);
    const list = JSON.parse(inboxOut.text());
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 1);
    assert.equal(list[0].subject, 's');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-5: messages-archive moves a notify message and prints archived id', () => {
  const root = _sandbox();
  try {
    const sendOut = _capture();
    send.run(
      ['--from', 'a', '--to', 'b', '--phase', 'P', '--kind', 'notify',
       '--subject', 's', '--body', 'hi'],
      { cwd: root, stdout: sendOut },
    );
    const sentId = JSON.parse(sendOut.text()).id;
    const archiveOut = _capture();
    const exit = archiveCmd.run([sentId], { cwd: root, stdout: archiveOut });
    assert.equal(exit, 0);
    assert.deepEqual(JSON.parse(archiveOut.text()), { archived: sentId });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-6: messages-archive without reply on expects_reply=true throws envelope code', () => {
  const root = _sandbox();
  try {
    const sendOut = _capture();
    send.run(
      ['--from', 'a', '--to', 'b', '--phase', 'P', '--kind', 'request',
       '--subject', 's', '--body', 'q', '--expects-reply'],
      { cwd: root, stdout: sendOut },
    );
    const reqId = JSON.parse(sendOut.text()).id;
    assert.throws(
      () => archiveCmd.run([reqId], { cwd: root, stdout: _capture() }),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-archive-without-reply',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-7: messages-thread prints causal reply chain', () => {
  const root = _sandbox();
  try {
    const reqOut = _capture();
    send.run(
      ['--from', 'a', '--to', 'b', '--phase', 'P', '--kind', 'request',
       '--subject', 's', '--body', 'q', '--expects-reply'],
      { cwd: root, stdout: reqOut },
    );
    const reqId = JSON.parse(reqOut.text()).id;
    const respOut = _capture();
    send.run(
      ['--from', 'b', '--to', 'a', '--phase', 'P', '--kind', 'response',
       '--subject', 's', '--body', 'a', '--in-reply-to', reqId],
      { cwd: root, stdout: respOut },
    );

    const threadOut = _capture();
    thread.run([reqId], { cwd: root, stdout: threadOut });
    const chain = JSON.parse(threadOut.text());
    assert.equal(chain.length, 2);
    assert.equal(chain[0].kind, 'request');
    assert.equal(chain[1].kind, 'response');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MSC-8: messages-archive without id throws messages-missing-id', () => {
  const root = _sandbox();
  try {
    assert.throws(
      () => archiveCmd.run([], { cwd: root, stdout: _capture() }),
      (err) => err.name === 'NubosPilotError' && err.code === 'messages-missing-id',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
