'use strict';

// Single source of truth for the Economy axis activation level (Ponytail-style
// graduated modes). The Economy schicht has two mechanisms — the prevention
// ladder in agents/np-executor.md (guidance BEFORE writing) and the in-loop
// Economy critic (agents/np-critic-economy.md, audits the diff AFTER). One
// enum dials both:
//
//   off    prevention OFF, critic OFF  — no economy pressure at all
//   lite   prevention ON,  critic OFF  — prevention-first DEFAULT (advisory only)
//   full   prevention ON,  critic ON   — standard critic rubric
//   ultra  prevention ON,  critic ON   — aggressive critic (lowered shrinkable bar)
//
// Default is `lite`: the climb-the-ladder discipline is on, but nothing bounces
// work back. This makes prevention-first the documented default philosophy
// while keeping the costlier critic opt-in (full/ultra).
//
// Backward-compat: the legacy boolean `agents.economy_critic` is honoured when
// `agents.economy` is absent — true→full, false→lite — so a pre-existing
// gitignored config keeps its behaviour. The resolver is LOUD: an explicit but
// invalid `agents.economy` string throws rather than silently defaulting.

const { NubosPilotError } = require('./core.cjs');

const VALID_ECONOMY_MODES = Object.freeze(['off', 'lite', 'full', 'ultra']);
const DEFAULT_ECONOMY_MODE = 'lite';

function resolveEconomyMode(config) {
  const agents = config && typeof config === 'object' ? config.agents : null;
  if (agents && typeof agents === 'object') {
    if (agents.economy !== undefined) {
      const explicit = agents.economy;
      if (typeof explicit !== 'string' || !VALID_ECONOMY_MODES.includes(explicit)) {
        throw new NubosPilotError(
          'config-invalid-economy-mode',
          'agents.economy must be one of ' + VALID_ECONOMY_MODES.join('|') + ' (got: ' + JSON.stringify(explicit) + ')',
          { value: explicit, valid: VALID_ECONOMY_MODES },
        );
      }
      return explicit;
    }
    if (typeof agents.economy_critic === 'boolean') {
      return agents.economy_critic ? 'full' : 'lite';
    }
  }
  return DEFAULT_ECONOMY_MODE;
}

function preventionOn(mode) { return mode !== 'off'; }
function criticOn(mode) { return mode === 'full' || mode === 'ultra'; }
function isUltra(mode) { return mode === 'ultra'; }

function economyFlags(config) {
  const mode = resolveEconomyMode(config);
  return { mode, prevention: preventionOn(mode), critic: criticOn(mode), ultra: isUltra(mode) };
}

module.exports = {
  VALID_ECONOMY_MODES,
  DEFAULT_ECONOMY_MODE,
  resolveEconomyMode,
  preventionOn,
  criticOn,
  isUltra,
  economyFlags,
};
