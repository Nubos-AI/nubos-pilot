'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./skill-audit.cjs');
const checkpoint = require('../../lib/checkpoint.cjs');

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-skill-cli-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot', 'checkpoints'), { recursive: true });
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: null\ncurrent_plan: null\ncurrent_task: null\n---\n',
    'utf-8',
  );
  return r;
}
function _cap(cwd) {
  const out = { text: '' }; const err = { text: '' };
  return { cwd, stdout: { write: (s) => { out.text += s; return true; } }, stderr: { write: (s) => { err.text += s; return true; } }, out, err };
}
const TID = 'M001-S001-T0001';

test('SC-1: expect then findings reports the unacked skill', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    assert.equal(run(['expect', '--task', TID, '--skills', 'np-api-design,np-encryption'], _cap(r)), 0);
    const c = _cap(r);
    assert.equal(run(['findings', '--task', TID], c), 0);
    const parsed = JSON.parse(c.out.text);
    assert.equal(parsed.findings.length, 1);
    assert.deepEqual(parsed.findings[0].raw.missing_skills.sort(), ['np-api-design', 'np-encryption']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SC-2: ack clears the finding for that skill', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    run(['expect', '--task', TID, '--skills', 'np-api-design'], _cap(r));
    run(['ack', '--task', TID, '--skill', 'np-api-design'], _cap(r));
    const c = _cap(r);
    run(['findings', '--task', TID], c);
    assert.equal(JSON.parse(c.out.text).findings.length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SC-3: invalid task id → error envelope exit 1', () => {
  const c = _cap(process.cwd());
  assert.equal(run(['ack', '--task', 'bogus', '--skill', 'x'], c), 1);
  assert.match(c.err.text, /skill-audit-invalid-task-id/);
});

test('SC-4: ack without --skill → error envelope exit 1', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    const c = _cap(r);
    assert.equal(run(['ack', '--task', TID], c), 1);
    assert.match(c.err.text, /skill-audit-missing-skill/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SC-5: unknown verb → exit 1; --help → exit 0', () => {
  const c1 = _cap(process.cwd());
  assert.equal(run(['bogus'], c1), 1);
  assert.match(c1.err.text, /skill-audit-unknown-verb/);
  const c2 = _cap(process.cwd());
  assert.equal(run(['--help'], c2), 0);
  assert.match(c2.out.text, /skill-audit/);
});

test('SC-6: expect with empty skills is a no-op (no findings)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    assert.equal(run(['expect', '--task', TID, '--skills', ''], _cap(r)), 0);
    const c = _cap(r);
    run(['findings', '--task', TID], c);
    assert.equal(JSON.parse(c.out.text).findings.length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
