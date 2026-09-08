'use strict';

const { NubosPilotError } = require('./core.cjs');

const VALID_PROVIDER_KINDS = Object.freeze(['native', 'openai-compat']);
const DEFAULT_PROVIDER = 'claude';

function matchRouting(agentName, routing) {
  if (!agentName || !routing || typeof routing !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(routing, agentName)) {
    return { key: agentName, entry: routing[agentName], match: 'exact' };
  }
  let best = null;
  for (const key of Object.keys(routing)) {
    if (key.length > 1 && key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      if (agentName.startsWith(prefix) && (!best || prefix.length > best.prefixLen)) {
        best = { key, entry: routing[key], match: 'glob', prefixLen: prefix.length };
      }
    }
  }
  return best ? { key: best.key, entry: best.entry, match: 'glob' } : null;
}

function resolveProvider({ agentName, tier, config }) {
  const cfg = config || {};
  const providers = cfg.model_providers;
  const routing = cfg.agent_routing;

  const matched = matchRouting(agentName || null, routing);

  let providerName;
  let pinnedModel = null;
  let source;
  if (matched) {
    const entry = matched.entry;
    if (!entry || typeof entry !== 'object') {
      throw new NubosPilotError(
        'agent-routing-invalid-entry',
        'agent_routing["' + matched.key + '"] must be an object with a "provider" field',
        { key: matched.key },
      );
    }
    providerName = entry.provider;
    if (typeof providerName !== 'string' || !providerName) {
      throw new NubosPilotError(
        'agent-routing-missing-provider',
        'agent_routing["' + matched.key + '"] has no "provider" field',
        { key: matched.key },
      );
    }
    if (typeof entry.model === 'string' && entry.model) pinnedModel = entry.model;
    source = 'agent_routing["' + matched.key + '"]';
  } else if (providers && typeof providers.default === 'string' && providers.default) {
    providerName = providers.default;
    source = 'model_providers.default';
  } else {
    providerName = DEFAULT_PROVIDER;
    source = 'default';
  }

  let def;
  if (providerName === DEFAULT_PROVIDER && (!providers || !providers[DEFAULT_PROVIDER])) {
    def = { kind: 'native' };
  } else if (providers && typeof providers === 'object' && providers[providerName]
             && typeof providers[providerName] === 'object') {
    def = providers[providerName];
  } else {
    throw new NubosPilotError(
      'provider-undefined',
      source + ' references provider "' + providerName
        + '", but model_providers.' + providerName + ' is not defined',
      { provider: providerName, source },
    );
  }

  const kind = def.kind || 'native';
  if (!VALID_PROVIDER_KINDS.includes(kind)) {
    throw new NubosPilotError(
      'provider-invalid-kind',
      'model_providers.' + providerName + '.kind must be one of ' + VALID_PROVIDER_KINDS.join('/'),
      { provider: providerName, got: kind, allowed: VALID_PROVIDER_KINDS.slice() },
    );
  }

  let model = null;
  if (kind === 'native') {
    model = pinnedModel || null;
  } else if (pinnedModel) {
    model = pinnedModel;
  } else if (def.models && typeof def.models === 'object' && typeof def.models[tier] === 'string' && def.models[tier]) {
    model = def.models[tier];
  } else {
    throw new NubosPilotError(
      'provider-model-unresolved',
      'cannot resolve a model for provider "' + providerName + '" at tier "' + tier
        + '": no pinned model in agent_routing and no model_providers.' + providerName + '.models.' + tier,
      { provider: providerName, tier },
    );
  }

  return {
    provider: providerName,
    kind,
    model,
    baseUrl: (typeof def.base_url === 'string' && def.base_url) ? def.base_url : null,
    apiKeyEnv: (typeof def.api_key_env === 'string' && def.api_key_env) ? def.api_key_env : null,
    routed: !!matched,
    source,
  };
}

module.exports = {
  matchRouting,
  resolveProvider,
  VALID_PROVIDER_KINDS,
  DEFAULT_PROVIDER,
};
