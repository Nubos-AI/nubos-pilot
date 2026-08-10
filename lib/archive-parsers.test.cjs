'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const archive = require('./archive.cjs');
const layout = require('./layout.cjs');

const FIX_VER = path.join(__dirname, 'fixtures', 'verification');
const FIX_VAL = path.join(__dirname, 'fixtures', 'validation');

const _sandboxes = [];

function _sb(milestoneNum, verificationFixture, validationFixture, opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-arc-parse-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# ' + (o.projectName || 'Test') + '\n\nbody\n', 'utf-8');
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    YAML.stringify({
      schema_version: 2,
      milestones: [
        { id: layout.mId(milestoneNum), number: milestoneNum, name: o.name || 'M', status: o.roadmapStatus || 'pending', success_criteria: ['x'], slices: [] },
      ],
    }),
    'utf-8',
  );
  const mDir = layout.milestoneDir(milestoneNum, root);
  fs.mkdirSync(mDir, { recursive: true });
  if (verificationFixture) {
    fs.copyFileSync(path.join(FIX_VER, verificationFixture), path.join(mDir, layout.mId(milestoneNum) + '-VERIFICATION.md'));
  }
  if (validationFixture) {
    fs.copyFileSync(path.join(FIX_VAL, validationFixture), path.join(mDir, layout.mId(milestoneNum) + '-VALIDATION.md'));
  }
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

test('AP-1: frontmatter-driven verified milestone produces zero blockers', () => {
  const sb = _sb(1, 'h3-colon-verified.md', 'clean-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  assert.deepEqual(result.blockers, []);
  const m = result.milestones[0];
  assert.equal(m.verification.milestone_status, 'verified');
  assert.equal(m.verification.sc_count, 3);
  assert.equal(m.verification.passed, 3);
  assert.equal(m.verification.failed, 0);
  assert.equal(m.verification.pending, 0);
  assert.equal(m.verification.source, 'frontmatter');
  assert.equal(m.validation.uncovered, 0);
  assert.equal(m.validation.under_sampled, 0);
  assert.equal(m.validation.source, 'frontmatter');
});

test('AP-2: H2 + em-dash VERIFICATION.md (M003-style) parses correctly without frontmatter', () => {
  const sb = _sb(3, 'h2-emdash-verified.md', 'clean-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  const m = result.milestones[0];
  assert.equal(m.verification.sc_count, 3, 'expected 3 SC blocks; got ' + m.verification.sc_count);
  assert.equal(m.verification.passed, 3);
  assert.equal(m.verification.failed, 0);
  assert.equal(m.verification.pending, 0);
  assert.equal(m.verification.milestone_status, 'verified');
  assert.equal(m.verification.source, 'body');
  assert.deepEqual(result.blockers, []);
});

test('AP-3: deferred status with 0 Pending + 0 Fail is NOT a blocker', () => {
  const sb = _sb(2, 'deferred-with-rationale.md', 'clean-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  const m = result.milestones[0];
  assert.equal(m.verification.milestone_status, 'deferred');
  assert.equal(m.verification.deferred, 1);
  assert.equal(m.verification.passed, 2);
  assert.equal(m.verification.failed, 0);
  assert.equal(m.verification.pending, 0);
  assert.deepEqual(result.blockers, [], 'deferred without Pending should not block; got: ' + JSON.stringify(result.blockers));
});

test('AP-4: failed SC produces exactly one blocker (no phantom)', () => {
  const sb = _sb(5, 'failed-mixed.md', 'clean-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  assert.equal(result.milestones[0].verification.failed, 1);
  assert.deepEqual(result.blockers, ['M005: 1 SC failed']);
});

test('AP-5: VALIDATION word-grep regression — narrative "UNCOVERED" produces zero blockers', () => {
  const sb = _sb(1, 'h3-colon-verified.md', 'legacy-no-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  const m = result.milestones[0];
  assert.equal(m.validation.uncovered, 0, 'narrative mention of UNCOVERED must not produce a phantom blocker');
  assert.equal(m.validation.under_sampled, 0);
  assert.equal(m.validation.source, 'body');
  assert.deepEqual(result.blockers, []);
});

test('AP-6: VALIDATION frontmatter with issues — exact counts surface as blockers', () => {
  const sb = _sb(6, 'h3-colon-verified.md', 'issues-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  const m = result.milestones[0];
  assert.equal(m.validation.covered, 14);
  assert.equal(m.validation.under_sampled, 3);
  assert.equal(m.validation.uncovered, 1);
  assert.equal(m.validation.nyquist_compliant, false);
  assert.deepEqual(result.blockers, ['M006: 1 requirement(s) UNCOVERED']);
});

test('AP-7: missing VERIFICATION.md surfaces as missing blocker (not 0-SC parse failure)', () => {
  const sb = _sb(4, null, 'clean-frontmatter.md');
  const result = archive.computeCompletionStatus(sb);
  assert.ok(result.blockers.includes('M004: VERIFICATION.md missing'),
    'expected missing blocker; got: ' + JSON.stringify(result.blockers));
  assert.equal(result.milestones[0].verification.source, 'missing');
});

test('AP-8: VERIFICATION with 0 SC blocks (truly empty) surfaces as parse-failure blocker', () => {
  const sb = _sb(7, null, null);
  const mDir = layout.milestoneDir(7, sb);
  fs.writeFileSync(path.join(mDir, 'M007-VERIFICATION.md'),
    '# M007 — Verification\n\nBody but no SC headings at all.\n', 'utf-8');
  fs.copyFileSync(path.join(FIX_VAL, 'clean-frontmatter.md'), path.join(mDir, 'M007-VALIDATION.md'));
  const result = archive.computeCompletionStatus(sb);
  assert.ok(
    result.blockers.some((b) => /VERIFICATION\.md has 0 SC blocks/.test(b)),
    'expected 0-SC blocker; got: ' + JSON.stringify(result.blockers),
  );
});

test('AP-9: full project — mix of verified + deferred + failed produces only real blockers', () => {
  const sb = _sb(1, 'h3-colon-verified.md', 'clean-frontmatter.md');
  const stateDir = path.join(sb, '.nubos-pilot');
  const roadmap = YAML.parse(fs.readFileSync(path.join(stateDir, 'roadmap.yaml'), 'utf-8'));
  roadmap.milestones.push(
    { id: 'M002', number: 2, name: 'M2', status: 'pending', success_criteria: ['x'], slices: [] },
    { id: 'M003', number: 3, name: 'M3', status: 'pending', success_criteria: ['x'], slices: [] },
    { id: 'M005', number: 5, name: 'M5', status: 'pending', success_criteria: ['x'], slices: [] },
  );
  fs.writeFileSync(path.join(stateDir, 'roadmap.yaml'), YAML.stringify(roadmap), 'utf-8');

  for (const [n, ver, val] of [
    [2, 'deferred-with-rationale.md', 'clean-frontmatter.md'],
    [3, 'h2-emdash-verified.md', 'legacy-no-frontmatter.md'],
    [5, 'failed-mixed.md', 'clean-frontmatter.md'],
  ]) {
    const mDir = layout.milestoneDir(n, sb);
    fs.mkdirSync(mDir, { recursive: true });
    fs.copyFileSync(path.join(FIX_VER, ver), path.join(mDir, layout.mId(n) + '-VERIFICATION.md'));
    fs.copyFileSync(path.join(FIX_VAL, val), path.join(mDir, layout.mId(n) + '-VALIDATION.md'));
  }

  const result = archive.computeCompletionStatus(sb);
  assert.deepEqual(
    result.blockers,
    ['M005: 1 SC failed'],
    'expected exactly the M005 failure as blocker, no phantoms; got: ' + JSON.stringify(result.blockers),
  );
});
