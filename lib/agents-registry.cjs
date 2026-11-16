'use strict';


const CRITIC_AGENTS = Object.freeze(['np-critic']);
const LEGACY_CRITIC_AXIS_AGENTS = Object.freeze([
  'np-critic-style',
  'np-critic-tests',
  'np-critic-acceptance',
  'np-critic-economy',
]);
const SUPPORTED_CRITIC_AXES = Object.freeze(['critic', 'style', 'tests', 'acceptance', 'economy']);

const EXECUTOR_AGENT = 'np-executor';
const BUILD_FIXER_AGENT = 'np-build-fixer';

const RESEARCHER_AGENT = 'np-researcher';

// Round-1 preparation agents that run between the researcher swarm and the
// executor. Config-gated (agents.architect / agents.test_writer). They get
// Layer-C spawn-evidence stamps but are NOT Rule-9 audited (see
// `AUDITED_AGENTS` in lib/nubosloop-audit.cjs) — the architect is
// advisory/read-only and the test-writer's quality is enforced downstream by the
// tests axis of np-critic.
const TASK_ARCHITECT_AGENT = 'np-task-architect';
const TEST_WRITER_AGENT = 'np-test-writer';

// NOTE: there is deliberately no AUDITED_AGENTS here. This module used to define
// a second, divergent copy (it included np-critic) with no consumer at all —
// every caller reads the real one from lib/nubosloop-audit.cjs, directly or via
// nubosloop.cjs's re-export. A dead twin of a security-relevant list is a trap:
// the next reader cannot tell which of the two governs, and the two disagreed.
// SSOT = lib/nubosloop-audit.cjs. Guarded by CAP-6 in tests/critic-axis-parity.test.cjs.

module.exports = {
  CRITIC_AGENTS,
  LEGACY_CRITIC_AXIS_AGENTS,
  SUPPORTED_CRITIC_AXES,
  EXECUTOR_AGENT,
  BUILD_FIXER_AGENT,
  RESEARCHER_AGENT,
  TASK_ARCHITECT_AGENT,
  TEST_WRITER_AGENT,
};
