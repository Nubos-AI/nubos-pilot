'use strict';

const path = require('node:path');

const { makePackage } = require('./pkgurl.cjs');

const FILES = Object.freeze(['composer.lock']);

const ECOSYSTEM = 'Packagist';

function warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function readLicense(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts = value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
  return parts.length ? parts.join(' OR ') : null;
}

function collect(entries, scope, source, packages, warnings) {
  if (entries == null) return;
  if (!Array.isArray(entries)) {
    warn(warnings, 'malformed-packages-section');
    return;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name.trim()) {
      warn(warnings, 'malformed-package');
      continue;
    }
    const version = typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : null;
    if (!version) warn(warnings, 'missing-version');
    try {
      packages.push(makePackage({
        ecosystem: ECOSYSTEM,
        name: entry.name.trim(),
        version,
        scope,
        direct: false,
        source,
        license: readLicense(entry.license),
      }));
    } catch {
      warn(warnings, 'invalid-package');
    }
  }
}

function parse(content, opts) {
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  if (path.basename(file) !== 'composer.lock') return { packages: [], warnings: ['unsupported-file'] };

  const warnings = [];
  let lock;
  try {
    lock = JSON.parse(typeof content === 'string' ? content : String(content == null ? '' : content));
  } catch {
    return { packages: [], warnings: ['invalid-json'] };
  }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return { packages: [], warnings: ['unexpected-lock-shape'] };
  }

  const source = file || null;
  const packages = [];
  collect(lock.packages, 'prod', source, packages, warnings);
  collect(lock['packages-dev'], 'dev', source, packages, warnings);
  return { packages, warnings };
}

module.exports = { FILES, parse };
