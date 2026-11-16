'use strict';

const { NubosPilotError } = require('../../core.cjs');

const CATEGORIES = Object.freeze([
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'public-domain',
  'proprietary',
  'unknown',
]);

const RESTRICTIVENESS = Object.freeze({
  'public-domain': 0,
  permissive: 1,
  'weak-copyleft': 2,
  'strong-copyleft': 3,
  'network-copyleft': 4,
  proprietary: 5,
  unknown: 6,
});

const LICENSES = Object.freeze({
  '0BSD': 'public-domain',
  'CC0-1.0': 'public-domain',
  Unlicense: 'public-domain',
  WTFPL: 'public-domain',

  MIT: 'permissive',
  'MIT-0': 'permissive',
  X11: 'permissive',
  ISC: 'permissive',
  'BSD-2-Clause': 'permissive',
  'BSD-3-Clause': 'permissive',
  'BSD-4-Clause': 'permissive',
  'Apache-1.1': 'permissive',
  'Apache-2.0': 'permissive',
  'BSL-1.0': 'permissive',
  'Artistic-2.0': 'permissive',
  Zlib: 'permissive',
  'Python-2.0': 'permissive',
  'PSF-2.0': 'permissive',
  PostgreSQL: 'permissive',
  NCSA: 'permissive',
  Ruby: 'permissive',
  'OFL-1.1': 'permissive',
  'CC-BY-3.0': 'permissive',
  'CC-BY-4.0': 'permissive',

  'MPL-1.1': 'weak-copyleft',
  'MPL-2.0': 'weak-copyleft',
  'EPL-1.0': 'weak-copyleft',
  'EPL-2.0': 'weak-copyleft',
  'CDDL-1.0': 'weak-copyleft',
  'CDDL-1.1': 'weak-copyleft',
  'MS-PL': 'weak-copyleft',
  'LGPL-2.0-only': 'weak-copyleft',
  'LGPL-2.0-or-later': 'weak-copyleft',
  'LGPL-2.1-only': 'weak-copyleft',
  'LGPL-2.1-or-later': 'weak-copyleft',
  'LGPL-3.0-only': 'weak-copyleft',
  'LGPL-3.0-or-later': 'weak-copyleft',
  'CC-BY-SA-3.0': 'weak-copyleft',
  'CC-BY-SA-4.0': 'weak-copyleft',

  'GPL-1.0-only': 'strong-copyleft',
  'GPL-1.0-or-later': 'strong-copyleft',
  'GPL-2.0-only': 'strong-copyleft',
  'GPL-2.0-or-later': 'strong-copyleft',
  'GPL-3.0-only': 'strong-copyleft',
  'GPL-3.0-or-later': 'strong-copyleft',

  'AGPL-1.0-only': 'network-copyleft',
  'AGPL-1.0-or-later': 'network-copyleft',
  'AGPL-3.0-only': 'network-copyleft',
  'AGPL-3.0-or-later': 'network-copyleft',
  'SSPL-1.0': 'network-copyleft',
  'OSL-3.0': 'network-copyleft',

  UNLICENSED: 'proprietary',
  'BUSL-1.1': 'proprietary',
  'Elastic-2.0': 'proprietary',
});

const DEPRECATED = Object.freeze({
  'GPL-1.0': 'GPL-1.0-only',
  'GPL-2.0': 'GPL-2.0-only',
  'GPL-3.0': 'GPL-3.0-only',
  'LGPL-2.0': 'LGPL-2.0-only',
  'LGPL-2.1': 'LGPL-2.1-only',
  'LGPL-3.0': 'LGPL-3.0-only',
  'AGPL-1.0': 'AGPL-1.0-only',
  'AGPL-3.0': 'AGPL-3.0-only',
  Nunit: 'Zlib',
});

const ALIASES = Object.freeze({
  'mit-license': 'MIT',
  'mit-licence': 'MIT',
  'the-mit-license': 'MIT',
  'the-mit-license-mit': 'MIT',
  expat: 'MIT',
  'isc-license': 'ISC',
  'apache-2': 'Apache-2.0',
  apache2: 'Apache-2.0',
  'asl-2.0': 'Apache-2.0',
  'apache-license': 'Apache-2.0',
  'apache-license-2': 'Apache-2.0',
  'apache-license-2.0': 'Apache-2.0',
  'apache-license-version-2.0': 'Apache-2.0',
  'apache-software-license': 'Apache-2.0',
  'apache-software-license-2.0': 'Apache-2.0',
  bsd: 'BSD-3-Clause',
  'bsd-3': 'BSD-3-Clause',
  'bsd-license': 'BSD-3-Clause',
  'new-bsd': 'BSD-3-Clause',
  'new-bsd-license': 'BSD-3-Clause',
  'modified-bsd': 'BSD-3-Clause',
  '3-clause-bsd': 'BSD-3-Clause',
  'bsd-2': 'BSD-2-Clause',
  '2-clause-bsd': 'BSD-2-Clause',
  'simplified-bsd': 'BSD-2-Clause',
  freebsd: 'BSD-2-Clause',
  'old-bsd': 'BSD-4-Clause',
  'original-bsd': 'BSD-4-Clause',
  'zlib-license': 'Zlib',
  'the-unlicense': 'Unlicense',
  cc0: 'CC0-1.0',
  'cc0-1.0-universal': 'CC0-1.0',
  'mpl-2': 'MPL-2.0',
  'mozilla-public-license-2.0': 'MPL-2.0',
  'epl-2': 'EPL-2.0',
  'eclipse-public-license-2.0': 'EPL-2.0',
  'boost-software-license-1.0': 'BSL-1.0',
  'artistic-license-2.0': 'Artistic-2.0',
  'microsoft-public-license': 'MS-PL',
  psf: 'PSF-2.0',
  'python-software-foundation-license': 'PSF-2.0',
  'do-what-the-fuck-you-want-to-public-license': 'WTFPL',
});

const OPERATORS = Object.freeze(['AND', 'OR', 'WITH']);

const SEE_LICENSE_RE = /^see\s+licen[cs]e(\s|$)/i;

const RANK_TO_CATEGORY = Object.freeze(Object.fromEntries(
  CATEGORIES.map((category) => [RESTRICTIVENESS[category], category]),
));

function _key(raw) {
  return String(raw).trim().toLowerCase().replace(/,/g, ' ').replace(/[\s_]+/g, '-');
}

const CANONICAL = Object.freeze(Object.fromEntries(
  Object.keys(LICENSES).map((id) => [_key(id), id]),
));

const DEPRECATED_INDEX = Object.freeze(Object.fromEntries(
  Object.entries(DEPRECATED).map(([id, replacement]) => [_key(id), replacement]),
));

function _orLater(key) {
  return key.endsWith('+') ? CANONICAL[key.slice(0, -1) + '-or-later'] : undefined;
}

function normalizeId(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const key = _key(trimmed);
  return CANONICAL[key]
    || DEPRECATED_INDEX[key]
    || ALIASES[key]
    || _orLater(key)
    || trimmed;
}

function isDeprecated(raw) {
  if (raw == null) return false;
  const key = _key(raw);
  if (!key) return false;
  return Boolean(DEPRECATED_INDEX[key] || _orLater(key));
}

function parseExpression(raw) {
  const trimmed = raw == null ? '' : String(raw).trim();
  const ids = [];
  const operators = [];
  const exceptions = [];
  const deprecated = [];
  if (!trimmed || SEE_LICENSE_RE.test(trimmed)) return { ids, operators, exceptions, deprecated };

  const tokens = trimmed.replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean);
  let depth = 0;
  let pendingException = false;
  for (const token of tokens) {
    if (token === '(') {
      depth += 1;
      continue;
    }
    if (token === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new NubosPilotError(
          'license-unbalanced-expression',
          'unbalanced parentheses in license expression: ' + JSON.stringify(trimmed),
          { expression: trimmed },
        );
      }
      continue;
    }
    const upper = token.toUpperCase();
    if (OPERATORS.includes(upper)) {
      if (!operators.includes(upper)) operators.push(upper);
      pendingException = upper === 'WITH';
      continue;
    }
    if (pendingException) {
      pendingException = false;
      if (!exceptions.includes(token)) exceptions.push(token);
      continue;
    }
    if (isDeprecated(token) && !deprecated.includes(token)) deprecated.push(token);
    const id = normalizeId(token);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (depth !== 0) {
    throw new NubosPilotError(
      'license-unbalanced-expression',
      'unbalanced parentheses in license expression: ' + JSON.stringify(trimmed),
      { expression: trimmed },
    );
  }
  return { ids, operators, exceptions, deprecated };
}

function classify(raw) {
  if (raw == null) return 'unknown';
  const trimmed = String(raw).trim();
  if (!trimmed || SEE_LICENSE_RE.test(trimmed)) return 'unknown';

  const single = LICENSES[normalizeId(trimmed)];
  if (single) return single;

  const { ids, operators } = parseExpression(trimmed);
  if (!ids.length) return 'unknown';
  const ranks = ids.map((id) => RESTRICTIVENESS[LICENSES[id] || 'unknown']);
  return RANK_TO_CATEGORY[operators.includes('OR') ? Math.min(...ranks) : Math.max(...ranks)];
}

module.exports = {
  CATEGORIES,
  RESTRICTIVENESS,
  LICENSES,
  DEPRECATED,
  ALIASES,
  OPERATORS,
  normalizeId,
  classify,
  parseExpression,
  isDeprecated,
};
