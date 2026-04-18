'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { computeNextStep: realComputeNextStep } = require('../../lib/next.cjs');
const { askUser: defaultAskUser } = require('../../lib/askuser.cjs');

const VALID_ACTIONS = new Set(['discuss', 'plan', 'execute', 'verify']);

function _parseArgs(args) {
  const list = Array.isArray(args) ? args : [];
  let phase = null;
  let force = false;
  let actionOverride = null;
  for (const a of list) {
    if (a === '--force') { force = true; continue; }
    if (typeof a === 'string' && a.startsWith('--action=')) {
      actionOverride = a.slice('--action='.length);
      continue;
    }
    if (phase == null && typeof a === 'string' && !a.startsWith('--')) {
      phase = a;
    }
  }
  return { phase, force, actionOverride };
}

function _normalize(result) {
  if (!result || typeof result !== 'object') {
    return { nextAction: null, ambiguous: false, alternatives: [] };
  }
  if (typeof result.nextAction === 'string') {
    return {
      nextAction: result.nextAction,
      ambiguous: Boolean(result.ambiguous),
      alternatives: Array.isArray(result.alternatives) ? result.alternatives : [],
      reasoning: result.reasoning,
    };
  }

  const cmd = result.next_step && result.next_step.command;
  let action = null;
  if (typeof cmd === 'string') {
    const m = cmd.match(/\/np:([a-z-]+)/);
    if (m) {
      const verb = m[1];
      if (verb.startsWith('discuss')) action = 'discuss';
      else if (verb.startsWith('plan')) action = 'plan';
      else if (verb.startsWith('execute')) action = 'execute';
      else if (verb.startsWith('verify')) action = 'verify';
    }
  }
  return {
    nextAction: action,
    ambiguous: false,
    alternatives: [],
    reasoning: result.next_step && result.next_step.reason,
  };
}

async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const askUser = typeof context.askUser === 'function' ? context.askUser : defaultAskUser;
  const computeNextStep = typeof context.computeNextStep === 'function'
    ? context.computeNextStep
    : realComputeNextStep;

  const { phase, force, actionOverride } = _parseArgs(args);

  if (actionOverride != null) {
    if (!VALID_ACTIONS.has(actionOverride)) {
      throw new NubosPilotError(
        'dispatch-unknown-action',
        'Unknown --action override: ' + actionOverride,
        { action: actionOverride, valid: [...VALID_ACTIONS] },
      );
    }
  }

  const raw = await computeNextStep(cwd, { phase });
  const resolved = _normalize(raw);

  let action = actionOverride || resolved.nextAction;

  if (!actionOverride && !force && resolved.ambiguous) {
    const options = [resolved.nextAction, ...(resolved.alternatives || [])]
      .filter((x) => x && VALID_ACTIONS.has(x));
    if (options.length > 1) {
      const answer = await askUser({
        type: 'select',
        question: `State ambiguous. Recommended: ${resolved.nextAction}. Override?`,
        options,
        default: resolved.nextAction,
      });
      if (answer && typeof answer.value === 'string') action = answer.value;
    }
  }

  if (!action || !VALID_ACTIONS.has(action)) {
    throw new NubosPilotError(
      'dispatch-no-action',
      'computeNextStep did not yield a routable action',
      { resolved, phase },
    );
  }

  const payload = {
    skill: 'np-' + action,
    args: { phase },
  };
  stdout.write(JSON.stringify(payload));
  return payload;
}

module.exports = { run };
