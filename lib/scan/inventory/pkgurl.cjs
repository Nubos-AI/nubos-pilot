'use strict';

const { NubosPilotError } = require('../../core.cjs');

const ECOSYSTEMS = Object.freeze([
  'npm', 'PyPI', 'Go', 'crates.io', 'Maven', 'Packagist', 'RubyGems', 'NuGet',
]);

const PURL_TYPE = Object.freeze({
  npm: 'npm',
  PyPI: 'pypi',
  Go: 'golang',
  'crates.io': 'cargo',
  Maven: 'maven',
  Packagist: 'composer',
  RubyGems: 'gem',
  NuGet: 'nuget',
});

const TYPE_TO_ECOSYSTEM = Object.freeze(
  Object.fromEntries(Object.entries(PURL_TYPE).map(([eco, type]) => [type, eco])),
);

const SCOPES = Object.freeze(['prod', 'dev', 'optional', 'unknown']);

function isEcosystem(value) {
  return ECOSYSTEMS.includes(value);
}

function assertEcosystem(ecosystem) {
  if (!isEcosystem(ecosystem)) {
    throw new NubosPilotError(
      'inventory-unknown-ecosystem',
      'unknown ecosystem: ' + JSON.stringify(ecosystem),
      { ecosystem, valid: ECOSYSTEMS },
    );
  }
  return ecosystem;
}

function splitName(ecosystem, name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return { namespace: null, name: '' };
  if (ecosystem === 'npm' && raw.startsWith('@')) {
    const slash = raw.indexOf('/');
    if (slash > 1) return { namespace: raw.slice(0, slash), name: raw.slice(slash + 1) };
    return { namespace: null, name: raw };
  }
  if (ecosystem === 'Maven') {
    const colon = raw.indexOf(':');
    if (colon > 0) return { namespace: raw.slice(0, colon), name: raw.slice(colon + 1) };
    return { namespace: null, name: raw };
  }
  if (ecosystem === 'Go') {
    const slash = raw.lastIndexOf('/');
    if (slash > 0) return { namespace: raw.slice(0, slash), name: raw.slice(slash + 1) };
    return { namespace: null, name: raw };
  }
  return { namespace: null, name: raw };
}

function normalizeName(ecosystem, name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '';
  if (ecosystem === 'PyPI') return raw.toLowerCase().replace(/[-_.]+/g, '-');
  if (ecosystem === 'crates.io') return raw.toLowerCase().replace(/_/g, '-');
  if (ecosystem === 'NuGet' || ecosystem === 'Packagist') return raw.toLowerCase();
  if (ecosystem === 'npm') return raw.toLowerCase();
  return raw;
}

function _encodeSegment(s) {
  return encodeURIComponent(String(s)).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}

function purl(pkg) {
  const p = pkg || {};
  const ecosystem = assertEcosystem(p.ecosystem);
  const type = PURL_TYPE[ecosystem];
  const { namespace, name } = splitName(ecosystem, p.name);
  if (!name) {
    throw new NubosPilotError(
      'inventory-missing-package-name',
      'a package URL needs a name',
      { ecosystem, name: p.name },
    );
  }
  const head = namespace
    ? 'pkg:' + type + '/' + _encodeSegment(namespace) + '/' + _encodeSegment(name)
    : 'pkg:' + type + '/' + _encodeSegment(name);
  const version = p.version == null || p.version === '' ? null : String(p.version);
  return version ? head + '@' + _encodeSegment(version) : head;
}

function parsePurl(str) {
  const raw = String(str == null ? '' : str).trim();
  if (!raw.startsWith('pkg:')) return null;
  const body = raw.slice(4);
  const slash = body.indexOf('/');
  if (slash <= 0) return null;
  const type = body.slice(0, slash).toLowerCase();
  const ecosystem = TYPE_TO_ECOSYSTEM[type];
  if (!ecosystem) return null;

  let rest = body.slice(slash + 1);
  rest = rest.split('?')[0].split('#')[0];
  const at = rest.lastIndexOf('@');
  const version = at > 0 ? decodeURIComponent(rest.slice(at + 1)) : null;
  const nameParts = (at > 0 ? rest.slice(0, at) : rest).split('/').filter(Boolean).map(decodeURIComponent);
  if (nameParts.length === 0) return null;

  const name = nameParts.pop();
  const namespace = nameParts.length ? nameParts.join('/') : null;
  return { ecosystem, namespace, name, version };
}

function makePackage(fields) {
  const f = fields || {};
  const ecosystem = assertEcosystem(f.ecosystem);
  const name = String(f.name == null ? '' : f.name).trim();
  if (!name) {
    throw new NubosPilotError(
      'inventory-missing-package-name',
      'an inventory entry needs a name',
      { ecosystem },
    );
  }
  const version = f.version == null || f.version === '' ? null : String(f.version);
  return {
    ecosystem,
    name,
    key: normalizeName(ecosystem, name),
    version,
    purl: purl({ ecosystem, name, version }),
    scope: SCOPES.includes(f.scope) ? f.scope : 'unknown',
    direct: f.direct === true,
    source: typeof f.source === 'string' && f.source ? f.source : null,
    license: typeof f.license === 'string' && f.license ? f.license : null,
  };
}

function dedupe(packages) {
  const byPurl = new Map();
  for (const pkg of Array.isArray(packages) ? packages : []) {
    if (!pkg || !pkg.purl) continue;
    const prior = byPurl.get(pkg.purl);
    if (!prior) { byPurl.set(pkg.purl, pkg); continue; }
    if (prior.scope === 'unknown' && pkg.scope !== 'unknown') prior.scope = pkg.scope;
    else if (prior.scope === 'dev' && pkg.scope === 'prod') prior.scope = 'prod';
    if (!prior.direct && pkg.direct) prior.direct = true;
    if (!prior.license && pkg.license) prior.license = pkg.license;
  }
  return [...byPurl.values()].sort((a, b) => a.purl.localeCompare(b.purl));
}

module.exports = {
  ECOSYSTEMS,
  PURL_TYPE,
  TYPE_TO_ECOSYSTEM,
  SCOPES,
  isEcosystem,
  assertEcosystem,
  splitName,
  normalizeName,
  purl,
  parsePurl,
  makePackage,
  dedupe,
};
