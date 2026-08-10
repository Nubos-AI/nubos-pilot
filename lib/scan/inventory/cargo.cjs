'use strict';

const path = require('node:path');

const { makePackage } = require('./pkgurl.cjs');
const { parseToml } = require('./toml.cjs');

const FILES = Object.freeze(['Cargo.lock']);

const ECOSYSTEM = 'crates.io';

function warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function hasSource(entry) {
  return typeof entry.source === 'string' && entry.source.trim() !== '';
}

function readName(entry) {
  return typeof entry.name === 'string' ? entry.name.trim() : '';
}

function readVersion(entry) {
  if (typeof entry.version === 'string' && entry.version.trim()) return entry.version.trim();
  if (typeof entry.version === 'number' && Number.isFinite(entry.version)) return String(entry.version);
  return null;
}

function parse(content, opts) {
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  if (path.basename(file) !== 'Cargo.lock') return { packages: [], warnings: ['unsupported-file'] };

  const text = typeof content === 'string' ? content : String(content == null ? '' : content);
  const warnings = [];

  let lock;
  try {
    lock = parseToml(text);
  } catch {
    return { packages: [], warnings: ['invalid-toml'] };
  }

  const entries = lock && Array.isArray(lock.package) ? lock.package : null;
  if (!entries) return { packages: [], warnings: ['no-packages'] };

  const packages = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !readName(entry)) {
      warn(warnings, 'malformed-package');
      continue;
    }
    if (!hasSource(entry)) {
      warn(warnings, 'workspace-member');
      continue;
    }
    const version = readVersion(entry);
    if (!version) warn(warnings, 'missing-version');
    try {
      packages.push(makePackage({
        ecosystem: ECOSYSTEM,
        name: readName(entry),
        version,
        scope: 'prod',
        direct: false,
        source: file || null,
      }));
    } catch {
      warn(warnings, 'invalid-package');
    }
  }
  return { packages, warnings };
}

module.exports = { FILES, parse };
