const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const state = require('../lib/state.cjs');
const { makeSandbox, cleanupAll } = require('./helpers/fixture.cjs');

afterEach(() => { cleanupAll(); });

const V1_MINIMAL =
  '---\n' +
  'schema_version: 1\n' +
  'current_phase: 2\n' +
  'current_plan: 02-02\n' +
  'last_updated: 2026-04-14T19:30:00Z\n' +
  '---\n\nbody\n';

test('SM-1: read v1 STATE.md → readState returns v2-shape with defaults', () => {
  const root = makeSandbox({ stateMd: V1_MINIMAL });
  const s = state.readState(root);
  assert.equal(s.frontmatter.schema_version, 2);
  assert.equal(s.frontmatter.current_task, null);
  assert.ok(s.frontmatter.progress && typeof s.frontmatter.progress === 'object');
  assert.equal(s.frontmatter.progress.total_phases, 0);
  assert.equal(s.frontmatter.progress.completed_phases, 0);
  assert.equal(s.frontmatter.progress.total_plans, 0);
  assert.equal(s.frontmatter.progress.completed_plans, 0);
  assert.equal(s.frontmatter.progress.percent, 0);
  assert.ok(s.frontmatter.session && typeof s.frontmatter.session === 'object');
  assert.equal(s.frontmatter.session.stopped_at, null);
  assert.equal(s.frontmatter.session.resume_file, null);

  assert.equal(s.frontmatter.session.last_activity, '2026-04-14T19:30:00Z');
});

test('SM-2: no-op mutateState upgrades on-disk schema to v2', () => {
  const root = makeSandbox({ stateMd: V1_MINIMAL });
  state.mutateState((s) => s, root);
  const raw = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  assert.match(raw, /schema_version:\s*2/);
  assert.doesNotMatch(raw, /schema_version:\s*1/);
});

test('SM-3: second readState after upgrade returns identical v2 payload (stable)', () => {
  const root = makeSandbox({ stateMd: V1_MINIMAL });
  state.mutateState((s) => s, root);
  const first = state.readState(root);
  state.mutateState((s) => s, root);
  const second = state.readState(root);
  assert.deepEqual(first.frontmatter, second.frontmatter);
});

test('SM-4: unsupported schema_version (legacy input with e.g. 99) rejected with supported=[1,2]', () => {
  const bad =
    '---\n' +
    'schema_version: 99\n' +
    'current_phase: 1\n' +
    '---\n\nbody\n';
  const root = makeSandbox({ stateMd: bad });
  assert.throws(
    () => state.readState(root),
    (err) => {
      return err.code === 'schema-version-mismatch'
        && err.details.got === 99
        && err.details.supported.includes(1)
        && err.details.supported.includes(2);
    },
  );
});

test('SM-5: 10-iteration write/read cycle produces no drift (byte-idempotent round-trip)', () => {
  const root = makeSandbox({ stateMd: V1_MINIMAL });

  state.mutateState((s) => s, root);
  const statePath = path.join(root, '.nubos-pilot', 'STATE.md');
  const baselineDisk = fs.readFileSync(statePath, 'utf-8');
  const baselineFm = state.readState(root).frontmatter;

  for (let i = 0; i < 10; i++) {
    state.mutateState((s) => s, root);
    const disk = fs.readFileSync(statePath, 'utf-8');
    const fm = state.readState(root).frontmatter;
    assert.equal(disk, baselineDisk, `Iteration ${i}: disk bytes drifted`);
    assert.deepEqual(fm, baselineFm, `Iteration ${i}: frontmatter drifted`);
  }
});
