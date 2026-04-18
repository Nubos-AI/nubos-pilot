const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nt = require('./np-tools.cjs');

const repoRoot = __dirname;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-tools-test-'));
}

test('NT-1: composeInit phase-op 3 returns full phase payload with requirements', () => {
  const payload = nt.composeInit('phase-op', ['3'], repoRoot);
  assert.equal(payload._workflow, 'phase-op');
  assert.equal(payload.phase_number, '3');
  assert.equal(payload.padded_phase, '03');
  assert.equal(payload.phase_slug, 'core-lib-parsers-dispatcher-capability-layer');
  assert.equal(payload.phase_found, true);
  assert.ok(payload.phase_dir && payload.phase_dir.endsWith('03-core-lib-parsers-dispatcher-capability-layer'));
  assert.equal(payload.has_context, true);
  assert.equal(payload.has_research, true);
  assert.equal(payload.has_plans, true);
  for (const r of ['LIB-03', 'LIB-04', 'LIB-05', 'LIB-06', 'LIB-07', 'LIB-08']) {
    assert.ok(payload.requirements.includes(r), 'missing ' + r);
  }
});

test('NT-2: composeInit phase-op 99 throws phase-not-found', () => {
  assert.throws(
    () => nt.composeInit('phase-op', ['99'], repoRoot),
    (err) => err && err.code === 'phase-not-found',
  );
});

test('NT-3: composeInit plan-phase 3 includes planned_plans + context/research paths', () => {
  const payload = nt.composeInit('plan-phase', ['3'], repoRoot);
  assert.equal(payload._workflow, 'plan-phase');
  assert.ok(Array.isArray(payload.planned_plans));
  assert.ok(payload.planned_plans.some((p) => p.endsWith('03-06-PLAN.md')));
  assert.ok(payload.context_path && payload.context_path.endsWith('03-CONTEXT.md'));
  assert.ok(payload.research_path && payload.research_path.endsWith('03-RESEARCH.md'));
});

test('NT-4: composeInit execute-phase 3 yields plans with task_count=0 when no tasks/ dir', () => {
  const payload = nt.composeInit('execute-phase', ['3'], repoRoot);
  assert.equal(payload._workflow, 'execute-phase');
  assert.ok(Array.isArray(payload.plans));
  assert.ok(payload.plans.length > 0);
  for (const p of payload.plans) {
    assert.ok(p.plan_path.endsWith('-PLAN.md'));
    assert.equal(typeof p.plan_frontmatter, 'object');
    assert.ok(p.tasks_dir.endsWith('/tasks'));
    assert.equal(p.task_count, 0);
    assert.deepEqual(p.waves, []);
    assert.deepEqual(p.warnings, []);
  }
});

test('NT-5: composeInit unknown workflow with phase-number arg falls through to minimal payload', () => {
  const payload = nt.composeInit('custom', ['3'], repoRoot);
  assert.equal(payload._workflow, 'custom');
  assert.equal(payload.phase_found, true);
  assert.equal(payload.phase_number, '3');
  assert.equal(payload.padded_phase, '03');
});

test('NT-5b: composeInit unknown workflow with no args returns skeleton', () => {
  const payload = nt.composeInit('custom', [], repoRoot);
  assert.equal(payload._workflow, 'custom');
  assert.equal(payload.phase_found, false);
});

test('NT-6: emit small payload writes JSON to stdout without @file: pointer', () => {
  const chunks = [];
  const fakeStdout = { write: (c) => { chunks.push(String(c)); return true; } };
  nt.emit({ _workflow: 'test', foo: 'bar' }, fakeStdout, repoRoot);
  const out = chunks.join('');
  assert.ok(!out.startsWith('@file:'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.foo, 'bar');
});

test('NT-7: emit big payload writes @file: pointer + temp file contains full JSON', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, '.nubos-pilot'), { recursive: true });
  const chunks = [];
  const fakeStdout = { write: (c) => { chunks.push(String(c)); return true; } };
  const big = { _workflow: 'big-test', data: 'x'.repeat(20 * 1024) };
  nt.emit(big, fakeStdout, tmp);
  const out = chunks.join('');
  assert.ok(out.startsWith('@file:'), 'expected @file: pointer, got: ' + out.slice(0, 50));
  const tmpPath = out.slice('@file:'.length).trim();
  assert.ok(tmpPath.includes('init-big-test-'));
  assert.match(tmpPath, /init-big-test-\d+-[0-9a-f]{8}\.json$/);
  const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
  assert.equal(parsed._workflow, 'big-test');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('NT-8: two emits on big payloads produce distinct temp files', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, '.nubos-pilot'), { recursive: true });
  const outs = [[], []];
  const fakeStdout0 = { write: (c) => { outs[0].push(String(c)); return true; } };
  const fakeStdout1 = { write: (c) => { outs[1].push(String(c)); return true; } };
  const big = { _workflow: 'dup', data: 'y'.repeat(20 * 1024) };
  nt.emit(big, fakeStdout0, tmp);
  nt.emit(big, fakeStdout1, tmp);
  const p0 = outs[0].join('').slice('@file:'.length).trim();
  const p1 = outs[1].join('').slice('@file:'.length).trim();
  assert.notEqual(p0, p1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('NT-9: phase-not-found error envelope shape after wrapping main-style', () => {
  let caught = null;
  try {
    nt.composeInit('phase-op', ['99'], repoRoot);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  const envelope = { error: { code: caught.code, message: caught.message, details: caught.details || null } };
  assert.equal(envelope.error.code, 'phase-not-found');
  assert.ok(envelope.error.message.length > 0);
});

test('NT-10: main invoked via child_process returns error envelope on stderr + exit 1', () => {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, ['np-tools.cjs', 'init', 'phase-op', '99'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"error"/);
  assert.match(res.stderr, /"code":\s*"phase-not-found"/);
});

test('NT-11: execute-phase 3 produces plans with parsed depends_on as Array (Pitfall 2 regression)', () => {
  const payload = nt.composeInit('execute-phase', ['3'], repoRoot);
  assert.ok(payload.plans.length >= 5);
  for (const p of payload.plans) {
    if ('depends_on' in p.plan_frontmatter) {
      assert.ok(
        Array.isArray(p.plan_frontmatter.depends_on),
        'depends_on must be Array in ' + p.plan_path,
      );
    }
  }
});
