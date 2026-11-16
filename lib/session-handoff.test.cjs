'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sh = require('./session-handoff.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-shandoff-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'state'), { recursive: true });
  return root;
}

function _doc(over) {
  return Object.assign({
    goal: 'Ship the reset-password flow so support stops handling resets by hand every day.',
    status: 'partial',
    active_files: [
      { path: 'lib/reset.cjs', purpose: 'token generation and single-use consumption' },
      { path: 'lib/mail.cjs', purpose: 'transport seam, currently logging instead of sending' },
    ],
    changes: [
      { what: 'added single-use token generation', why: 'a replayable reset link is a takeover vector' },
    ],
    failed_approaches: [
      {
        approach: 'storing the reset token hashed with the user row',
        why_failed: 'the row is cached for 15 minutes, so a consumed token stayed valid until eviction',
      },
    ],
    next_steps: [
      { step: 'wire the real SMTP transport', command: '/np:execute-phase 3' },
      { step: 'then re-run verification' },
    ],
  }, over || {});
}

// ---------------------------------------------------------------- validate

test('SH-1: a well-formed document validates and comes back frozen', () => {
  const doc = sh.validateDoc(_doc());
  assert.ok(Object.isFrozen(doc));
});

test('SH-2: a non-object is refused', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.throws(() => sh.validateDoc(bad), _code('session-handoff-not-object'));
  }
});

test('SH-3: status must be one of the three declared values', () => {
  assert.throws(() => sh.validateDoc(_doc({ status: 'done' })), _code('session-handoff-bad-status'));
  assert.throws(() => sh.validateDoc(_doc({ status: undefined })), _code('session-handoff-bad-status'));
  for (const ok of sh.VALID_STATUSES) {
    assert.doesNotThrow(() => sh.validateDoc(_doc({ status: ok })));
  }
});

test('SH-4: a thin goal is refused', () => {
  assert.throws(() => sh.validateDoc(_doc({ goal: 'fix stuff' })), _code('session-handoff-thin-goal'));
});

test('SH-5: active_files must exist and each entry must carry a purpose', () => {
  assert.throws(() => sh.validateDoc(_doc({ active_files: [] })), _code('session-handoff-no-active-files'));
  assert.throws(
    () => sh.validateDoc(_doc({ active_files: [{ path: 'a.cjs' }] })),
    _code('session-handoff-active-file-no-purpose'),
  );
  assert.throws(
    () => sh.validateDoc(_doc({ active_files: [{ purpose: 'does something useful' }] })),
    _code('session-handoff-bad-active-file'),
  );
});

test('SH-6: every change needs a why — the diff already carries the what', () => {
  assert.throws(() => sh.validateDoc(_doc({ changes: [] })), _code('session-handoff-no-changes'));
  assert.throws(
    () => sh.validateDoc(_doc({ changes: [{ what: 'added the token generator' }] })),
    _code('session-handoff-change-no-why'),
  );
});

// --- section 5, the reason this format exists ---

test('SH-7: an absent failed_approaches key is refused outright', () => {
  const doc = _doc();
  delete doc.failed_approaches;
  assert.throws(() => sh.validateDoc(doc), _code('session-handoff-missing-failed-approaches'));
});

test('SH-8: an empty failed_approaches list needs an explicit recorded reason', () => {
  assert.throws(
    () => sh.validateDoc(_doc({ failed_approaches: [] })),
    _code('session-handoff-unexplained-empty-failed-approaches'),
  );
  // Too short a reason is the same evasion with extra characters.
  assert.throws(
    () => sh.validateDoc(_doc({ failed_approaches: [], no_failed_approaches_reason: 'none' })),
    _code('session-handoff-unexplained-empty-failed-approaches'),
  );
  assert.doesNotThrow(() => sh.validateDoc(_doc({
    failed_approaches: [],
    no_failed_approaches_reason: 'Single mechanical task, first approach worked and was committed unchanged.',
  })));
});

test('SH-9: a failed approach without its cause is refused — it reads as an untried option', () => {
  assert.throws(
    () => sh.validateDoc(_doc({ failed_approaches: [{ approach: 'caching the token on the user row' }] })),
    _code('session-handoff-failed-approach-no-cause'),
  );
  assert.throws(
    () => sh.validateDoc(_doc({ failed_approaches: [{ approach: 'short', why_failed: 'it did not work well' }] })),
    _code('session-handoff-bad-failed-approach'),
  );
});

test('SH-10: an approach longer than the learnings pattern cap is refused here, not there', () => {
  assert.throws(
    () => sh.validateDoc(_doc({
      failed_approaches: [{ approach: 'x'.repeat(sh.MAX_PATTERN_CHARS + 1), why_failed: 'it was far too long' }],
    })),
    _code('session-handoff-failed-approach-too-long'),
  );
});

test('SH-10b: the cap covers approach AND why_failed, since both become one pattern', () => {
  // A short approach with a very long cause used to pass here and then throw
  // inside logLearning, far from the field responsible.
  assert.throws(
    () => sh.validateDoc(_doc({
      failed_approaches: [{
        approach: 'caching the reset token on the user row',
        why_failed: 'y'.repeat(sh.MAX_PATTERN_CHARS),
      }],
    })),
    _code('session-handoff-failed-approach-too-long'),
  );
});

test('SH-11: next_steps must exist and at least one must carry a concrete command', () => {
  assert.throws(() => sh.validateDoc(_doc({ next_steps: [] })), _code('session-handoff-no-next-steps'));
  assert.throws(
    () => sh.validateDoc(_doc({ next_steps: [{ step: 'continue the work' }] })),
    _code('session-handoff-no-reentry-command'),
  );
  assert.throws(
    () => sh.validateDoc(_doc({ next_steps: [{ step: 'do the thing properly', command: '' }] })),
    _code('session-handoff-bad-next-step-command'),
  );
});

// ------------------------------------------------------------------ secrets

test('SH-12: secret values are refused while variable names pass', () => {
  const cases = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'sk-abcdefghijklmnopqrstuvwxyz012345',
    'xoxb-1234567890-abcdefghij',
    'Bearer abcdefghijklmnopqrstuvwxyz0123',
    'postgres://user:hunter2pass@db.internal:5432/app',
    '-----BEGIN RSA PRIVATE KEY-----',
    'STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop',
  ];
  for (const leak of cases) {
    assert.throws(
      () => sh.validateDoc(_doc({ changes: [{ what: 'configured the transport ' + leak, why: 'needed for sending' }] })),
      _code('session-handoff-secret-value'),
      'expected a refusal for: ' + leak,
    );
  }
});

test('SH-13: naming an env var without its value is explicitly allowed', () => {
  assert.doesNotThrow(() => sh.validateDoc(_doc({
    changes: [{
      what: 'reads SMTP_PASSWORD and STRIPE_SECRET_KEY from the environment',
      why: 'the transport needs credentials that must not live in the repo',
    }],
  })));
  // An empty assignment is a name, not a value.
  assert.doesNotThrow(() => sh.validateDoc(_doc({
    changes: [{ what: 'set SMTP_PASSWORD= in the local env file', why: 'placeholder until procurement lands' }],
  })));
});

test('SH-14: scanForSecrets reports the offending field path', () => {
  const findings = sh.scanForSecrets({ changes: [{ what: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'github-token');
  assert.match(findings[0].path, /^changes\[0\]\.what$/);
});

// ------------------------------------------------------------------- render

test('SH-15: the rendered document carries all six sections in order', () => {
  const md = sh.renderMarkdown(_doc(), { created_at: '2026-07-30T10:00:00.000Z' });
  const order = ['## 1. Goal', '## 2. Status', '## 3. Active files', '## 4. Changes made',
    '## 5. Failed approaches', '## 6. Next steps'];
  let cursor = -1;
  for (const heading of order) {
    const at = md.indexOf(heading);
    assert.ok(at > cursor, heading + ' missing or out of order');
    cursor = at;
  }
});

test('SH-16: failed approaches render with an explicit do-not-retry framing', () => {
  const md = sh.renderMarkdown(_doc(), {});
  assert.match(md, /Do not re-attempt these/);
  assert.match(md, /Failed because:/);
});

test('SH-17: an explained-empty section renders the reason rather than looking skipped', () => {
  const md = sh.renderMarkdown(_doc({
    failed_approaches: [],
    no_failed_approaches_reason: 'Single mechanical rename, first approach worked and was committed unchanged.',
  }), {});
  assert.match(md, /_None recorded\._/);
  assert.match(md, /Single mechanical rename/);
});

// -------------------------------------------------------------- write/read

test('SH-18: writeHandoff writes RESUME.md, the state file, and a dated archive copy', () => {
  const root = _sandbox();
  try {
    const res = sh.writeHandoff(_doc(), root, { milestone: 'M003', task: 'M003-S001-T0002' });
    assert.equal(res.ok, true);
    assert.equal(res.failed_approaches, 1);
    assert.ok(fs.existsSync(res.resume_path), 'RESUME.md must exist');
    assert.ok(fs.existsSync(res.state_path), 'state file must exist');
    assert.ok(fs.existsSync(res.archive_path), 'archive copy must exist');
    assert.match(path.basename(res.archive_path), /-resume\.md$/);
    const md = fs.readFileSync(res.resume_path, 'utf-8');
    assert.match(md, /^---\n/);
    assert.match(md, /status: "partial"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-19: two handoffs in the same session do not overwrite each other in the archive', () => {
  const root = _sandbox();
  try {
    const a = sh.writeHandoff(_doc(), root);
    const b = sh.writeHandoff(_doc({ status: 'blocked' }), root);
    assert.notEqual(a.archive_path, b.archive_path, 'archive filenames must be unique per write');
    assert.equal(fs.readdirSync(sh.archiveDir(root)).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-20: readHandoff returns null when nothing was written', () => {
  const root = _sandbox();
  try {
    assert.equal(sh.readHandoff(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-21: a corrupt state file fails loudly rather than reading as absent', () => {
  const root = _sandbox();
  try {
    fs.writeFileSync(sh.statePath(root), '{ not json', 'utf-8');
    assert.throws(() => sh.readHandoff(root), _code('session-handoff-corrupt-state'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- ack/gate

test('SH-22: a fresh handoff blocks the gate until it is acknowledged', () => {
  const root = _sandbox();
  try {
    assert.equal(sh.handoffStatus(root).gate, 'none');
    sh.writeHandoff(_doc(), root);
    const before = sh.handoffStatus(root);
    assert.equal(before.exists, true);
    assert.equal(before.acknowledged, false);
    assert.equal(before.gate, 'blocked');
    assert.equal(before.failed_approaches, 1);

    sh.ackHandoff('Reset flow is half done.\nToken caching approach was disproved.\nNext is the SMTP transport.', root);
    const after = sh.handoffStatus(root);
    assert.equal(after.acknowledged, true);
    assert.equal(after.gate, 'clear');
    assert.ok(after.read_at);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-23: a one-line ack is refused — a checkbox gets ticked without reading', () => {
  const root = _sandbox();
  try {
    sh.writeHandoff(_doc(), root);
    assert.throws(() => sh.ackHandoff('read it', root), _code('session-handoff-ack-too-short'));
    assert.throws(() => sh.ackHandoff('', root), _code('session-handoff-ack-too-short'));
    assert.throws(() => sh.ackHandoff(null, root), _code('session-handoff-ack-too-short'));
    // Blank lines do not count toward the floor.
    assert.throws(() => sh.ackHandoff('one line\n\n\n', root), _code('session-handoff-ack-too-short'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-24: restating the whole handoff is not summarising it', () => {
  const root = _sandbox();
  try {
    sh.writeHandoff(_doc(), root);
    const tooLong = Array.from({ length: sh.MAX_ACK_LINES + 1 }, (_, i) => 'line ' + i).join('\n');
    assert.throws(() => sh.ackHandoff(tooLong, root), _code('session-handoff-ack-too-long'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-25: acking with no handoff present is an error, not a silent no-op', () => {
  const root = _sandbox();
  try {
    assert.throws(() => sh.ackHandoff('a\nb', root), _code('session-handoff-none'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SH-26: the ack is persisted and RESUME.md frontmatter reflects it', () => {
  const root = _sandbox();
  try {
    sh.writeHandoff(_doc(), root);
    sh.ackHandoff('Half-built reset flow.\nToken-on-user-row was disproved by row caching.', root);
    const record = sh.readHandoff(root);
    assert.ok(record.read_at);
    assert.match(record.ack_summary, /disproved/);
    const md = fs.readFileSync(sh.resumePath(root), 'utf-8');
    assert.ok(!/read_at: null/.test(md), 'RESUME.md must not still claim the handoff is unread');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- learnings

test('SH-27: failed approaches convert to outcome:failed learning candidates', () => {
  const candidates = sh.toLearningCandidates(_doc(), { task_id: 'M003-S001-T0002', milestone_id: 'M003' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].outcome, 'failed', 'a disproved approach must be demoted, not competing with proven ones');
  assert.match(candidates[0].pattern, /^avoid /);
  assert.match(candidates[0].pattern, /row is cached/, 'the cause must travel with the pattern');
  assert.equal(candidates[0].task_id, 'M003-S001-T0002');
  assert.equal(candidates[0].milestone_id, 'M003');
});

test('SH-28: an already-negated approach is not double-negated', () => {
  const candidates = sh.toLearningCandidates(_doc({
    failed_approaches: [{
      approach: "don't cache the reset token on the user row",
      why_failed: 'the row cache kept a consumed token valid for 15 minutes',
    }],
  }));
  assert.ok(!/avoid don't/i.test(candidates[0].pattern), 'got: ' + candidates[0].pattern);
  assert.match(candidates[0].pattern, /^avoid cache the reset token/);
});

test('SH-29: an explained-empty section yields no candidates rather than a placeholder', () => {
  const candidates = sh.toLearningCandidates(_doc({
    failed_approaches: [],
    no_failed_approaches_reason: 'Single mechanical rename, first approach worked and was committed unchanged.',
  }));
  assert.deepEqual(candidates, []);
});

test('SH-30: a candidate at the character cap still fits the store byte cap in UTF-8', () => {
  // The two caps count different units: MAX_PATTERN_CHARS is characters, while
  // logLearning's 4 KiB limit is bytes. Multi-byte prose is where a
  // character-based cap can still overflow a byte-based one, so build the worst
  // realistic case — a pattern of all two-byte characters right at the limit.
  const half = Math.floor((sh.MAX_PATTERN_CHARS - 20) / 2);
  const candidates = sh.toLearningCandidates(_doc({
    failed_approaches: [{ approach: 'ü'.repeat(half), why_failed: 'ö'.repeat(half) }],
  }));
  const bytes = Buffer.byteLength(candidates[0].pattern, 'utf-8');
  assert.ok(candidates[0].pattern.length <= sh.MAX_PATTERN_CHARS, 'fixture must sit at the character cap');
  assert.ok(bytes > sh.MAX_PATTERN_CHARS, 'sanity: this fixture must actually be multi-byte');
  assert.ok(bytes < 4 * 1024, `candidate pattern is ${bytes} bytes — logLearning would reject it at 4096`);
});
