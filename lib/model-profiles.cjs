const { NubosPilotError } = require('./core.cjs');

const TIER_PROFILE_MATRIX = {
  opus:   { quality: 'opus',   balanced: 'opus',   budget: 'sonnet', inherit: '' },
  sonnet: { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku',  inherit: '' },
  haiku:  { quality: 'sonnet', balanced: 'haiku',  budget: 'haiku',  inherit: '' },
};

const MODEL_ALIAS_MAP = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5',
};

const VALID_TIERS = ['haiku', 'sonnet', 'opus'];
const VALID_PROFILES = ['quality', 'balanced', 'budget', 'inherit'];

function resolve(tier, profile) {
  if (!VALID_TIERS.includes(tier)) {
    throw new NubosPilotError(
      'invalid-tier',
      'tier must be one of ' + VALID_TIERS.join('/'),
      { got: tier, allowed: VALID_TIERS.slice() },
    );
  }
  if (!VALID_PROFILES.includes(profile)) {
    throw new NubosPilotError(
      'invalid-profile',
      'profile must be one of ' + VALID_PROFILES.join('/'),
      { got: profile, allowed: VALID_PROFILES.slice() },
    );
  }
  return TIER_PROFILE_MATRIX[tier][profile];
}

module.exports = {
  TIER_PROFILE_MATRIX,
  MODEL_ALIAS_MAP,
  VALID_TIERS,
  VALID_PROFILES,
  resolve,
};
