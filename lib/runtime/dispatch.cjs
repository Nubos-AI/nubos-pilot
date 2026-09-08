'use strict';

const path = require('node:path');
const { NubosPilotError } = require('../core.cjs');
const { loadAgentSource } = require('../agents.cjs');
const { resolveFromConfig } = require('../../bin/np-tools/resolve-model.cjs');
const { assertPreflight } = require('./preflight.cjs');
const { runAgentLoop } = require('./agent-loop.cjs');
const { toolsetFor } = require('./tools/index.cjs');
const elision = require('../elision.cjs');
const { AUDITED_AGENTS, auditToolUse } = require('../nubosloop-audit.cjs');
const { TASK_ID_RE } = require('../ids.cjs');
const metrics = require('../metrics.cjs');

function _lintOutput(content, schemaName) {
  if (!schemaName) return null;
  try {
    const { getSchema } = require('../schemas/index.cjs');
    const { lintContent } = require('../output-lint.cjs');
    const res = lintContent(String(content == null ? '' : content), getSchema(schemaName));
    return { ok: !!res.ok, schema: schemaName, violations: res.violations || [] };
  } catch (err) {
    return { ok: false, schema: schemaName, error: (err && err.code) || 'output-lint-failed' };
  }
}

function _defaultInWorktree(cwd) {
  try {
    const { listSliceWorktrees } = require('../worktree.cjs');
    return listSliceWorktrees(cwd).some((w) => cwd === w.path || cwd.startsWith(w.path + path.sep));
  } catch { return false; }
}

function _parseTools(toolsField) {
  if (Array.isArray(toolsField)) return toolsField.map((s) => String(s).trim()).filter(Boolean);
  if (typeof toolsField === 'string') return toolsField.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

async function dispatchOffHost(o) {
  const opts = o || {};
  const cwd = opts.cwd || process.cwd();
  const deps = opts.deps || {};
  const resolve = deps.resolve || resolveFromConfig;
  const preflight = deps.preflight || assertPreflight;
  const loadSource = deps.loadSource || loadAgentSource;
  const runLoop = deps.runLoop || runAgentLoop;
  const isInWorktree = deps.isInWorktree || _defaultInWorktree;
  const now = deps.now || (() => new Date().toISOString());

  if (typeof opts.agent !== 'string' || !opts.agent) {
    throw new NubosPilotError('dispatch-no-agent', 'dispatchOffHost requires an agent name', {});
  }

  const res = resolve({ agentOrTier: opts.agent, cwd });
  if (res.kind !== 'openai-compat') {
    throw new NubosPilotError(
      'dispatch-not-offhost',
      'agent "' + opts.agent + '" resolves to provider "' + res.provider + '" (kind ' + res.kind
        + ') — dispatchOffHost only runs openai-compat providers',
      { provider: res.provider, kind: res.kind },
    );
  }
  const audited = AUDITED_AGENTS.includes(opts.agent);
  const hasTaskCtx = typeof opts.taskId === 'string' && TASK_ID_RE.test(opts.taskId);
  if (audited && !hasTaskCtx) {
    throw new NubosPilotError(
      'offhost-audited-agent-unsupported',
      'agent "' + opts.agent + '" is Rule-9-audited and needs a task context off-host — pass --task-id '
        + 'M<NNN>-S<NNN>-T<NNNN> so the search-evidence ledger + audit apply. (Wired into execute-phase in ADR-0021 Slice 4b.)',
      { agent: opts.agent, audited: AUDITED_AGENTS.slice() },
    );
  }

  if (opts.allowBash && !isInWorktree(cwd)) {
    throw new NubosPilotError(
      'offhost-bash-requires-sandbox',
      'off-host Bash needs worktree isolation — run inside a slice worktree (workflow.worktree_isolation) so model-driven shell is confined. Refused outside one.',
      { cwd: path.basename(cwd) },
    );
  }

  const src = loadSource(opts.agent, cwd);
  const declared = _parseTools(src.frontmatter && src.frontmatter.tools);
  const cx = elision.compressionContext(cwd);
  const toolset = toolsetFor(declared, {
    readOnly: !!opts.readOnly,
    allowBash: !!opts.allowBash,
    withSearch: audited,
    withExpand: cx.enabled,
    // `agent` makes the search-evidence ledger agent-attributable. Here it is
    // authoritative: the dispatcher knows which agent it is spawning, so the
    // spawn cannot claim someone else's search.
    ctx: {
      taskId: hasTaskCtx ? opts.taskId : null,
      agent: opts.agent || null,
      customRulesPath: opts.customRulesPath,
    },
  });
  const provider = { baseUrl: res.baseUrl, apiKeyEnv: res.apiKeyEnv, model: res.model };
  const _os = cx.outputSteering;
  if (_os && _os.effortRouting && _os.baseEffort) provider.effort = _os.baseEffort;

  await preflight(provider);

  const started = now();
  let result = null;
  let status = 'ok';
  let errObj = null;
  try {
    result = await runLoop({
      systemPrompt: src.body,
      task: opts.task,
      toolset,
      provider,
      cwd,
      maxIterations: opts.maxIterations,
    });
  } catch (err) {
    status = 'error';
    errObj = { code: (err && err.code) || 'dispatch-loop-failed', message: (err && err.message) || 'loop failed' };
  }
  const ended = now();

  let metricsRecorded = false;
  try {
    const record = metrics.buildRecord({
      agent: opts.agent,
      tier: res.tier,
      resolved_model: res.model,
      phase: opts.phase || '',
      plan: opts.plan || 'offhost',
      task: opts.taskId || 'adhoc',
      started_at: started,
      ended_at: ended,
      status,
      runtime: res.provider,
      error: errObj,
    });
    metrics.appendRecord(record, { cwd });
    metricsRecorded = true;
  } catch {}

  if (status === 'error') {
    throw new NubosPilotError(errObj.code, errObj.message, { agent: opts.agent, provider: res.provider });
  }

  let rule9 = null;
  if (audited && hasTaskCtx && !opts.skipAudit) {
    try {
      rule9 = auditToolUse(opts.taskId, opts.agent, (result.toolLog || []).map((t) => t.name), cwd);
    } catch (err) { rule9 = { ok: false, error: (err && err.code) || 'audit-failed' }; }
  }

  const toolsAdvertised = (toolset.schemas || []).length;
  const toolCalls = (result.toolLog || []).length;
  const capability = {
    toolsAdvertised,
    toolCalls,
    mutating: toolset.names.some((n) => n === 'Write' || n === 'Edit' || n === 'Bash'),
    ok: !(toolsAdvertised > 0 && toolCalls === 0),
  };

  return {
    agent: opts.agent,
    provider: res.provider,
    model: res.model,
    content: result.content,
    stopped: result.stopped,
    iterations: result.iterations,
    toolLog: result.toolLog,
    tools: toolset.names,
    rule9,
    capability,
    output_lint: _lintOutput(result.content, opts.outputSchema),
    metrics_recorded: metricsRecorded,
    compression: result.compression || null,
  };
}

module.exports = { dispatchOffHost, _parseTools };
