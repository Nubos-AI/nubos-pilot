'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, safeAssign } = require('../../lib/core.cjs');
const safePath = require('../../lib/safe-path.cjs');

const checkpoint = require('../../lib/checkpoint.cjs');
const config = require('../../lib/config.cjs');
const nubosloop = require('../../lib/nubosloop.cjs');
const messaging = require('../../lib/messaging.cjs');
const compress = require('../../lib/compress.cjs');
const elision = require('../../lib/elision.cjs');
const logger = require('../../lib/logger.cjs').child('loop-run-round');
const args = require('./_args.cjs');

const { TASK_ID_RE } = require('../../lib/ids.cjs');

function _resolveInsideCwdOrTmp(p, cwd, label, errorCode) {
  return safePath.assertInsideCwdOrTmp(p, cwd, label, errorCode);
}

function _verifyExcerpt(verifyOutput, cwd) {
  const s = String(verifyOutput);
  const cx = elision.compressionContext(cwd);
  const maxBytes = cx.verifyMaxBytes;
  if (s.length <= maxBytes) return s;
  if (cx.enabled) {
    try {
      const crushed = compress.crushLogToBudget(s, maxBytes);
      if (crushed && crushed.length < s.length) {
        const hash = cx.store ? cx.store(s, 'log') : null;
        return crushed + (hash ? '\n' + compress.marker(hash, 'full verify log') : '');
      }
    } catch (err) { logger.warn('verify compression skipped', { cause: err && err.message }); }
  }
  return '…[truncated head, original ' + s.length + ' bytes — see VERIFY_LOG]\n' + s.slice(-maxBytes);
}

const VALID_PHASES = new Set([
  'preflight',
  'post-researcher',
  'post-architect',
  'post-test-writer',
  'post-executor',
  'post-critics',
  'commit',
  'stuck',
]);

const ROUND_ADVANCE_ACTIONS = new Set(['executor', 'researcher', 'askuser']);

async function _runPreflight(taskId, list, cwd) {
  const query = args.getFlag(list, '--query');
  if (!query) {
    throw new NubosPilotError(
      'loop-run-round-preflight-missing-query',
      'phase=preflight requires --query "<task summary>"',
      { hint: 'use the task plan goal + acceptance criteria as the query string' },
    );
  }
  const force = list.includes('--force-preflight');
  if (!force) {
    const cur = checkpoint.readCheckpoint(taskId, cwd) || {};
    const prev = (cur && cur.nubosloop) || {};
    const lp = prev.last_phase;
    if (lp && lp !== 'commit' && lp !== 'stuck') {
      throw new NubosPilotError(
        'loop-preflight-already-stamped',
        'phase=preflight refused: task ' + taskId + ' already entered the loop body (last_phase=' + lp + ', round=' + (prev.round || 0) + '). ' +
        'Re-running preflight would silently re-bump the round counter and detach Layer-C audits from reality. ' +
        'Pass --force-preflight to override (e.g. for fixture migration), or run --phase commit / --phase stuck first.',
        { taskId, last_phase: lp, round: prev.round || 0 },
      );
    }
  }
  const opts = { taskId };
  const t = args.getFlag(list, '--threshold');
  if (t !== undefined) opts.threshold = Number(t);
  const m = args.getFlag(list, '--min-occurrence');
  if (m !== undefined) opts.minOccurrence = Number(m);
  const result = await nubosloop.preflightCacheLookup(query, opts, cwd);
  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      const round = (Number(prev.round) || 0) + 1;
      const partial = {
        round,
        last_action: 'preflight',
        last_phase: 'preflight',
        cache_hit: result.hit,
        cache_miss_reason: result.cache_miss_reason,
        bypass_swarm: result.bypass_swarm,
        degraded: result.degraded || null,
      };
      if (force) partial.forced_preflight = true;
      return { nubosloop: safeAssign({}, prev, partial) };
    },
    cwd,
  );
  return {
    phase: 'preflight',
    next_action: result.bypass_swarm ? 'spawn-executor-with-cache' : 'spawn-researcher-swarm',
    cache_hit: result.hit,
    bypass_swarm: result.bypass_swarm,
    cache_miss_reason: result.cache_miss_reason,
    degraded: result.degraded || null,
    swarm: result.swarm,
    forced: force,
  };
}

function _runPostResearcher(taskId, list, cwd) {
  const force = list.includes('--force-post-researcher');
  const swarm = require('../../lib/researcher-swarm.cjs');
  const expectedK = swarm.resolveSwarmOpts(cwd).k;
  let cpForRound = checkpoint.readCheckpoint(taskId, cwd) || {};
  const round = Number((cpForRound.nubosloop && cpForRound.nubosloop.round)) || 1;
  if (!force) {
    const verdict = nubosloop.assertSpawnsCountForRound(
      taskId, 'np-researcher', expectedK, round, cwd,
    );
    if (!verdict.satisfied) {
      throw new NubosPilotError(
        'loop-post-researcher-missing-spawn-audit',
        'phase=post-researcher refused: insufficient `loop-audit-tool-use` records for round=' + round +
        ', agent=np-researcher on ' + taskId + ' (found ' + verdict.found + ', need ' + verdict.required + '). ' +
        'Spawn `swarm.research.k` independent researchers in parallel and call `loop-audit-tool-use ' + taskId +
        ' --agent np-researcher --tool-use-log <json>` once per spawn, ' +
        'or pass --force-post-researcher for an explicit override.',
        {
          taskId, round,
          missing: verdict.found < verdict.required ? ['np-researcher'] : [],
          required: ['np-researcher'],
          required_count: verdict.required,
          found_count: verdict.found,
          required_agents_k: { 'np-researcher': verdict.required },
        },
      );
    }
  }
  const merged = checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      const partial = {
        last_phase: 'post-researcher',
        last_action: 'researcher-spawned',
      };
      if (force) partial.forced_post_researcher = true;
      return { nubosloop: safeAssign({}, prev, partial) };
    },
    cwd,
  );
  return {
    phase: 'post-researcher',
    next_action: _nextAfterResearcher(cwd),
    forced: force,
    expected_researcher_count: expectedK,
    round: merged.nubosloop ? merged.nubosloop.round : null,
  };
}

// Round-1 preparation steps (architect, test-writer) that run between the
// researcher swarm and the executor. Each verifies its spawn was stamped via
// `loop-audit-tool-use` (Layer-C SKIP-GUARD) and records last_phase. They never
// bump the round counter — TDD writes tests once; build-fixer rounds iterate.
// Config-gated in the orchestrator: when agents.architect / agents.test_writer
// is off the step (and this phase) is simply never invoked.
function _checkPrepSpawnAudited(taskId, list, cwd, agent, forceFlag) {
  const force = list.includes(forceFlag);
  const cur = checkpoint.readCheckpoint(taskId, cwd) || {};
  const round = Number((cur.nubosloop && cur.nubosloop.round)) || 1;
  const satisfied = force
    ? true
    : nubosloop.assertSpawnsAuditedForRound(taskId, [agent], round, cwd).satisfied;
  return { force, round, satisfied };
}

function _stampPrepPhase(taskId, cwd, phase, lastAction, forcedKey, force, extraFn) {
  return checkpoint.mergeCheckpoint(
    taskId,
    (curCp) => {
      const prev = (curCp && curCp.nubosloop) || {};
      const partial = { last_phase: phase, last_action: lastAction };
      if (force) partial[forcedKey] = true;
      if (typeof extraFn === 'function') safeAssign(partial, extraFn(prev));
      return { nubosloop: safeAssign({}, prev, partial) };
    },
    cwd,
  );
}

// The round-1 prep steps are config-gated, so the emitted next_action hint must
// reflect which downstream steps are actually enabled — a consumer driving off
// the JSON hint (rather than the ACTION CONTRACT prose) must not skip an enabled
// architect/test-writer or stall on a disabled one.
function _nextEnabled(cwd, steps) {
  for (const [path, action] of steps) {
    if (config.tryReadConfigPath(cwd, path, true, { onWarn() {} })) return action;
  }
  return 'spawn-executor';
}

function _nextAfterResearcher(cwd) {
  return _nextEnabled(cwd, [['agents.architect', 'spawn-architect'], ['agents.test_writer', 'spawn-test-writer']]);
}

function _nextAfterArchitect(cwd) {
  return _nextEnabled(cwd, [['agents.test_writer', 'spawn-test-writer']]);
}

// `--tests "a, b, c"` → ['a','b','c']; the post-test-writer phase records these
// (the paths np-test-writer wrote) so commit-task can fold them into the commit.
function _parseTestPaths(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function _runPostArchitect(taskId, list, cwd) {
  const g = _checkPrepSpawnAudited(taskId, list, cwd, 'np-task-architect', '--force-post-architect');
  if (!g.satisfied) {
    throw new NubosPilotError(
      'loop-post-architect-missing-spawn-audit',
      'phase=post-architect refused: no `loop-audit-tool-use` record for round=' + g.round +
      ', agent=np-task-architect on ' + taskId + '. ' +
      'Spawn np-task-architect and call `loop-audit-tool-use ' + taskId +
      ' --agent np-task-architect --tool-use-log <json>` after the spawn, ' +
      'or pass --force-post-architect for an explicit override.',
      { taskId, round: g.round, missing: ['np-task-architect'], required: ['np-task-architect'] },
    );
  }
  const merged = _stampPrepPhase(taskId, cwd, 'post-architect', 'architect-spawned', 'forced_post_architect', g.force);
  return {
    phase: 'post-architect',
    next_action: _nextAfterArchitect(cwd),
    forced: g.force,
    round: merged.nubosloop ? merged.nubosloop.round : g.round,
  };
}

function _runPostTestWriter(taskId, list, cwd) {
  const g = _checkPrepSpawnAudited(taskId, list, cwd, 'np-test-writer', '--force-post-test-writer');
  if (!g.satisfied) {
    throw new NubosPilotError(
      'loop-post-test-writer-missing-spawn-audit',
      'phase=post-test-writer refused: no `loop-audit-tool-use` record for round=' + g.round +
      ', agent=np-test-writer on ' + taskId + '. ' +
      'Spawn np-test-writer and call `loop-audit-tool-use ' + taskId +
      ' --agent np-test-writer --tool-use-log <json>` after the spawn, ' +
      'or pass --force-post-test-writer for an explicit override.',
      { taskId, round: g.round, missing: ['np-test-writer'], required: ['np-test-writer'] },
    );
  }
  const testPaths = _parseTestPaths(args.getFlag(list, '--tests'));
  const merged = _stampPrepPhase(
    taskId, cwd, 'post-test-writer', 'test-writer-spawned', 'forced_post_test_writer', g.force,
    (prev) => {
      const prior = Array.isArray(prev.tdd_tests) ? prev.tdd_tests : [];
      const seen = new Set(prior);
      const tdd_tests = prior.slice();
      for (const p of testPaths) { if (!seen.has(p)) { seen.add(p); tdd_tests.push(p); } }
      return { tdd_tests };
    },
  );
  return {
    phase: 'post-test-writer',
    next_action: 'spawn-executor',
    forced: g.force,
    tdd_tests: merged.nubosloop && Array.isArray(merged.nubosloop.tdd_tests) ? merged.nubosloop.tdd_tests : [],
    round: merged.nubosloop ? merged.nubosloop.round : g.round,
  };
}

function _runPostExecutor(taskId, list, cwd) {
  const verifyExitCode = args.getFlag(list, '--verify-exit-code');
  if (verifyExitCode === undefined) {
    throw new NubosPilotError(
      'loop-run-round-post-executor-missing-verify',
      'phase=post-executor requires --verify-exit-code <int>',
      { hint: 'pass the exit code of the task verify command' },
    );
  }
  const force = list.includes('--force-post-executor');
  let gateRound = null;
  if (!force) {
    const cur = checkpoint.readCheckpoint(taskId, cwd) || {};
    const round = Number((cur.nubosloop && cur.nubosloop.round)) || 1;
    gateRound = round;
    const required = round === 1 ? nubosloop.POST_EXECUTOR_EVIDENCE_R1 : nubosloop.POST_EXECUTOR_EVIDENCE_RN;
    const verdict = nubosloop.assertSpawnsAuditedForRound(taskId, required, round, cwd);
    if (!verdict.satisfied) {
      throw new NubosPilotError(
        'loop-post-executor-missing-spawn-audit',
        'phase=post-executor refused: no `loop-audit-tool-use` record found for round=' + round +
        ', agent=' + verdict.missing.join('/') + ' on ' + taskId + '. ' +
        'Spawn the executor/build-fixer agent and call `loop-audit-tool-use ' + taskId +
        ' --agent <name> --tool-use-log <json>` first, or pass --force-post-executor for an explicit override.',
        { taskId, round, missing: verdict.missing.slice(), required: required.slice() },
      );
    }
  }
  const code = Number(verifyExitCode);
  const verifyOutputPath = args.getFlag(list, '--verify-output-path');
  let verifyOutput = '';
  if (verifyOutputPath) {
    const resolved = _resolveInsideCwdOrTmp(verifyOutputPath, cwd, '--verify-output-path', 'loop-run-round-verify-output-traversal');
    try { verifyOutput = fs.readFileSync(resolved, 'utf-8'); }
    catch (err) {
      throw new NubosPilotError(
        'loop-run-round-verify-output-unreadable',
        '--verify-output-path could not be read',
        { path: verifyOutputPath, cause: err && err.message },
      );
    }
  }
  const green = code === 0;
  let verifyExcerpt = null;
  if (verifyOutput) {
    verifyExcerpt = _verifyExcerpt(verifyOutput, cwd);
  }
  const merged = checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      const curRound = Number(prev.round) || 1;
      if (gateRound !== null && curRound !== gateRound) {
        throw new NubosPilotError(
          'loop-post-executor-round-shifted',
          'phase=post-executor refused: round shifted from ' + gateRound + ' to ' + curRound +
          ' between audit-gate check and checkpoint merge (concurrent post-critics writer). Retry post-executor for round=' + curRound + '.',
          { taskId, gate_round: gateRound, current_round: curRound },
        );
      }
      const partial = {
        last_phase: 'post-executor',
        last_action: green ? 'verify-green' : 'verify-red',
        verify_exit_code: code,
        verify_output_excerpt: verifyExcerpt,
      };
      if (force) partial.forced_post_executor = true;
      if (!green) partial.round = curRound + 1;
      return { nubosloop: safeAssign({}, prev, partial) };
    },
    cwd,
  );
  return {
    phase: 'post-executor',
    next_action: green ? 'spawn-critic-schwarm' : 'spawn-build-fixer',
    verify_green: green,
    round: merged.nubosloop ? merged.nubosloop.round : null,
    forced: force,
  };
}

function _readCriticOutputsFromPath(criticPath, cwd) {
  const resolved = _resolveInsideCwdOrTmp(criticPath, cwd, '--critic-outputs-path', 'loop-run-round-critic-outputs-path-traversal');
  let raw;
  try { raw = fs.readFileSync(resolved, 'utf-8'); }
  catch (err) {
    throw new NubosPilotError(
      'loop-run-round-critic-outputs-path-unreadable',
      '--critic-outputs-path could not be read',
      { path: criticPath, cause: err && err.message },
    );
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new NubosPilotError(
      'loop-run-round-critic-outputs-path-invalid-json',
      '--critic-outputs-path content is not valid JSON',
      { path: criticPath, cause: err && err.message },
    );
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  throw new NubosPilotError(
    'loop-run-round-critic-outputs-path-invalid-shape',
    '--critic-outputs-path must contain a critic-output object or array of objects',
    { path: criticPath, got: typeof parsed },
  );
}

function _runPostCritics(taskId, list, cwd) {
  const inlineRaw = args.getFlag(list, '--critic-outputs');
  const pathFlag = args.getFlag(list, '--critic-outputs-path');
  if (inlineRaw !== undefined && pathFlag !== undefined) {
    throw new NubosPilotError(
      'loop-run-round-post-critics-conflicting-outputs',
      'pass exactly one of --critic-outputs or --critic-outputs-path, not both',
      { hint: 'Verdict-Only contract (ADR-0010 §L5) prefers --critic-outputs-path; inline form is the legacy fallback' },
    );
  }
  let criticOutputs;
  if (pathFlag !== undefined) {
    criticOutputs = _readCriticOutputsFromPath(pathFlag, cwd);
  } else {
    criticOutputs = args.getJsonFlag(
      list,
      '--critic-outputs',
      'loop-run-round-post-critics-missing-outputs',
      'pass the merged critic JSON array (style + tests + acceptance), or --critic-outputs-path <file> per ADR-0010 §L5',
    );
  }
  if (!Array.isArray(criticOutputs)) {
    throw new NubosPilotError(
      'loop-run-round-post-critics-invalid-outputs',
      '--critic-outputs must be a JSON array',
      { got: typeof criticOutputs },
    );
  }
  if (criticOutputs.length === 0) {
    // Fail closed: the audit gate below proves the critic swarm ran, so an empty
    // report array means their output was lost, not that they all passed.
    throw new NubosPilotError(
      'loop-run-round-post-critics-empty-outputs',
      'phase=post-critics refused: --critic-outputs is empty',
      { hint: 'a critic that found nothing must still report { "critic": "<axis>", "findings": [] }' },
    );
  }
  const preCp = checkpoint.readCheckpoint(taskId, cwd) || {};
  const gateRound = Number((preCp.nubosloop && preCp.nubosloop.round)) || 1;
  const force = list.includes('--force-post-critics');
  if (!force) {
    const verdict = nubosloop.assertSpawnsAuditedForRound(
      taskId, nubosloop.POST_CRITICS_EVIDENCE, gateRound, cwd,
    );
    if (!verdict.satisfied) {
      throw new NubosPilotError(
        'loop-post-critics-missing-critic-audit',
        'phase=post-critics refused: critic-schwarm spawn-evidence missing for round=' + gateRound +
        ' on ' + taskId + ' (missing audits: ' + verdict.missing.join(', ') + '). ' +
        'For each critic agent, call `loop-audit-tool-use ' + taskId +
        ' --agent <np-critic-style|np-critic-tests|np-critic-acceptance|np-critic-economy> --tool-use-log <json>` ' +
        'after the spawn, then re-run --phase post-critics. Pass --force-post-critics for an explicit override.',
        { taskId, round: gateRound, missing: verdict.missing.slice(), required: nubosloop.POST_CRITICS_EVIDENCE.slice() },
      );
    }
  }
  const opts = nubosloop.resolveLoopOpts(cwd);
  let evalResult = null;
  let effectiveMax = null;
  const merged = checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      const round = Number(prev.round) || 1;
      if (round !== gateRound) {
        throw new NubosPilotError(
          'loop-post-critics-round-shifted',
          'phase=post-critics refused: round shifted from ' + gateRound + ' to ' + round +
          ' between audit-gate check and checkpoint merge (concurrent post-executor verify-red). Retry post-critics for round=' + round + '.',
          { taskId, gate_round: gateRound, current_round: round },
        );
      }
      const override = prev.max_rounds_override;
      effectiveMax = (Number.isInteger(override) && override >= 1)
        ? nubosloop.coerceMaxRounds(override)
        : opts.maxRounds;
      const auditFindings = nubosloop.auditFindingsFromAudits(prev.tool_use_audit, round, taskId);
      const skillFindings = nubosloop.skillFindingsFromState(prev, round, taskId);
      const combinedAudit = skillFindings.length ? auditFindings.concat(skillFindings) : auditFindings;
      evalResult = nubosloop.evaluateLoop(
        { round },
        criticOutputs,
        { maxRounds: effectiveMax, auditFindings: combinedAudit },
      );
      const perRound = (prev.findings_per_round && typeof prev.findings_per_round === 'object')
        ? safeAssign({}, prev.findings_per_round)
        : {};
      perRound[String(round)] = evalResult.findings;
      const routed = nubosloop.markAuditsRoutedInArray(prev.tool_use_audit, round);
      const skillRoutedRounds = skillFindings.length
        ? nubosloop.markSkillFindingsRoutedInArray(prev.skill_routed_rounds, round)
        : (Array.isArray(prev.skill_routed_rounds) ? prev.skill_routed_rounds : []);
      const partial = {
        last_phase: 'post-critics',
        last_action: evalResult.next_action,
        findings: evalResult.findings,
        findings_per_round: perRound,
        skill_routed_rounds: skillRoutedRounds,
        tool_use_audit: routed.audits,
      };
      if (force) partial.forced_post_critics = true;
      if (ROUND_ADVANCE_ACTIONS.has(evalResult.next_action)) {
        partial.round = round + 1;
      }
      return { nubosloop: safeAssign({}, prev, partial) };
    },
    cwd,
  );
  return {
    phase: 'post-critics',
    round: gateRound,
    next_round: merged.nubosloop ? merged.nubosloop.round : gateRound,
    next_action: evalResult.next_action,
    stuck: evalResult.stuck,
    findings: evalResult.findings,
    routing: evalResult.routing,
    max_rounds: effectiveMax,
    forced: force,
  };
}

function _runCommit(taskId, list, cwd) {
  const force = list.includes('--force-commit-phase');
  if (!force) {
    const cur = checkpoint.readCheckpoint(taskId, cwd) || {};
    const np = (cur && cur.nubosloop) || {};
    if (np.verify_exit_code !== 0) {
      throw new NubosPilotError(
        'loop-commit-precondition-missing',
        'phase=commit refused: post-executor did not record a verify-green run for ' + taskId +
        ' (observed verify_exit_code=' + (np.verify_exit_code === undefined ? 'undefined' : np.verify_exit_code) + '). ' +
        'Run `loop-run-round ' + taskId + ' --phase post-executor --verify-exit-code 0 --verify-output-path ...` first, ' +
        'or pass --force-commit-phase for an explicit override.',
        { taskId, missing: 'verify_exit_code', observed: np.verify_exit_code === undefined ? null : np.verify_exit_code },
      );
    }
    if (!Array.isArray(np.findings)) {
      throw new NubosPilotError(
        'loop-commit-precondition-missing',
        'phase=commit refused: post-critics did not produce a findings array for ' + taskId +
        ' (observed findings=' + (np.findings === undefined ? 'undefined' : JSON.stringify(np.findings)) + '). ' +
        'Run `loop-run-round ' + taskId + ' --phase post-critics --critic-outputs <json>` first, ' +
        'or pass --force-commit-phase for an explicit override.',
        { taskId, missing: 'findings', observed: np.findings === undefined ? null : np.findings },
      );
    }
    if (np.findings.length !== 0) {
      throw new NubosPilotError(
        'loop-commit-precondition-missing',
        'phase=commit refused: post-critics produced ' + np.findings.length +
        ' open finding(s) for ' + taskId + '. ' +
        'Loop until `evaluateLoop` reports `next_action=commit` (zero findings) before stamping commit, ' +
        'or pass --force-commit-phase for an explicit override.',
        { taskId, missing: 'findings=[]', observed_findings_count: np.findings.length },
      );
    }
    let pendingReplies;
    try { pendingReplies = messaging.pendingReplies(taskId, cwd); }
    catch { pendingReplies = []; }
    if (pendingReplies.length > 0) {
      throw new NubosPilotError(
        'loop-commit-precondition-missing',
        'phase=commit refused: ' + pendingReplies.length +
        ' inter-agent message(s) with expects_reply=true are unarchived for ' + taskId +
        '. Each request needs a response (kind=response, --in-reply-to <id>) before commit. ADR-0015.',
        {
          taskId,
          missing: 'pending-replies-cleared',
          observed_pending_replies: pendingReplies.length,
          pending_subjects: pendingReplies.map((m) => m.subject),
        },
      );
    }
  }
  const pattern = args.getFlag(list, '--learning-pattern') || null;
  const outcome = args.getFlag(list, '--learning-outcome') || 'verified';
  const cpForCache = checkpoint.readCheckpoint(taskId, cwd) || {};
  const cacheHit = !!(cpForCache.nubosloop && cpForCache.nubosloop.cache_hit);
  const isSentinelPlaceholder = typeof pattern === 'string'
    && pattern.startsWith('<')
    && pattern.endsWith('>');
  let logged = null;
  let skipReason = null;
  if (!pattern) {
    skipReason = 'no-pattern';
  } else if (cacheHit) {
    skipReason = 'cache-hit';
  } else if (isSentinelPlaceholder) {
    skipReason = 'sentinel-placeholder';
  } else {
    try {
      logged = nubosloop.autoLogLearning(taskId, { pattern, outcome }, cwd);
    } catch (err) {
      logged = { error: err && err.code ? err.code : 'auto-log-learning-failed' };
    }
  }

  let messagesSwept = 0;
  try { messagesSwept = messaging.sweepTaskOnCommit(taskId, cwd); }
  catch { messagesSwept = 0; }

  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => ({
      status: 'pre-commit',
      nubosloop: safeAssign({}, (cur && cur.nubosloop) || {}, {
        last_phase: 'commit',
        last_action: 'commit',
        committed_at: new Date().toISOString(),
        forced_commit_phase: force ? true : (cur && cur.nubosloop && cur.nubosloop.forced_commit_phase) || false,
        max_rounds_override: null,
      }),
    }),
    cwd,
  );
  return {
    phase: 'commit',
    next_action: 'commit-task',
    learning_logged: logged,
    learning_skip_reason: skipReason,
    messages_swept: messagesSwept,
    forced: force,
  };
}

const STUCK_REASONS_THAT_CLEAR_OVERRIDE = new Set([
  'user-requested-replan',
  'manual-fix-pending',
]);

function _runStuck(taskId, list, cwd) {
  const reason = args.getFlag(list, '--reason') || '';
  const findingsInline = args.getFlag(list, '--findings');
  const findingsPath = args.getFlag(list, '--findings-path');
  if (findingsInline !== undefined && findingsPath !== undefined) {
    throw new NubosPilotError(
      'loop-run-round-stuck-conflicting-findings',
      'pass exactly one of --findings or --findings-path, not both',
      { hint: 'Verdict-Only contract (ADR-0010 §L5) prefers --findings-path; inline form is the legacy fallback' },
    );
  }
  let findings;
  if (findingsPath !== undefined) {
    const parsed = _readCriticOutputsFromPath(findingsPath, cwd);
    findings = parsed;
  } else {
    findings = args.optionalJsonFlag(list, '--findings');
  }
  const merged = checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      const partial = {
        last_phase: 'stuck',
        last_action: 'stuck',
        stuck: true,
        stuck_reason: reason || null,
        stuck_at: new Date().toISOString(),
      };
      if (findings !== undefined) {
        partial.findings = findings;
        const round = Number(prev.round) || 1;
        const perRound = (prev.findings_per_round && typeof prev.findings_per_round === 'object')
          ? safeAssign({}, prev.findings_per_round)
          : {};
        perRound[String(round)] = findings;
        partial.findings_per_round = perRound;
      }
      if (STUCK_REASONS_THAT_CLEAR_OVERRIDE.has(reason)) {
        partial.max_rounds_override = null;
      }
      return {
        status: 'stuck',
        nubosloop: safeAssign({}, prev, partial),
      };
    },
    cwd,
  );
  return {
    phase: 'stuck',
    next_action: 'escalate-via-askuser',
    nubosloop: merged.nubosloop || null,
  };
}

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const taskId = list[0];
  args.assertMatch(taskId, TASK_ID_RE, 'loop-run-round-invalid-task-id', 'taskId');
  const phase = args.getFlag(list.slice(1), '--phase');
  if (!phase) {
    throw new NubosPilotError(
      'loop-run-round-missing-phase',
      'loop-run-round requires --phase <preflight|post-researcher|post-architect|post-test-writer|post-executor|post-critics|commit|stuck>',
      { hint: 'each phase corresponds to a non-LLM transition between LLM spawns' },
    );
  }
  if (!VALID_PHASES.has(phase)) {
    throw new NubosPilotError(
      'loop-run-round-invalid-phase',
      'unknown --phase: ' + phase,
      { value: phase, supported: Array.from(VALID_PHASES).sort() },
    );
  }

  const tail = list.slice(1);
  let result;
  switch (phase) {
    case 'preflight':        result = await _runPreflight(taskId, tail, cwd); break;
    case 'post-researcher':  result = _runPostResearcher(taskId, tail, cwd); break;
    case 'post-architect':   result = _runPostArchitect(taskId, tail, cwd); break;
    case 'post-test-writer': result = _runPostTestWriter(taskId, tail, cwd); break;
    case 'post-executor':    result = _runPostExecutor(taskId, tail, cwd); break;
    case 'post-critics':    result = _runPostCritics(taskId, tail, cwd); break;
    case 'commit':          result = _runCommit(taskId, tail, cwd); break;
    case 'stuck':           result = _runStuck(taskId, tail, cwd); break;
    default:
      throw new NubosPilotError('loop-run-round-internal', 'unhandled phase: ' + phase, { phase });
  }
  result.task_id = taskId;
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

module.exports = { run, VALID_PHASES };
