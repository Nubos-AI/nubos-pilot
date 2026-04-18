const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('../../lib/phase.cjs');
const { detect } = require('../../lib/runtime/index.cjs');

function _validatePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'eval-review-invalid-arg',
      'eval-review requires a phase number argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new NubosPilotError(
      'eval-review-invalid-arg',
      'Invalid phase number: ' + s,
      { value: s },
    );
  }
  return s;
}

function _resolvePhaseDir(phaseArg, cwd, slug) {
  const hit = findPhaseDir(phaseArg, cwd);
  if (hit) return hit;
  const padded = paddedPhase(phaseArg);
  return path.join(path.resolve(cwd), '.nubos-pilot', 'phases', padded + '-' + slug);
}

function _computeState(hasAiSpec, summaryPresent) {
  if (hasAiSpec && summaryPresent) return 'A';
  if (summaryPresent) return 'B';
  return 'C';
}

function _buildPayload(phaseArg, cwd) {
  let phase;
  try {
    phase = getPhase(phaseArg, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'eval-review-not-found',
        'Phase ' + phaseArg + ' not found in roadmap',
        { number: phaseArg },
      );
    }
    throw err;
  }

  const padded = paddedPhase(phaseArg);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const eval_review_path = path.join(phase_dir, padded + '-EVAL-REVIEW.md');
  const summary_path = path.join(phase_dir, padded + '-SUMMARY.md');
  const ai_spec_path = path.join(phase_dir, padded + '-AI-SPEC.md');
  const summary_present = fs.existsSync(summary_path);
  const has_ai_spec = fs.existsSync(ai_spec_path);
  const state = _computeState(has_ai_spec, summary_present);
  const { runtime } = detect({ cwd });

  return {
    _workflow: 'eval-review',
    phase: phaseArg,
    padded,
    phase_dir,
    eval_review_path,
    summary_present,
    summary_path,
    ai_spec_path,
    has_ai_spec,
    state,
    agents: { eval_auditor: 'np-eval-auditor' },
    runtime,
  };
}

function _emitError(err, stderr) {
  if (err && err.name === 'NubosPilotError') {
    stderr.write(
      JSON.stringify({ code: err.code, message: err.message, details: err.details }) + '\n',
    );
  } else {
    stderr.write(String((err && err.stack) || err) + '\n');
  }
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const list = Array.isArray(args) ? args : [];

  if (list[0] == null || list[0] === '') {
    stderr.write('Usage: np-tools.cjs init eval-review <phase>\n');
    return 1;
  }

  try {
    const phaseArg = _validatePhaseArg(list[0]);
    const payload = _buildPayload(phaseArg, cwd);
    stdout.write(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _buildPayload, _computeState };
