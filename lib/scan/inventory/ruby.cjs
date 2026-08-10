'use strict';

const path = require('node:path');

const { makePackage } = require('./pkgurl.cjs');

const FILES = Object.freeze(['Gemfile.lock']);

const ECOSYSTEM = 'RubyGems';

const SPEC_SECTIONS = Object.freeze(['GEM', 'PATH', 'GIT']);

function warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function indentOf(line) {
  const match = /^ */.exec(line);
  return match[0].length;
}

function dependencyName(line) {
  const first = line.trim().split(/\s+/)[0] || '';
  return first.replace(/!$/, '');
}

function parse(content, opts) {
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  if (path.basename(file) !== 'Gemfile.lock') return { packages: [], warnings: ['unsupported-file'] };

  const text = typeof content === 'string' ? content : String(content == null ? '' : content);
  const warnings = [];
  const specs = new Map();
  const direct = new Set();

  let section = null;
  let inSpecs = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const header = /^([A-Z][A-Z ]*)$/.exec(line);
    if (header) {
      section = header[1].trim();
      inSpecs = false;
      continue;
    }

    const indent = indentOf(line);

    if (section === 'DEPENDENCIES') {
      if (indent < 2) continue;
      const name = dependencyName(line);
      if (name) direct.add(name);
      continue;
    }

    if (!SPEC_SECTIONS.includes(section)) continue;

    if (indent === 2) {
      inSpecs = line.trim() === 'specs:';
      continue;
    }

    if (!inSpecs || indent !== 4) continue;

    const spec = /^ {4}(\S+) \(([^()]*)\)$/.exec(line);
    if (!spec) {
      warn(warnings, 'malformed-spec-line');
      continue;
    }
    const name = spec[1];
    const version = spec[2].trim() || null;
    if (!version) warn(warnings, 'missing-version');
    if (!specs.has(name)) specs.set(name, version);
  }

  const packages = [];
  for (const [name, version] of specs) {
    try {
      packages.push(makePackage({
        ecosystem: ECOSYSTEM,
        name,
        version,
        scope: 'unknown',
        direct: direct.has(name),
        source: file || null,
      }));
    } catch {
      warn(warnings, 'invalid-package');
    }
  }
  return { packages, warnings };
}

module.exports = { FILES, parse };
