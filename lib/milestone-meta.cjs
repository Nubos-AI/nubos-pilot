'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync, withFileLock } = require('./core.cjs');
const layout = require('./layout.cjs');

function _redact(p) { return p ? path.basename(p) : p; }

function readMilestoneMeta(mNum, cwd) {
  const p = layout.milestoneMetaPath(mNum, cwd);
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new NubosPilotError(
      'milestone-meta-unreadable',
      'M-META.json not readable (' + (err && err.code) + ')',
      { file: _redact(p), cause: err && err.code },
    );
  }
  if (raw.trim() === '') return null;
  try { return JSON.parse(raw); }
  catch (err) {
    throw new NubosPilotError(
      'milestone-meta-invalid-json',
      'M-META.json invalid JSON: ' + (err && err.message),
      { file: _redact(p) },
    );
  }
}

function setMilestoneMetaStatus(mNum, status, cwd) {
  if (typeof status !== 'string' || !status) {
    throw new NubosPilotError(
      'milestone-meta-invalid-status',
      'setMilestoneMetaStatus: status must be non-empty string',
      { status },
    );
  }
  const p = layout.milestoneMetaPath(mNum, cwd);
  return withFileLock(p, () => {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (err) {
      if (err && err.code === 'ENOENT') return { changed: false, reason: 'meta-missing' };
      throw err;
    }
    const previous = typeof meta.status === 'string' ? meta.status : null;
    if (previous === status) return { changed: false, previous };
    meta.status = status;
    atomicWriteFileSync(p, JSON.stringify(meta, null, 2) + '\n');
    return { changed: true, previous, status };
  });
}

function writeMilestoneMeta(mNum, content, cwd) {
  const p = layout.milestoneMetaPath(mNum, cwd);
  const body = typeof content === 'string'
    ? content
    : JSON.stringify(content, null, 2) + '\n';
  return withFileLock(p, () => atomicWriteFileSync(p, body));
}

module.exports = {
  readMilestoneMeta,
  setMilestoneMetaStatus,
  writeMilestoneMeta,
};
