'use strict';

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
const layout = require('../../lib/layout.cjs');
const {
  verifyMilestone,
  writeVerificationMd,
  milestoneVerificationPath,
} = require('../../lib/verify.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');
const textMode = require('../../lib/text-mode.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;
const _VALID_SC_STATUSES = new Set(['Pass', 'Fail', 'Defer', 'Pending']);

function _validateMilestoneArg(raw) {
  if (raw == null || raw === '' || !/^\d+$/.test(String(raw))) {
    throw new NubosPilotError(
      'verify-work-invalid-phase',
      'verify-work requires a positive integer milestone argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  return Number(raw);
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

function _initPayload(mNum, cwd) {
  let def;
  try {
    def = getPhase(mNum, cwd);
  } catch (err) {
    if (err && err.code === 'phase-not-found') {
      throw new NubosPilotError(
        'verify-work-not-found',
        'Milestone ' + mNum + ' not found in roadmap.yaml',
        { number: mNum },
      );
    }
    throw err;
  }
  const mDir = layout.milestoneDir(mNum, cwd);
  const results = verifyMilestone(mNum, { cwd });
  const verificationPath = milestoneVerificationPath(mNum, cwd);

  // Collect slice UAT coverage
  const slices = layout.listSlices(mNum, cwd);
  const sliceUat = slices.map((s) => {
    const uatPath = layout.sliceUatPath(mNum, s.number, cwd);
    const summaryPath = layout.sliceSummaryPath(mNum, s.number, cwd);
    const tasks = layout.listTasks(mNum, s.number, cwd);
    return {
      id: s.id,
      full_id: s.full_id,
      uat_path: uatPath,
      summary_path: summaryPath,
      has_uat: fs.existsSync(uatPath),
      has_summary: fs.existsSync(summaryPath),
      task_count: tasks.length,
    };
  });

  const tmDetail = textMode.resolveTextModeDetail(cwd);

  return {
    _workflow: 'verify-work',
    milestone: mNum,
    milestone_id: layout.mId(mNum),
    milestone_dir: mDir,
    milestone_name: def.name,
    success_criteria: Array.isArray(def.success_criteria) ? def.success_criteria : [],
    draft_results: results,
    verification_path: verificationPath,
    slice_uat: sliceUat,
    verifier_tier: 'sonnet',
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
    agent_skills: { verifier: _safeSkills('np-verifier', cwd) },
  };
}

function _emitDraft(mNum, cwd) {
  writeVerificationMd(mNum, cwd);
  return { ok: true, path: milestoneVerificationPath(mNum, cwd) };
}

function _recordSc(mNum, scId, status, notes, cwd) {
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
  const mDir = layout.findMilestoneDir(mNum, cwd);
  if (!mDir) {
    throw new NubosPilotError(
      'verify-work-milestone-dir-missing',
      'Milestone directory not found for milestone ' + mNum,
      { milestone: mNum },
    );
  }
  const target = milestoneVerificationPath(mNum, cwd);

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
      const mNum = _validateMilestoneArg(list[1]);
      const payload = _initPayload(mNum, cwd);
      _emit(payload, stdout, cwd);
      return payload;
    }
    case 'emit-draft': {
      const mNum = _validateMilestoneArg(list[1]);
      const result = _emitDraft(mNum, cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    case 'record-sc': {
      const mNum = _validateMilestoneArg(list[1]);
      const scId = list[2];
      const status = list[3];
      const notes = list.slice(4).join(' ') || null;
      const result = _recordSc(mNum, scId, status, notes, cwd);
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
