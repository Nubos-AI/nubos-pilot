const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const verify = require('./verify.cjs');
const {
  verifyMilestone,
  verifyPhase,
  renderVerificationMd,
  parseVerificationMd,
  writeVerificationMd,
  milestoneVerificationPath,
} = verify;
const layout = require('./layout.cjs');

const _sandboxes = [];

function makeRoadmapSandbox(milestones) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-verify-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const doc = { schema_version: 2, milestones };
  const YAML = require('yaml');
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'roadmap.yaml'),
    YAML.stringify(doc, { indent: 2 }),
    'utf-8',
  );
  _sandboxes.push(root);
  return root;
}

function cleanupAll() {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
}

test.afterEach(() => cleanupAll());

test('VR-1: renderVerificationMd emits nubos-pilot headers and per-SC blocks', () => {
  const results = [
    {
      id: 'SC-1', text: 'first criterion', status: 'Pass',
      classified_by: 'np-verifier', evidence: ['abc1234', 'lib/foo.cjs'],
      notes: '', needs_user_confirm: false,
    },
    {
      id: 'SC-2', text: 'second criterion', status: 'Fail',
      classified_by: 'np-verifier', evidence: [], notes: 'missing export',
      needs_user_confirm: false,
    },
  ];
  const md = renderVerificationMd(6, 'test-milestone', results);

  assert.match(md, /^# M006 — test-milestone — Verification$/m);
  assert.match(md, /^\*\*Verified:\*\* \d{4}-\d{2}-\d{2}$/m);
  assert.match(md, /^\*\*Milestone Status:\*\* (verified|failed|deferred)$/m);
  assert.match(md, /^## Success Criteria$/m);

  assert.match(md, /^### SC-1: first criterion$/m);
  assert.match(md, /^- \*\*Status:\*\* Pass$/m);
  assert.match(md, /^- \*\*Classified by:\*\* np-verifier$/m);
  assert.match(md, /^- \*\*Evidence:\*\* abc1234, lib\/foo\.cjs$/m);
  assert.match(md, /^### SC-2: second criterion$/m);
  assert.match(md, /^- \*\*Status:\*\* Fail$/m);
  assert.match(md, /^- \*\*Notes:\*\* missing export$/m);
});

test('VR-2: parseVerificationMd round-trip extracts id/text/status', () => {
  const results = [
    { id: 'SC-1', text: 'alpha', status: 'Pass', classified_by: 'np-verifier', evidence: [], notes: '', needs_user_confirm: false },
    { id: 'SC-2', text: 'beta',  status: 'Fail', classified_by: 'user',     evidence: [], notes: '', needs_user_confirm: false },
    { id: 'SC-3', text: 'gamma', status: 'Defer', classified_by: 'user',    evidence: [], notes: '', needs_user_confirm: false },
  ];
  const md = renderVerificationMd(7, 'round-trip-milestone', results);
  const tmp = path.join(os.tmpdir(), 'np-verify-round-' + Date.now() + '.md');
  fs.writeFileSync(tmp, md, 'utf-8');
  try {
    const parsed = parseVerificationMd(tmp);
    assert.equal(parsed.length, 3);
    assert.deepEqual(
      parsed.map((r) => ({ id: r.id, text: r.text, status: r.status })),
      [
        { id: 'SC-1', text: 'alpha', status: 'Pass' },
        { id: 'SC-2', text: 'beta',  status: 'Fail' },
        { id: 'SC-3', text: 'gamma', status: 'Defer' },
      ],
    );
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('VR-3: milestone status — any Fail → failed', () => {
  const results = [
    { id: 'SC-1', text: 't', status: 'Pass', classified_by: 'np-verifier', evidence: [], notes: '', needs_user_confirm: false },
    { id: 'SC-2', text: 't', status: 'Fail', classified_by: 'np-verifier', evidence: [], notes: '', needs_user_confirm: false },
    { id: 'SC-3', text: 't', status: 'Defer', classified_by: 'user',    evidence: [], notes: '', needs_user_confirm: false },
  ];
  const md = renderVerificationMd(1, 'n', results);
  assert.match(md, /^\*\*Milestone Status:\*\* failed$/m);
});

test('VR-4: milestone status — no Fail, any Defer → deferred', () => {
  const results = [
    { id: 'SC-1', text: 't', status: 'Pass', classified_by: 'np-verifier', evidence: [], notes: '', needs_user_confirm: false },
    { id: 'SC-2', text: 't', status: 'Defer', classified_by: 'user',    evidence: [], notes: '', needs_user_confirm: false },
  ];
  const md = renderVerificationMd(1, 'n', results);
  assert.match(md, /^\*\*Milestone Status:\*\* deferred$/m);
});

test('VR-5: milestone status — all Pass → verified', () => {
  const results = [
    { id: 'SC-1', text: 't', status: 'Pass', classified_by: 'np-verifier', evidence: [], notes: '', needs_user_confirm: false },
    { id: 'SC-2', text: 't', status: 'Pass', classified_by: 'np-verifier', evidence: [], notes: '', needs_user_confirm: false },
  ];
  const md = renderVerificationMd(1, 'n', results);
  assert.match(md, /^\*\*Milestone Status:\*\* verified$/m);
});

test('VR-6: verifyMilestone returns skeleton Result[] with null status per SC', () => {
  const sb = makeRoadmapSandbox([
    {
      id: 'M006',
      number: 6,
      name: 'exec-milestone',
      goal: 'execute things',
      success_criteria: ['criterion one works', 'criterion two works', 'criterion three works'],
      requirements: [],
      status: 'pending',
      slices: [],
    },
  ]);
  const results = verifyMilestone(6, { cwd: sb });
  assert.equal(results.length, 3);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    assert.equal(r.id, 'SC-' + (i + 1));
    assert.equal(r.status, null);
    assert.equal(r.classified_by, null);
    assert.ok(Array.isArray(r.evidence));
    assert.equal(r.needs_user_confirm, false);
  }
  assert.equal(results[0].text, 'criterion one works');
});

test('VR-7: writeVerificationMd persists under milestones/M<NNN>/M<NNN>-VERIFICATION.md', () => {
  const sb = makeRoadmapSandbox([
    {
      id: 'M006',
      number: 6,
      name: 'exec-milestone',
      goal: 'execute things',
      success_criteria: ['only one thing'],
      requirements: [],
      status: 'pending',
      slices: [],
    },
  ]);
  layout.createMilestoneDir(6, sb);
  writeVerificationMd(6, sb);
  const target = milestoneVerificationPath(6, sb);
  assert.ok(fs.existsSync(target), 'VERIFICATION.md should exist at ' + target);
  const content = fs.readFileSync(target, 'utf-8');
  assert.match(content, /^# M006 — exec-milestone — Verification$/m);
  assert.match(content, /^### SC-1: only one thing$/m);
});

test('VR-8: verifyPhase is a backwards-compat alias for verifyMilestone', () => {
  const sb = makeRoadmapSandbox([
    {
      id: 'M006',
      number: 6,
      name: 'exec-milestone',
      success_criteria: ['x'],
      requirements: [],
      status: 'pending',
      slices: [],
    },
  ]);
  const a = verifyPhase(6, { cwd: sb });
  const b = verifyMilestone(6, { cwd: sb });
  assert.deepEqual(a, b);
});
