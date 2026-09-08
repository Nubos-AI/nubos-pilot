'use strict';

const { NubosPilotError } = require('../../core.cjs');
const { make, sortFindings } = require('../finding.cjs');
const {
  CATEGORIES, classify, parseExpression, normalizeId,
} = require('./spdx.cjs');

const SCANNER = 'license';

const RULES = Object.freeze({
  deniedCategory: Object.freeze({
    id: 'NPS-0801',
    rule_name: 'license_denied_category',
    category: 'license-policy',
    severity: 'high',
    cwe: Object.freeze([]),
    reminder: 'This license category is not allowed by the project policy. Replace the dependency, isolate it behind a service boundary, or record an approved exception.',
  }),
  deniedId: Object.freeze({
    id: 'NPS-0802',
    rule_name: 'license_denied_id',
    category: 'license-policy',
    severity: 'high',
    cwe: Object.freeze([]),
    reminder: 'This exact SPDX identifier is on the project deny list. Replace the dependency or move the identifier to allowIds with a written justification.',
  }),
  unknown: Object.freeze({
    id: 'NPS-0803',
    rule_name: 'license_unknown',
    category: 'license-unresolved',
    severity: 'low',
    cwe: Object.freeze([]),
    reminder: 'The declared license could not be resolved to a known SPDX identifier. Read the upstream LICENSE file and record the resolved identifier before shipping.',
  }),
  missing: Object.freeze({
    id: 'NPS-0804',
    rule_name: 'license_missing',
    category: 'license-unresolved',
    severity: 'low',
    cwe: Object.freeze([]),
    reminder: 'The package declares no license at all, which means no grant of use. Confirm the terms upstream or drop the dependency.',
  }),
  deprecatedId: Object.freeze({
    id: 'NPS-0805',
    rule_name: 'license_deprecated_id',
    category: 'license-hygiene',
    severity: 'info',
    cwe: Object.freeze([]),
    reminder: 'This SPDX identifier is deprecated because it is ambiguous about the "or later" option. Prefer the explicit -only or -or-later form.',
  }),
  proprietary: Object.freeze({
    id: 'NPS-0806',
    rule_name: 'license_proprietary',
    category: 'license-policy',
    severity: 'medium',
    cwe: Object.freeze([]),
    reminder: 'A proprietary or source-available dependency carries no open-source grant. Verify a commercial agreement covers this use before distribution.',
  }),
});

const DEFAULT_POLICY = Object.freeze({
  allow: null,
  deny: Object.freeze(['strong-copyleft', 'network-copyleft']),
  denyIds: Object.freeze([]),
  allowIds: Object.freeze([]),
  warnUnknown: true,
  ignoreScopes: Object.freeze(['dev']),
});

function _categoryList(value, field) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new NubosPilotError(
      'license-invalid-policy',
      'policy.' + field + ' must be an array of license categories or null',
      { field, value },
    );
  }
  for (const entry of value) {
    if (!CATEGORIES.includes(entry)) {
      throw new NubosPilotError(
        'license-unknown-category',
        'policy.' + field + ' names an unknown license category: ' + JSON.stringify(entry),
        { field, entry, valid: CATEGORIES },
      );
    }
  }
  return value.slice();
}

function _idList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new NubosPilotError(
      'license-invalid-policy',
      'policy.' + field + ' must be an array of SPDX identifiers',
      { field, value },
    );
  }
  const out = [];
  for (const entry of value) {
    const id = normalizeId(entry);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function _scopeList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new NubosPilotError(
      'license-invalid-policy',
      'policy.ignoreScopes must be an array of dependency scopes',
      { value },
    );
  }
  return value.filter((scope) => typeof scope === 'string' && scope);
}

function _resolvePolicy(policy) {
  const p = policy && typeof policy === 'object' ? policy : {};
  return {
    allow: p.allow === undefined ? DEFAULT_POLICY.allow : _categoryList(p.allow, 'allow'),
    deny: p.deny === undefined
      ? DEFAULT_POLICY.deny.slice()
      : (_categoryList(p.deny, 'deny') || []),
    denyIds: p.denyIds === undefined ? [] : _idList(p.denyIds, 'denyIds'),
    allowIds: p.allowIds === undefined ? [] : _idList(p.allowIds, 'allowIds'),
    warnUnknown: p.warnUnknown === undefined ? DEFAULT_POLICY.warnUnknown : p.warnUnknown === true,
    ignoreScopes: p.ignoreScopes === undefined
      ? DEFAULT_POLICY.ignoreScopes.slice()
      : _scopeList(p.ignoreScopes),
  };
}

function _evaluateId(id, policy) {
  const category = classify(id);
  if (policy.allowIds.includes(id)) return { id, category, allowed: true, reason: 'allow-id' };
  if (policy.denyIds.includes(id)) return { id, category, allowed: false, reason: 'deny-id' };
  if (policy.allow && !policy.allow.includes(category)) {
    return { id, category, allowed: false, reason: 'not-allowed' };
  }
  if (policy.deny.includes(category)) return { id, category, allowed: false, reason: 'deny-category' };
  return { id, category, allowed: true, reason: 'allowed' };
}

function _label(pkg) {
  return pkg.name + (pkg.version ? '@' + pkg.version : '');
}

function _finding(rule, pkg, title) {
  return make({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: SCANNER,
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe,
    file: pkg.source,
    line: null,
    title,
    reminder: rule.reminder,
    package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem },
    fixed_version: null,
  });
}

function _checkPackage(pkg, policy, findings) {
  const declared = typeof pkg.license === 'string' ? pkg.license.trim() : '';
  if (!declared) {
    findings.push(_finding(RULES.missing, pkg, _label(pkg) + ' declares no license'));
    return 'unknown';
  }

  const effective = classify(declared);
  const parsed = parseExpression(declared);
  const evaluated = parsed.ids.map((id) => _evaluateId(id, policy));
  const rejected = evaluated.filter((entry) => !entry.allowed);
  const compliant = parsed.operators.includes('OR')
    ? evaluated.some((entry) => entry.allowed)
    : rejected.length === 0;

  if (!compliant) {
    for (const entry of rejected) {
      const rule = entry.reason === 'deny-id' ? RULES.deniedId : RULES.deniedCategory;
      const detail = entry.reason === 'deny-id'
        ? entry.id
        : entry.id + ' (' + entry.category + ')';
      findings.push(_finding(
        rule,
        pkg,
        _label(pkg) + ' uses a disallowed license: ' + detail,
      ));
    }
  } else if (effective === 'proprietary') {
    findings.push(_finding(
      RULES.proprietary,
      pkg,
      _label(pkg) + ' is proprietary (' + declared + ')',
    ));
  }

  if (effective === 'unknown' && policy.warnUnknown) {
    findings.push(_finding(
      RULES.unknown,
      pkg,
      _label(pkg) + ' has an unrecognized license: ' + declared,
    ));
  }

  for (const token of parsed.deprecated) {
    findings.push(_finding(
      RULES.deprecatedId,
      pkg,
      _label(pkg) + ' uses the deprecated SPDX id ' + token + ' (use ' + normalizeId(token) + ')',
    ));
  }

  return effective;
}

function checkInventory(inventory, policy) {
  const inv = inventory && typeof inventory === 'object' ? inventory : {};
  if (!Array.isArray(inv.packages)) {
    throw new NubosPilotError(
      'license-invalid-inventory',
      'inventory.packages must be an array of package records',
      { got: inv.packages === undefined ? 'undefined' : typeof inv.packages },
    );
  }

  const resolved = _resolvePolicy(policy);
  const findings = [];
  const categories = {};
  for (const category of CATEGORIES) categories[category] = 0;

  let evaluated = 0;
  let ignored = 0;
  for (const pkg of inv.packages) {
    if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string' || !pkg.name) {
      ignored += 1;
      continue;
    }
    if (resolved.ignoreScopes.includes(pkg.scope)) {
      ignored += 1;
      continue;
    }
    evaluated += 1;
    categories[_checkPackage(pkg, resolved, findings)] += 1;
  }

  return {
    findings: sortFindings(findings),
    summary: {
      packages: inv.packages.length,
      evaluated,
      ignored,
      findings: findings.length,
      categories,
    },
  };
}

module.exports = {
  RULES,
  DEFAULT_POLICY,
  checkInventory,
};
