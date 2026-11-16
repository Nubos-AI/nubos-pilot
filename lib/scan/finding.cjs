'use strict';

const crypto = require('node:crypto');

const { NubosPilotError } = require('../core.cjs');

const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

const SEVERITY_RANK = Object.freeze({
  info: 0, low: 1, medium: 2, high: 3, critical: 4,
});

const LEGACY_SEVERITY = Object.freeze({
  nit: 'low',
  warn: 'medium',
  risk: 'high',
  fail: 'high',
});

const SCANNERS = Object.freeze([
  'patterns', 'secrets', 'advisory', 'malicious', 'misconfig', 'license', 'reviewer',
]);

const SOURCES = Object.freeze(['builtin', 'custom', 'advisory', 'reviewer']);

const ID_RANGES = Object.freeze({
  patterns: Object.freeze([1, 99]),
  secrets: Object.freeze([100, 299]),
  advisory: Object.freeze([300, 399]),
  malicious: Object.freeze([400, 499]),
  misconfig: Object.freeze([500, 799]),
  license: Object.freeze([800, 899]),
  reviewer: Object.freeze([900, 999]),
});

const RULE_ID_RE = /^NP[SC]-\d{4}$/;
const BUILTIN_ID_RE = /^NPS-\d{4}$/;
const CUSTOM_ID_RE = /^NPC-\d{4}$/;
const CWE_RE = /^CWE-\d{1,5}$/;
const MAX_TITLE = 200;
const MAX_REMINDER = 1024;
const UNKNOWN_SEVERITY = 'high';

function isValidRuleId(id) {
  return typeof id === 'string' && RULE_ID_RE.test(id);
}

function isCustomRuleId(id) {
  return typeof id === 'string' && CUSTOM_ID_RE.test(id);
}

function idInRange(id, scanner) {
  const range = ID_RANGES[scanner];
  if (!range || typeof id !== 'string' || !BUILTIN_ID_RE.test(id)) return false;
  const n = Number(id.slice(4));
  return n >= range[0] && n <= range[1];
}

function customRuleId(ruleName) {
  const digest = crypto.createHash('sha256').update(String(ruleName == null ? '' : ruleName)).digest();
  return 'NPC-' + String(digest.readUInt16BE(0) % 10000).padStart(4, '0');
}

function normalizeSeverity(raw) {
  const v = String(raw == null ? '' : raw).toLowerCase().trim();
  if (SEVERITY_RANK[v] !== undefined) return v;
  if (LEGACY_SEVERITY[v]) return LEGACY_SEVERITY[v];
  return UNKNOWN_SEVERITY;
}

function toLegacySeverity(severity) {
  return SEVERITY_RANK[normalizeSeverity(severity)] >= SEVERITY_RANK.high ? 'risk' : 'warn';
}

function atLeast(severity, minimum) {
  return SEVERITY_RANK[normalizeSeverity(severity)] >= SEVERITY_RANK[normalizeSeverity(minimum)];
}

function _clamp(value, max) {
  if (typeof value !== 'string' || value === '') return null;
  return Buffer.byteLength(value, 'utf-8') > max
    ? Buffer.from(value, 'utf-8').slice(0, max).toString('utf-8')
    : value;
}

function _cwes(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const out = [];
  for (const entry of list) {
    const id = String(entry || '').toUpperCase().trim();
    if (CWE_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function _pkg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : null;
  if (!name) return null;
  return {
    name,
    version: typeof raw.version === 'string' && raw.version ? raw.version : null,
    ecosystem: typeof raw.ecosystem === 'string' && raw.ecosystem ? raw.ecosystem : null,
  };
}

function make(fields) {
  const f = fields || {};
  if (!isValidRuleId(f.id)) {
    throw new NubosPilotError(
      'scan-finding-invalid-id',
      'finding id must match NPS-#### (got: ' + JSON.stringify(f.id) + ')',
      { id: f.id },
    );
  }
  const scanner = SCANNERS.includes(f.scanner) ? f.scanner : null;
  if (!scanner) {
    throw new NubosPilotError(
      'scan-finding-invalid-scanner',
      'finding scanner must be one of ' + SCANNERS.join('|') + ' (got: ' + JSON.stringify(f.scanner) + ')',
      { scanner: f.scanner, valid: SCANNERS },
    );
  }
  return {
    id: f.id,
    rule_name: typeof f.rule_name === 'string' && f.rule_name ? f.rule_name : f.id,
    scanner,
    source: SOURCES.includes(f.source) ? f.source : 'builtin',
    category: typeof f.category === 'string' && f.category ? f.category : 'unspecified',
    severity: normalizeSeverity(f.severity),
    cwe: _cwes(f.cwe),
    file: typeof f.file === 'string' && f.file ? f.file : null,
    line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
    title: _clamp(f.title, MAX_TITLE),
    reminder: _clamp(f.reminder, MAX_REMINDER),
    package: _pkg(f.package),
    fixed_version: typeof f.fixed_version === 'string' && f.fixed_version ? f.fixed_version : null,
  };
}

function fingerprint(f) {
  const o = f || {};
  const pkg = _pkg(o.package);
  return [
    String(o.file || ''),
    String(o.line == null ? '' : o.line),
    String(o.category || ''),
    String(o.id || o.rule_name || o.title || ''),
    pkg ? pkg.name + '@' + (pkg.version || '') : '',
  ].join('|');
}

function sortFindings(findings) {
  return (Array.isArray(findings) ? findings.slice() : []).sort((a, b) => {
    const rank = SEVERITY_RANK[normalizeSeverity(b.severity)] - SEVERITY_RANK[normalizeSeverity(a.severity)];
    if (rank !== 0) return rank;
    return String(a.file || '').localeCompare(String(b.file || ''))
      || (a.line || 0) - (b.line || 0)
      || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function envelope(findings, opts) {
  const o = opts || {};
  const minimum = o.minSeverity ? normalizeSeverity(o.minSeverity) : 'info';
  const gating = sortFindings(findings).filter((f) => atLeast(f.severity, minimum));
  return {
    allow: gating.length === 0,
    denials: gating.map((f) => ({
      id: f.id,
      msg: (f.title || f.rule_name || f.id) + (f.file ? ' (' + f.file + (f.line ? ':' + f.line : '') + ')' : ''),
    })),
  };
}

module.exports = {
  SEVERITIES,
  SEVERITY_RANK,
  SCANNERS,
  SOURCES,
  ID_RANGES,
  RULE_ID_RE,
  BUILTIN_ID_RE,
  CUSTOM_ID_RE,
  UNKNOWN_SEVERITY,
  isValidRuleId,
  isCustomRuleId,
  idInRange,
  customRuleId,
  normalizeSeverity,
  toLegacySeverity,
  atLeast,
  make,
  fingerprint,
  sortFindings,
  envelope,
};
