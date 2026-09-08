'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handler = require('./resume-doc.cjs');
const learnings = require('../../lib/learnings.cjs');

function _ctx(cwd) {
  const out = [];
  const err = [];
  return {
    ctx: { cwd, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rd-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'state'), { recursive: true });
  return root;
}

const DOC = {
  goal: 'Ship the reset-password flow so support stops handling resets by hand every day.',
  status: 'partial',
  active_files: [{ path: 'lib/reset.cjs', purpose: 'token generation and single-use consumption' }],
  changes: [{ what: 'added single-use token generation', why: 'a replayable reset link is a takeover vector' }],
  failed_approaches: [{
    approach: 'storing the reset token on the user row',
    why_failed: 'the row is cached for 15 minutes, so a consumed token stayed valid until eviction',
  }],
  next_steps: [{ step: 'wire the real SMTP transport', command: '/np:execute-phase 3' }],
};

function _write(root, doc) {
  const c = _ctx(root);
  const rc = handler.run(['write', '--doc', JSON.stringify(doc || DOC)], c.ctx);
  return { rc, c };
}

test('RD-1: no args prints usage and exits non-zero; --help exits zero', () => {
  const a = _ctx();
  assert.equal(handler.run([], a.ctx), 1);
  assert.match(a.out(), /Usage:/);
  const b = _ctx();
  assert.equal(handler.run(['--help'], b.ctx), 0);
  assert.match(b.out(), /failed_approaches/);
});

test('RD-2: write persists RESUME.md, the archive copy and the state file', () => {
  const root = _sandbox();
  try {
    const { rc, c } = _write(root);
    assert.equal(rc, 0);
    const payload = JSON.parse(c.out());
    assert.equal(payload.ok, true);
    assert.equal(payload.failed_approaches, 1);
    assert.ok(fs.existsSync(payload.resume_path));
    assert.ok(fs.existsSync(payload.archive_path));
    assert.ok(fs.existsSync(payload.state_path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-3: write requires a document and rejects malformed JSON', () => {
  const root = _sandbox();
  try {
    const missing = _ctx(root);
    assert.equal(handler.run(['write'], missing.ctx), 1);
    assert.match(missing.err(), /resume-doc-missing-doc/);

    const broken = _ctx(root);
    assert.equal(handler.run(['write', '--doc', '{ not json'], broken.ctx), 1);
    assert.match(broken.err(), /resume-doc-invalid-json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-4: write refuses a document whose failed_approaches section is missing', () => {
  const root = _sandbox();
  try {
    const doc = Object.assign({}, DOC);
    delete doc.failed_approaches;
    const c = _ctx(root);
    assert.equal(handler.run(['write', '--doc', JSON.stringify(doc)], c.ctx), 1);
    assert.match(c.err(), /session-handoff-missing-failed-approaches/);
    assert.ok(
      !fs.existsSync(path.join(root, '.nubos-pilot', 'RESUME.md')),
      'a refused write must leave no artefact behind',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-5: lint validates without writing anything', () => {
  const root = _sandbox();
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['lint', '--doc', JSON.stringify(DOC)], c.ctx), 0);
    assert.equal(JSON.parse(c.out()).ok, true);
    assert.ok(!fs.existsSync(path.join(root, '.nubos-pilot', 'RESUME.md')), 'lint must not persist');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-6: lint accepts a --doc-file and reports an explained-empty section', () => {
  const root = _sandbox();
  const file = path.join(root, 'doc.json');
  try {
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, DOC, {
      failed_approaches: [],
      no_failed_approaches_reason: 'One mechanical rename; the first approach worked and was committed unchanged.',
    })), 'utf-8');
    const c = _ctx(root);
    assert.equal(handler.run(['lint', '--doc-file', file], c.ctx), 0);
    assert.equal(JSON.parse(c.out()).explained_empty, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-7: status walks none -> blocked -> clear', () => {
  const root = _sandbox();
  try {
    const none = _ctx(root);
    assert.equal(handler.run(['status'], none.ctx), 0);
    assert.equal(none.out().trim(), 'none');

    _write(root);
    const blocked = _ctx(root);
    handler.run(['status'], blocked.ctx);
    assert.equal(blocked.out().trim(), 'blocked');

    const acked = _ctx(root);
    assert.equal(handler.run(['ack', '--summary', 'Reset flow half built.\nToken-on-row disproved by caching.'], acked.ctx), 0);

    const clear = _ctx(root);
    handler.run(['status'], clear.ctx);
    assert.equal(clear.out().trim(), 'clear');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-8: status --json exposes the failed-approach count for the gate message', () => {
  const root = _sandbox();
  try {
    _write(root);
    const c = _ctx(root);
    assert.equal(handler.run(['status', '--json'], c.ctx), 0);
    const st = JSON.parse(c.out());
    assert.equal(st.gate, 'blocked');
    assert.equal(st.failed_approaches, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-9: read prints the markdown brief by default and the record with --json', () => {
  const root = _sandbox();
  try {
    _write(root);
    const md = _ctx(root);
    assert.equal(handler.run(['read'], md.ctx), 0);
    assert.match(md.out(), /## 5\. Failed approaches/);
    assert.match(md.out(), /Do not re-attempt these/);

    const json = _ctx(root);
    assert.equal(handler.run(['read', '--json'], json.ctx), 0);
    assert.equal(JSON.parse(json.out()).doc.status, 'partial');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-10: read and learnings fail loudly when no handoff exists', () => {
  const root = _sandbox();
  try {
    const r = _ctx(root);
    assert.equal(handler.run(['read'], r.ctx), 1);
    assert.match(r.err(), /resume-doc-none/);

    const l = _ctx(root);
    assert.equal(handler.run(['learnings'], l.ctx), 1);
    assert.match(l.err(), /resume-doc-none/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-11: ack requires a summary and enforces the line floor', () => {
  const root = _sandbox();
  try {
    _write(root);
    const missing = _ctx(root);
    assert.equal(handler.run(['ack'], missing.ctx), 1);
    assert.match(missing.err(), /resume-doc-missing-summary/);

    const short = _ctx(root);
    assert.equal(handler.run(['ack', '--summary', 'read'], short.ctx), 1);
    assert.match(short.err(), /session-handoff-ack-too-short/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-12: ack accepts a --summary-file', () => {
  const root = _sandbox();
  const file = path.join(root, 'ack.txt');
  try {
    _write(root);
    fs.writeFileSync(file, 'Reset flow is half built.\nThe user-row token cache approach was disproved.\n', 'utf-8');
    const c = _ctx(root);
    assert.equal(handler.run(['ack', '--summary-file', file], c.ctx), 0);
    assert.equal(JSON.parse(c.out()).lines, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-13: learnings lists candidates without logging unless --log is given', () => {
  const root = _sandbox();
  try {
    _write(root);
    const dry = _ctx(root);
    assert.equal(handler.run(['learnings'], dry.ctx), 0);
    const payload = JSON.parse(dry.out());
    assert.equal(payload.logged, false);
    assert.equal(payload.candidates.length, 1);
    assert.equal(payload.candidates[0].outcome, 'failed');
    assert.equal(learnings.listLearnings(root).length, 0, 'a dry run must not touch the store');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-14: learnings --log persists the disproved approach as outcome failed', () => {
  const root = _sandbox();
  try {
    _write(root);
    const c = _ctx(root);
    assert.equal(handler.run(['learnings', '--log'], c.ctx), 0);
    assert.equal(JSON.parse(c.out()).count, 1);
    const stored = learnings.listLearnings(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].outcome, 'failed');
    assert.match(stored[0].pattern, /^avoid storing the reset token/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RD-15: an unknown verb lists the allowed set', () => {
  const c = _ctx();
  assert.equal(handler.run(['frobnicate'], c.ctx), 1);
  assert.match(c.err(), /resume-doc-unknown-verb/);
  assert.match(c.err(), /learnings/);
});
