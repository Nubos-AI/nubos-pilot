'use strict';

const { VALID_TIERS } = require('./model-profiles.cjs');

// ADR-0013: a tier is a routing/meta property derived from OBSERVABLE task
// signals (files touched + risk keywords), never invented from implementation
// detail. classifyTier is advisory — the planner remains the decider; this
// helper only makes that decision evidence-based. Output is deterministic
// (no clock, no randomness) so a given task always classifies the same way.

const RISK_RE = /\b(auth|authn|authz|authoriz\w*|login|crypto|encrypt\w*|decrypt\w*|password|secret|credential|token|jwt|oauth|saml|session|payment|billing|invoice|permission|role|access[\s-]?control|migrat\w*|schema)\b/i;
const ARCH_RE = /\b(architect\w*|cross[\s-]?cutting|multi[\s-]?module|redesign|breaking[\s-]?change|public[\s-]?api|contract|interface|protocol|state[\s-]?machine|concurren\w*|distributed|orchestrat\w*)\b/i;
const TRIVIAL_RE = /\b(typo|comment|rename|docs?|readme|changelog|copy(?:writing)?|wording|spelling|version[\s-]?bump|bump[\s-]?version|lint|format(?:ting)?|whitespace|config[\s-]?value|constant|string[\s-]?literal)\b/i;

const SIZE_TO_TIER = Object.freeze({ trivial: 'haiku', standard: 'sonnet', large: 'opus' });

const LARGE_FILE_THRESHOLD = 6;

function _text(name, desc) {
  return [String(name || ''), String(desc || '')].join(' ');
}

/**
 * @param {{files_modified?: string[], name?: string, desc?: string}} task
 * @returns {{tier: string, size: string, rationale: string, signals: {file_count: number, risk: boolean, arch: boolean, trivial: boolean}}}
 */
function classifyTier(task) {
  const t = task || {};
  const files = Array.isArray(t.files_modified) ? t.files_modified : [];
  const fileCount = files.length;
  const haystack = _text(t.name, t.desc) + ' ' + files.join(' ');

  const risk = RISK_RE.test(haystack);
  const arch = ARCH_RE.test(haystack);
  const trivial = TRIVIAL_RE.test(haystack);

  let size;
  let rationale;
  if (risk) {
    size = 'large';
    rationale = 'security/data-sensitive surface (auth, crypto, secrets, or migration) — escalate to the strongest tier';
  } else if (arch || fileCount >= LARGE_FILE_THRESHOLD) {
    size = 'large';
    rationale = arch
      ? 'architectural / cross-cutting change — invariants span multiple units'
      : 'broad change touching ' + fileCount + ' files — cross-file invariants likely';
  } else if (fileCount <= 1 && trivial) {
    size = 'trivial';
    rationale = 'single-file mechanical edit (docs/rename/format/config) — narrow, low-risk';
  } else {
    size = 'standard';
    rationale = 'ordinary single-concern implementation';
  }

  return {
    tier: SIZE_TO_TIER[size],
    size,
    rationale,
    signals: { file_count: fileCount, risk, arch, trivial },
  };
}

function isValidTier(tier) {
  return VALID_TIERS.includes(tier);
}

module.exports = { classifyTier, isValidTier, SIZE_TO_TIER, LARGE_FILE_THRESHOLD };
