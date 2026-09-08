'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { NubosPilotError } = require('../../core.cjs');
const { idInRange, SEVERITIES } = require('../finding.cjs');
const { makePackage } = require('../inventory/pkgurl.cjs');
const { RULES, DEFAULT_POLICY, checkInventory } = require('./index.cjs');

function pkg(fields) {
  return makePackage({
    ecosystem: 'npm',
    name: 'left-pad',
    version: '1.3.0',
    source: 'package-lock.json',
    ...fields,
  });
}

function inventory(packages) {
  return { packages };
}

function names(findings) {
  return findings.map((f) => f.rule_name);
}

test('LIC-1 every rule id is unique and inside the license range', () => {
  const rules = Object.values(RULES);
  assert.ok(rules.length >= 6);
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique: ' + ids.join(','));
  assert.equal(new Set(rules.map((r) => r.rule_name)).size, rules.length);
  for (const rule of rules) {
    assert.ok(idInRange(rule.id, 'license'), rule.id + ' must be in the license range');
    assert.ok(SEVERITIES.includes(rule.severity), rule.id + ' severity ' + rule.severity);
    assert.ok(Array.isArray(rule.cwe), rule.id + ' cwe must be an array');
    assert.ok(rule.reminder.length > 20, rule.id + ' needs a real reminder');
    assert.ok(Object.isFrozen(rule));
  }
  assert.ok(Object.isFrozen(RULES));
});

test('LIC-2 DEFAULT_POLICY is frozen and conservative', () => {
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.equal(DEFAULT_POLICY.allow, null);
  assert.deepEqual([...DEFAULT_POLICY.deny], ['strong-copyleft', 'network-copyleft']);
  assert.deepEqual([...DEFAULT_POLICY.denyIds], []);
  assert.deepEqual([...DEFAULT_POLICY.allowIds], []);
  assert.equal(DEFAULT_POLICY.warnUnknown, true);
  assert.deepEqual([...DEFAULT_POLICY.ignoreScopes], ['dev']);
});

test('LIC-3 permissive dependencies produce no findings by default', () => {
  const result = checkInventory(inventory([
    pkg({ name: 'left-pad', license: 'MIT' }),
    pkg({ name: 'inherits', license: 'ISC' }),
    pkg({ name: 'aws-sdk', license: 'Apache-2.0' }),
    pkg({ name: 'tweetnacl', license: 'Unlicense' }),
  ]), null);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.evaluated, 4);
  assert.equal(result.summary.categories.permissive, 3);
  assert.equal(result.summary.categories['public-domain'], 1);
});

test('LIC-4 a denied category is a high finding with full package context', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'gpl-thing', version: '2.1.0', license: 'GPL-3.0-only', source: 'package.json' }),
  ]));
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.id, RULES.deniedCategory.id);
  assert.equal(finding.rule_name, 'license_denied_category');
  assert.equal(finding.scanner, 'license');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.file, 'package.json');
  assert.equal(finding.line, null);
  assert.deepEqual(finding.cwe, []);
  assert.deepEqual(finding.package, { name: 'gpl-thing', version: '2.1.0', ecosystem: 'npm' });
  assert.match(finding.title, /GPL-3\.0-only/);
});

test('LIC-5 network copyleft is denied by default', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'agpl-thing', license: 'AGPL-3.0-or-later' }),
  ]));
  assert.deepEqual(names(findings), ['license_denied_category']);
  assert.match(findings[0].title, /network-copyleft/);
});

test('LIC-6 OR is satisfied when any branch is allowed', () => {
  const result = checkInventory(inventory([
    pkg({ name: 'dual', license: 'MIT OR GPL-3.0-only' }),
    pkg({ name: 'dual-reversed', license: 'AGPL-3.0-only OR Apache-2.0' }),
    pkg({ name: 'dual-parens', license: '(MIT OR GPL-2.0-only)' }),
  ]));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.categories.permissive, 3);
});

test('LIC-7 OR is denied only when every branch is denied', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'both-bad', license: 'GPL-3.0-only OR AGPL-3.0-only' }),
  ]));
  assert.equal(findings.length, 2);
  assert.deepEqual(new Set(names(findings)), new Set(['license_denied_category']));
});

test('LIC-8 AND requires every id to be allowed', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'combined', license: 'MIT AND GPL-3.0-only' }),
  ]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_name, 'license_denied_category');
  assert.match(findings[0].title, /GPL-3\.0-only/);
  assert.doesNotMatch(findings[0].title, /MIT/);
});

test('LIC-9 denyIds beats a category that would otherwise be allowed', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'left-pad', license: 'MIT' }),
    pkg({ name: 'inherits', license: 'ISC' }),
  ]), { denyIds: ['MIT'] });
  assert.deepEqual(names(findings), ['license_denied_id']);
  assert.equal(findings[0].id, RULES.deniedId.id);
  assert.equal(findings[0].package.name, 'left-pad');
});

test('LIC-10 denyIds accepts non-canonical spellings', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'apache-thing', license: 'Apache-2.0' }),
  ]), { denyIds: ['apache 2.0'] });
  assert.deepEqual(names(findings), ['license_denied_id']);
});

test('LIC-11 allowIds beats a denied category', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'gpl-thing', license: 'GPL-3.0-only' }),
  ]), { allowIds: ['GPL-3.0-only'] });
  assert.deepEqual(findings, []);
});

test('LIC-12 an explicit allow list rejects everything outside it', () => {
  const policy = { allow: ['permissive', 'public-domain'] };
  const { findings } = checkInventory(inventory([
    pkg({ name: 'left-pad', license: 'MIT' }),
    pkg({ name: 'weak', license: 'MPL-2.0' }),
  ]), policy);
  assert.deepEqual(names(findings), ['license_denied_category']);
  assert.equal(findings[0].package.name, 'weak');
  assert.match(findings[0].title, /weak-copyleft/);
});

test('LIC-13 ignoreScopes suppresses dev dependencies by default', () => {
  const packages = [
    pkg({ name: 'gpl-dev-tool', license: 'GPL-3.0-only', scope: 'dev' }),
    pkg({ name: 'left-pad', license: 'MIT', scope: 'prod' }),
  ];
  const quiet = checkInventory(inventory(packages));
  assert.deepEqual(quiet.findings, []);
  assert.equal(quiet.summary.packages, 2);
  assert.equal(quiet.summary.evaluated, 1);
  assert.equal(quiet.summary.ignored, 1);

  const loud = checkInventory(inventory(packages), { ignoreScopes: [] });
  assert.deepEqual(names(loud.findings), ['license_denied_category']);
  assert.equal(loud.summary.evaluated, 2);
  assert.equal(loud.summary.ignored, 0);
});

test('LIC-14 a missing license is a low finding', () => {
  const { findings, summary } = checkInventory(inventory([
    pkg({ name: 'no-license', license: null }),
    pkg({ name: 'blank-license', license: '   ' }),
  ]));
  assert.deepEqual(names(findings), ['license_missing', 'license_missing']);
  assert.equal(findings[0].severity, 'low');
  assert.equal(findings[0].id, RULES.missing.id);
  assert.equal(summary.categories.unknown, 2);
});

test('LIC-15 UNLICENSED is reported as proprietary at medium severity', () => {
  const { findings, summary } = checkInventory(inventory([
    pkg({ name: 'internal-app', license: 'UNLICENSED' }),
  ]));
  assert.deepEqual(names(findings), ['license_proprietary']);
  assert.equal(findings[0].severity, 'medium');
  assert.equal(summary.categories.proprietary, 1);

  const strict = checkInventory(inventory([
    pkg({ name: 'internal-app', license: 'UNLICENSED' }),
  ]), { deny: ['proprietary'] });
  assert.deepEqual(names(strict.findings), ['license_denied_category']);
});

test('LIC-16 unresolvable licenses warn once and can be silenced', () => {
  const packages = [
    pkg({ name: 'weird', license: 'Frobnicate-1.0' }),
    pkg({ name: 'file-ref', license: 'SEE LICENSE IN LICENSE.md' }),
  ];
  const warned = checkInventory(inventory(packages));
  assert.deepEqual(names(warned.findings), ['license_unknown', 'license_unknown']);
  assert.equal(warned.findings[0].severity, 'low');
  assert.equal(warned.summary.categories.unknown, 2);

  const silent = checkInventory(inventory(packages), { warnUnknown: false });
  assert.deepEqual(silent.findings, []);
  assert.equal(silent.summary.categories.unknown, 2);
});

test('LIC-17 an OR expression with an unknown branch does not warn', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'dual', license: 'MIT OR Frobnicate-1.0' }),
  ]));
  assert.deepEqual(findings, []);
});

test('LIC-18 a deprecated SPDX id is an info finding alongside the policy verdict', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'gpl-thing', license: 'GPL-3.0' }),
  ]));
  assert.deepEqual(new Set(names(findings)), new Set(['license_denied_category', 'license_deprecated_id']));
  const deprecated = findings.find((f) => f.rule_name === 'license_deprecated_id');
  assert.equal(deprecated.severity, 'info');
  assert.equal(deprecated.id, RULES.deprecatedId.id);
  assert.match(deprecated.title, /GPL-3\.0-only/);

  const allowed = checkInventory(inventory([
    pkg({ name: 'lgpl-thing', license: 'LGPL-2.1' }),
  ]));
  assert.deepEqual(names(allowed.findings), ['license_deprecated_id']);
});

test('LIC-19 findings come back sorted by severity', () => {
  const { findings } = checkInventory(inventory([
    pkg({ name: 'weird', license: 'Frobnicate-1.0' }),
    pkg({ name: 'gpl-thing', license: 'GPL-3.0-only' }),
    pkg({ name: 'internal-app', license: 'UNLICENSED' }),
  ]));
  assert.deepEqual(findings.map((f) => f.severity), ['high', 'medium', 'low']);
});

test('LIC-20 summary reports totals and every category key', () => {
  const { findings, summary } = checkInventory(inventory([
    pkg({ name: 'left-pad', license: 'MIT' }),
    pkg({ name: 'weak', license: 'MPL-2.0' }),
    pkg({ name: 'gpl-thing', license: 'GPL-2.0-or-later' }),
    pkg({ name: 'agpl-thing', license: 'AGPL-3.0-only' }),
    pkg({ name: 'zero', license: '0BSD' }),
    pkg({ name: 'internal-app', license: 'UNLICENSED' }),
    pkg({ name: 'weird', license: 'Frobnicate-1.0' }),
    pkg({ name: 'dev-tool', license: 'GPL-3.0-only', scope: 'dev' }),
  ]));
  assert.equal(summary.packages, 8);
  assert.equal(summary.evaluated, 7);
  assert.equal(summary.ignored, 1);
  assert.deepEqual(summary.categories, {
    permissive: 1,
    'weak-copyleft': 1,
    'strong-copyleft': 1,
    'network-copyleft': 1,
    'public-domain': 1,
    proprietary: 1,
    unknown: 1,
  });
  assert.equal(summary.findings, findings.length);
  assert.equal(summary.findings, 4);
});

test('LIC-21 an invalid inventory or policy raises a NubosPilotError', () => {
  assert.throws(() => checkInventory(null), (err) => {
    assert.ok(err instanceof NubosPilotError);
    assert.equal(err.code, 'license-invalid-inventory');
    return true;
  });
  assert.throws(() => checkInventory({ packages: 'nope' }), NubosPilotError);
  assert.throws(
    () => checkInventory(inventory([]), { deny: ['viral'] }),
    (err) => {
      assert.equal(err.code, 'license-unknown-category');
      return true;
    },
  );
  assert.throws(
    () => checkInventory(inventory([]), { allow: 'permissive' }),
    (err) => {
      assert.equal(err.code, 'license-invalid-policy');
      return true;
    },
  );
});

test('LIC-22 malformed package records are skipped, not thrown on', () => {
  const { findings, summary } = checkInventory(inventory([
    null,
    { name: '' },
    pkg({ name: 'gpl-thing', license: 'GPL-3.0-only' }),
  ]));
  assert.deepEqual(names(findings), ['license_denied_category']);
  assert.equal(summary.packages, 3);
  assert.equal(summary.evaluated, 1);
  assert.equal(summary.ignored, 2);
});
