'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const security = require('./security.cjs');
const ledger = require('../../lib/security/ledger.cjs');

let _c = 0;
function freshSid() { _c += 1; return 'cmd-sec-' + process.pid + '-' + _c; }
function cleanup(sid) { ledger.removeLedger(sid); try { fs.unlinkSync(ledger.ledgerPath(sid) + '.lock'); } catch {} }

function collector() {
  const chunks = [];
  return { stdout: { write: (s) => chunks.push(s) }, text: () => chunks.join('') };
}

async function runVerb(verb, payload, cwd, extra) {
  const c = collector();
  const argv = [verb, '--payload', JSON.stringify(payload), ...(extra || [])];
  await security.run(argv, { cwd: cwd || process.cwd(), stdout: c.stdout });
  return c.text();
}

test('SECCMD-1 scan emits additionalContext on first hit, silent on repeat (report-once)', async () => {
  const sid = freshSid();
  try {
    const payload = { session_id: sid, tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'const r = eval(q)' } };
    const first = await runVerb('scan', payload);
    const second = await runVerb('scan', payload);
    assert.match(first, /hookSpecificOutput/);
    assert.match(first, /nubos-pilot security/);
    assert.equal(second, '');
  } finally { cleanup(sid); }
});

test('SECCMD-2 review harvests unsurfaced risks and emits a non-blocking Stop block decision', async () => {
  const sid = freshSid();
  try {
    ledger.addReviewFindings(sid, [{ file: 'a.js', line: 5, category: 'injection', severity: 'risk', title: 'SQLi', mitigation_hint: 'parameterize' }], 'stop');
    const out = await runVerb('review', { session_id: sid });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /nubos-pilot security/);
    assert.match(parsed.reason, /SQLi/);
  } finally { cleanup(sid); }
});

test('SECCMD-3 commit verb ignores non-git Bash commands', async () => {
  const sid = freshSid();
  try {
    const out = await runVerb('commit', { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    assert.equal(out, '');
    assert.equal(ledger.readLedger(sid).commit_review_times.length, 0);
  } finally { cleanup(sid); }
});

test('SECCMD-4 master toggle off makes every hook verb a silent no-op', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sec-proj-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'), JSON.stringify({ security: { enabled: false } }));
  const sid = freshSid();
  try {
    const scanOut = await runVerb('scan', { session_id: sid, tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'eval(q)' } }, root);
    ledger.addReviewFindings(sid, [{ file: 'a.js', line: 1, category: 'x', severity: 'risk', title: 't' }], 'stop');
    const reviewOut = await runVerb('review', { session_id: sid }, root);
    assert.equal(scanOut, '');
    assert.equal(reviewOut, '');
  } finally { cleanup(sid); fs.rmSync(root, { recursive: true, force: true }); }
});

test('SECCMD-5 session-start and baseline are safe no-throw no-ops without a repo', async () => {
  const sid = freshSid();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-sec-nr-'));
  try {
    assert.equal(await runVerb('session-start', { session_id: sid }, root), '');
    assert.equal(await runVerb('baseline', { session_id: sid }, root), '');
  } finally { cleanup(sid); fs.rmSync(root, { recursive: true, force: true }); }
});
