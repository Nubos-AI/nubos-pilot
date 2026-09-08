'use strict';

const DEFAULT_RESEARCH_TOOLS = Object.freeze({
  WebFetch: true,
  Context7: true,
});

const DEFAULT_WORKFLOW = Object.freeze({
  commit_docs: true,
  commit_artifacts: true,
  worktree_isolation: false,
  tier_routing: false,
  research_tools: DEFAULT_RESEARCH_TOOLS,
});

const DEFAULT_AGENTS = Object.freeze({
  parallelization: true,
  research: true,
  plan_checker: true,
  verifier: true,
  architect: true,
  test_writer: true,
  economy: 'lite',
});

const DEFAULT_LOOP = Object.freeze({
  maxRounds: 3,
  verify_runs: 1,
});

const DEFAULT_MEMORY = Object.freeze({
  enabled: false,
  model: 'Xenova/bge-small-en-v1.5',
  alpha: 0.6,
});

const DEFAULT_SWARM_RESEARCH = Object.freeze({
  k: 3,
  threshold: 0.2,
  minOccurrence: 1,
  minConfidence: 0.3,
  bypassThreshold: 0.5,
});

const DEFAULT_SWARM_CRITIC = Object.freeze({
  style_tier: 'haiku',
  tests_tier: 'sonnet',
  acceptance_tier: 'sonnet',
  economy_tier: 'haiku',
});

const DEFAULT_SWARM = Object.freeze({
  research: DEFAULT_SWARM_RESEARCH,
  critic: DEFAULT_SWARM_CRITIC,
  knowledge_adapter: 'local',
});

const DEFAULT_SCAN = Object.freeze({
  enabled: true,
  advisory: true,
  malicious: true,
  secrets: true,
  misconfig: true,
  license: false,
  min_severity: 'high',
  ignore_scopes: Object.freeze(['dev']),
  fail_on: 'never',
  db_dir: null,
  max_findings_per_run: 50,
});

const DEFAULT_SECURITY = Object.freeze({
  enabled: true,
  scan_on_write: true,
  review_on_stop: true,
  review_on_commit: true,
  custom_rules_path: null,
  guidance_path: null,
  review_timeout_ms: 180000,
  max_stop_reviews_in_a_row: 3,
  max_commit_reviews_per_hour: 20,
  max_files_per_review: 30,
  scan: DEFAULT_SCAN,
});

const DEFAULT_CONFORMANCE = Object.freeze({
  inject_criteria: true,
});

const DEFAULT_PLAN_LINT = Object.freeze({
  verify_allow_commands: Object.freeze([]),
});

const DEFAULT_LEARNINGS = Object.freeze({
  auto_capture: true,
  max_captures_per_hour: 10,
  max_in_a_row: 3,
  timeout_ms: 120000,
  max_files: 30,
  inject: true,
  inject_limit: 6,
  inject_max_chars: 2000,
});

const DEFAULT_AUTO_LOG_LEARNING = true;

const DEFAULT_SPAWN_HEADLESS = Object.freeze({
  enabled: false,
  agents: Object.freeze(['np-critic', 'np-researcher']),
  timeout_ms: 10 * 60 * 1000,
  fallback_on_error: true,
});

const DEFAULT_SPAWN = Object.freeze({
  headless: DEFAULT_SPAWN_HEADLESS,
});

const DEFAULT_COMPRESSION_ELISION = Object.freeze({
  enabled: true,
  ttl_ms: 30 * 60 * 1000,
});

const DEFAULT_COMPRESSION_PROXY = Object.freeze({
  enabled: false,
});

const DEFAULT_COMPRESSION_OUTPUT_STEERING = Object.freeze({
  enabled: false,
  verbosity_profile: 'balanced',
  effort_routing: Object.freeze({
    enabled: false,
    base_effort: null,
    mechanical_effort: 'low',
  }),
});

const DEFAULT_COMPRESSION_CACHE_ALIGN = Object.freeze({
  enabled: false,
});

const DEFAULT_COMPRESSION = Object.freeze({
  enabled: false,
  min_block_bytes: 2048,
  verify_max_bytes: 2000,
  elision: DEFAULT_COMPRESSION_ELISION,
  proxy: DEFAULT_COMPRESSION_PROXY,
  output_steering: DEFAULT_COMPRESSION_OUTPUT_STEERING,
  cache_align: DEFAULT_COMPRESSION_CACHE_ALIGN,
});

const DEFAULT_MODEL_PROFILE = 'frontier';
const DEFAULT_SCOPE = 'local';
const DEFAULT_RESPONSE_LANGUAGE = 'en';

const INSTALL_ECONOMY_MODE = 'ultra';

// ADR-0026. Off with no endpoint: with `enabled: false` nothing in lib/otlp.cjs
// runs, so ADR-0001 (no daemon) and ADR-0002 (zero runtime deps) hold by
// default. `endpoint` stays null rather than defaulting to localhost:4318 — a
// default endpoint would make "enabled" the only switch standing between a
// private project and an unintended egress.
const DEFAULT_TELEMETRY_OTLP = Object.freeze({
  enabled: false,
  endpoint: null,
  headers: {},
  service_name: 'nubos-pilot',
  timeout_ms: 10000,
});

const DEFAULT_TELEMETRY = Object.freeze({
  otlp: DEFAULT_TELEMETRY_OTLP,
});

// ADR-0029. `direct` is the default because it is the status quo — nubos-pilot
// installs into a host CLI and inherits its permissions — not because it is safe.
// The tier is named `direct` rather than `none` so it cannot be read as "no
// isolation needed".
const DEFAULT_ISOLATION_CONTAINER = Object.freeze({
  image: 'node:22-bookworm-slim',
  network: 'none',
  user: null,
  memory: null,
  cpus: null,
  mounts: Object.freeze([]),
});

const DEFAULT_ISOLATION = Object.freeze({
  tier: 'direct',
  container: DEFAULT_ISOLATION_CONTAINER,
});

const DEFAULT_CONFIG_TREE = Object.freeze({
  scope: DEFAULT_SCOPE,
  model_profile: DEFAULT_MODEL_PROFILE,
  response_language: DEFAULT_RESPONSE_LANGUAGE,
  workflow: DEFAULT_WORKFLOW,
  agents: DEFAULT_AGENTS,
  loop: DEFAULT_LOOP,
  memory: DEFAULT_MEMORY,
  swarm: DEFAULT_SWARM,
  spawn: DEFAULT_SPAWN,
  compression: DEFAULT_COMPRESSION,
  security: DEFAULT_SECURITY,
  conformance: DEFAULT_CONFORMANCE,
  plan_lint: DEFAULT_PLAN_LINT,
  learnings: DEFAULT_LEARNINGS,
  telemetry: DEFAULT_TELEMETRY,
  isolation: DEFAULT_ISOLATION,
  auto_log_learning: DEFAULT_AUTO_LOG_LEARNING,
});

function buildInstallConfig(answers) {
  const a = answers || {};
  const workflowOverride = { ...DEFAULT_WORKFLOW, research_tools: { ...DEFAULT_RESEARCH_TOOLS } };
  if (typeof a.commit_artifacts === 'boolean') {
    workflowOverride.commit_artifacts = a.commit_artifacts;
  }
  return {
    runtime: a.runtime || null,
    runtimes: Array.isArray(a.runtimes) ? a.runtimes.slice() : (a.runtime ? [a.runtime] : []),
    scope: a.scope || DEFAULT_SCOPE,
    model_profile: a.model_profile || DEFAULT_MODEL_PROFILE,
    response_language: a.response_language || DEFAULT_RESPONSE_LANGUAGE,
    workflow: workflowOverride,
    agents: { ...DEFAULT_AGENTS, economy: INSTALL_ECONOMY_MODE },
    loop: { ...DEFAULT_LOOP },
    swarm: {
      research: { ...DEFAULT_SWARM_RESEARCH },
      critic: { ...DEFAULT_SWARM_CRITIC },
      knowledge_adapter: DEFAULT_SWARM.knowledge_adapter,
    },
    spawn: {
      headless: {
        enabled: DEFAULT_SPAWN_HEADLESS.enabled,
        agents: [...DEFAULT_SPAWN_HEADLESS.agents],
        timeout_ms: DEFAULT_SPAWN_HEADLESS.timeout_ms,
        fallback_on_error: DEFAULT_SPAWN_HEADLESS.fallback_on_error,
      },
    },
    security: { ...DEFAULT_SECURITY },
    conformance: { ...DEFAULT_CONFORMANCE },
    plan_lint: { verify_allow_commands: [...DEFAULT_PLAN_LINT.verify_allow_commands] },
    learnings: { ...DEFAULT_LEARNINGS },
    auto_log_learning: DEFAULT_AUTO_LOG_LEARNING,
  };
}

module.exports = {
  DEFAULT_WORKFLOW,
  DEFAULT_RESEARCH_TOOLS,
  DEFAULT_AGENTS,
  DEFAULT_LOOP,
  DEFAULT_MEMORY,
  DEFAULT_SWARM,
  DEFAULT_SWARM_RESEARCH,
  DEFAULT_SWARM_CRITIC,
  DEFAULT_SPAWN,
  DEFAULT_SPAWN_HEADLESS,
  DEFAULT_COMPRESSION,
  DEFAULT_COMPRESSION_ELISION,
  DEFAULT_COMPRESSION_PROXY,
  DEFAULT_COMPRESSION_OUTPUT_STEERING,
  DEFAULT_COMPRESSION_CACHE_ALIGN,
  DEFAULT_SECURITY,
  DEFAULT_CONFORMANCE,
  DEFAULT_PLAN_LINT,
  DEFAULT_LEARNINGS,
  DEFAULT_AUTO_LOG_LEARNING,
  DEFAULT_MODEL_PROFILE,
  DEFAULT_SCOPE,
  DEFAULT_RESPONSE_LANGUAGE,
  INSTALL_ECONOMY_MODE,
  DEFAULT_CONFIG_TREE,
  buildInstallConfig,
};
