'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const roadmap = require('../../lib/roadmap.cjs');

const ALLOWED_FIELDS = new Set([
  'number',
  'id',
  'name',
  'goal',
  'requirements',
  'success_criteria',
  'depends_on',
  'status',
]);

function _parseArgs(args) {
  const out = { milestone: null, field: null, length: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      if (out.milestone == null) out.milestone = a;
      continue;
    }
    if (a === '--field' || a === '-f') { out.field = args[++i] || null; continue; }
    if (a === '--length' || a === '-l') { out.length = true; continue; }
  }
  return out;
}

function _validateMilestone(raw) {
  if (raw == null) {
    throw new NubosPilotError('phase-meta-missing-milestone',
      'milestone number required (e.g. M002 or 2)', {});
  }
  const s = String(raw).trim();
  const m = s.match(/^M?(\d+(?:\.\d+)?)$/i);
  if (!m) {
    throw new NubosPilotError('phase-meta-invalid-milestone',
      'milestone must be M<NNN> or <number>', { milestone: raw });
  }
  return m[1];
}

function _project(phase) {
  return {
    number: phase.number,
    id: phase.id || null,
    name: phase.name || '',
    goal: phase.goal || '',
    requirements: Array.isArray(phase.requirements) ? phase.requirements : [],
    success_criteria: Array.isArray(phase.success_criteria) ? phase.success_criteria : [],
    depends_on: phase.depends_on || null,
    status: phase.status || null,
  };
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  const mNum = _validateMilestone(parsed.milestone);

  let def;
  try {
    def = roadmap.getPhase(mNum, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError('phase-meta-not-found',
        'Milestone ' + mNum + ' not found in roadmap.yaml', { milestone: mNum });
    }
    throw err;
  }

  const projected = _project(def);

  if (parsed.field) {
    if (!ALLOWED_FIELDS.has(parsed.field)) {
      throw new NubosPilotError('phase-meta-unknown-field',
        'unknown field: ' + parsed.field,
        { field: parsed.field, allowed: Array.from(ALLOWED_FIELDS) });
    }
    const value = projected[parsed.field];
    if (parsed.length) {
      if (!Array.isArray(value)) {
        throw new NubosPilotError('phase-meta-length-non-array',
          '--length requires an array field; ' + parsed.field + ' is not an array',
          { field: parsed.field });
      }
      stdout.write(String(value.length));
      return 0;
    }
    stdout.write(JSON.stringify(value));
    return 0;
  }

  stdout.write(JSON.stringify(projected));
  return 0;
}

module.exports = { run, _parseArgs, _validateMilestone, ALLOWED_FIELDS };
