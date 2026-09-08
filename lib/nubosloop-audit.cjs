'use strict';

const { NubosPilotError, safeAssign } = require('./core.cjs');
const checkpoint = require('./checkpoint.cjs');
const { TASK_ID_RE } = require('./ids.cjs');

// `knowledge-search` is the only real search tool: it is the one registered verb
// (bin/np-tools/knowledge-search.cjs) and the only one that writes the evidence
// ledger. `search-knowledge` and `match-existing-learning` used to sit here as
// leftovers from the removed Nubos-MCP integration. Neither was ever a verb, so
// logging them was only possible by fabrication — and because they were absent
// from LEDGER_VERIFIED_SEARCH_TOOLS they were credited *without any evidence*,
// which made Rule 9 a free pass for anyone who typed the right string.
const SEARCH_TOOLS = Object.freeze([
  'knowledge-search',
]);

const LEDGER_VERIFIED_SEARCH_TOOLS = Object.freeze(['knowledge-search']);

const AUDITED_AGENTS = Object.freeze(['np-researcher', 'np-executor', 'np-build-fixer']);

function findSpawnAuditForRound(taskId, agent, round, cwd) {
  if (!TASK_ID_RE.test(taskId)) return null;
  const target = Number(round);
  if (!Number.isFinite(target) || target < 1) return null;
  const audits = readToolUseAudit(taskId, cwd) || [];
  for (const a of audits) {
    if (!a) continue;
    if (a.agent !== agent) continue;
    if ((Number(a.round) || 1) !== target) continue;
    return a;
  }
  return null;
}

function assertSpawnsAuditedForRound(taskId, requiredAgents, round, cwd) {
  const missing = [];
  for (const agent of requiredAgents) {
    if (!findSpawnAuditForRound(taskId, agent, round, cwd)) missing.push(agent);
  }
  return { satisfied: missing.length === 0, missing };
}

function countSpawnAuditsForRound(taskId, agent, round, cwd) {
  if (!TASK_ID_RE.test(taskId)) return 0;
  const target = Number(round);
  if (!Number.isFinite(target) || target < 1) return 0;
  const audits = readToolUseAudit(taskId, cwd) || [];
  let count = 0;
  for (const a of audits) {
    if (!a) continue;
    if (a.agent !== agent) continue;
    if ((Number(a.round) || 1) !== target) continue;
    count += 1;
  }
  return count;
}

function assertSpawnsCountForRound(taskId, agent, requiredCount, round, cwd) {
  const required = Math.max(1, Number(requiredCount) || 1);
  const found = countSpawnAuditsForRound(taskId, agent, round, cwd);
  return { satisfied: found >= required, agent, found, required };
}

function recordSearchEvidence(taskId, query, cwd, agent) {
  if (!TASK_ID_RE.test(taskId)) return null;
  let stampedRound = 1;
  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      stampedRound = Number(prev.round) || 1;
      const evidence = Array.isArray(prev.search_evidence) ? prev.search_evidence.slice() : [];
      evidence.push({
        round: stampedRound,
        // Who ran the search. Without this the ledger was round-global: the
        // researcher's entry credited the executor's claim in the same round.
        agent: typeof agent === 'string' && agent ? agent : null,
        query: typeof query === 'string' ? query.slice(0, 200) : '',
        recorded_at: new Date().toISOString(),
      });
      return { nubosloop: safeAssign({}, prev, { search_evidence: evidence }) };
    },
    cwd,
  );
  return { task_id: taskId, round: stampedRound, agent: agent || null };
}

// When `agent` is given, only that agent's own entries count — the executor must
// not ride the researcher's entry. The one exception is backward compatibility:
// a round whose evidence was ALL written before the ledger recorded an agent
// (an in-flight task that spanned an upgrade) has no per-agent signal to scope
// by, so those legacy entries credit the requesting agent rather than firing a
// spurious rule-9 violation. As soon as any agented entry exists for the round —
// i.e. normal post-upgrade operation — the legacy fallback is off and scoping is
// strict again.
function searchEvidenceForRound(taskId, round, cwd, agent) {
  if (!TASK_ID_RE.test(taskId)) return [];
  const target = Number(round);
  if (!Number.isFinite(target) || target < 1) return [];
  const cur = checkpoint.readCheckpoint(taskId, cwd) || {};
  const evidence = (cur.nubosloop && cur.nubosloop.search_evidence) || [];
  if (!Array.isArray(evidence)) return [];
  const forRound = evidence.filter((e) => e && (Number(e.round) || 1) === target);
  if (agent === undefined) return forRound;
  const anyAgented = forRound.some((e) => e.agent != null);
  return forRound.filter((e) => e.agent === agent || (!anyAgented && e.agent == null));
}

// ── Skill-bar consultation evidence (additive; mirrors search-evidence) ──────
// The orchestrator records the skills it injected for a task (`recordExpectedSkills`);
// the executor stamps each skill it actually consulted (`recordSkillEvidence`, via
// `skill-audit ack`). skillFindingsFromState turns an unmet expectation into a
// `skill-bar-unconsulted` finding (ROUTE_TABLE → executor), round-stamped and
// emitted at most once per round via `skill_routed_rounds` — same anti-re-route
// guarantee as the Rule-9 path. The Rule-9 functions below are left untouched.

function _normSkillName(s) {
  const v = String(s || '').trim();
  // A path like `.claude/skills/<skill>/SKILL.md` names the skill by its directory.
  const dir = v.match(/([^/]+)\/SKILL\.md$/i);
  if (dir) return dir[1];
  // Otherwise a bare name (optionally with a stray .md): take the basename.
  return v.replace(/^.*\//, '').replace(/\.md$/i, '');
}

function recordSkillEvidence(taskId, skill, cwd) {
  if (!TASK_ID_RE.test(taskId)) return null;
  const name = _normSkillName(skill);
  if (!name) return null;
  let stampedRound = 1;
  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      stampedRound = Number(prev.round) || 1;
      const evidence = Array.isArray(prev.skill_evidence) ? prev.skill_evidence.slice() : [];
      evidence.push({ round: stampedRound, skill: name, recorded_at: new Date().toISOString() });
      return { nubosloop: safeAssign({}, prev, { skill_evidence: evidence }) };
    },
    cwd,
  );
  return { task_id: taskId, round: stampedRound, skill: name };
}

function recordExpectedSkills(taskId, skills, cwd) {
  if (!TASK_ID_RE.test(taskId)) return null;
  const names = (Array.isArray(skills) ? skills : []).map(_normSkillName).filter(Boolean);
  if (names.length === 0) return { task_id: taskId, expected: [] };
  let stampedRound = 1;
  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      stampedRound = Number(prev.round) || 1;
      const expect = Array.isArray(prev.skill_expect) ? prev.skill_expect.slice() : [];
      expect.push({ round: stampedRound, skills: names, recorded_at: new Date().toISOString() });
      return { nubosloop: safeAssign({}, prev, { skill_expect: expect }) };
    },
    cwd,
  );
  return { task_id: taskId, round: stampedRound, expected: names };
}

function _collectForRound(listVal, round, key) {
  const out = [];
  if (!Array.isArray(listVal)) return out;
  for (const e of listVal) {
    if (!e || (Number(e.round) || 1) !== round) continue;
    const v = e[key];
    if (Array.isArray(v)) out.push(...v);
    else if (v) out.push(v);
  }
  return out;
}

// Pure: derive skill-bar findings from a checkpoint's nubosloop sub-object.
function skillFindingsFromState(prevNubosloop, round, taskId) {
  const prev = prevNubosloop || {};
  const t = Number(round);
  if (!Number.isFinite(t) || t < 1) return [];
  const routed = Array.isArray(prev.skill_routed_rounds) ? prev.skill_routed_rounds : [];
  if (routed.includes(t)) return [];
  const expected = Array.from(new Set(_collectForRound(prev.skill_expect, t, 'skills')));
  if (expected.length === 0) return [];
  const acked = new Set(_collectForRound(prev.skill_evidence, t, 'skill'));
  const missing = expected.filter((s) => !acked.has(s));
  if (missing.length === 0) return [];
  return [{
    category: 'skill-bar-unconsulted',
    severity: 'fail',
    file: '-',
    line: null,
    remediation: 'Spawn was given Nubos skills as the quality bar for this task but did not consult '
      + (missing.length === 1 ? 'it' : 'them') + ': [' + missing.join(', ') + ']. For each, `Read` '
      + '`.claude/skills/<skill>/SKILL.md`, satisfy its "Verification bar" in the diff, then stamp '
      + '`node np-tools.cjs skill-audit ack --task ' + taskId + ' --skill <skill>` — before editing.',
    raw: { missing_skills: missing, expected_skills: expected },
  }];
}

function markSkillFindingsRoutedInArray(routedRounds, round) {
  const t = Number(round);
  const arr = Array.isArray(routedRounds) ? routedRounds.slice() : [];
  if (!Number.isFinite(t) || t < 1 || arr.includes(t)) return arr;
  arr.push(t);
  return arr;
}

function auditToolUse(taskId, agent, toolUseLog, cwd) {
  if (!TASK_ID_RE.test(taskId)) {
    throw new NubosPilotError(
      'nubosloop-audit-invalid-task-id',
      'auditToolUse taskId must match M<NNN>-S<NNN>-T<NNNN>',
      { taskId },
    );
  }
  if (typeof agent !== 'string' || !agent) {
    throw new NubosPilotError(
      'nubosloop-audit-invalid-agent',
      'auditToolUse agent (string) is required',
      { agent },
    );
  }
  if (!Array.isArray(toolUseLog)) {
    throw new NubosPilotError(
      'nubosloop-audit-invalid-log',
      'auditToolUse toolUseLog must be an array of tool names',
      { got: typeof toolUseLog },
    );
  }
  const audited = AUDITED_AGENTS.includes(agent);
  const searchCalls = toolUseLog.filter((t) => typeof t === 'string' && SEARCH_TOOLS.includes(t));
  const auditCheckpoint = checkpoint.readCheckpoint(taskId, cwd) || {};
  const auditRound = Number((auditCheckpoint.nubosloop || {}).round) || 1;
  // Per-agent, not round-global: the executor must not ride the researcher's entry.
  const ledgerEvidence = searchEvidenceForRound(taskId, auditRound, cwd, agent);
  const hasLedgerEvidence = ledgerEvidence.length > 0;
  const creditedCalls = searchCalls.filter(
    (t) => !LEDGER_VERIFIED_SEARCH_TOOLS.includes(t) || hasLedgerEvidence,
  );
  let violation = null;
  if (audited && searchCalls.length === 0) {
    violation = 'rule-9-no-search-tool-invoked';
  } else if (audited && creditedCalls.length === 0) {
    violation = 'rule-9-search-tool-unverified';
  }
  let stampedRound = 1;
  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      stampedRound = Number(prev.round) || 1;
      const auditEntry = {
        agent,
        audited,
        round: stampedRound,
        search_calls: searchCalls,
        credited_calls: creditedCalls,
        search_evidence_count: ledgerEvidence.length,
        tool_use_count: toolUseLog.length,
        violation,
        audited_at: new Date().toISOString(),
      };
      const log = Array.isArray(prev.tool_use_audit) ? prev.tool_use_audit.slice() : [];
      log.push(auditEntry);
      return { nubosloop: safeAssign({}, prev, { tool_use_audit: log }) };
    },
    cwd,
  );
  return { ok: violation == null, agent, round: stampedRound, search_calls: searchCalls, violation };
}

function auditFindingsFromAudits(audits, target, taskId) {
  if (!Array.isArray(audits)) return [];
  const t = Number(target);
  if (!Number.isFinite(t) || t < 1) return [];
  const out = [];
  for (const a of audits) {
    if (!a || !a.violation) continue;
    const aRound = Number(a.round) || 1;
    if (aRound > t) continue;
    if (aRound < t && a.routed_in_round != null) continue;
    if (aRound === t && a.routed_in_round != null) continue;
    out.push({
      category: 'rule-9-violation',
      severity: 'fail',
      file: '-',
      line: null,
      remediation: (a.violation === 'rule-9-search-tool-unverified'
        ? 'Spawn `' + a.agent + '` stamped a `knowledge-search` tool in its tool-use log, '
          + 'but no knowledge-search evidence was recorded for round ' + aRound + '. '
          + 'Re-run and actually invoke `node np-tools.cjs knowledge-search "<query>" --task '
          + taskId + ' --agent ' + a.agent + '` (via Bash) before editing.'
        : 'Spawn `' + a.agent + '` shipped without invoking a SEARCH_TOOL ('
          + Array.from(SEARCH_TOOLS).slice(0, 4).join(', ')
          + '). Re-run with explicit instruction to consult institutional memory before writing code.')
        + (aRound < t ? ' (Carried forward from round ' + aRound + ' — verify-red short-circuit.)' : ''),
      raw: { audit: a },
    });
  }
  return out;
}

function auditFindingsForRound(taskId, round, cwd) {
  if (!TASK_ID_RE.test(taskId)) return [];
  const audits = readToolUseAudit(taskId, cwd) || [];
  return auditFindingsFromAudits(audits, round, taskId);
}

function markAuditsRoutedInArray(audits, target) {
  const t = Number(target);
  if (!Number.isFinite(t) || t < 1 || !Array.isArray(audits)) return { audits: audits || [], marked: 0 };
  let marked = 0;
  const updated = audits.map((a) => {
    if (!a || !a.violation) return a;
    if ((Number(a.round) || 1) > t) return a;
    if (a.routed_in_round != null) return a;
    marked += 1;
    return safeAssign({}, a, { routed_in_round: t });
  });
  return { audits: updated, marked };
}

function markAuditsRoutedForRound(taskId, round, cwd) {
  if (!TASK_ID_RE.test(taskId)) return 0;
  let marked = 0;
  checkpoint.mergeCheckpoint(
    taskId,
    (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      const result = markAuditsRoutedInArray(prev.tool_use_audit, round);
      marked = result.marked;
      return { nubosloop: safeAssign({}, prev, { tool_use_audit: result.audits }) };
    },
    cwd,
  );
  return marked;
}

function readToolUseAudit(taskId, cwd) {
  if (!TASK_ID_RE.test(taskId)) return null;
  const cp = checkpoint.readCheckpoint(taskId, cwd);
  if (!cp || !cp.nubosloop) return [];
  return Array.isArray(cp.nubosloop.tool_use_audit) ? cp.nubosloop.tool_use_audit : [];
}

module.exports = {
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
};
