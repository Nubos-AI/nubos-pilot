'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const schema = require('./config-schema.cjs');
const { validateConfig, mergeNewDefaults, VALID_MODEL_PROFILES } = schema;

test('CS-1 known top-level keys produce zero warnings', () => {
  const w = validateConfig({
    scope: 'local',
    model_profile: 'balanced',
    response_language: 'de',
    auto_log_learning: true,
    workflow: { commit_docs: true, commit_artifacts: false },
    agents: { parallelization: true },
    loop: { maxRounds: 5 },
  });
  assert.deepEqual(w, []);
});

test('CS-MEM-1 the ADR-0014 memory block validates clean', () => {
  // The whole point: a user who follows ADR-0014 and turns the memory layer on
  // must not be told their config key is unknown. The code has always honoured
  // memory.enabled/model/alpha; only the schema did not know about them.
  assert.deepEqual(validateConfig({ memory: { enabled: true } }), []);
  assert.deepEqual(
    validateConfig({ memory: { enabled: true, model: 'Xenova/bge-base-en-v1.5', alpha: 0.4 } }),
    [],
  );
});

test('CS-MEM-2 memory.model enum stays in parity with the provider whitelist', () => {
  const { KNOWN_DIMS } = require('./memory-provider-local.cjs');
  const w = validateConfig({ memory: { model: 'evil/model' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'memory.model');
  assert.deepEqual(w[0].allowed, Object.keys(KNOWN_DIMS));
  for (const model of Object.keys(KNOWN_DIMS)) {
    assert.deepEqual(validateConfig({ memory: { model } }), [], `${model} must validate`);
  }
});

test('CS-MEM-3 memory defaults mirror the resolver fallbacks', () => {
  // Asserting the literals a second time would only prove that this file agrees
  // with itself: the defaults could drift away from the values the resolver
  // actually falls back to and stay green. So read the fallbacks out of the
  // call sites and compare against those.
  const fs = require('node:fs');
  const path = require('node:path');
  const { DEFAULT_MEMORY, DEFAULT_CONFIG_TREE } = require('./config-defaults.cjs');

  const fallbackOf = (src, key) => {
    const m = new RegExp(
      `tryReadConfigPath\\([^,]+,\\s*'memory\\.${key}',\\s*([^)]+)\\)`,
    ).exec(src);
    assert.ok(m, `no memory.${key} fallback found — did the call site move?`);
    return m[1].trim().replace(/^'|'$/g, '');
  };

  const resolver = fs.readFileSync(
    path.join(__dirname, '..', 'bin', 'np-tools', '_memory-resolve.cjs'), 'utf-8',
  );
  assert.equal(String(DEFAULT_MEMORY.enabled), fallbackOf(resolver, 'enabled'));
  assert.equal(DEFAULT_MEMORY.model, fallbackOf(resolver, 'model'));
  assert.equal(String(DEFAULT_MEMORY.alpha), fallbackOf(resolver, 'alpha'));

  // knowledge-adapter.cjs keeps a third copy of alpha as DEFAULT_HYBRID_ALPHA.
  const { DEFAULT_HYBRID_ALPHA } = require('./knowledge-adapter.cjs');
  assert.equal(DEFAULT_MEMORY.alpha, DEFAULT_HYBRID_ALPHA);

  assert.equal(DEFAULT_CONFIG_TREE.memory, DEFAULT_MEMORY);
  assert.deepEqual(validateConfig({ memory: DEFAULT_MEMORY }), []);
});

test('CS-RTS-1 runtime_source accepts every value install.js can actually write', () => {
  // install.js copies `source` straight out of lib/install/runtime-detect.cjs,
  // which yields path/disk/default — NOT the config/env/default of
  // lib/runtime/index.cjs::detect. Deriving the enum from the reader alone made
  // a fresh install on a machine with `claude` on $PATH warn about a key
  // nubos-pilot had just written itself.
  for (const source of ['flag', 'asked', 'path', 'disk', 'config', 'env', 'default']) {
    assert.deepEqual(
      validateConfig({ runtime: 'claude', runtime_source: source }),
      [],
      `install.js/runtime-detect can write runtime_source=${source}`,
    );
  }
  const w = validateConfig({ runtime_source: 'not-a-source' });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
});

test('CS-SYNC-2 every config path the code reads is declared in SCHEMA', () => {
  // The reverse of SCHEMA-SYNC-1. That test walks DEFAULT_CONFIG_TREE -> SCHEMA,
  // so a key that is read by the code but present in neither slips through both.
  // That is exactly how `memory.*` (honoured by _memory-resolve.cjs since
  // ADR-0014) and `runtime_source` (written by install.js itself) came to warn
  // as unknown-key. Source of truth here is the call site, not a hand list.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');

  const walk = (dir, out = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, out);
      else if (/\.(cjs|js)$/.test(ent.name) && !/\.test\.cjs$/.test(ent.name)) out.push(p);
    }
    return out;
  };

  // Accept any first argument (`cwd`, `cwd || process.cwd()`, `o.cwd`) and any
  // quote style. A first version only matched a bare identifier + single quotes
  // and silently skipped a third of the call sites.
  const READ = /(?:try)?[rR]eadConfigPath\(\s*[^,]+,\s*['"`]([^'"`]+)['"`]/g;
  const ANY_CALL = /(?:try)?[rR]eadConfigPath\(/g;
  // Call sites whose path is not a literal at the call site, so this guard cannot
  // see them. Pinned per file: a new dynamic read makes this test fail rather
  // than quietly widening the blind spot. All current entries resolve to paths
  // that ARE declared:
  //   lib/config.cjs            — the definitions plus an internal delegate
  //   plan-lint.cjs             — reads via the ALLOW_COMMANDS_KEY constant
  //   loop-run-round.cjs        — _nextEnabled() is table-driven; the literals
  //                               ('agents.architect', 'agents.test_writer') sit
  //                               in the caller's table, not at the read
  //   worktree.cjs              — reads `'workflow.' + CONFIG_FLAG`; the quoted
  //                               part is only a prefix, not the path
  const KNOWN_NON_LITERAL = {
    'lib/config.cjs': 3,
    'lib/worktree.cjs': 1,
    'bin/np-tools/loop-run-round.cjs': 1,
    'bin/np-tools/plan-lint.cjs': 1,
  };

  // A quoted fragment that is not a whole dotted path (`'workflow.' + FLAG`) must
  // count as unseen, not as a path — otherwise the guard reports the fragment as
  // an undeclared key and the real read stays unchecked either way.
  const isWholePath = (s) => /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(s);

  const paths = new Set();
  const unseen = {};
  for (const file of [...walk(path.join(root, 'lib')), ...walk(path.join(root, 'bin'))]) {
    const src = fs.readFileSync(file, 'utf-8');
    let m;
    READ.lastIndex = 0;
    let resolved = 0;
    while ((m = READ.exec(src)) !== null) {
      if (!isWholePath(m[1])) continue;
      paths.add(m[1]);
      resolved++;
    }
    const total = (src.match(ANY_CALL) || []).length;
    if (total > resolved) unseen[path.relative(root, file)] = total - resolved;
  }

  assert.deepEqual(
    unseen,
    KNOWN_NON_LITERAL,
    'config reads this guard cannot see changed — make the path a literal at the call site, or pin it here with a reason',
  );
  assert.ok(paths.size > 0, 'expected to find config reads to check');

  // A read path resolves against SCHEMA if each segment exists; `shape: 'any'`
  // subtrees (model_providers, agent_routing, ...) accept anything below them.
  const resolves = (dotted) => {
    let node = { shape: schema.SCHEMA };
    for (const seg of dotted.split('.')) {
      if (!node || node.shape === 'any') return true;
      const shape = node.shape;
      if (!shape || !Object.prototype.hasOwnProperty.call(shape, seg)) return false;
      node = shape[seg];
    }
    return true;
  };

  const undeclared = [...paths].filter((p) => !resolves(p)).sort();
  assert.deepEqual(undeclared, [], `config paths read but not declared in SCHEMA: ${undeclared.join(', ')}`);
});

test('CS-2 unknown top-level key flagged', () => {
  const w = validateConfig({ commit_artifacttt: true });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'commit_artifacttt');
});

test('CS-3 unknown nested key flagged with dotted path', () => {
  const w = validateConfig({ workflow: { commit_artifact: true } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'workflow.commit_artifact');
});

test('CS-4 invalid enum value (model_profile) flagged', () => {
  const w = validateConfig({ model_profile: 'premium' });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'model_profile');
  assert.deepEqual(w[0].allowed, VALID_MODEL_PROFILES);
});

test('CS-5 unsupported knowledge_adapter (pinecone) flagged as invalid-enum', () => {
  const w = validateConfig({ swarm: { knowledge_adapter: 'pinecone' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'swarm.knowledge_adapter');
});

test('CS-6 invalid tier for critic flagged', () => {
  const w = validateConfig({ swarm: { critic: { style_tier: 'gold' } } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-enum');
  assert.equal(w[0].path, 'swarm.critic.style_tier');
});

test('CS-7 invalid type for boolean field flagged', () => {
  const w = validateConfig({ agents: { parallelization: 'yes' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-type');
  assert.equal(w[0].path, 'agents.parallelization');
  assert.equal(w[0].expected, 'boolean');
  assert.equal(w[0].actual, 'string');
});

test('CS-8 typo in swarm.* flagged at correct depth', () => {
  const w = validateConfig({ swarm: { research: { kk: 5 } } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'swarm.research.kk');
});

test('CS-9 multiple warnings collected, not short-circuited', () => {
  const w = validateConfig({
    model_profile: 'premium',
    workflow: { commit_artifact: true },
    swarm: { knowledge_adapter: 'pinecone' },
  });
  assert.equal(w.length, 3);
  const kinds = w.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['invalid-enum', 'invalid-enum', 'unknown-key']);
});

test('CS-10 null/empty config returns no warnings (graceful)', () => {
  assert.deepEqual(validateConfig(null), []);
  assert.deepEqual(validateConfig(undefined), []);
  assert.deepEqual(validateConfig({}), []);
});

test('MERGE-1 mergeNewDefaults adds missing keys without overwriting user values', () => {
  const existing = { workflow: { commit_artifacts: false } };
  const defaults = {
    scope: 'local',
    workflow: { commit_docs: true, commit_artifacts: true },
    loop: { maxRounds: 3 },
  };
  const merged = mergeNewDefaults(existing, defaults);
  assert.equal(merged.workflow.commit_artifacts, false, 'user value preserved');
  assert.equal(merged.workflow.commit_docs, true, 'new key filled from default');
  assert.equal(merged.scope, 'local', 'top-level new key filled');
  assert.equal(merged.loop.maxRounds, 3, 'nested new tree filled');
});

test('MERGE-2 mergeNewDefaults strips prototype-pollution keys', () => {
  const poisoned = JSON.parse('{"__proto__":{"polluted":true},"foo":1}');
  const merged = mergeNewDefaults({}, poisoned);
  assert.equal(merged.foo, 1);
  assert.equal(({}).polluted, undefined);
});

test('MERGE-3 mergeNewDefaults handles null/undefined existing', () => {
  const defaults = { a: 1, b: { c: 2 } };
  assert.deepEqual(mergeNewDefaults(null, defaults), { a: 1, b: { c: 2 } });
  assert.deepEqual(mergeNewDefaults(undefined, defaults), { a: 1, b: { c: 2 } });
});

test('MERGE-4 mergeNewDefaults replaces a null user value with the default tree', () => {
  // user wrote `workflow: null` (typo, copy/paste, partial migration) — the
  // re-install merge must heal that, not preserve null, otherwise readConfig
  // hits invalid-type warnings on every call and downstream readConfigPath
  // falls back silently. Memory `feedback_nubos_pilot_fix_doctrines.md`
  // — "Config-Reader sind LOUD" — bedeutet auch silent-null muss aufgelöst werden.
  const merged = mergeNewDefaults(
    { workflow: null, scope: 'local' },
    { workflow: { commit_docs: true, commit_artifacts: true }, scope: 'local' },
  );
  assert.deepEqual(merged.workflow, { commit_docs: true, commit_artifacts: true });
  assert.equal(merged.scope, 'local');
});

test('CS-PL-1 valid plan_lint block produces zero warnings', () => {
  assert.deepEqual(validateConfig({ plan_lint: { verify_allow_commands: ['just', 'bazel'] } }), []);
  assert.deepEqual(validateConfig({ plan_lint: { verify_allow_commands: [] } }), []);
});

test('CS-PL-2 unknown plan_lint sub-key flagged (no silent typo)', () => {
  const w = validateConfig({ plan_lint: { verify_allow_command: ['just'] } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'plan_lint.verify_allow_command');
});

test('CS-PL-3 verify_allow_commands must be an array of strings', () => {
  const wType = validateConfig({ plan_lint: { verify_allow_commands: 'just' } });
  assert.equal(wType.length, 1);
  assert.equal(wType[0].kind, 'invalid-type');
  assert.equal(wType[0].path, 'plan_lint.verify_allow_commands');
  assert.equal(wType[0].expected, 'array');

  const wEl = validateConfig({ plan_lint: { verify_allow_commands: ['just', 7] } });
  assert.equal(wEl.length, 1);
  assert.equal(wEl[0].kind, 'invalid-array-element');
  assert.equal(wEl[0].path, 'plan_lint.verify_allow_commands[1]');
});

test('SCHEMA-SYNC-1 every top-level key in DEFAULT_CONFIG_TREE has a SCHEMA entry', () => {
  // Drift-Sperre (CW1-2): wer einen Default zufügt MUSS auch SCHEMA pflegen.
  const defaults = require('./config-defaults.cjs');
  const { SCHEMA: liveSchema, SCHEMA_ONLY_KEYS } = require('./config-schema.cjs');
  for (const key of Object.keys(defaults.DEFAULT_CONFIG_TREE)) {
    assert.ok(liveSchema[key], 'DEFAULT_CONFIG_TREE.' + key + ' has no SCHEMA entry');
  }
  // Reverse: every SCHEMA top-level key is either in DEFAULT_CONFIG_TREE or
  // in the schema-only allowlist (vars like runtime/runtimes/agent_skills
  // that exist only on disk, not as a default).
  for (const key of Object.keys(liveSchema)) {
    const inDefaults = Object.prototype.hasOwnProperty.call(defaults.DEFAULT_CONFIG_TREE, key);
    const inAllowlist = SCHEMA_ONLY_KEYS.includes(key);
    assert.ok(inDefaults || inAllowlist,
      'SCHEMA.' + key + ' is neither in DEFAULT_CONFIG_TREE nor SCHEMA_ONLY_KEYS — drift');
  }
});

test('SEC-CFG-1 valid security block produces zero warnings', () => {
  const w = validateConfig({
    security: {
      enabled: true,
      scan_on_write: true,
      review_on_stop: false,
      review_on_commit: true,
      custom_rules_path: '.nubos-pilot/security-rules.json',
      guidance_path: null,
      review_timeout_ms: 120000,
      max_stop_reviews_in_a_row: 3,
      max_commit_reviews_per_hour: 20,
      max_files_per_review: 30,
    },
  });
  assert.deepEqual(w, []);
});

test('SEC-CFG-2 wrong type in security flags is flagged', () => {
  const w = validateConfig({ security: { enabled: 'yes', max_files_per_review: 'lots' } });
  assert.equal(w.length, 2);
  assert.ok(w.every((x) => x.kind === 'invalid-type'));
});

test('SEC-CFG-3 unknown security sub-key is flagged', () => {
  const w = validateConfig({ security: { scan_everywhere: true } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
  assert.equal(w[0].path, 'security.scan_everywhere');
});

test('SEC-CFG-4 default security tree validates clean', () => {
  const defaults = require('./config-defaults.cjs');
  assert.deepEqual(validateConfig({ security: defaults.DEFAULT_SECURITY }), []);
});

test('CONF-CFG-1 valid conformance block produces zero warnings', () => {
  assert.deepEqual(validateConfig({ conformance: { inject_criteria: true } }), []);
});

test('CONF-CFG-2 wrong type in conformance.inject_criteria is flagged', () => {
  const w = validateConfig({ conformance: { inject_criteria: 'yes' } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'invalid-type');
  assert.equal(w[0].path, 'conformance.inject_criteria');
});

test('CONF-CFG-3 unknown conformance sub-key is flagged', () => {
  const w = validateConfig({ conformance: { review_on_executor_stop: true } });
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'unknown-key');
});

test('CONF-CFG-4 default conformance tree validates clean', () => {
  const defaults = require('./config-defaults.cjs');
  assert.deepEqual(validateConfig({ conformance: defaults.DEFAULT_CONFORMANCE }), []);
});

test('CS-SCAN-1 every default scan key is covered by the schema', () => {
  const { DEFAULT_CONFIG_TREE } = require('./config-defaults.cjs');
  const shape = schema.SCHEMA.security.shape.scan.shape;
  for (const key of Object.keys(DEFAULT_CONFIG_TREE.security.scan)) {
    assert.ok(shape[key], 'security.scan.' + key + ' has no schema entry — drift');
  }
  for (const key of Object.keys(shape)) {
    assert.ok(key in DEFAULT_CONFIG_TREE.security.scan, 'schema key security.scan.' + key + ' has no default — drift');
  }
});

test('CS-SCAN-2 the whole default scan block validates clean', () => {
  const { DEFAULT_CONFIG_TREE } = require('./config-defaults.cjs');
  assert.deepEqual(validateConfig({ security: { scan: DEFAULT_CONFIG_TREE.security.scan } }), []);
});

test('CS-SCAN-3 min_severity and fail_on reject out-of-vocabulary values', () => {
  assert.equal(validateConfig({ security: { scan: { min_severity: 'high' } } }).length, 0);
  assert.ok(validateConfig({ security: { scan: { min_severity: 'catastrophic' } } }).length > 0);
  assert.equal(validateConfig({ security: { scan: { fail_on: 'critical' } } }).length, 0);
  assert.ok(validateConfig({ security: { scan: { fail_on: 'sometimes' } } }).length > 0);
});

test('CS-SCAN-4 ignore_scopes must be an array of strings', () => {
  assert.equal(validateConfig({ security: { scan: { ignore_scopes: ['dev', 'optional'] } } }).length, 0);
  assert.ok(validateConfig({ security: { scan: { ignore_scopes: 'dev' } } }).length > 0);
  assert.ok(validateConfig({ security: { scan: { ignore_scopes: [1, 2] } } }).length > 0);
});

test('CS-SCAN-5 an unknown scan key is reported', () => {
  const w = validateConfig({ security: { scan: { scan_everything: true } } });
  assert.ok(w.length > 0);
  assert.equal(w[0].path, 'security.scan.scan_everything');
});
