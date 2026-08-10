'use strict';

const path = require('node:path');

const { NubosPilotError, safeAssign, normalizeText } = require('./core.cjs');
const checkpoint = require('./checkpoint.cjs');
const { TASK_ID_RE } = require('./ids.cjs');
const { getAdapter } = require('./knowledge-adapter.cjs');
const swarm = require('./researcher-swarm.cjs');
const config = require('./config.cjs');
const audit = require('./nubosloop-audit.cjs');

const DEFAULT_MAX_ROUNDS = 3;
const agentsRegistry = require('./agents-registry.cjs');
const SUPPORTED_CRITICS = agentsRegistry.SUPPORTED_CRITIC_AXES;

const ROUTE_TABLE = {
  'style': 'executor',
  'dead-code': 'executor',
  'dangling-thread': 'executor',
  'todo-marker': 'executor',
  'import-hygiene': 'executor',
  'comment-hygiene': 'executor',
  'lint-violation': 'executor',
  'critic-error': 'stuck',
  'rule-9-violation': 'executor',
  'skill-bar-unconsulted': 'executor',
  'missing-test': 'executor',
  'edge-case-gap': 'executor',
  'weak-assertion': 'executor',
  'silenced-failure': 'executor',
  'test-naming': 'executor',
  'non-deterministic': 'executor',
  'verify-mismatch': 'executor',
  'unmet-criterion': 'executor',
  'scope-creep': 'executor',
  'over-engineering': 'executor',
  'stdlib-reinvention': 'executor',
  'native-duplication': 'executor',
  'shrinkable': 'executor',
  'information-missing': 'researcher',
  'question-to-user': 'askuser',
  'locked-decision-violation': 'plan-checker',
  'infrastructure-mismatch': 'plan-checker',
  'stuck-detected': 'stuck',
};

function _readLoopConfig(cwd) {
  const loop = config.tryReadConfigPath(cwd, 'loop', {});
  return loop && typeof loop === 'object' && !Array.isArray(loop) ? loop : {};
}

function _readAutoLogLearning(cwd) {
  return config.tryReadConfigPath(cwd, 'auto_log_learning', true) !== false;
}

const HARD_MAX_ROUNDS_BOUND = 100;
function _coerceMaxRounds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROUNDS;
  return Math.max(1, Math.min(HARD_MAX_ROUNDS_BOUND, Math.round(n)));
}

function resolveLoopOpts(cwd, override) {
  const cfg = _readLoopConfig(cwd);
  const o = override || {};
  const rawMax = o.maxRounds != null ? o.maxRounds : (cfg.maxRounds != null ? cfg.maxRounds : DEFAULT_MAX_ROUNDS);
  return { maxRounds: _coerceMaxRounds(rawMax) };
}

const _NL_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function _deepSanitize(v, seen) {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return null;
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => _deepSanitize(x, seen));
  const out = {};
  for (const k of Object.keys(v)) {
    if (_NL_PROTO_KEYS.has(k)) continue;
    out[k] = _deepSanitize(v[k], seen);
  }
  return out;
}

function _assertFindingObject(critic, raw, index) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return;
  throw new NubosPilotError(
    'critic-output-malformed-finding',
    'critic=' + critic + ' finding[' + index + '] is not a finding object: ' + JSON.stringify(raw),
    {
      critic,
      index,
      got: Array.isArray(raw) ? 'array' : (raw === null ? 'null' : typeof raw),
      value: raw,
      hint: 'each finding must be an object with { category, severity, file, line, remediation }; '
        + 'a non-object used to be dropped silently, and zero findings routes to commit',
    },
  );
}

function _normalizeFinding(critic, raw, index) {
  _assertFindingObject(critic, raw, index == null ? 0 : index);
  raw = _deepSanitize(raw, new WeakSet());
  const category = raw.category;
  const known = typeof category === 'string'
    && Object.prototype.hasOwnProperty.call(ROUTE_TABLE, category);
  if (!known) {
    return {
      critic,
      category: category || 'unknown',
      severity: 'fail',
      route: 'stuck',
      file: raw.file || null,
      line: raw.line != null ? Number(raw.line) : null,
      remediation: 'Critic emitted unknown category "' + (category || '') + '"; orchestrator must escalate (no silent route to executor).',
      raw,
      unknown_category: true,
    };
  }
  return {
    critic,
    category,
    severity: raw.severity || 'fail',
    route: ROUTE_TABLE[category],
    file: raw.file || null,
    line: raw.line != null ? Number(raw.line) : null,
    remediation: raw.remediation || '',
    raw,
  };
}

function _findingFingerprint(f) {
  const parts = [
    f.category || '',
    normalizeText(f.file),
    f.line != null ? String(f.line) : '',
    normalizeText(f.remediation).slice(0, 80),
  ];
  return parts.join('|');
}

function _compareFindings(a, b) {
  const ca = (b.confirmed_by || []).length - (a.confirmed_by || []).length;
  if (ca !== 0) return ca;
  const sevOrder = { fail: 0, risk: 1, nit: 2 };
  const sa = (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3);
  if (sa !== 0) return sa;
  return (a.category || '').localeCompare(b.category || '');
}

const KNOWN_CRITERION_VERDICTS = Object.freeze([
  'Satisfied',
  'Unsatisfied',
  'Information-Missing',
]);

function _criteriaAsFindings(critic, criteria) {
  if (!Array.isArray(criteria)) return [];
  const out = [];
  let index = -1;
  for (const c of criteria) {
    index += 1;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new NubosPilotError(
        'critic-output-malformed-criterion',
        'critic=' + critic + ' criteria[' + index + '] is not a criterion object: ' + JSON.stringify(c),
        {
          critic,
          index,
          got: Array.isArray(c) ? 'array' : (c === null ? 'null' : typeof c),
          value: c,
          hint: 'each criterion must be an object with { id, verdict, evidence? }; '
            + 'a non-object used to be skipped, which reads as "criterion satisfied"',
        },
      );
    }
    const verdict = c.verdict;
    if (verdict === 'Satisfied') continue;
    const id = c.id || c.criterion_id || '';
    if (verdict === 'Information-Missing') {
      out.push({
        category: 'information-missing',
        severity: 'fail',
        criterion_id: id,
        file: '-',
        line: null,
        remediation: c.missing_info || ('SC ' + id + ' lacks evidence; needs research.'),
      });
    } else if (verdict === 'Unsatisfied') {
      out.push({
        category: 'unmet-criterion',
        severity: 'fail',
        criterion_id: id,
        file: '-',
        line: null,
        remediation: c.evidence || ('SC ' + id + ' is not satisfied by the diff.'),
      });
    } else {
      out.push({
        category: 'unmet-criterion',
        severity: 'fail',
        criterion_id: id,
        file: '-',
        line: null,
        remediation: 'SC ' + id + ' carries an unrecognised verdict '
          + JSON.stringify(verdict) + ' — expected one of '
          + KNOWN_CRITERION_VERDICTS.map((v) => JSON.stringify(v)).join(' | ')
          + '. Treated as unsatisfied.',
      });
    }
  }
  return out;
}

const CRITIC_ENVELOPE_MARKERS = Object.freeze(['blockers_count', 'report_path']);

function _assertCriticOutput(out, index) {
  const at = 'criticOutputs[' + index + ']';
  if (!out || typeof out !== 'object' || Array.isArray(out)) {
    throw new NubosPilotError(
      'critic-output-not-an-object',
      at + ' is not a critic report object',
      { index, got: Array.isArray(out) ? 'array' : typeof out },
    );
  }
  const envelope = CRITIC_ENVELOPE_MARKERS.filter((m) => m in out);
  if (envelope.length) {
    throw new NubosPilotError(
      'critic-output-is-envelope',
      at + ' looks like a report envelope (' + envelope.join(', ') + '), not the findings object',
      { index, markers: envelope, hint: 'pass the { critic, findings, criteria? } object itself' },
    );
  }
  if (!SUPPORTED_CRITICS.includes(out.critic)) {
    throw new NubosPilotError(
      'critic-output-unknown-axis',
      at + ' has critic=' + JSON.stringify(out.critic) + ', which is not a known axis',
      {
        index,
        got: out.critic,
        supported: SUPPORTED_CRITICS.slice(),
        hint: 'use the axis (e.g. "style"), not the agent name (e.g. "np-critic-style"); '
          + 'an unknown axis used to be dropped silently, taking its findings with it',
      },
    );
  }
  if (!Array.isArray(out.findings) && !Array.isArray(out.criteria)) {
    throw new NubosPilotError(
      'critic-output-no-findings',
      at + ' (critic=' + out.critic + ') has neither a findings nor a criteria array',
      { index, hint: 'a critic that found nothing must report "findings": []' },
    );
  }
  for (const field of ['findings', 'criteria']) {
    if (field in out && !Array.isArray(out[field])) {
      throw new NubosPilotError(
        'critic-output-' + field + '-not-an-array',
        at + ' (critic=' + out.critic + ') has a ' + field + ' field that is not an array: '
          + JSON.stringify(out[field]),
        {
          index,
          field,
          got: out[field] === null ? 'null' : typeof out[field],
          hint: '"' + field + '" must be an array; a non-array value was read as absent and dropped',
        },
      );
    }
  }
  if (!Array.isArray(out.findings) && Array.isArray(out.criteria) && out.criteria.length === 0) {
    throw new NubosPilotError(
      'critic-output-empty-criteria',
      at + ' (critic=' + out.critic + ') carries an empty criteria array and no findings array — it asserts nothing',
      {
        index,
        hint: 'report the criteria you verdicted, or state "findings": [] to claim a clean review',
      },
    );
  }
}

function mergeCriticOutputs(outputs) {
  if (!Array.isArray(outputs)) {
    throw new TypeError('mergeCriticOutputs: outputs must be an array');
  }
  outputs.forEach(_assertCriticOutput);
  const findings = [];
  const seen = new Map();
  for (const out of outputs) {
    const critic = out.critic;
    const explicit = Array.isArray(out.findings) ? out.findings : [];
    const promoted = _criteriaAsFindings(critic, out.criteria);
    const list = explicit.concat(promoted);
    let index = -1;
    for (const raw of list) {
      index += 1;
      const normalized = _normalizeFinding(critic, raw, index);
      const fp = _findingFingerprint(normalized);
      if (seen.has(fp)) {
        const existing = seen.get(fp);
        if (!existing.confirmed_by.includes(critic)) existing.confirmed_by.push(critic);
      } else {
        const record = safeAssign({ confirmed_by: [critic] }, normalized);
        seen.set(fp, record);
        findings.push(record);
      }
    }
  }
  findings.sort(_compareFindings);
  return findings;
}

const KNOWN_ROUTING_BUCKETS = Object.freeze(['executor', 'researcher', 'askuser', 'plan-checker', 'stuck']);

function routeFindings(findings) {
  const buckets = { executor: [], researcher: [], askuser: [], 'plan-checker': [], stuck: [] };
  for (const f of findings || []) {
    const route = f.route || 'executor';
    if (!KNOWN_ROUTING_BUCKETS.includes(route)) {
      throw new NubosPilotError(
        'nubosloop-unknown-route',
        'finding route "' + route + '" is not a known bucket; valid: ' + KNOWN_ROUTING_BUCKETS.join(', '),
        { route, finding: f, valid: KNOWN_ROUTING_BUCKETS.slice() },
      );
    }
    buckets[route].push(f);
  }
  const stuck = buckets.stuck && buckets.stuck.length > 0;
  return {
    next_destination: _decideNext(buckets, stuck),
    buckets,
    stuck,
    finding_count: (findings || []).length,
  };
}

function _decideNext(buckets, stuck) {
  if (stuck) return 'stuck';
  if (buckets.askuser && buckets.askuser.length) return 'askuser';
  if (buckets['plan-checker'] && buckets['plan-checker'].length) return 'plan-checker';
  if (buckets.researcher && buckets.researcher.length) return 'researcher';
  if (buckets.executor && buckets.executor.length) return 'executor';
  return 'commit';
}

function _mergeAuditFindings(findings, auditRaw) {
  if (!Array.isArray(auditRaw) || auditRaw.length === 0) return findings;
  const seen = new Set(findings.map(_findingFingerprint));
  let index = -1;
  for (const raw of auditRaw) {
    index += 1;
    const normalized = _normalizeFinding('audit', raw, index);
    const fp = _findingFingerprint(normalized);
    if (seen.has(fp)) continue;
    seen.add(fp);
    findings.push(safeAssign({ confirmed_by: ['audit'] }, normalized));
  }
  findings.sort(_compareFindings);
  return findings;
}

function _assertHasEvidence(criticOutputs, auditFindings) {
  const reports = Array.isArray(criticOutputs) ? criticOutputs.length : 0;
  const audits = Array.isArray(auditFindings) ? auditFindings.length : 0;
  if (reports > 0 || audits > 0) return;
  throw new NubosPilotError(
    'nubosloop-no-evidence',
    'evaluateLoop refused: zero critic reports and zero audit findings — '
      + 'that is an absence of evidence, not a clean review, and it must not route to commit',
    {
      critic_report_count: reports,
      audit_finding_count: audits,
      hint: 'pass at least one { critic, findings[] } report; a critic that found nothing '
        + 'must still report "findings": []. If every critic spawn failed, route to stuck.',
    },
  );
}

function evaluateLoop(state, criticOutputs, opts) {
  const o = opts || {};
  const maxRounds = o.maxRounds != null
    ? _coerceMaxRounds(o.maxRounds)
    : DEFAULT_MAX_ROUNDS;
  const round = (state && Number(state.round)) || 1;
  _assertHasEvidence(criticOutputs, o.auditFindings);
  const findings = _mergeAuditFindings(mergeCriticOutputs(criticOutputs), o.auditFindings);
  const routing = routeFindings(findings);

  if (findings.length === 0) {
    return {
      round,
      next_action: 'commit',
      stuck: false,
      findings: [],
      routing,
      reason: 'all critics returned passed',
    };
  }
  if (round >= maxRounds) {
    return {
      round,
      next_action: 'stuck',
      stuck: true,
      findings,
      routing,
      reason: 'maxRounds reached without convergence',
    };
  }
  return {
    round,
    next_action: routing.next_destination,
    stuck: false,
    findings,
    routing,
    reason: 'next_round',
  };
}

function recordLoopState(taskId, partial, cwd) {
  if (typeof taskId !== 'string' || !taskId) {
    throw new NubosPilotError(
      'nubosloop-invalid-task-id',
      'recordLoopState requires a non-empty taskId',
      { taskId },
    );
  }
  return checkpoint.mergeCheckpoint(
    taskId,
    (cur) => ({ nubosloop: safeAssign({}, (cur && cur.nubosloop) || {}, partial || {}) }),
    cwd,
  );
}

function readLoopState(taskId, cwd) {
  const cur = checkpoint.readCheckpoint(taskId, cwd);
  if (!cur || !cur.nubosloop) return null;
  return cur.nubosloop;
}

function logLearningOnSuccess(adapter, entry) {
  if (!adapter || typeof adapter.log !== 'function') return null;
  if (typeof adapter.isAvailable === 'function' && !adapter.isAvailable()) return null;
  return adapter.log(entry);
}

const {
  SEARCH_TOOLS,
  LEDGER_VERIFIED_SEARCH_TOOLS,
  AUDITED_AGENTS,
  auditToolUse,
  recordSearchEvidence,
  searchEvidenceForRound,
  recordSkillEvidence,
  recordExpectedSkills,
  skillFindingsFromState,
  markSkillFindingsRoutedInArray,
  readToolUseAudit,
  auditFindingsForRound,
  auditFindingsFromAudits,
  markAuditsRoutedForRound,
  markAuditsRoutedInArray,
  findSpawnAuditForRound,
  assertSpawnsAuditedForRound,
  countSpawnAuditsForRound,
  assertSpawnsCountForRound,
} = audit;

const POST_EXECUTOR_EVIDENCE_R1 = Object.freeze([agentsRegistry.EXECUTOR_AGENT]);
const POST_EXECUTOR_EVIDENCE_RN = Object.freeze([agentsRegistry.BUILD_FIXER_AGENT]);
const POST_CRITICS_EVIDENCE = Object.freeze(agentsRegistry.CRITIC_AGENTS.slice());

function autoLogLearning(taskId, entry, cwd) {
  if (!_readAutoLogLearning(cwd)) return null;
  if (taskId != null && !TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'nubosloop-auto-log-invalid-task-id',
      'autoLogLearning taskId must match M<NNN>-S<NNN>-T<NNNN>',
      { taskId },
    );
  }
  const adapter = getAdapter(cwd);
  return logLearningOnSuccess(adapter, safeAssign({ task_id: taskId }, entry));
}

async function preflightCacheLookup(query, opts, cwd) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new NubosPilotError(
      'nubosloop-preflight-invalid-query',
      'preflightCacheLookup requires a non-empty query string',
      { query },
    );
  }
  const o = safeAssign({}, swarm.resolveSwarmOpts(cwd), opts || {});
  const taskId = (opts && typeof opts.taskId === 'string') ? opts.taskId : null;
  const spawnInput = taskId
    ? { task_id: taskId, task_query: query }
    : { task_query: query };
  const spawnSpecs = swarm.buildSpawnSpecs(spawnInput, o.k, { cwd });
  const swarmBlock = {
    k: o.k,
    threshold: o.threshold,
    min_occurrence: o.minOccurrence,
    min_confidence: o.minConfidence,
    bypass_threshold: o.bypassThreshold,
    spawn_specs: spawnSpecs,
  };
  const SOFT_CACHE_FAILURES = new Set(['knowledge-adapter-unknown']);
  let adapter;
  try { adapter = getAdapter(cwd); }
  catch (err) {
    if (err && err.name === 'NubosPilotError' && SOFT_CACHE_FAILURES.has(err.code)) {
      return {
        hit: null,
        bypass_swarm: false,
        cache_miss_reason: { code: err.code, message: err.message },
        degraded: null,
        swarm: safeAssign({}, swarmBlock, {
          cache_hit: null,
          cache_miss_reason: { code: err.code, message: err.message },
          bypass_swarm: false,
        }),
      };
    }
    throw err;
  }
  const m = await adapter.match(query, {
    threshold: o.threshold,
    minOccurrence: o.minOccurrence,
    minConfidence: o.minConfidence,
  });
  const degraded = (m && m.degraded) || null;
  if (m && m.best) {
    const hit = {
      adapter: adapter.name,
      fingerprint: m.best.fingerprint,
      pattern: m.best.pattern,
      outcome: m.best.outcome,
      occurrence: m.best.occurrence,
      similarity: m.best.similarity,
      confidence: m.best.confidence != null ? m.best.confidence : null,
      retrieval: m.best.retrieval || null,
    };
    const bypass = (hit.similarity || 0) >= o.bypassThreshold;
    const weakReason = bypass ? null : {
      code: 'cache-hit-below-bypass-threshold',
      message: 'similarity ' + (hit.similarity || 0).toFixed(3)
        + ' is below the bypass threshold ' + o.bypassThreshold
        + '; the hit is advisory context only and the swarm still runs.',
    };
    return {
      hit,
      bypass_swarm: bypass,
      cache_miss_reason: weakReason,
      degraded,
      swarm: safeAssign({}, swarmBlock, {
        cache_hit: hit,
        cache_miss_reason: weakReason,
        bypass_swarm: bypass,
      }),
    };
  }
  return {
    hit: null,
    bypass_swarm: false,
    cache_miss_reason: null,
    degraded,
    swarm: safeAssign({}, swarmBlock, {
      cache_hit: null,
      cache_miss_reason: null,
      bypass_swarm: false,
    }),
  };
}

function _emptyHistogram(maxRounds) {
  const out = {};
  const cap = Math.max(1, Math.min(HARD_MAX_ROUNDS_BOUND, maxRounds));
  for (let i = 1; i <= cap; i += 1) out[i] = 0;
  return out;
}

function aggregateLoopMetrics(cwd) {
  const maxRounds = resolveLoopOpts(cwd).maxRounds;
  const summary = {
    tasks_with_loop: 0,
    total_rounds: 0,
    stuck_count: 0,
    commit_count: 0,
    route_distribution: {
      executor: 0,
      researcher: 0,
      askuser: 0,
      'plan-checker': 0,
      stuck: 0,
      commit: 0,
    },
    finding_categories: {},
    rounds_histogram: _emptyHistogram(maxRounds),
    corrupt_checkpoints: [],
  };
  const paths = checkpoint.listCheckpoints(cwd);
  for (const p of paths) {
    const taskId = path.basename(p, '.json');
    if (!TASK_ID_RE.test(taskId)) {
      summary.corrupt_checkpoints.push({ path: p, reason: 'invalid-task-id-filename' });
      continue;
    }
    let cp;
    try {
      cp = checkpoint.readCheckpoint(taskId, cwd);
    } catch (err) {
      summary.corrupt_checkpoints.push({
        path: p,
        reason: err && err.code ? err.code : 'unreadable',
        message: err && err.message ? err.message : String(err),
      });
      continue;
    }
    const pb = cp && cp.nubosloop;
    if (!pb || typeof pb !== 'object') continue;
    summary.tasks_with_loop += 1;
    const round = Number(pb.round) || 0;
    summary.total_rounds += round;
    if (Object.prototype.hasOwnProperty.call(summary.rounds_histogram, round)) {
      summary.rounds_histogram[round] += 1;
    }
    const action = pb.last_action;
    if (action && summary.route_distribution[action] !== undefined) {
      summary.route_distribution[action] += 1;
    }
    if (action === 'stuck') summary.stuck_count += 1;
    if (action === 'commit') summary.commit_count += 1;
    const findings = Array.isArray(pb.findings) ? pb.findings : [];
    for (const f0 of findings) {
      const c = f0 && f0.category;
      if (!c) continue;
      summary.finding_categories[c] = (summary.finding_categories[c] || 0) + 1;
    }
  }
  summary.average_rounds = summary.tasks_with_loop > 0
    ? Number((summary.total_rounds / summary.tasks_with_loop).toFixed(2))
    : 0;
  return summary;
}

module.exports = {
  DEFAULT_MAX_ROUNDS,
  HARD_MAX_ROUNDS_BOUND,
  coerceMaxRounds: _coerceMaxRounds,
  SUPPORTED_CRITICS,
  ROUTE_TABLE,
  resolveLoopOpts,
  mergeCriticOutputs,
  routeFindings,
  evaluateLoop,
  recordLoopState,
  readLoopState,
  autoLogLearning,
  auditToolUse,
  recordSearchEvidence,
  searchEvidenceForRound,
  recordSkillEvidence,
  recordExpectedSkills,
  skillFindingsFromState,
  markSkillFindingsRoutedInArray,
  readToolUseAudit,
  auditFindingsForRound,
  auditFindingsFromAudits,
  markAuditsRoutedForRound,
  markAuditsRoutedInArray,
  findSpawnAuditForRound,
  assertSpawnsAuditedForRound,
  countSpawnAuditsForRound,
  assertSpawnsCountForRound,
  POST_EXECUTOR_EVIDENCE_R1,
  POST_EXECUTOR_EVIDENCE_RN,
  POST_CRITICS_EVIDENCE,
  KNOWN_ROUTING_BUCKETS,
  SEARCH_TOOLS,
  LEDGER_VERIFIED_SEARCH_TOOLS,
  AUDITED_AGENTS,
  preflightCacheLookup,
  aggregateLoopMetrics,
  _readAutoLogLearning,
};
