'use strict';

const path = require('node:path');
const { NubosPilotError } = require('./core.cjs');

// The version a roadmap without conditional slice edges is written at. It stays
// 2 on purpose: `_mutate` stamps this value on every write, so raising it would
// silently migrate every existing project to a version older installs cannot
// read — for a feature those projects do not use.
const CURRENT_SCHEMA_VERSION = 2;

// The version required once any slice carries a `when` (ADR-0028). A conditional
// edge changes execution semantics, so a reader that does not understand the
// field must refuse the file rather than ignore it and run a gated slice. That is
// what a version bump is for, and it is why this is not just an optional field on
// v2.
const CONDITIONAL_SCHEMA_VERSION = 3;

const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);

const MILESTONE_STATUSES = Object.freeze([
  'pending', 'in-progress', 'verified', 'failed', 'deferred', 'done', 'complete', 'backlog',
]);
const MILESTONE_DONE_STATUSES = Object.freeze(['done', 'complete', 'verified']);

const MILESTONE_ROLLUP_STATUSES = Object.freeze(['pending', 'in-progress']);
const SLICE_STATUSES = Object.freeze(['pending', 'in-progress', 'done']);

function isDoneMilestoneStatus(status) {
  return typeof status === 'string' && MILESTONE_DONE_STATUSES.includes(status);
}

function validateSchemaVersion(doc, p) {
  if (!doc || typeof doc !== 'object') return 1;
  const raw = doc.schema_version;
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new NubosPilotError(
      'roadmap-unsupported-schema',
      'roadmap.yaml schema_version must be integer',
      {
        file: path.basename(p),
        got: typeof raw,
        supported: SUPPORTED_SCHEMA_VERSIONS.slice(),
      },
    );
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw)) {
    throw new NubosPilotError(
      'roadmap-unsupported-schema',
      'roadmap.yaml schema_version=' + raw + ' not supported',
      {
        file: path.basename(p),
        got: raw,
        supported: SUPPORTED_SCHEMA_VERSIONS.slice(),
      },
    );
  }
  return raw;
}

/**
 * The schema_version this document actually requires.
 *
 * Bidirectional on purpose. Adding a `when` raises the file to 3 so an older
 * reader refuses it; removing the last `when` drops it back to 2, which makes the
 * file readable by older installs again — honestly, because there is nothing left
 * for them to mishandle.
 *
 * `hasConditionalEdges` is required lazily: slice-conditions.cjs is a leaf module
 * and requiring it at load time would make roadmap-schema ↔ slice-conditions a
 * cycle for any future condition code that needs the version constants.
 */
function requiredSchemaVersion(doc) {
  const { hasConditionalEdges } = require('./slice-conditions.cjs');
  return hasConditionalEdges(doc) ? CONDITIONAL_SCHEMA_VERSION : CURRENT_SCHEMA_VERSION;
}

/**
 * Refuse a document that uses conditional edges while declaring a version too old
 * to imply them. This is the file an older install would read successfully and
 * then execute wrongly, running a slice the plan gated — so it is rejected at the
 * newer install too, rather than being quietly repaired on write.
 */
function validateConditionalVersion(doc, p) {
  const { hasConditionalEdges } = require('./slice-conditions.cjs');
  if (!hasConditionalEdges(doc)) return;
  const declared = doc && typeof doc.schema_version === 'number' ? doc.schema_version : 1;
  if (declared < CONDITIONAL_SCHEMA_VERSION) {
    throw new NubosPilotError(
      'roadmap-conditional-requires-v3',
      'roadmap.yaml uses conditional slice edges (`when`) but declares schema_version=' + declared
      + '. Conditional edges require schema_version ' + CONDITIONAL_SCHEMA_VERSION
      + ', because a reader that ignores `when` runs a slice the plan gated.',
      {
        file: p ? path.basename(p) : null,
        declared,
        required: CONDITIONAL_SCHEMA_VERSION,
      },
    );
  }
}

module.exports = {
  validateSchemaVersion,
  validateConditionalVersion,
  requiredSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  CONDITIONAL_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  MILESTONE_STATUSES,
  MILESTONE_DONE_STATUSES,
  MILESTONE_ROLLUP_STATUSES,
  SLICE_STATUSES,
  isDoneMilestoneStatus,
};
