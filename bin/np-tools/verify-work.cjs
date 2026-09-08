'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  NubosPilotError,
  atomicWriteFileSync,
  withFileLock,
} = require('../../lib/core.cjs');
const { emitInitPayload } = require('../../lib/init-emit.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const layout = require('../../lib/layout.cjs');
const {
  verifyMilestone,
  writeVerificationMd,
  milestoneVerificationPath,
  parseVerificationMd,
  _syncRoadmapStatusFromResults,
} = require('../../lib/verify.cjs');
const { getAgentSkills } = require('../../lib/agents.cjs');
const textMode = require('../../lib/text-mode.cjs');
const rollup = require('../../lib/rollup.cjs');
const { isDoneMilestoneStatus } = require('../../lib/roadmap-schema.cjs');

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
    let sync = { synced: false, reason: 'not-attempted' };
    try {
      const parsed = parseVerificationMd(target);
      sync = _syncRoadmapStatusFromResults(mNum, parsed, cwd);
    } catch (err) {
      sync = { synced: false, reason: err && err.code ? err.code : 'sync-error' };
    }
    const syncOk = _isSyncOk(sync);
    _warnPartialClassification(sync);
    if (sync && sync.status) _warnTerminalOverOpenWork(mNum, sync.status, cwd);
    if (!syncOk) {
      try {
        process.stderr.write(
          'nubos-pilot verify-work: SC ' + scId + ' recorded but roadmap-sync failed ('
          + (sync.reason || 'unknown') + '). Run `np-tools verify-work sync-roadmap` to retry.\n',
        );
      } catch {}
    }
    return { ok: syncOk, sc_id: scId, status, path: target, roadmap_sync: sync };
  });
}

const _SYNC_OK_REASONS = new Set(['no-classified-results', 'verification-missing']);
function _isSyncOk(sync) {
  if (!sync) return false;
  if (sync.synced === true) return sync.meta_stale !== true;
  return _SYNC_OK_REASONS.has(sync.reason);
}

function _warnTerminalOverOpenWork(mNum, status, cwd) {
  if (!isDoneMilestoneStatus(status)) return;
  let inspected;
  try { inspected = rollup.inspectMilestone(mNum, cwd); } catch { return; }
  if (inspected.slices.length === 0 || inspected.all_done) return;
  const open = inspected.slices
    .filter((s) => s.derived !== null && s.derived !== 'done')
    .map((s) => s.id);
  if (open.length === 0) return;
  try {
    process.stderr.write(
      'nubos-pilot verify-work: milestone set to "' + status + '" while '
      + open.join(', ') + ' ' + (open.length === 1 ? 'is' : 'are')
      + ' not done. The verification covers work that is still open — '
      + 'run `np-tools doctor` (milestone-terminal-with-open-work) to review.\n',
    );
  } catch {}
}

function _warnPartialClassification(sync) {
  if (!sync || sync.partial !== true) return;
  try {
    process.stderr.write(
      'nubos-pilot verify-work: ' + sync.classified + '/' + sync.total
      + ' SC classified — milestone stays "' + sync.status
      + '". Record the remaining SC verdicts to reach a terminal status.\n',
    );
  } catch {}
}

function _syncRoadmapForMilestone(mNum, cwd) {
  const target = milestoneVerificationPath(mNum, cwd);
  if (!fs.existsSync(target)) {
    return { milestone: mNum, synced: false, reason: 'verification-missing' };
  }
  let parsed;
  try {
    parsed = parseVerificationMd(target);
  } catch (err) {
    return { milestone: mNum, synced: false, reason: err && err.code ? err.code : 'parse-error' };
  }
  const sync = _syncRoadmapStatusFromResults(mNum, parsed, cwd);
  _warnPartialClassification(sync);
  if (sync && sync.status) _warnTerminalOverOpenWork(mNum, sync.status, cwd);
  return Object.assign({ milestone: mNum }, sync);
}

function _syncAllRoadmap(cwd) {
  const found = layout.listMilestones(cwd);
  const results = [];
  let allOk = true;
  for (const entry of found) {
    const num = entry && Number(entry.number);
    if (!Number.isInteger(num)) continue;
    const r = _syncRoadmapForMilestone(num, cwd);
    if (!_isSyncOk(r)) allOk = false;
    results.push(r);
  }
  if (!allOk) {
    try {
      process.stderr.write('nubos-pilot verify-work: sync-roadmap finished with errors — check results[].reason\n');
    } catch {}
  }
  return { ok: allOk, count: results.length, results };
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
      emitInitPayload(payload, stdout, cwd, 'verify-work');
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
      if (context.suppressExitCode !== true && result.ok === false) {
        process.exitCode = 1;
      }
      return result;
    }
    case 'sync-roadmap': {
      const raw = list[1];
      let result;
      if (raw == null || raw === '') {
        result = _syncAllRoadmap(cwd);
      } else {
        const mNum = _validateMilestoneArg(raw);
        const single = _syncRoadmapForMilestone(mNum, cwd);
        result = Object.assign({ ok: _isSyncOk(single) }, single);
      }
      stdout.write(JSON.stringify(result));
      if (context.suppressExitCode !== true && result.ok === false) {
        process.exitCode = 1;
      }
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

// Exported so the workflow-dialog guard can assert that every SC status a
// dialog offers is one this verb accepts, without regexing this file's source.
module.exports = { run, _VALID_SC_STATUSES };
