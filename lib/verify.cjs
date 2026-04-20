'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { withFileLock, atomicWriteFileSync, NubosPilotError } = require('./core.cjs');
const { getPhase } = require('./roadmap.cjs');
const layout = require('./layout.cjs');

const _SUBJECTIVE_RE = /\b(subjective|feels?|UX|usability|look|looks|aesthetic|intuitive)\b/i;

function verifyMilestone(n, { cwd = process.cwd() } = {}) {
  const def = getPhase(n, cwd);
  const criteria = def.success_criteria || [];
  return criteria.map((sc, idx) => ({
    id: 'SC-' + (idx + 1),
    text: sc,
    status: null,
    classified_by: null,
    evidence: [],
    notes: '',
    needs_user_confirm: _SUBJECTIVE_RE.test(sc),
  }));
}

function _milestoneStatusFromResults(results) {
  if (results.some((r) => r.status === 'Fail')) return 'failed';
  if (results.some((r) => r.status === 'Defer')) return 'deferred';
  if (results.some((r) => r.needs_user_confirm && r.status == null)) return 'deferred';
  if (results.length > 0 && results.every((r) => r.status === 'Pass')) return 'verified';
  return 'deferred';
}

function renderVerificationMd(n, milestoneName, results) {
  const ms = _milestoneStatusFromResults(results);
  const ts = new Date().toISOString().slice(0, 10);
  const lines = [];
  const mIdStr = layout.mId(n);
  lines.push('# ' + mIdStr + ' — ' + milestoneName + ' — Verification');
  lines.push('');
  lines.push('**Verified:** ' + ts);
  lines.push('**Milestone Status:** ' + ms);
  lines.push('');
  lines.push('## Success Criteria');
  lines.push('');
  for (const r of results) {
    lines.push('### ' + r.id + ': ' + r.text);
    lines.push('- **Status:** ' + (r.status || 'Pending'));
    lines.push('- **Classified by:** ' + (r.classified_by || 'n/a'));
    const evidence = Array.isArray(r.evidence) && r.evidence.length > 0
      ? r.evidence.join(', ')
      : '—';
    lines.push('- **Evidence:** ' + evidence);
    if (r.notes) lines.push('- **Notes:** ' + r.notes);
    if (r.needs_user_confirm && r.status == null) {
      lines.push('- **Needs user confirm:** true');
    }
    lines.push('');
  }
  return lines.join('\n');
}

const _SC_RE = /^### (SC-\d+): ([^\n]+)\n- \*\*Status:\*\* (\w+)/gm;

function parseVerificationMd(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'verify-file-unreadable',
      'VERIFICATION.md not readable at ' + filePath,
      { path: filePath, cause: err && err.code },
    );
  }
  const out = [];
  for (const m of raw.matchAll(_SC_RE)) {
    out.push({ id: m[1], text: m[2].trim(), status: m[3] });
  }
  return out;
}

function milestoneVerificationPath(n, cwd = process.cwd()) {
  return path.join(layout.milestoneDir(n, cwd), layout.mId(n) + '-VERIFICATION.md');
}

function writeVerificationMd(n, cwd = process.cwd()) {
  const def = getPhase(n, cwd);
  const mDir = layout.findMilestoneDir(n, cwd);
  if (!mDir) {
    throw new NubosPilotError(
      'verify-milestone-dir-missing',
      'Milestone directory not found for milestone ' + n,
      { milestone: n },
    );
  }
  const target = milestoneVerificationPath(n, cwd);
  const results = verifyMilestone(n, { cwd });
  const md = renderVerificationMd(n, def.name || '', results);
  return withFileLock(target, () => atomicWriteFileSync(target, md));
}

// Backwards-compat alias used by older call sites.
function verifyPhase(n, opts) { return verifyMilestone(n, opts); }

module.exports = {
  verifyMilestone,
  verifyPhase,
  renderVerificationMd,
  parseVerificationMd,
  writeVerificationMd,
  milestoneVerificationPath,
  _milestoneStatusFromResults,
};
