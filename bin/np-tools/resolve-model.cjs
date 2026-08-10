const { NubosPilotError } = require('../../lib/core.cjs');
const { readConfig, _CONFIG_PARSE_CODES } = require('../../lib/config.cjs');
const { loadAgent, loadAgentModule } = require('../../lib/agents.cjs');
const { resolve: resolveAlias, MODEL_ALIAS_MAP, VALID_TIERS } = require('../../lib/model-profiles.cjs');
const { resolveProvider } = require('../../lib/model-providers.cjs');

let _warnedCorruptOnce = false;
function _readConfig(cwd) {
  try {
    return readConfig(cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') return {};
    if (err && _CONFIG_PARSE_CODES.has(err.code)) {
      if (!_warnedCorruptOnce) {
        _warnedCorruptOnce = true;
        try {
          process.stderr.write(
            'nubos-pilot resolve-model: config.json unusable (' + err.code
            + ') — using built-in defaults. Run `np-tools doctor` to repair.\n',
          );
        } catch {}
      }
      return {};
    }
    throw err;
  }
}
function _resetCorruptWarnedForTests() { _warnedCorruptOnce = false; }

const CRITIC_TIER_OVERRIDES = {
  'np-critic':             'tier',
  'np-critic-style':       'style_tier',
  'np-critic-tests':       'tests_tier',
  'np-critic-acceptance':  'acceptance_tier',
  'np-critic-economy':     'economy_tier',
};

function _criticTierOverride(config, agentName) {
  const key = CRITIC_TIER_OVERRIDES[agentName];
  if (!key) return null;
  const override = config && config.swarm && config.swarm.critic && config.swarm.critic[key];
  if (typeof override !== 'string') return null;
  return VALID_TIERS.includes(override) ? override : null;
}

function _loadAgentForResolve(name, cwd) {
  try {
    return loadAgent(name, cwd);
  } catch (err) {
    if (err && err.code === 'agent-not-spawnable') {
      return loadAgentModule(name, cwd);
    }
    throw err;
  }
}

function resolveFromConfig({ agentOrTier, profileOverride, cwd, format }) {
  const config = _readConfig(cwd);

  let tier;
  let agentName = null;
  if (VALID_TIERS.includes(agentOrTier)) {
    tier = agentOrTier;
  } else {
    const fm = _loadAgentForResolve(agentOrTier, cwd);
    tier = fm.tier;
    agentName = agentOrTier;
    const override = _criticTierOverride(config, agentOrTier);
    if (override) tier = override;
  }

  const profile = profileOverride || config.model_profile || 'balanced';
  const alias = resolveAlias(tier, profile);

  let mode;
  if (profile === 'inherit') {
    mode = 'inherit';
  } else if (format === 'omit' || config.resolve_model_ids === 'omit') {
    mode = 'omit';
  } else if (format === 'id' || config.resolve_model_ids === true) {
    mode = 'full-id';
  } else {
    mode = 'alias';
  }

  let resolved;
  if (mode === 'omit' || mode === 'inherit') {
    resolved = '';
  } else if (mode === 'full-id') {
    const override = config.model_overrides
      && config.model_overrides.tier_map
      && config.model_overrides.tier_map[alias];
    resolved = override || MODEL_ALIAS_MAP[alias] || '';
  } else {
    resolved = alias;
  }

  const prov = resolveProvider({ agentName, tier, config });
  let providerModel = prov.model;
  if (prov.kind === 'native') {
    if (prov.model) {
      resolved = prov.model;
      mode = 'full-id';
    } else {
      providerModel = null;
    }
  } else {
    resolved = prov.model;
    mode = 'provider';
  }

  return {
    tier,
    profile,
    alias,
    resolved,
    mode,
    provider: prov.provider,
    kind: prov.kind,
    model: providerModel,
    baseUrl: prov.baseUrl,
    apiKeyEnv: prov.apiKeyEnv,
  };
}

function run(argv) {
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(3);
  if (args.length === 0 || args[0] === '--help') {
    process.stderr.write(
      'Usage: np-tools.cjs resolve-model <agent|tier> [--profile P] [--raw] [--format alias|id|omit]\n',
    );
    return 1;
  }
  const agentOrTier = args.shift();
  let profileOverride = null;
  let format = null;
  let asJson = false;
  let asKind = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--profile') {
      profileOverride = args.shift();
    } else if (flag === '--format') {
      format = args.shift();
    } else if (flag === '--json') {
      asJson = true;
    } else if (flag === '--kind') {
      asKind = true;
    } else if (flag === '--raw') {

    }
  }
  try {
    const out = resolveFromConfig({
      agentOrTier,
      profileOverride,
      cwd: process.cwd(),
      format,
    });
    if (asKind) {
      process.stdout.write((out.kind || 'native') + '\n');
      return 0;
    }
    if (asJson) {
      process.stdout.write(JSON.stringify(out) + '\n');
      return 0;
    }
    if (out.kind === 'openai-compat') {
      process.stderr.write(
        JSON.stringify({
          code: 'off-host-not-on-native-path',
          message: 'agent "' + agentOrTier + '" routes to provider "' + out.provider
            + '" (model ' + out.model + '), which the native `claude` spawn path cannot run. '
            + 'Run it off-host with: np-tools spawn-offhost --agent ' + agentOrTier + ' --task <…>',
          details: { provider: out.provider, kind: out.kind, model: out.model },
        }) + '\n',
      );
      return 1;
    }
    process.stdout.write(out.resolved + '\n');
    return 0;
  } catch (err) {
    if (err && err.name === 'NubosPilotError') {
      process.stderr.write(
        JSON.stringify({ code: err.code, message: err.message, details: err.details }) + '\n',
      );
    } else {
      process.stderr.write(String((err && err.stack) || err) + '\n');
    }
    return 1;
  }
}

module.exports = { run, resolveFromConfig, _resetCorruptWarnedForTests };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
