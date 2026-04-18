const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('../../lib/phase.cjs');
const { detect } = require('../../lib/runtime/index.cjs');

const VALID_DEPTHS = new Set(['quick', 'standard', 'deep']);

function _usage() {
  return 'Usage: np-tools.cjs init code-review <phase> [--depth=quick|standard|deep]';
}

function _validatePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'code-review-invalid-arg',
      'code-review requires a phase number argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new NubosPilotError(
      'code-review-invalid-arg',
      'Invalid phase number: ' + s,
      { value: s },
    );
  }
  return s;
}

function _parseDepth(args) {
  let depth = 'standard';
  for (let i = 0; i < args.length; i += 1) {
    const s = String(args[i]);
    if (s.startsWith('--depth=')) {
      depth = s.slice('--depth='.length);
    } else if (s === '--depth' && args[i + 1]) {
      depth = String(args[i + 1]);
      i += 1;
    }
  }
  if (!VALID_DEPTHS.has(depth)) {
    throw new NubosPilotError(
      'code-review-invalid-depth',
      'depth must be one of quick|standard|deep, got: ' + depth,
      { depth },
    );
  }
  return depth;
}

function _resolvePhaseDir(phaseArg, cwd, slug) {
  const hit = findPhaseDir(phaseArg, cwd);
  if (hit) return hit;
  const padded = paddedPhase(phaseArg);
  return path.join(path.resolve(cwd), '.nubos-pilot', 'phases', padded + '-' + slug);
}

function _buildPayload(phaseArg, cwd, depth) {
  let phase;
  try {
    phase = getPhase(phaseArg, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'code-review-not-found',
        'Phase ' + phaseArg + ' not found in roadmap',
        { number: phaseArg },
      );
    }
    throw err;
  }
  const padded = paddedPhase(phaseArg);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const review_path = path.join(phase_dir, padded + '-REVIEW.md');
  const review_fix_path = path.join(phase_dir, padded + '-REVIEW-FIX.md');
  const summary_path = path.join(phase_dir, padded + '-SUMMARY.md');
  const summary_present = fs.existsSync(summary_path);
  const has_review = fs.existsSync(review_path);
  const { runtime } = detect({ cwd });
  return {
    _workflow: 'code-review',
    phase: phaseArg,
    padded,
    phase_dir,
    review_path,
    review_fix_path,
    summary_present,
    summary_path,
    has_review,
    depth,
    agents: { code_reviewer: 'np-code-reviewer', code_fixer: 'np-code-fixer' },
    runtime,
  };
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'code-review-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const list = Array.isArray(args) ? args : [];
  if (list[0] == null || list[0] === '') {
    stderr.write(_usage() + '\n');
    return 1;
  }
  try {
    const phaseArg = _validatePhaseArg(list[0]);
    const depth = _parseDepth(list.slice(1));
    const payload = _buildPayload(phaseArg, cwd, depth);
    stdout.write(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, _buildPayload, _parseDepth };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
