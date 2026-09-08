'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const loopStateRead   = require('./loop-state-read.cjs');
const loopStateRecord = require('./loop-state-record.cjs');
const loopEvaluate    = require('./loop-evaluate.cjs');
const loopStuck       = require('./loop-stuck.cjs');
const loopMetrics     = require('./loop-metrics.cjs');
const learningLog     = require('./learning-log.cjs');
const checkpoint      = require('../../lib/checkpoint.cjs');
const learnings       = require('../../lib/learnings.cjs');

const _sandboxes = [];

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-loop-cli-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot', 'checkpoints'), { recursive: true });
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: null\ncurrent_plan: null\ncurrent_task: null\n---\n',
    'utf-8',
  );
  _sandboxes.push(r);
  return r;
}

function _cap() {
  let s = '';
  return { stub: { write: (x) => { s += String(x); return true; } }, get: () => s };
}

afterEach(() => {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('LCLI-1: loop-state-record + loop-state-read round-trip (symmetric shape)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const cap1 = _cap();
  loopStateRecord.run(
    ['M001-S001-T0001', '--json', '{"last_action":"awaiting-user"}'],
    { cwd: r, stdout: cap1.stub },
  );
  const cap2 = _cap();
  loopStateRead.run(['M001-S001-T0001'], { cwd: r, stdout: cap2.stub });
  const out = JSON.parse(cap2.get());
  // Both commands return { task_id, nubosloop } — symmetric shape.
  assert.equal(out.task_id, 'M001-S001-T0001');
  assert.equal(out.nubosloop.last_action, 'awaiting-user');
});

test('LCLI-2: loop-state-record rejects invalid taskId', () => {
  const r = _mkRoot();
  assert.throws(
    () => loopStateRecord.run(
      ['../../STATE', '--json', '{}'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-state-invalid-task-id',
  );
});

test('LCLI-3: loop-state-record requires --json payload', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  assert.throws(
    () => loopStateRecord.run(['M001-S001-T0001'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-state-missing-json',
  );
});

test('LCLI-3a: loop-state-record rejects round (write-once-by-phase, ADR-0010 trust-layer)', () => {
  // `round` advances mechanically inside `loop-run-round --phase` calls.
  // Allowing the CLI to set it would let an attacker flip the round counter
  // back to one for which a valid Layer-C audit already exists, replaying old
  // evidence against the strict-equal `agent + round` match.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  assert.throws(
    () => loopStateRecord.run(
      ['M001-S001-T0001', '--json', '{"round":2}'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-state-unknown-key' && err.details.key === 'round',
  );
});

test('LCLI-3b: loop-state-record rejects last_phase / verify_exit_code / findings (trust-layer fields)', () => {
  // The five fields `_assertLoopGate` reads MUST NOT be settable via the CLI,
  // otherwise a single state-record call synthesizes the entire commit-task
  // gate signature and bypasses Layers A/B/C in one shot.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  for (const key of ['last_phase', 'verify_exit_code', 'findings', 'tool_use_audit', 'committed_at']) {
    assert.throws(
      () => loopStateRecord.run(
        ['M001-S001-T0001', '--json', JSON.stringify({ [key]: key === 'findings' || key === 'tool_use_audit' ? [] : 0 })],
        { cwd: r, stdout: _cap().stub },
      ),
      (err) => err && err.code === 'loop-state-unknown-key' && err.details.key === key,
      'expected ' + key + ' to be rejected',
    );
  }
});

test('LCLI-3c: loop-state-record rejects max_rounds_override < 1 (T3)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  assert.throws(
    () => loopStateRecord.run(
      ['M001-S001-T0001', '--json', '{"max_rounds_override":0}'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-state-invalid-value' && err.details.key === 'max_rounds_override',
  );
});

test('LCLI-3d: loop-state-record accepts new keys user_reply / max_rounds_override / pending_askuser_spec', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  loopStateRecord.run(
    ['M001-S001-T0001', '--json',
      '{"user_reply":"yes","max_rounds_override":8,"pending_askuser_spec":{"type":"select"}}'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.user_reply, 'yes');
  assert.equal(cp.nubosloop.max_rounds_override, 8);
  assert.deepEqual(cp.nubosloop.pending_askuser_spec, { type: 'select' });
});

test('LCLI-4: loop-evaluate takes critic JSON, emits next_action', () => {
  const r = _mkRoot();
  const cap = _cap();
  loopEvaluate.run(
    ['--round', '1', '--max-rounds', '3', '--json',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit');
});

test('LCLI-5: loop-evaluate routes a todo-marker finding to executor', () => {
  const r = _mkRoot();
  const cap = _cap();
  loopEvaluate.run(
    ['--round', '1', '--json',
      '[{"critic":"style","findings":[{"category":"todo-marker","file":"a","line":1,"severity":"fail"}]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'executor');
});

test('LCLI-6: loop-evaluate at maxRounds with findings → stuck', () => {
  const r = _mkRoot();
  const cap = _cap();
  loopEvaluate.run(
    ['--round', '3', '--max-rounds', '3', '--json',
      '[{"critic":"style","findings":[{"category":"todo-marker","file":"a","line":1,"severity":"fail"}]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'stuck');
  assert.equal(out.stuck, true);
});

test('LCLI-7: loop-stuck flips checkpoint status to stuck + records loop state', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const cap = _cap();
  loopStuck.run(
    ['M001-S001-T0001', '--reason', 'maxRounds reached', '--findings', '[]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.status, 'stuck');
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.status, 'stuck');
  assert.equal(cp.nubosloop.stuck, true);
  assert.equal(cp.nubosloop.stuck_reason, 'maxRounds reached');
  assert.match(cp.nubosloop.stuck_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('LCLI-8: loop-metrics aggregates across checkpoints', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // `round` is no longer settable from the CLI — seed it directly through the
  // lib helper so the metrics aggregator sees a complete loop state.
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1, last_action: 'commit' }, r);
  const cap = _cap();
  loopMetrics.run([], { cwd: r, stdout: cap.stub });
  const m = JSON.parse(cap.get());
  assert.equal(m.tasks_with_loop, 1);
  assert.equal(m.commit_count, 1);
});

test('LCLI-9: learning-log persists via local adapter', () => {
  const r = _mkRoot();
  const cap = _cap();
  learningLog.run(
    ['--pattern', 'use jose for jwt verification', '--outcome', 'verified',
      '--task-id', 'M001-S001-T0001'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.adapter, 'local');
  assert.equal(out.persisted, true);
  const list = learnings.listLearnings(r);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].task_ids, ['M001-S001-T0001']);
});

test('LCLI-10: learning-log requires --pattern and --outcome', () => {
  const r = _mkRoot();
  assert.throws(
    () => learningLog.run(['--pattern', 'x'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'learning-log-missing-args',
  );
});

test('LCLI-11: every new loop command is registered in _commands.cjs', () => {
  const { COMMANDS } = require('./_commands.cjs');
  const names = COMMANDS.map((c) => c.name);
  for (const cmd of ['loop-state-read', 'loop-state-record', 'loop-evaluate', 'loop-stuck', 'loop-metrics', 'learning-log']) {
    assert.ok(names.includes(cmd), 'missing command in _commands.cjs: ' + cmd);
  }
});

test('LCLI-12: every new loop command is dispatched by np-tools.cjs', () => {
  const { topLevelCommands } = require('../../np-tools.cjs');
  for (const cmd of ['loop-state-read', 'loop-state-record', 'loop-evaluate', 'loop-stuck', 'loop-metrics', 'learning-log']) {
    assert.ok(topLevelCommands[cmd], 'missing dispatcher entry: ' + cmd);
    assert.equal(typeof topLevelCommands[cmd].run, 'function', 'no run() for ' + cmd);
  }
});

test('LCLI-13: loop-stuck atomic — nubosloop.last_action="stuck" AND status="stuck" land in one mtime', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  loopStuck.run(
    ['M001-S001-T0001', '--reason', 'maxRounds reached', '--findings', '[{"category":"todo-marker"}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  // Both surfaces must be set after a single command
  assert.equal(cp.status, 'stuck');
  assert.equal(cp.nubosloop.last_action, 'stuck');
  assert.equal(cp.nubosloop.stuck, true);
  assert.equal(cp.nubosloop.findings.length, 1);
});

test('LCLI-14: loop-stuck without --findings preserves previous round findings (no clobber)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // Round 1 records two findings — these are write-once-by-phase fields,
  // so we seed them via the lib helper rather than the CLI allow-list.
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState(
    'M001-S001-T0001',
    { round: 2, last_action: 'executor', findings: [{ category: 'todo-marker' }, { category: 'missing-test' }] },
    r,
  );
  // Stuck without --findings — must NOT overwrite to []
  loopStuck.run(
    ['M001-S001-T0001', '--reason', 'no progress'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.status, 'stuck');
  assert.equal(cp.nubosloop.last_action, 'stuck');
  assert.equal(cp.nubosloop.findings.length, 2, 'previous round findings must be preserved');
});

test('LCLI-15: loop-preflight returns no-hit shape on empty store', async () => {
  const r = _mkRoot();
  const cap = _cap();
  const loopPreflight = require('./loop-preflight.cjs');
  await loopPreflight.run(['--query', 'any task'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.hit, null);
  assert.equal(out.bypass_swarm, false);
});

test('LCLI-16: loop-preflight cache-bypass on populated store', async () => {
  const r = _mkRoot();
  const lr = require('../../lib/learnings.cjs');
  for (let i = 0; i < 3; i += 1) lr.logLearning({ pattern: 'use jose for jwt verification', outcome: 'ok' }, r);
  const cap = _cap();
  const loopPreflight = require('./loop-preflight.cjs');
  await loopPreflight.run(['--query', 'use jose for jwt verification', '--threshold', '0.5', '--min-occurrence', '3'],
    { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.ok(out.hit);
  assert.equal(out.bypass_swarm, true);
});

test('LCLI-17: loop-preflight rejects missing --query', async () => {
  const r = _mkRoot();
  const loopPreflight = require('./loop-preflight.cjs');
  await assert.rejects(
    () => loopPreflight.run([], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-preflight-missing-query',
  );
});

// LCLI-18 / LCLI-19 (loop-state-advance) removed in fourth review — the verb
// had no workflow consumer; loop-run-round + loop-state-record cover its job.

test('LCLI-AUDIT-1: loop-audit-tool-use append mode persists log', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // A real spawn leaves a ledger entry attributed to itself before claiming the call.
  require('../../lib/nubosloop.cjs').recordSearchEvidence('M001-S001-T0001', 'q', r, 'np-executor');
  const cap = _cap();
  const audit = require('./loop-audit-tool-use.cjs');
  audit.run(
    ['M001-S001-T0001', '--agent', 'np-executor', '--tool-use-log', '["Read","knowledge-search","Edit"]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.ok, true);
  assert.equal(out.violation, null);
  assert.deepEqual(out.search_calls, ['knowledge-search']);
});

test('LCLI-AUDIT-2: loop-audit-tool-use --read returns the audit log', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const audit = require('./loop-audit-tool-use.cjs');
  audit.run(
    ['M001-S001-T0001', '--agent', 'np-executor', '--tool-use-log', '["Read","Edit"]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cap = _cap();
  audit.run(['M001-S001-T0001', '--read'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.audit.length, 1);
  assert.equal(out.audit[0].violation, 'rule-9-no-search-tool-invoked');
});

test('LCLI-AUDIT-3: loop-audit-tool-use rejects missing --agent + --tool-use-log', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const audit = require('./loop-audit-tool-use.cjs');
  assert.throws(
    () => audit.run(['M001-S001-T0001'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-audit-missing-agent',
  );
});

test('LCLI-READ-1: loop-state-read --strict throws when checkpoint missing', () => {
  const r = _mkRoot();
  assert.throws(
    () => loopStateRead.run(['M001-S001-T0001', '--strict'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-state-task-not-found',
  );
});

test('LCLI-READ-2: loop-state-read returns task_exists=true even when nubosloop is null', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const cap = _cap();
  loopStateRead.run(['M001-S001-T0001'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.task_exists, true);
  assert.equal(out.nubosloop, null);
});

test('LCLI-RR-1: loop-run-round phase=preflight stamps cache_hit + advances round', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'preflight', '--query', 'use jose for jwt verification'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.phase, 'preflight');
  assert.equal(out.next_action, 'spawn-researcher-swarm');
  assert.equal(out.cache_hit, null);
  // Checkpoint state must reflect the advance
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.round, 1);
  assert.equal(cp.nubosloop.last_phase, 'preflight');
});

test('LCLI-RR-2: loop-run-round preflight on populated store → spawn-executor-with-cache', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const lr = require('../../lib/learnings.cjs');
  for (let i = 0; i < 3; i += 1) lr.logLearning({ pattern: 'use jose for jwt verification', outcome: 'ok' }, r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'preflight', '--query', 'use jose for jwt verification', '--threshold', '0.5'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.bypass_swarm, true);
  assert.equal(out.next_action, 'spawn-executor-with-cache');
  assert.ok(out.cache_hit);
});

// Helper: seed the per-round spawn-evidence audit log so Layer-C gates accept
// post-executor / post-critics. Tests that exercise the gate explicitly
// (LCLI-RR-12+) build their own partial fixtures.
function _seedSpawnEvidence(taskId, round, agents, cwd) {
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState(taskId, { round }, cwd);
  for (const a of agents) {
    // Pass an empty tool-use log — these are evidence stamps, not Rule 9 audits.
    // AUDITED_AGENTS must look like a real spawn: log `knowledge-search` AND
    // leave a ledger entry attributed to themselves. This used to log the
    // now-removed `search-knowledge` alias precisely because that string was
    // credited with no ledger evidence at all — the P3.6 free pass.
    if (nubosloop.AUDITED_AGENTS.includes(a)) {
      nubosloop.recordSearchEvidence(taskId, 'seed query', cwd, a);
      nubosloop.auditToolUse(taskId, a, ['knowledge-search'], cwd);
    } else {
      nubosloop.auditToolUse(taskId, a, [], cwd);
    }
  }
}

test('LCLI-RR-2a: phase=post-architect refuses without np-task-architect spawn audit', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  require('../../lib/nubosloop.cjs').recordLoopState('M001-S001-T0001', { round: 1 }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-architect'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-architect-missing-spawn-audit',
  );
});

test('LCLI-RR-2b: phase=post-architect with stamp → spawn-test-writer, no round bump', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-task-architect'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'post-architect'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.phase, 'post-architect');
  assert.equal(out.next_action, 'spawn-test-writer');
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.last_phase, 'post-architect');
  assert.equal(cp.nubosloop.round, 1, 'prep step must not bump the round counter');
});

test('LCLI-RR-2c: phase=post-architect --force-post-architect bypasses the audit gate', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  require('../../lib/nubosloop.cjs').recordLoopState('M001-S001-T0001', { round: 1 }, r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-architect', '--force-post-architect'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.forced, true);
  assert.equal(out.next_action, 'spawn-test-writer');
});

test('LCLI-RR-2d: phase=post-test-writer refuses without np-test-writer spawn audit', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  require('../../lib/nubosloop.cjs').recordLoopState('M001-S001-T0001', { round: 1 }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-test-writer'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-test-writer-missing-spawn-audit',
  );
});

test('LCLI-RR-2e: phase=post-test-writer with stamp → spawn-executor, no round bump', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-test-writer'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'post-test-writer'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.phase, 'post-test-writer');
  assert.equal(out.next_action, 'spawn-executor');
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.last_phase, 'post-test-writer');
  assert.equal(cp.nubosloop.round, 1);
});

test('LCLI-RR-2f: phase=post-test-writer --tests records the written paths in nubosloop.tdd_tests', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-test-writer'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-test-writer', '--tests', 'tests/a.test.ts, tests/b.test.ts'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.deepEqual(out.tdd_tests, ['tests/a.test.ts', 'tests/b.test.ts']);
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.deepEqual(cp.nubosloop.tdd_tests, ['tests/a.test.ts', 'tests/b.test.ts']);
});

test('LCLI-RR-2g: post-researcher next_action skips disabled prep steps (architect off → test-writer)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'config.json'),
    JSON.stringify({ agents: { architect: false } }),
    'utf-8',
  );
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-researcher', 'np-researcher', 'np-researcher'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'post-researcher'], { cwd: r, stdout: cap.stub });
  assert.equal(JSON.parse(cap.get()).next_action, 'spawn-test-writer');
});

test('LCLI-RR-2h: post-researcher next_action → executor when both prep steps are off', async () => {
  const r = _mkRoot();
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'config.json'),
    JSON.stringify({ agents: { architect: false, test_writer: false } }),
    'utf-8',
  );
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-researcher', 'np-researcher', 'np-researcher'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'post-researcher'], { cwd: r, stdout: cap.stub });
  assert.equal(JSON.parse(cap.get()).next_action, 'spawn-executor');
});

test('LCLI-RR-3: loop-run-round phase=post-executor with verify-green → spawn-critic-schwarm', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.verify_green, true);
  assert.equal(out.next_action, 'spawn-critic-schwarm');
});

test('LCLI-RR-4: loop-run-round phase=post-executor with verify-red → spawn-build-fixer', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '1'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.verify_green, false);
  assert.equal(out.next_action, 'spawn-build-fixer');
});

test('LCLI-RR-5: loop-run-round phase=post-critics with zero findings → commit', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1,
    ['np-executor', 'np-critic'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[],"criteria":[]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit');
  assert.equal(out.stuck, false);
});

test('LCLI-RR-5b: post-critics surfaces rule-9-violation from audit log even with empty critic findings', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  // Round 1, executor shipped without searching → audit captures violation
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  nubosloop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'Edit'], r);
  // Seed the three critic spawn evidences so the Layer-C gate is satisfied —
  // we want the rule-9-violation to surface from the audit log, not the gate.
  _seedSpawnEvidence('M001-S001-T0001', 1,
    ['np-critic'], r);
  // Critics return zero findings (style/tests/acceptance all clean) — without
  // the Rule 9 chain the loop would commit. With it, the audit violation must
  // still route the round to executor.
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[],"criteria":[]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'executor', 'rule-9 audit violation must route post-critics → executor');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].category, 'rule-9-violation');
  assert.equal(out.findings[0].critic, 'audit');
  // And the audit findings must persist to the checkpoint so dashboards see them.
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.findings[0].category, 'rule-9-violation');
});

test('LCLI-RR-5c: post-critics ignores audits already routed in a prior round', async () => {
  // Updated for Gap #1 carry-forward: round-2 only ignores round-1 audits
  // when they were marked `routed_in_round` (which post-critics would have
  // done if it ran for round 1). This test simulates the simulated chain:
  // round-1 violation routed via post-critics, then round 2 is clean.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  // Round 1: executor violated. Manually mark routed (would normally be
  // done by `_runPostCritics` after consuming the finding).
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  nubosloop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read'], r);
  nubosloop.markAuditsRoutedForRound('M001-S001-T0001', 1, r);
  // Round 2: build-fixer searched (no violation), critics seeded.
  nubosloop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
  nubosloop.recordSearchEvidence('M001-S001-T0001', 'q', r, 'np-build-fixer');
  nubosloop.auditToolUse('M001-S001-T0001', 'np-build-fixer', ['knowledge-search'], r);
  _seedSpawnEvidence('M001-S001-T0001', 2, ['np-critic'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[],"criteria":[]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  // Round-1 violation marked routed → does not carry forward → commit.
  assert.equal(out.next_action, 'commit');
  assert.equal(out.findings.length, 0);
});

test('LCLI-RR-5d: post-critics CARRIES FORWARD unrouted Rule-9 violation from verify-red round (Gap #1)', async () => {
  // The orphan-on-verify-red scenario. Round-1 executor violates Rule 9 AND
  // verify is red. _runPostExecutor bumps to round 2 without invoking
  // post-critics, so round-1 audits remain unrouted. In round 2, even if the
  // critics are clean, the carried-forward audit must route the loop back to
  // executor — otherwise the violation evaporates silently.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  // Simulate: round 1 verify-red after executor violation.
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  nubosloop.auditToolUse('M001-S001-T0001', 'np-executor', ['Read', 'Edit'], r); // violation, NOT marked
  // Round 2: build-fixer audited (with search), critic seeded. Critics clean.
  nubosloop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
  nubosloop.recordSearchEvidence('M001-S001-T0001', 'q', r, 'np-build-fixer');
  nubosloop.auditToolUse('M001-S001-T0001', 'np-build-fixer', ['knowledge-search'], r);
  _seedSpawnEvidence('M001-S001-T0001', 2, ['np-critic'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[],"criteria":[]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  // Round-1 violation must surface here (carried forward).
  assert.equal(out.next_action, 'executor', 'orphaned round-1 violation must route to executor');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].category, 'rule-9-violation');
  assert.match(out.findings[0].remediation, /Carried forward from round 1/);
  // After consumption, the audit must be marked routed so a future round
  // doesn't re-fire it.
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  const auditEntry = cp.nubosloop.tool_use_audit.find((a) => a.agent === 'np-executor' && a.violation);
  assert.equal(auditEntry.routed_in_round, 2);
});


test('LCLI-RR-6: loop-run-round phase=stuck flips status + records reason', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'stuck', '--reason', 'maxRounds reached'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'escalate-via-askuser');
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.status, 'stuck');
  assert.equal(cp.nubosloop.stuck_reason, 'maxRounds reached');
});

test('LCLI-RR-7: loop-run-round rejects unknown --phase', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(['M001-S001-T0001', '--phase', 'mystery'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-run-round-invalid-phase',
  );
});

test('LCLI-RR-8: phase=commit refuses without verify_exit_code (post-executor never ran)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'commit'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-commit-precondition-missing'
      && err.details && err.details.missing === 'verify_exit_code',
  );
});

test('LCLI-RR-9: phase=commit refuses without findings (post-critics never ran)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  // post-executor ran (verify-green) but critics never produced findings.
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  checkpoint.mergeCheckpoint('M001-S001-T0001', (cur) => ({
    nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, { verify_exit_code: 0 }),
  }), r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'commit'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-commit-precondition-missing'
      && err.details && err.details.missing === 'findings',
  );
});

test('LCLI-RR-10: phase=commit accepts complete loop state (verify-green + findings array)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  checkpoint.mergeCheckpoint('M001-S001-T0001', (cur) => ({
    nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, {
      verify_exit_code: 0,
      findings: [],
    }),
  }), r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'commit'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit-task');
  assert.equal(out.forced, false);
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.last_phase, 'commit');
  assert.equal(cp.nubosloop.forced_commit_phase, false);
});

test('LCLI-RR-11: phase=commit --force-commit-phase bypasses preconditions and stamps the override', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // Empty checkpoint — no verify, no findings. Force should still allow.
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'commit', '--force-commit-phase'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit-task');
  assert.equal(out.forced, true);
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.forced_commit_phase, true);
});

test('LCLI-RR-MSG-1: phase=commit refused while pendingReplies > 0 (ADR-0015)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  checkpoint.mergeCheckpoint('M001-S001-T0001', (cur) => ({
    nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, {
      verify_exit_code: 0,
      findings: [],
    }),
  }), r);
  const messaging = require('../../lib/messaging.cjs');
  messaging.send({
    from: 'np-critic', to: 'np-executor',
    phase: 'M001-S001-T0001', kind: 'request',
    subject: 'fix-x', body: 'please fix', expects_reply: true,
  }, r);

  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(['M001-S001-T0001', '--phase', 'commit'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-commit-precondition-missing'
      && err.details && err.details.missing === 'pending-replies-cleared'
      && err.details.observed_pending_replies === 1,
  );
});

test('LCLI-RR-MSG-2: phase=commit succeeds and sweeps task messages once replies are archived', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  checkpoint.mergeCheckpoint('M001-S001-T0001', (cur) => ({
    nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, {
      verify_exit_code: 0,
      findings: [],
    }),
  }), r);
  const messaging = require('../../lib/messaging.cjs');
  const req = messaging.send({
    from: 'np-critic', to: 'np-executor',
    phase: 'M001-S001-T0001', kind: 'request',
    subject: 'fix-x', body: 'please fix', expects_reply: true,
  }, r);
  messaging.send({
    from: 'np-executor', to: 'np-critic',
    phase: 'M001-S001-T0001', kind: 'response',
    subject: 'fix-x', body: 'done', in_reply_to: req.id,
  }, r);
  messaging.archive(req.id, r);

  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'commit'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit-task');
  assert.equal(out.messages_swept, 2);

  const inboxLeft = messaging.inbox('np-critic', { phase: 'M001-S001-T0001' }, r);
  assert.equal(inboxLeft.length, 0);
  const archived = path.join(r, '.nubos-pilot', 'messages', 'archive', 'by-task', 'M001-S001-T0001');
  assert.ok(fs.existsSync(archived));
});

test('LCLI-RR-MEM-1: phase=commit indexes the just-logged learning into memory when memory.enabled=true', async () => {
  const r = _mkRoot();
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'config.json'),
    JSON.stringify({ memory: { enabled: true, model: 'mock-v1', alpha: 0.6 } }),
    'utf-8',
  );
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  checkpoint.mergeCheckpoint('M001-S001-T0001', (cur) => ({
    nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, {
      verify_exit_code: 0,
      findings: [],
    }),
  }), r);

  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'commit',
     '--learning-pattern', 'use jose for jwt',
     '--learning-outcome', 'verified'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit-task');
});

test('LCLI-RR-MEM-2: phase=commit reports memory_skip_reason=memory-disabled when feature off', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  checkpoint.mergeCheckpoint('M001-S001-T0001', (cur) => ({
    nubosloop: Object.assign({}, (cur && cur.nubosloop) || {}, {
      verify_exit_code: 0,
      findings: [],
    }),
  }), r);

  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'commit',
     '--learning-pattern', 'use jose for jwt',
     '--learning-outcome', 'verified'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.messages_swept, 0);
});

// Layer C — audit-trail evidence enforcement -------------------------------

test('LCLI-RR-12: post-executor refuses without np-executor audit (R1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // Round defaults to 1 with no audit entries.
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-executor-missing-spawn-audit'
      && Array.isArray(err.details && err.details.missing)
      && err.details.missing.includes('np-executor')
      && err.details.round === 1,
  );
});

test('LCLI-RR-13: post-executor refuses on R1 if only np-build-fixer was audited (wrong agent)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-build-fixer'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-executor-missing-spawn-audit'
      && err.details.missing.includes('np-executor'),
  );
});

test('LCLI-RR-14: post-executor on R≥2 requires np-build-fixer audit, not np-executor', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // Advance to round 2; audit only the wrong agent (np-executor).
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 2 }, r);
  nubosloop.auditToolUse('M001-S001-T0001', 'np-executor', ['search-knowledge'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-executor-missing-spawn-audit'
      && err.details.missing.includes('np-build-fixer')
      && err.details.round === 2,
  );
});

test('LCLI-RR-15: post-critics refuses without critic audit (synthetic-JSON bypass)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  // No critic-spawn audit → gate must refuse even if --critic-outputs is valid.
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
        '[{"critic":"critic","findings":[],"criteria":[]}]'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-critics-missing-critic-audit'
      && Array.isArray(err.details.missing)
      && err.details.missing.length === 1
      && err.details.missing[0] === 'np-critic',
  );
});

test('LCLI-RR-16: post-critics refuses if executor audited but critic missing (single-critic revision)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1,
    ['np-executor'], r); // critic missing
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
        '[{"critic":"critic","findings":[],"criteria":[]}]'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-critics-missing-critic-audit'
      && err.details.missing.length === 1
      && err.details.missing[0] === 'np-critic',
  );
});

test('LCLI-RR-17: --force-post-executor bypasses Layer-C gate', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // No audit entries; force flag must let us through.
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0', '--force-post-executor'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'spawn-critic-schwarm');
});

test('LCLI-RR-18: --force-post-critics bypasses Layer-C gate', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r); // executor audited, critics not
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"critic","findings":[],"criteria":[]}]',
     '--force-post-critics'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit');
});

test('LCLI-RR-19: assertSpawnsAuditedForRound returns the missing critic when none audited', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  // No critic audited yet.
  const v = nubosloop.assertSpawnsAuditedForRound(
    'M001-S001-T0001', nubosloop.POST_CRITICS_EVIDENCE, 1, r,
  );
  assert.equal(v.satisfied, false);
  assert.deepEqual(v.missing, ['np-critic']);
});

test('LCLI-RR-20: findSpawnAuditForRound is round-scoped (round-1 audit not visible from round-2)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  nubosloop.auditToolUse('M001-S001-T0001', 'np-critic', [], r);
  assert.ok(nubosloop.findSpawnAuditForRound('M001-S001-T0001', 'np-critic', 1, r));
  assert.equal(nubosloop.findSpawnAuditForRound('M001-S001-T0001', 'np-critic', 2, r), null);
});

test('LCLI-RR-21: loop-audit-tool-use accepts np-critic without --tool-use-log (records empty spawn)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  const loopAudit = require('./loop-audit-tool-use.cjs');
  const cap = _cap();
  loopAudit.run(['M001-S001-T0001', '--agent', 'np-critic'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.agent, 'np-critic');
  assert.equal(out.violation, null); // critic isn't audited for Rule 9
  // The audit log must still record the spawn so Layer C can find it.
  assert.ok(nubosloop.findSpawnAuditForRound('M001-S001-T0001', 'np-critic', 1, r));
});

test('LCLI-RR-22: loop-audit-tool-use still REQUIRES --tool-use-log for AUDITED_AGENTS', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopAudit = require('./loop-audit-tool-use.cjs');
  assert.throws(
    () => loopAudit.run(['M001-S001-T0001', '--agent', 'np-executor'], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'loop-audit-missing-log',
  );
});

test('LCLI-RR-23: post-executor verify-red advances round on checkpoint (L1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '1'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.round, 2, 'verify-red MUST advance round so Layer-C R≥2 evidence is round-scoped');
});

test('LCLI-RR-24: post-executor verify-green does NOT advance round (L1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.round, 1);
});

test('LCLI-RR-25: post-critics next_action=executor advances round (L1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-critic'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[{"category":"todo-marker","file":"a","line":1,"severity":"fail"}]}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.round, 2, 'next_action=executor MUST advance round');
});

test('LCLI-RR-26: post-critics next_action=commit does NOT advance round (L1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-critic'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[],"criteria":[]}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.round, 1);
});

test('LCLI-RR-27: --force-post-executor stamps forced_post_executor on checkpoint (T1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // No spawn evidence — Layer C would refuse without --force.
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0', '--force-post-executor'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.forced_post_executor, true);
});

test('LCLI-RR-28: --force-post-critics stamps forced_post_critics on checkpoint (T1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics',
      '--critic-outputs', '[{"critic":"style","findings":[]}]', '--force-post-critics'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.forced_post_critics, true);
});

test('LCLI-RR-29: post-critics builds findings_per_round bucket (D1)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-critic'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[{"category":"todo-marker","file":"a","line":1,"severity":"fail"}]}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp1 = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(typeof cp1.nubosloop.findings_per_round, 'object');
  assert.equal(cp1.nubosloop.findings_per_round['1'].length, 1);

  // Run round 2 with different findings — bucket must accumulate.
  _seedSpawnEvidence('M001-S001-T0001', 2, ['np-critic'], r);
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[]},{"critic":"tests","findings":[]},{"critic":"acceptance","findings":[],"criteria":[]}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp2 = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp2.nubosloop.findings_per_round['1'].length, 1);
  assert.equal(cp2.nubosloop.findings_per_round['2'].length, 0);
});

test('LCLI-RR-30: post-critics honors max_rounds_override on the checkpoint (T3)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 3, max_rounds_override: 8 }, r);
  _seedSpawnEvidence('M001-S001-T0001', 3, ['np-critic'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"style","findings":[{"category":"todo-marker","file":"a","line":1,"severity":"fail"}]}]'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.max_rounds, 8, 'override on checkpoint must beat default maxRounds=3');
  assert.equal(out.next_action, 'executor', 'round 3 < override 8 → still routing, not stuck');
  assert.equal(out.stuck, false);
});

test('LCLI-RR-31: commit skips auto-log when cache_hit=true on checkpoint (L4)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', {
    round: 1, cache_hit: true, verify_exit_code: 0, findings: [],
  }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'commit', '--learning-pattern', 'real pattern from store'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.learning_logged, null);
  assert.equal(out.learning_skip_reason, 'cache-hit');
});

test('LCLI-RR-32: commit skips auto-log on sentinel placeholder pattern (L4)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', {
    round: 1, verify_exit_code: 0, findings: [],
  }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'commit', '--learning-pattern',
      '<merged consensus from 3 researchers>'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.learning_logged, null);
  assert.equal(out.learning_skip_reason, 'sentinel-placeholder');
});

test('LCLI-RR-33: post-executor rejects --verify-output-path outside cwd/TMPDIR (D2)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-executor',
        '--verify-exit-code', '0', '--verify-output-path', '/etc/hosts'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-run-round-verify-output-traversal',
  );
});

test('LCLI-RR-34: post-researcher refuses without np-researcher audit (T2)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-researcher'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-researcher-missing-spawn-audit'
      && err.details && err.details.required_count === 3
      && err.details.found_count === 0,
  );
});

test('LCLI-RR-34b: post-researcher refuses with only 1-of-3 audits (Gap #6 k-gate)', async () => {
  // The earlier "first match" gate accepted a single audit and let the
  // orchestrator synthesize the other 2. The k-gate refuses until k entries
  // exist for the round.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  nubosloop.auditToolUse('M001-S001-T0001', 'np-researcher', ['search-knowledge'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-researcher'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-post-researcher-missing-spawn-audit'
      && err.details.required_count === 3
      && err.details.found_count === 1,
  );
});

test('LCLI-RR-35: post-researcher accepts when k=3 np-researcher audits exist (T2)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1 }, r);
  for (let i = 0; i < 3; i += 1) {
    nubosloop.auditToolUse('M001-S001-T0001', 'np-researcher', ['search-knowledge'], r);
  }
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-researcher'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'spawn-architect');
  assert.equal(out.forced, false);
  assert.equal(out.expected_researcher_count, 3);
});

test('LCLI-RR-35b: post-researcher k-gate honors swarm.research.k config (Gap #6)', async () => {
  // Drop k to 1 in config; gate must accept a single audit.
  const r = _mkRoot();
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'config.json'),
    JSON.stringify({ swarm: { research: { k: 1 } } }),
    'utf-8',
  );
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-researcher'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-researcher'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.expected_researcher_count, 1);
  assert.equal(out.next_action, 'spawn-architect');
});

test('LCLI-RR-36: --force-post-researcher bypasses Layer-C gate + stamps flag (T2)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-researcher', '--force-post-researcher'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.forced, true);
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.forced_post_researcher, true);
});

test('LCLI-AUDIT-4: loop-audit-tool-use rejects module-named agent (D4)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopAudit = require('./loop-audit-tool-use.cjs');
  assert.throws(
    () => loopAudit.run(
      ['M001-S001-T0001', '--agent', 'np-critic-style', '--tool-use-log', '[]'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-audit-agent-is-module',
  );
});

test('LCLI-22: learning-match queries the local store', async () => {
  const r = _mkRoot();
  const lr = require('../../lib/learnings.cjs');
  for (let i = 0; i < 3; i += 1) lr.logLearning({ pattern: 'use jose for jwt verification', outcome: 'verified' }, r);
  const cap = _cap();
  const learningMatch = require('./learning-match.cjs');
  await learningMatch.run(['--query', 'use jose for jwt verification', '--threshold', '0.5'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.adapter, 'local');
  assert.ok(out.best);
  assert.equal(out.best.occurrence, 3);
});

test('LCLI-23: learning-match rejects missing --query', async () => {
  const r = _mkRoot();
  const learningMatch = require('./learning-match.cjs');
  await assert.rejects(
    () => learningMatch.run([], { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'learning-match-missing-query',
  );
});

test('LCLI-24: learning-list returns sorted-by-occurrence projection without tokens[]', () => {
  const r = _mkRoot();
  const lr = require('../../lib/learnings.cjs');
  lr.logLearning({ pattern: 'pattern alpha here', outcome: 'ok' }, r);
  for (let i = 0; i < 3; i += 1) lr.logLearning({ pattern: 'pattern beta here', outcome: 'ok' }, r);
  for (let i = 0; i < 2; i += 1) lr.logLearning({ pattern: 'pattern gamma here', outcome: 'ok' }, r);
  const cap = _cap();
  const learningList = require('./learning-list.cjs');
  learningList.run([], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.total, 3);
  assert.equal(out.returned, 3);
  // Sorted by occurrence desc — beta (3) first
  assert.equal(out.learnings[0].occurrence, 3);
  assert.equal(out.learnings[1].occurrence, 2);
  assert.equal(out.learnings[2].occurrence, 1);
  // tokens[] should be stripped from listing
  for (const l of out.learnings) assert.equal(l.tokens, undefined);
});

test('LCLI-25: learning-list respects --limit', () => {
  const r = _mkRoot();
  const lr = require('../../lib/learnings.cjs');
  lr.logLearning({ pattern: 'first one here', outcome: 'ok' }, r);
  lr.logLearning({ pattern: 'second one here', outcome: 'ok' }, r);
  lr.logLearning({ pattern: 'third one here', outcome: 'ok' }, r);
  const cap = _cap();
  const learningList = require('./learning-list.cjs');
  learningList.run(['--limit', '2'], { cwd: r, stdout: cap.stub });
  const out = JSON.parse(cap.get());
  assert.equal(out.total, 3);
  assert.equal(out.returned, 2);
});

test('LCLI-21: learning-log rejects invalid --milestone-id', () => {
  const r = _mkRoot();
  assert.throws(
    () => learningLog.run(['--pattern', 'x y z', '--outcome', 'ok', '--milestone-id', 'not-a-milestone'],
      { cwd: r, stdout: _cap().stub }),
    (err) => err && err.code === 'learning-log-invalid-milestone-id',
  );
});

test('LCLI-RR-37: post-critics next_action=askuser advances round (Gap #2)', async () => {
  // Without round bump, the original executor audit kept satisfying Layer-C
  // for the post-askuser re-spawn — orchestrators could rationalise away
  // the re-spawn entirely. ROUND_ADVANCE_ACTIONS now includes 'askuser'.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-critic'], r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs',
      '[{"critic":"acceptance","findings":[{"category":"question-to-user","file":"-","severity":"fail","remediation":"Confirm OAuth scope"}]}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.last_action, 'askuser');
  assert.equal(cp.nubosloop.round, 2, 'askuser MUST advance round so post-askuser executor needs fresh audit');
});

test('LCLI-RR-38: commit clears max_rounds_override (Gap #7)', async () => {
  // /np:resume-work after manual intervention must not silently inherit a
  // prior incident's "+5 Runden" decision. Commit clears it.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', {
    round: 1,
    verify_exit_code: 0,
    findings: [],
    max_rounds_override: 8,
  }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(['M001-S001-T0001', '--phase', 'commit'], { cwd: r, stdout: _cap().stub });
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.max_rounds_override, null);
});

test('LCLI-RR-39: stuck with reason=user-requested-replan clears override (Gap #7)', async () => {
  // Replan implies different premises for the next attempt — old +5 cap
  // should not carry into an unrelated re-run.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 8, max_rounds_override: 8 }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'stuck', '--reason', 'user-requested-replan'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.max_rounds_override, null);
});

test('LCLI-RR-40: stuck with reason=max-rounds-user-stuck PRESERVES override (Gap #7)', async () => {
  // The user explicitly chose to pause here; resume should pick up the same
  // cap. Only replan/manual-fix reasons clear.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 8, max_rounds_override: 8 }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'stuck', '--reason', 'max-rounds-user-stuck'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.max_rounds_override, 8);
});

test('LCLI-RR-41: stuck with --findings updates findings_per_round (Gap #11)', async () => {
  // Previous stuck only wrote `findings`; the per-round audit trail had a
  // hole at the stuck round.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 3 }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'stuck',
      '--reason', 'maxRounds reached',
      '--findings', '[{"category":"todo-marker","file":"a","line":1,"severity":"fail"}]'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.findings_per_round['3'].length, 1);
  assert.equal(cp.nubosloop.findings_per_round['3'][0].category, 'todo-marker');
});

test('LCLI-RR-42: post-executor prepends truncation marker on >2000 byte verify output (Gap #10)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  // Build a 5000-byte verify log inside cwd.
  const longLog = 'X'.repeat(5000);
  const logPath = path.join(r, 'verify.log');
  fs.writeFileSync(logPath, longLog, 'utf-8');
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0',
      '--verify-output-path', 'verify.log'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.match(cp.nubosloop.verify_output_excerpt, /truncated head/);
  assert.match(cp.nubosloop.verify_output_excerpt, /5000 bytes/);
});

test('LCLI-RR-42b: post-executor stores verify output verbatim under 2000 bytes (Gap #10)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor'], r);
  fs.writeFileSync(path.join(r, 'verify.log'), 'short output\n', 'utf-8');
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-executor', '--verify-exit-code', '0',
      '--verify-output-path', 'verify.log'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.verify_output_excerpt, 'short output\n');
});

test('LCLI-RR-43: preflight refuses double-call when last_phase!=commit/stuck (Gap #9)', async () => {
  // The earlier (prev.round||0)+1 blindly re-bumped, leaving the round
  // counter desynced from reality.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'preflight', '--query', 'task summary'],
    { cwd: r, stdout: _cap().stub },
  );
  // Second preflight call without bumping out of last_phase=preflight should refuse.
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'preflight', '--query', 'task summary'],
      { cwd: r, stdout: _cap().stub },
    ),
    (err) => err && err.code === 'loop-preflight-already-stamped',
  );
});

test('LCLI-RR-43b: --force-preflight bypasses double-call check + stamps flag (Gap #9)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'preflight', '--query', 'task summary'],
    { cwd: r, stdout: _cap().stub },
  );
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'preflight', '--query', 'task summary', '--force-preflight'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.forced, true);
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.forced_preflight, true);
});

test('LCLI-RR-43c: preflight allowed after commit (resume scenario, Gap #9)', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const nubosloop = require('../../lib/nubosloop.cjs');
  nubosloop.recordLoopState('M001-S001-T0001', { round: 1, last_phase: 'commit' }, r);
  const loopRunRound = require('./loop-run-round.cjs');
  const cap = _cap();
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'preflight', '--query', 'task summary'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.phase, 'preflight');
});

test('LCLI-3e: loop-state-record rejects forced_* flags (write-once-by-phase)', () => {
  // The five forced_* fields are stamped by their respective phase verbs
  // (_runPreflight / _runPostResearcher / _runPostExecutor / _runPostCritics
  // / _runCommit) when --force-* is passed. Letting the CLI overwrite them
  // would let an operator silently zero out their force-bypass dashboard
  // counters retroactively, breaking the audit trail in ADR-0010 Trust-Layer.
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  for (const key of [
    'forced_preflight',
    'forced_post_researcher',
    'forced_post_executor',
    'forced_post_critics',
    'forced_commit_phase',
  ]) {
    assert.throws(
      () => loopStateRecord.run(
        ['M001-S001-T0001', '--json', JSON.stringify({ [key]: true })],
        { cwd: r, stdout: _cap().stub },
      ),
      (err) => err && err.code === 'loop-state-unknown-key' && err.details.key === key,
      'expected ' + key + ' to be rejected',
    );
  }
});

test('LCLI-3f: loop-state-record accepts max_rounds_override=null as clear sentinel (Gap #7)', () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  // Set then clear.
  loopStateRecord.run(
    ['M001-S001-T0001', '--json', '{"max_rounds_override":8}'],
    { cwd: r, stdout: _cap().stub },
  );
  loopStateRecord.run(
    ['M001-S001-T0001', '--json', '{"max_rounds_override":null}'],
    { cwd: r, stdout: _cap().stub },
  );
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.equal(cp.nubosloop.max_rounds_override, null);
});

test('LCLI-20: learning-log payload carries fingerprint + was_new + occurrence', () => {
  const r = _mkRoot();
  const cap1 = _cap();
  learningLog.run(['--pattern', 'use jose for jwt verification', '--outcome', 'verified'],
    { cwd: r, stdout: cap1.stub });
  const out1 = JSON.parse(cap1.get());
  assert.equal(out1.was_new, true);
  assert.match(out1.fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(out1.occurrence, 1);
  // Re-log: was_new=false, occurrence=2
  const cap2 = _cap();
  learningLog.run(['--pattern', 'use jose for jwt verification', '--outcome', 'still verified'],
    { cwd: r, stdout: cap2.stub });
  const out2 = JSON.parse(cap2.get());
  assert.equal(out2.was_new, false);
  assert.equal(out2.occurrence, 2);
  assert.equal(out2.fingerprint, out1.fingerprint);
});

// ADR-0010 §L5 Verdict-Only Contract — post-critics reads findings from disk.

test('LCLI-RR-L5-1: post-critics --critic-outputs-path reads file and routes commit on zero findings', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor', 'np-critic'], r);
  const reportDir = path.join(r, '.nubos-pilot', '.tmp');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'critic-r1.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    critic: 'critic', task_id: 'M001-S001-T0001', round: 1,
    criteria: [], findings: [], verdict: 'passed',
  }), 'utf-8');
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics',
      '--critic-outputs-path', path.relative(r, reportPath)],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'commit');
  assert.equal(out.findings.length, 0);
});

test('LCLI-RR-L5-2: post-critics --critic-outputs-path with single object (not array) is wrapped', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor', 'np-critic'], r);
  const reportPath = path.join(r, 'critic-r1.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    critic: 'critic', task_id: 'M001-S001-T0001', round: 1,
    findings: [{ category: 'todo-marker', severity: 'fail', file: 'a.ts', line: 4, remediation: 'remove TODO' }],
    criteria: [], verdict: 'issues_found',
  }), 'utf-8');
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs-path', 'critic-r1.json'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.next_action, 'executor');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].category, 'todo-marker');
});

test('LCLI-RR-L5-3: post-critics rejects both --critic-outputs and --critic-outputs-path', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor', 'np-critic'], r);
  const reportPath = path.join(r, 'critic-r1.json');
  fs.writeFileSync(reportPath, '[]', 'utf-8');
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-critics',
        '--critic-outputs', '[]',
        '--critic-outputs-path', 'critic-r1.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'loop-run-round-post-critics-conflicting-outputs',
  );
});

test('LCLI-RR-L5-4: post-critics --critic-outputs-path rejects path traversal outside cwd', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor', 'np-critic'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs-path', '/etc/passwd'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'loop-run-round-critic-outputs-path-traversal',
  );
});

test('LCLI-RR-L5-5: post-critics --critic-outputs-path on missing file errors typed', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor', 'np-critic'], r);
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs-path', 'never-was-here.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'loop-run-round-critic-outputs-path-unreadable',
  );
});

test('LCLI-RR-L5-6: post-critics --critic-outputs-path on invalid JSON errors typed', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  _seedSpawnEvidence('M001-S001-T0001', 1, ['np-executor', 'np-critic'], r);
  const reportPath = path.join(r, 'broken.json');
  fs.writeFileSync(reportPath, 'not valid json {{{', 'utf-8');
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'post-critics', '--critic-outputs-path', 'broken.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'loop-run-round-critic-outputs-path-invalid-json',
  );
});

test('LCLI-RR-L5-7: stuck --findings-path mirrors the post-critics path semantics', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const reportPath = path.join(r, 'stuck-findings.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    critic: 'critic', findings: [{ category: 'todo-marker', severity: 'fail', file: 'x.ts', line: 1, remediation: 'fix' }],
    criteria: [], verdict: 'issues_found',
  }), 'utf-8');
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await loopRunRound.run(
    ['M001-S001-T0001', '--phase', 'stuck', '--reason', 'manual-fix-pending',
      '--findings-path', 'stuck-findings.json'],
    { cwd: r, stdout: cap.stub },
  );
  const out = JSON.parse(cap.get());
  assert.equal(out.phase, 'stuck');
  const cp = checkpoint.readCheckpoint('M001-S001-T0001', r);
  assert.ok(Array.isArray(cp.nubosloop.findings), 'findings persisted as array');
  assert.equal(cp.nubosloop.findings[0].findings[0].category, 'todo-marker');
});

test('LCLI-RR-L5-8: stuck rejects both --findings and --findings-path', async () => {
  const r = _mkRoot();
  checkpoint.startTask({ id: 'M001-S001-T0001' }, r);
  const reportPath = path.join(r, 'f.json');
  fs.writeFileSync(reportPath, '[]', 'utf-8');
  const cap = _cap();
  const loopRunRound = require('./loop-run-round.cjs');
  await assert.rejects(
    () => loopRunRound.run(
      ['M001-S001-T0001', '--phase', 'stuck', '--reason', 'manual-fix-pending',
        '--findings', '[]', '--findings-path', 'f.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'loop-run-round-stuck-conflicting-findings',
  );
});
