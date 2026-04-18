const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('../../lib/phase.cjs');
const { detect } = require('../../lib/runtime/index.cjs');

function _validatePhaseArg(raw) {
  if (raw == null || raw === '') {
    throw new NubosPilotError(
      'ui-phase-invalid-arg',
      'ui-phase requires a phase number argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  const s = String(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new NubosPilotError(
      'ui-phase-invalid-arg',
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

function _buildPayload(phaseArg, cwd) {
  let phase;
  try {
    phase = getPhase(phaseArg, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'ui-phase-not-found',
        'Phase ' + phaseArg + ' not found in roadmap',
        { number: phaseArg },
      );
    }
    throw err;
  }

  const padded = paddedPhase(phaseArg);
  const slug = phase.slug || phaseSlug(phase.name);
  const phase_dir = _resolvePhaseDir(phaseArg, cwd, slug);
  const ui_spec_path = path.join(phase_dir, padded + '-UI-SPEC.md');
  const has_ui_spec = fs.existsSync(ui_spec_path);
  const template_path = path.join(path.resolve(cwd), 'templates', 'UI-SPEC.md');
  const { runtime } = detect({ cwd });

  return {
    _workflow: 'ui-phase',
    phase: phaseArg,
    padded,
    phase_dir,
    ui_spec_path,
    has_ui_spec,
    template_path,
    agents: {
      ui_researcher: 'np-ui-researcher',
      ui_checker: 'np-ui-checker',
    },
    max_iterations: 2,
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
    stderr.write('Usage: np-tools.cjs init ui-phase <phase>\n');
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

module.exports = { run, _buildPayload };
