'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { withFileLock, atomicWriteFileSync, NubosPilotError } = require('./core.cjs');
const { getPhase, setMilestoneStatus } = require('./roadmap.cjs');
const { setMilestoneMetaStatus } = require('./milestone-meta.cjs');
const layout = require('./layout.cjs');
const { stripFrontmatter } = require('./frontmatter.cjs');

const _SUBJECTIVE_RE = /\b(subjective|feels?|UX|usability|look|looks|aesthetic|intuitive)\b/i;

function _scText(sc) {
  if (typeof sc === 'string') return sc;
  if (sc && typeof sc === 'object') {
    for (const key of ['text', 'criterion', 'description', 'title']) {
      const v = sc[key];
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
    if (typeof sc.id === 'string' && sc.id.trim() !== '') return sc.id;
  }
  if (sc == null) return '';
  return String(sc);
}

function verifyMilestone(n, { cwd = process.cwd() } = {}) {
  const def = getPhase(n, cwd);
  const criteria = def.success_criteria || [];
  return criteria.map((sc, idx) => {
    const text = _scText(sc);
    return {
      id: 'SC-' + (idx + 1),
      text,
      status: null,
      classified_by: null,
      evidence: [],
      notes: '',
      needs_user_confirm: _SUBJECTIVE_RE.test(text),
    };
  });
}

function _milestoneStatusFromResults(results) {
  if (results.some((r) => r.status === 'Fail')) return 'failed';
  if (results.some((r) => r.status === 'Defer')) return 'deferred';
  if (results.some((r) => r.needs_user_confirm && r.status == null)) return 'deferred';
  if (results.length > 0 && results.every((r) => r.status === 'Pass')) return 'verified';
  return 'deferred';
}

function _countsFromResults(results) {
  const counts = { passed: 0, failed: 0, deferred: 0, pending: 0 };
  for (const r of results) {
    if (r.status === 'Pass') counts.passed++;
    else if (r.status === 'Fail') counts.failed++;
    else if (r.status === 'Defer') counts.deferred++;
    else counts.pending++;
  }
  return counts;
}

function _roadmapStatusFromResults(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const c = _countsFromResults(results);
  if (c.failed > 0) return 'failed';
  if (c.pending === results.length) return null;
  if (c.pending > 0) return 'in-progress';
  if (c.deferred > 0) return 'deferred';
  if (c.passed === results.length) return 'verified';
  return 'in-progress';
}

function _metaSyncFailed(meta) {
  if (!meta) return true;
  if (meta.changed === true) return false;
  if (meta.reason === 'meta-missing') return false;
  return meta.reason !== undefined;
}

function _syncRoadmapStatusFromResults(n, results, cwd) {
  const total = Array.isArray(results) ? results.length : 0;
  const counts = _countsFromResults(Array.isArray(results) ? results : []);
  const classified = total - counts.pending;
  const status = _roadmapStatusFromResults(results);
  if (status == null) {
    return { synced: false, reason: 'no-classified-results', classified, total };
  }
  let roadmapResult;
  try {
    roadmapResult = setMilestoneStatus(n, status, cwd);
  } catch (err) {
    if (err && (err.code === 'roadmap-write-read-error' || err.code === 'roadmap-parse-error')) {
      return { synced: false, reason: err.code, classified, total };
    }
    throw err;
  }
  let metaResult = { changed: false, reason: 'not-attempted' };
  try {
    metaResult = setMilestoneMetaStatus(n, status, cwd);
  } catch (err) {
    metaResult = { changed: false, reason: err && err.code ? err.code : 'meta-sync-error' };
  }
  return {
    synced: true,
    status,
    previous: roadmapResult.previous,
    changed: roadmapResult.changed,
    meta: metaResult,
    meta_stale: _metaSyncFailed(metaResult),
    classified,
    total,
    partial: classified < total,
  };
}

function renderVerificationMd(n, milestoneName, results) {
  const ms = _milestoneStatusFromResults(results);
  const counts = _countsFromResults(results);
  const ts = new Date().toISOString().slice(0, 10);
  const lines = [];
  const mIdStr = layout.mId(n);

  lines.push('---');
  lines.push('schema_version: 2');
  lines.push('milestone: ' + JSON.stringify(mIdStr));
  lines.push('milestone_name: ' + JSON.stringify(String(milestoneName || '')));
  lines.push('verified: ' + JSON.stringify(ts));
  lines.push('milestone_status: ' + ms);
  lines.push('sc_total: ' + results.length);
  lines.push('passed: ' + counts.passed);
  lines.push('failed: ' + counts.failed);
  lines.push('deferred: ' + counts.deferred);
  lines.push('pending: ' + counts.pending);
  lines.push('---');
  lines.push('');
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

const _SC_HEADING_RE = /^#{2,3}\s+(SC-\d+)[\s:—-]+([^\n]*)$/gm;

function _scBlocks(raw) {
  const body = stripFrontmatter(raw);
  const matches = [...body.matchAll(_SC_HEADING_RE)];
  const blocks = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const block = body.slice(start, end);
    blocks.push({ id: m[1], text: (m[2] || '').trim(), block });
  }
  return blocks;
}

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
  for (const b of _scBlocks(raw)) {
    const status = _readField(b.block, 'Status');
    if (!status) continue;
    out.push({ id: b.id, text: b.text, status });
  }
  return out;
}

function milestoneVerificationPath(n, cwd = process.cwd()) {
  return path.join(layout.milestoneDir(n, cwd), layout.mId(n) + '-VERIFICATION.md');
}

function _readField(block, label) {
  const re = new RegExp('(?:^|\\n)[*-]?\\s*\\*\\*' + label + ':\\*\\*\\s*([^\\n]*)');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function _readExistingResults(target) {
  if (!fs.existsSync(target)) return null;
  let raw;
  try { raw = fs.readFileSync(target, 'utf-8'); } catch { return null; }
  const blocks = [];
  for (const b of _scBlocks(raw)) {
    const status = _readField(b.block, 'Status');
    if (!status) continue;
    const classified = _readField(b.block, 'Classified by');
    const evidence = _readField(b.block, 'Evidence');
    const notes = _readField(b.block, 'Notes');
    blocks.push({
      id: b.id,
      status: status === 'Pending' ? null : status,
      classified_by: !classified || classified === 'n/a' ? null : classified,
      evidence: !evidence || evidence === '—' ? [] : evidence.split(',').map((s) => s.trim()).filter(Boolean),
      notes: notes || '',
    });
  }
  return blocks.length > 0 ? blocks : null;
}

function _mergeExistingIntoResults(results, existing) {
  if (!existing) return results;
  const byId = new Map(existing.map((e) => [e.id, e]));
  return results.map((r) => {
    const e = byId.get(r.id);
    if (!e) return r;
    return {
      ...r,
      status: e.status != null ? e.status : r.status,
      classified_by: e.classified_by != null ? e.classified_by : r.classified_by,
      evidence: e.evidence.length > 0 ? e.evidence : r.evidence,
      notes: e.notes || r.notes,
    };
  });
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
  let results = verifyMilestone(n, { cwd });
  const existing = _readExistingResults(target);
  if (existing) {
    results = _mergeExistingIntoResults(results, existing);
  }
  const md = renderVerificationMd(n, def.name || '', results);
  withFileLock(target, () => atomicWriteFileSync(target, md));
  return _syncRoadmapStatusFromResults(n, results, cwd);
}

function verifyPhase(n, opts) { return verifyMilestone(n, opts); }

module.exports = {
  verifyMilestone,
  verifyPhase,
  renderVerificationMd,
  parseVerificationMd,
  writeVerificationMd,
  milestoneVerificationPath,
  _milestoneStatusFromResults,
  _countsFromResults,
  _roadmapStatusFromResults,
  _syncRoadmapStatusFromResults,
  _scBlocks,
  _readField,
};
