const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot, NubosPilotError } = require('../../lib/core.cjs');
const { loadAgent } = require('../../lib/agents.cjs');
const { resolve: resolveAlias, MODEL_ALIAS_MAP, VALID_TIERS } = require('../../lib/model-profiles.cjs');

function _readConfig(cwd) {
  let root;
  try {
    root = findProjectRoot(cwd || process.cwd());
  } catch {
    return {};
  }
  const configPath = path.join(root, '.nubos-pilot', 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveFromConfig({ agentOrTier, profileOverride, cwd, format }) {
  const config = _readConfig(cwd);

  let tier;
  if (VALID_TIERS.includes(agentOrTier)) {
    tier = agentOrTier;
  } else {
    const fm = loadAgent(agentOrTier, cwd);
    tier = fm.tier;
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

  return { tier, profile, alias, resolved, mode };
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
  while (args.length) {
    const flag = args.shift();
    if (flag === '--profile') {
      profileOverride = args.shift();
    } else if (flag === '--format') {
      format = args.shift();
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

module.exports = { run, resolveFromConfig };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
