const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { dispatchOffHost, _parseTools } = require('./dispatch.cjs');

const _dirs = [];
function _root() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-')));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  _dirs.push(root);
  return root;
}
afterEach(() => { while (_dirs.length) { try { fs.rmSync(_dirs.pop(), { recursive: true, force: true }); } catch {} } });

const NOW = () => '2026-06-16T00:00:00.000Z';

function _deps(over) {
  return Object.assign({
    resolve: () => ({ kind: 'openai-compat', provider: 'ollama', model: 'qwen2.5-coder:32b', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: null, tier: 'sonnet' }),
    preflight: async () => ({ ok: true }),
    loadSource: () => ({ frontmatter: { name: 'np-executor', tier: 'sonnet', tools: 'Read, Write, Bash, Grep' }, body: 'You are the executor.' }),
    runLoop: async () => ({ content: 'done', stopped: 'final', iterations: 2, toolLog: [{ name: 'Read', ok: true }] }),
    now: NOW,
  }, over || {});
}

test('DSP-1: happy path returns the envelope and records a metrics row', async () => {
  const cwd = _root();
  const out = await dispatchOffHost({ agent: 'np-architect', task: 'do it', cwd, deps: _deps() });
  assert.equal(out.provider, 'ollama');
  assert.equal(out.model, 'qwen2.5-coder:32b');
  assert.equal(out.content, 'done');
  assert.equal(out.stopped, 'final');
  assert.equal(out.metrics_recorded, true);
  const meta = fs.readFileSync(path.join(cwd, '.nubos-pilot', 'metrics', 'meta.jsonl'), 'utf-8');
  const rec = JSON.parse(meta.trim().split('\n').pop());
  assert.equal(rec.runtime, 'ollama');
  assert.equal(rec.resolved_model, 'qwen2.5-coder:32b');
  assert.equal(rec.status, 'ok');
});

test('DSP-1c: provider.effort is seeded from base_effort only when effort routing is opted in', async () => {
  const bare = _root();
  let seenBare;
  await dispatchOffHost({ agent: 'np-architect', task: 't', cwd: bare,
    deps: _deps({ runLoop: async ({ provider }) => { seenBare = provider; return { content: 'x', stopped: 'final', iterations: 1, toolLog: [] }; } }) });
  assert.equal(seenBare.effort, undefined, 'no effort field absent opt-in (providers without support unaffected)');

  const on = _root();
  fs.writeFileSync(path.join(on, '.nubos-pilot', 'config.json'), JSON.stringify({
    compression: { enabled: true, output_steering: { enabled: true, effort_routing: { enabled: true, base_effort: 'high', mechanical_effort: 'low' } } },
  }));
  let seenOn;
  await dispatchOffHost({ agent: 'np-architect', task: 't', cwd: on,
    deps: _deps({ runLoop: async ({ provider }) => { seenOn = provider; return { content: 'x', stopped: 'final', iterations: 1, toolLog: [] }; } }) });
  assert.equal(seenOn.effort, 'high', 'base_effort seeds the provider effort');
});

test('DSP-2: a native-kind agent is refused (dispatch-not-offhost)', async () => {
  const cwd = _root();
  const deps = _deps({ resolve: () => ({ kind: 'native', provider: 'claude', model: null, tier: 'opus' }) });
  await assert.rejects(
    dispatchOffHost({ agent: 'np-planner', task: 't', cwd, deps }),
    (e) => e.code === 'dispatch-not-offhost',
  );
});

test('DSP-3: Bash is excluded by default; opt-in (inside a worktree) includes it', async () => {
  const cwd = _root();
  let seen = null;
  const deps = _deps({
    isInWorktree: () => true,
    runLoop: async ({ toolset }) => { seen = toolset.names.slice(); return { content: 'x', stopped: 'final', iterations: 1, toolLog: [] }; },
  });
  await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps });
  assert.deepEqual(seen, ['Read', 'Write', 'Grep']);
  await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps, allowBash: true });
  assert.deepEqual(seen, ['Read', 'Write', 'Bash', 'Grep']);
});

test('DSP-3b: readOnly restricts the toolset to read tools', async () => {
  const cwd = _root();
  let seen = null;
  const deps = _deps({ runLoop: async ({ toolset }) => { seen = toolset.names.slice(); return { content: 'x', stopped: 'final', iterations: 1, toolLog: [] }; } });
  await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps, readOnly: true });
  assert.deepEqual(seen, ['Read', 'Grep']);
});

test('DSP-4: a loop error records an error metrics row and rethrows the loop code', async () => {
  const cwd = _root();
  const { NubosPilotError } = require('../core.cjs');
  const deps = _deps({ runLoop: async () => { throw new NubosPilotError('provider-http-error', 'HTTP 500', {}); } });
  await assert.rejects(dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps }), (e) => e.code === 'provider-http-error');
  const rec = JSON.parse(fs.readFileSync(path.join(cwd, '.nubos-pilot', 'metrics', 'meta.jsonl'), 'utf-8').trim().split('\n').pop());
  assert.equal(rec.status, 'error');
});

test('DSP-5: preflight runs before the loop and a failure aborts before any tool call', async () => {
  const cwd = _root();
  let looped = false;
  const { NubosPilotError } = require('../core.cjs');
  const deps = _deps({
    preflight: async () => { throw new NubosPilotError('preflight-failed', 'unreachable', {}); },
    runLoop: async () => { looped = true; return { content: 'x', stopped: 'final', iterations: 1, toolLog: [] }; },
  });
  await assert.rejects(dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps }), (e) => e.code === 'preflight-failed');
  assert.equal(looped, false);
});

test('DSP-6: missing agent throws dispatch-no-agent', async () => {
  await assert.rejects(dispatchOffHost({ task: 't', deps: _deps() }), (e) => e.code === 'dispatch-no-agent');
});

test('DSP-8: a Rule-9-audited agent without a task context is refused off-host', async () => {
  const cwd = _root();
  await assert.rejects(
    dispatchOffHost({ agent: 'np-executor', task: 't', cwd, deps: _deps() }),
    (e) => e.code === 'offhost-audited-agent-unsupported',
  );
  await assert.rejects(
    dispatchOffHost({ agent: 'np-researcher', task: 't', cwd, deps: _deps() }),
    (e) => e.code === 'offhost-audited-agent-unsupported',
  );
});

test('DSP-9: an audited agent WITH a valid --task-id is allowed; Rule-9 audit rides the envelope', async () => {
  const cwd = _root();
  let seen = null;
  const deps = _deps({ runLoop: async ({ toolset }) => { seen = toolset.names.slice(); return { content: 'x', stopped: 'final', iterations: 1, toolLog: [{ name: 'knowledge-search', ok: true }] }; } });
  const out = await dispatchOffHost({ agent: 'np-executor', task: 't', cwd, deps, taskId: 'M001-S001-T0001' });
  assert.ok(seen.includes('knowledge-search'), 'knowledge-search must be injected for an audited agent');
  assert.ok(out.rule9 && typeof out.rule9 === 'object', 'audit result must ride the envelope');
});

test('DSP-9b: with recorded search evidence the Rule-9 audit passes', async () => {
  const cwd = _root();
  const taskId = 'M001-S001-T0002';
  require('../nubosloop-audit.cjs').recordSearchEvidence(taskId, 'auth', cwd, 'np-executor');
  const deps = _deps({ runLoop: async () => ({ content: 'x', stopped: 'final', iterations: 1, toolLog: [{ name: 'knowledge-search', ok: true }] }) });
  const out = await dispatchOffHost({ agent: 'np-executor', task: 't', cwd, deps, taskId });
  assert.equal(out.rule9.ok, true);
  assert.equal(out.rule9.violation, null);
});

test('DSP-12: skipAudit defers Rule-9 to the orchestrator (rule9 not run by dispatch)', async () => {
  const cwd = _root();
  const deps = _deps({ runLoop: async () => ({ content: 'x', stopped: 'final', iterations: 1, toolLog: [{ name: 'knowledge-search', ok: true }] }) });
  const out = await dispatchOffHost({ agent: 'np-executor', task: 't', cwd, deps, taskId: 'M001-S001-T0003', skipAudit: true });
  assert.equal(out.rule9, null, 'dispatch must not audit when skipAudit is set');
});

test('DSP-10: --allow-bash outside a worktree is refused (offhost-bash-requires-sandbox)', async () => {
  const cwd = _root();
  const deps = _deps({ isInWorktree: () => false });
  await assert.rejects(
    dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps, allowBash: true }),
    (e) => e.code === 'offhost-bash-requires-sandbox',
  );
});

test('DSP-11: --allow-bash inside a worktree includes Bash in the toolset', async () => {
  const cwd = _root();
  let seen = null;
  const deps = _deps({
    isInWorktree: () => true,
    runLoop: async ({ toolset }) => { seen = toolset.names.slice(); return { content: 'x', stopped: 'final', iterations: 1, toolLog: [] }; },
  });
  await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps, allowBash: true });
  assert.ok(seen.includes('Bash'), 'Bash must be available inside a worktree');
});

test('DSP-13: outputSchema lints the result and rides the envelope (null when unset)', async () => {
  const cwd = _root();
  const out1 = await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps: _deps() });
  assert.equal(out1.output_lint, null, 'no schema ⇒ no lint');
  const out2 = await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps: _deps(), outputSchema: 'researcher-output' });
  assert.ok(out2.output_lint && out2.output_lint.schema === 'researcher-output', 'lint result rides the envelope');
  assert.equal(typeof out2.output_lint.ok, 'boolean');
});

test('DSP-14: capability flags zero tool-calls despite an advertised toolset (tool-calling unsupported signal)', async () => {
  const cwd = _root();
  const noTools = _deps({ runLoop: async () => ({ content: 'just text', stopped: 'final', iterations: 1, toolLog: [] }) });
  const out1 = await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps: noTools });
  assert.equal(out1.capability.ok, false);
  assert.equal(out1.capability.toolCalls, 0);
  assert.ok(out1.capability.toolsAdvertised > 0);
  assert.equal(out1.capability.mutating, true);

  const usedTool = _deps({ runLoop: async () => ({ content: 'x', stopped: 'final', iterations: 2, toolLog: [{ name: 'Read', ok: true }] }) });
  const out2 = await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps: usedTool });
  assert.equal(out2.capability.ok, true);

  const ro = _deps({ runLoop: async () => ({ content: 'x', stopped: 'final', iterations: 1, toolLog: [] }) });
  const out3 = await dispatchOffHost({ agent: 'np-architect', task: 't', cwd, deps: ro, readOnly: true });
  assert.equal(out3.capability.ok, false);
  assert.equal(out3.capability.mutating, false);
});

test('DSP-7: _parseTools accepts a comma string or an array', () => {
  assert.deepEqual(_parseTools('Read, Write , Bash'), ['Read', 'Write', 'Bash']);
  assert.deepEqual(_parseTools(['Read', 'Grep']), ['Read', 'Grep']);
  assert.deepEqual(_parseTools(undefined), []);
});
