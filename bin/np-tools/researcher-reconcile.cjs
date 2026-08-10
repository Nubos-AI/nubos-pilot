'use strict';

const fs = require('node:fs');

const { NubosPilotError } = require('../../lib/core.cjs');
const { emitJsonPayload } = require('../../lib/init-emit.cjs');
const reconciler = require('../../lib/researcher-reconciler.cjs');
const layout = require('../../lib/layout.cjs');

function _validateMilestoneArg(raw) {
  if (raw == null || !/^\d+$/.test(String(raw))) {
    throw new NubosPilotError(
      'researcher-reconcile-invalid-milestone',
      'milestone must be a positive integer',
      { value: raw },
    );
  }
  return Number(raw);
}

function _parseFlags(list) {
  const out = { min_agreement_score: null, max_contested: null, file: null };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--min-agreement-score') out.min_agreement_score = Number(list[++i]);
    else if (a === '--max-contested') out.max_contested = Number(list[++i]);
    else if (a === '--file') out.file = list[++i];
  }
  return out;
}

function _verbParseSpawn(args, ctx) {
  const flags = _parseFlags(args.slice(0));
  if (!flags.file) {
    throw new NubosPilotError('researcher-reconcile-missing-file', 'parse-spawn requires --file <path>', {});
  }
  return reconciler.parseSpawnOutput(flags.file);
}

function _verbPrepare(args, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const mNum = _validateMilestoneArg(args[0]);
  const flags = _parseFlags(args.slice(1));
  const opts = {};
  if (flags.min_agreement_score != null) opts.min_agreement_score = flags.min_agreement_score;
  if (flags.max_contested != null) opts.max_contested = flags.max_contested;
  return reconciler.prepareReconcilerInput(mNum, cwd, opts);
}

function _verbGate(args, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const mNum = _validateMilestoneArg(args[0]);
  const flags = _parseFlags(args.slice(1));
  const t = {};
  if (flags.min_agreement_score != null) t.min_agreement_score = flags.min_agreement_score;
  if (flags.max_contested != null) t.max_contested = flags.max_contested;

  const finalPath = reconciler.finalResearchPath(mNum, cwd);
  if (!fs.existsSync(finalPath)) {
    throw new NubosPilotError(
      'researcher-reconcile-no-final',
      'final RESEARCH.md not found at ' + finalPath,
      { milestone: mNum, path: finalPath },
    );
  }
  const raw = fs.readFileSync(finalPath, 'utf-8');
  return reconciler.gateFromFinalFrontmatter(raw, t);
}

function run(args, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const cwd = context.cwd || process.cwd();
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  let payload;
  switch (verb) {
    case 'parse-spawn':
      payload = _verbParseSpawn(list.slice(1), { cwd });
      break;
    case 'prepare':
    case 'prepare-input':
      payload = _verbPrepare(list.slice(1), { cwd });
      break;
    case 'gate':
      payload = _verbGate(list.slice(1), { cwd });
      break;
    default:
      throw new NubosPilotError(
        'researcher-reconcile-unknown-verb',
        'researcher-reconcile: unknown verb: ' + String(verb),
        { verb, allowed: ['parse-spawn', 'prepare', 'gate'] },
      );
  }
  emitJsonPayload(payload, stdout, cwd, 'researcher-reconcile');
  return payload;
}

module.exports = { run };
