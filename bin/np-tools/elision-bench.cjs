'use strict';

const bench = require('../../lib/elision-bench.cjs');

function _parseArgs(args) {
  const out = { json: false, withModel: false, tier: 'frontier', size: null, holdout: 0.2, maxCases: null, charsPerToken: null, pricePerMTok: null, currency: null };
  for (let i = 0; i < (args || []).length; i += 1) {
    const a = args[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--with-model') { out.withModel = true; continue; }
    if (a === '--tier') { out.tier = args[++i] || out.tier; continue; }
    if (a === '--size') { out.size = args[++i] || out.size; continue; }
    if (a === '--holdout') { const v = parseFloat(args[++i]); if (Number.isFinite(v)) out.holdout = v; continue; }
    if (a === '--max-cases') { const v = parseInt(args[++i], 10); if (Number.isFinite(v)) out.maxCases = v; continue; }
    if (a === '--chars-per-token') { const v = parseFloat(args[++i]); if (Number.isFinite(v)) out.charsPerToken = v; continue; }
    if (a === '--price-per-mtok') { const v = parseFloat(args[++i]); if (Number.isFinite(v)) out.pricePerMTok = v; continue; }
    if (a === '--currency') { out.currency = args[++i] || out.currency; continue; }
  }
  return out;
}

async function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const parsed = _parseArgs(args || []);

  if (parsed.size) {
    const scale = bench.runScale({ cwd, size: parsed.size, holdoutRatio: parsed.holdout, maxCases: parsed.maxCases, charsPerToken: parsed.charsPerToken, pricePerMTok: parsed.pricePerMTok, currency: parsed.currency });
    stdout.write((parsed.json ? JSON.stringify({ scale }) : bench.formatScale(scale)) + '\n');
    return scale.summary.invariants_ok ? 0 : 1;
  }

  const fidelity = bench.runFidelity({ cwd });
  let equivalence = null;

  if (parsed.withModel) {
    const { resolveFromConfig } = require('./resolve-model.cjs');
    const { chat } = require('../../lib/runtime/providers/openai-compat.cjs');
    const res = resolveFromConfig({ agentOrTier: parsed.tier, cwd, format: 'json' });
    if (!res || !res.model || !res.baseUrl) {
      stdout.write((parsed.json ? JSON.stringify({ fidelity, equivalence: null, error: 'no-provider' }) : 'No off-host provider resolved for tier "' + parsed.tier + '" — equivalence skipped.') + '\n');
      return fidelity.summary.invariants_ok ? 0 : 1;
    }
    const provider = { baseUrl: res.baseUrl, apiKeyEnv: res.apiKeyEnv, model: res.model };
    equivalence = await bench.runEquivalence({ chatImpl: chat, provider });
  }

  if (parsed.json) {
    stdout.write(JSON.stringify({ fidelity, equivalence }) + '\n');
  } else {
    stdout.write(bench.formatReport(fidelity) + '\n');
    if (equivalence) {
      stdout.write('\nAnswer equivalence — ' + equivalence.summary.equivalent + '/' + equivalence.summary.cases
        + ' equivalent, regressions: ' + (equivalence.summary.regressions.length ? equivalence.summary.regressions.join(', ') : 'none') + '\n');
      for (const c of equivalence.cases) {
        stdout.write('  ' + (c.regression ? '✗' : '✓') + ' ' + c.name + ' (raw '
          + (c.raw_ok ? 'ok' : 'miss') + ', compressed ' + (c.compressed_ok ? 'ok' : 'miss') + ')\n');
      }
    }
  }

  const ok = fidelity.summary.invariants_ok && (!equivalence || equivalence.summary.no_regression);
  return ok ? 0 : 1;
}

module.exports = { run, _parseArgs };
