'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'workflows');

const EXPECTED = [
  { workflow: 'execute-phase.md',  agent: 'np-executor',             marker: '--agent "$EXECUTOR_AGENT"' },
  { workflow: 'execute-phase.md',  agent: 'np-critic',               marker: '--agent np-critic' },
  { workflow: 'execute-phase.md',  agent: 'np-researcher',           marker: '--agent np-researcher' },
  { workflow: 'execute-phase.md',  agent: 'np-task-architect',       marker: '--agent np-task-architect' },
  { workflow: 'execute-phase.md',  agent: 'np-test-writer',          marker: '--agent np-test-writer' },
  { workflow: 'plan-phase.md',     agent: 'np-planner',              marker: '--agent np-planner' },
  { workflow: 'plan-phase.md',     agent: 'np-plan-checker',         marker: '--agent np-plan-checker' },
  { workflow: 'discuss-phase.md',  agent: 'np-sc-extractor',         marker: '--agent np-sc-extractor' },
  { workflow: 'research-phase.md', agent: 'np-researcher',           marker: '--agent np-researcher' },
  { workflow: 'research-phase.md', agent: 'np-researcher-reconciler',marker: '--agent np-researcher-reconciler' },
  { workflow: 'validate-phase.md', agent: 'np-nyquist-auditor',      marker: '--agent np-nyquist-auditor' },
  { workflow: 'verify-work.md',    agent: 'np-verifier',             marker: '--agent np-verifier' },
  { workflow: 'architect-phase.md',agent: 'np-architect',            marker: '--agent np-architect' },
  { workflow: 'architect-phase.md',agent: 'np-critic',               marker: '--agent np-critic' },
  { workflow: 'architect-phase.md',agent: 'np-researcher',           marker: '--agent np-researcher' },
  { workflow: 'add-tests.md',      agent: 'np-critic',               marker: '--agent np-critic' },
  { workflow: 'scan-codebase.md',  agent: 'np-codebase-documenter',  marker: '--agent np-codebase-documenter' },
];

const EXCEPTIONS = [
  { agent: 'np-build-fixer',        reason: 'spawned via the $EXECUTOR_AGENT variable in execute-phase (round >= 2); covered by the np-executor off-host branch.' },
  { agent: 'np-security-reviewer',  reason: 'spawned via spawn-headless (lib/security/review.cjs), not a workflow orchestrator spawn — off-host routing is handled centrally inside spawn-headless (async dispatchOffHost branch, ADR-0021), so no per-workflow branch applies.' },
  { agent: 'np-learnings-extractor',reason: 'spawned via spawn-headless (lib/learnings/extract.cjs) — same central off-host routing as np-security-reviewer.' },
  { agent: 'np-critic-acceptance',  reason: 'not actively spawned — superseded by the single np-critic (ADR-0010 2026-05-05).' },
  { agent: 'np-critic-style',       reason: 'not actively spawned — superseded by the single np-critic.' },
  { agent: 'np-critic-tests',       reason: 'not actively spawned — superseded by the single np-critic.' },
  { agent: 'np-simplifier',         reason: 'spawned only by /np:simplify-review — an interactive, read-only economy audit run in the host session; the report is meant to return inline to the user, so it deliberately stays out of the autonomous off-host dispatch lane (ADR-0021 covers the unattended milestone pipeline, not manual review utilities).' },
];

const SPAWN_INDICATOR_RE = /(?:subagent_type="(np-[a-z-]+)"|Spawn agent=(np-[a-z-]+)|Spawn `agents\/(np-[a-z-]+))/g;

function _read(wf) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, wf), 'utf-8');
}

function _hasOffhost(text, marker) {
  if (!text.includes(marker)) return false;
  return /spawn-offhost/.test(text);
}

function check() {
  const gaps = [];
  const drift = [];
  const exempt = new Set(EXCEPTIONS.map((e) => e.agent));

  // 1. Coverage: every EXPECTED (workflow, agent) must have an off-host branch.
  for (const e of EXPECTED) {
    let text;
    try { text = _read(e.workflow); }
    catch { gaps.push(`${e.workflow}: file missing (expected to wire ${e.agent})`); continue; }
    if (!_hasOffhost(text, e.marker)) {
      gaps.push(`${e.workflow}: ${e.agent} has NO off-host branch (missing marker \`${e.marker}\` near a spawn-offhost call)`);
    }
  }

  // 2. Drift: every structured spawn-indicator in any workflow must be an
  //    EXPECTED (workflow, agent) pair or an explicit EXCEPTION — otherwise a
  //    new spawn site shipped without an off-host branch.
  const expectedPairs = new Set(EXPECTED.map((e) => e.workflow + '::' + e.agent));
  for (const wf of fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'))) {
    const text = _read(wf);
    let m;
    SPAWN_INDICATOR_RE.lastIndex = 0;
    const seen = new Set();
    while ((m = SPAWN_INDICATOR_RE.exec(text)) !== null) {
      const agent = m[1] || m[2] || m[3];
      if (!agent || seen.has(agent)) continue;
      seen.add(agent);
      if (expectedPairs.has(wf + '::' + agent)) continue;
      if (exempt.has(agent)) continue;
      drift.push(`${wf}: spawn-indicator for "${agent}" is not in the off-host coverage matrix — wire an off-host branch and add it to EXPECTED in scripts/check-offhost-coverage.cjs`);
    }
  }

  return { ok: gaps.length === 0 && drift.length === 0, gaps, drift };
}

module.exports = { check, EXPECTED, EXCEPTIONS };

if (require.main === module) {
  const r = check();
  if (r.ok) {
    process.stdout.write(`[ok] off-host coverage: ${EXPECTED.length} spawn sites wired, ${EXCEPTIONS.length} documented exceptions, no drift.\n`);
    process.exit(0);
  }
  for (const g of r.gaps) process.stderr.write('[gap] ' + g + '\n');
  for (const d of r.drift) process.stderr.write('[drift] ' + d + '\n');
  process.stderr.write(`\noff-host coverage check FAILED: ${r.gaps.length} gap(s), ${r.drift.length} drift(s).\n`);
  process.exit(1);
}
