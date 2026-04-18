const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  NubosPilotError,
  projectStateDir,
  atomicWriteFileSync,
  withFileLock,
} = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const { paddedPhase, findPhaseDir } = require('../../lib/phase.cjs');
const {
  verifyPhase,
  renderVerificationMd,
  writeVerificationMd,
} = require('../../lib/verify.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;
const _VALID_SC_STATUSES = new Set(['Pass', 'Fail', 'Defer', 'Pending']);

function _validatePhaseArg(raw) {
  if (raw == null || raw === '' || !/^\d+(\.\d+)?$/.test(String(raw))) {
    throw new NubosPilotError(
      'verify-work-invalid-phase',
      'verify-work requires a numeric phase argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  return String(raw);
}

function _safeSkills(name, cwd) {
  try { return getAgentSkills(name, cwd); } catch { return []; }
}

function _emit(payload, stdout, cwd) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf-8') <= INLINE_THRESHOLD_BYTES) {
    stdout.write(json);
    return;
  }
  let tmpDir;
  try {
    tmpDir = path.join(projectStateDir(cwd), '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch { tmpDir = os.tmpdir(); }
  const suffix = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(tmpDir, 'init-verify-work-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _initPayload(phaseArg, cwd) {
  const phaseN = Number(phaseArg);
  const phase = getPhase(phaseN, cwd);
  const padded = paddedPhase(phaseN);
  const phase_dir = findPhaseDir(phaseN, cwd);
  const results = verifyPhase(phaseN, { cwd });
  return {
    _workflow: 'verify-work',
    phase: phaseArg,
    padded,
    phase_dir,
    phase_name: phase.name,
    success_criteria: Array.isArray(phase.success_criteria) ? phase.success_criteria : [],
    draft_results: results,
    verification_path: phase_dir ? path.join(phase_dir, padded + '-VERIFICATION.md') : null,
    verifier_tier: 'sonnet',
    agent_skills: { verifier: _safeSkills('np-verifier', cwd) },
  };
}

function _emitDraft(phaseArg, cwd) {
  const phaseN = Number(phaseArg);
  writeVerificationMd(phaseN, cwd);
  const padded = paddedPhase(phaseN);
  const phase_dir = findPhaseDir(phaseN, cwd);
  return { ok: true, path: path.join(phase_dir, padded + '-VERIFICATION.md') };
}

function _recordSc(phaseArg, scId, status, notes, cwd) {
  if (!/^SC-\d+$/.test(String(scId))) {
    throw new NubosPilotError(
      'verify-work-invalid-sc-id',
      'Invalid SC id: ' + scId + ' (expected SC-N)',
      { scId },
    );
  }
  if (!_VALID_SC_STATUSES.has(status)) {
    throw new NubosPilotError(
      'verify-work-invalid-status',
      'Invalid SC status: ' + status + ' (allowed: ' + [..._VALID_SC_STATUSES].join(', ') + ')',
      { status },
    );
  }
  const phaseN = Number(phaseArg);
  const padded = paddedPhase(phaseN);
  const phase_dir = findPhaseDir(phaseN, cwd);
  if (!phase_dir) {
    throw new NubosPilotError(
      'verify-work-phase-dir-missing',
      'Phase directory not found for phase ' + phaseN,
      { phase: phaseN },
    );
  }
  const target = path.join(phase_dir, padded + '-VERIFICATION.md');

  return withFileLock(target, () => {
    let raw;
    try { raw = fs.readFileSync(target, 'utf-8'); } catch (err) {
      throw new NubosPilotError(
        'verify-work-file-unreadable',
        'VERIFICATION.md not readable at ' + target + ' — run `verify-work emit-draft` first',
        { path: target, cause: err && err.code },
      );
    }

    
    const blockRe = new RegExp(
      '^(### ' + scId + ':[^\\n]*\\n)(- \\*\\*Status:\\*\\* )[^\\n]*(\\n- \\*\\*Classified by:\\*\\* )[^\\n]*',
      'm',
    );
    if (!blockRe.test(raw)) {
      throw new NubosPilotError(
        'verify-work-sc-not-found',
        'SC ' + scId + ' not found in VERIFICATION.md',
        { scId, path: target },
      );
    }
    let next = raw.replace(blockRe, (_m, hdr, p1, p3) => hdr + p1 + status + p3 + 'user');

    
    if (notes) {
      const afterRe = new RegExp(
        '^(### ' + scId + ':[^\\n]*\\n- \\*\\*Status:\\*\\* [^\\n]*\\n- \\*\\*Classified by:\\*\\* [^\\n]*\\n- \\*\\*Evidence:\\*\\* [^\\n]*)(\\n- \\*\\*Notes:\\*\\* [^\\n]*)?',
        'm',
      );
      next = next.replace(afterRe, (_m, head) => head + '\n- **Notes:** ' + notes);
    }
    atomicWriteFileSync(target, next);
    return { ok: true, sc_id: scId, status, path: target };
  });
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  switch (verb) {
    case 'init': {
      const phaseArg = _validatePhaseArg(list[1]);
      const payload = _initPayload(phaseArg, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    case 'emit-draft': {
      const phaseArg = _validatePhaseArg(list[1]);
      const result = _emitDraft(phaseArg, cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    case 'record-sc': {
      const phaseArg = _validatePhaseArg(list[1]);
      const scId = list[2];
      const status = list[3];
      const notes = list.slice(4).join(' ') || null;
      const result = _recordSc(phaseArg, scId, status, notes, cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    default:
      throw new NubosPilotError(
        'verify-work-unknown-verb',
        'verify-work: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run, INLINE_THRESHOLD_BYTES };
