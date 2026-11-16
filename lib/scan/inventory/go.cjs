'use strict';

const path = require('node:path');

const { makePackage } = require('./pkgurl.cjs');

const FILES = Object.freeze(['go.mod', 'go.sum']);

const ECOSYSTEM = 'Go';

function warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function addPackage(packages, warnings, fields) {
  try {
    packages.push(makePackage(fields));
  } catch {
    warn(warnings, 'invalid-package');
  }
}

function splitComment(line) {
  const at = line.indexOf('//');
  if (at < 0) return { code: line, comment: '' };
  return { code: line.slice(0, at), comment: line.slice(at + 2) };
}

function collectRequire(body, comment, requires, warnings) {
  const fields = body.split(/\s+/).filter(Boolean);
  if (fields.length < 2 || !fields[0] || !fields[1]) {
    warn(warnings, 'malformed-require');
    return;
  }
  requires.set(fields[0], {
    version: fields[1],
    direct: !/\bindirect\b/.test(comment),
  });
}

function collectReplace(body, replacements, warnings) {
  const halves = body.split('=>');
  if (halves.length !== 2) {
    warn(warnings, 'malformed-replace');
    return;
  }
  const left = halves[0].split(/\s+/).filter(Boolean);
  const right = halves[1].split(/\s+/).filter(Boolean);
  if (left.length < 1 || right.length < 1) {
    warn(warnings, 'malformed-replace');
    return;
  }
  if (right.length >= 2) {
    replacements.set(left[0], right[1]);
    return;
  }
  replacements.set(left[0], null);
  warn(warnings, 'replaced-by-local-path');
}

function collectDirective(kind, body, comment, requires, replacements, warnings) {
  if (kind === 'exclude') return;
  if (kind === 'replace') {
    collectReplace(body, replacements, warnings);
    return;
  }
  collectRequire(body, comment, requires, warnings);
}

function parseGoMod(content, source, warnings) {
  const requires = new Map();
  const replacements = new Map();
  let block = null;

  for (const raw of content.split(/\r?\n/)) {
    const { code, comment } = splitComment(raw);
    const line = code.trim();
    if (!line) continue;

    if (block) {
      if (line === ')') {
        block = null;
        continue;
      }
      collectDirective(block, line, comment, requires, replacements, warnings);
      continue;
    }

    const opening = /^(require|replace|exclude)\s*\(\s*$/.exec(line);
    if (opening) {
      block = opening[1];
      continue;
    }

    const single = /^(require|replace|exclude)\s+(.+)$/.exec(line);
    if (single) collectDirective(single[1], single[2].trim(), comment, requires, replacements, warnings);
  }

  if (block) warn(warnings, 'unterminated-block');

  const packages = [];
  for (const [name, entry] of requires) {
    addPackage(packages, warnings, {
      ecosystem: ECOSYSTEM,
      name,
      version: replacements.has(name) ? replacements.get(name) : entry.version,
      scope: 'prod',
      direct: entry.direct,
      source,
    });
  }
  return packages;
}

function parseGoSum(content, source, warnings) {
  const seen = new Set();
  const packages = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split(/\s+/).filter(Boolean);
    if (fields.length < 3) {
      warn(warnings, 'malformed-sum-line');
      continue;
    }
    const name = fields[0];
    const version = fields[1].replace(/\/go\.mod$/, '');
    if (!name || !version) {
      warn(warnings, 'malformed-sum-line');
      continue;
    }
    const key = name + '@' + version;
    if (seen.has(key)) continue;
    seen.add(key);
    addPackage(packages, warnings, {
      ecosystem: ECOSYSTEM,
      name,
      version,
      scope: 'prod',
      direct: false,
      source,
    });
  }
  return packages;
}

function parse(content, opts) {
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  const basename = path.basename(file);
  const warnings = [];
  const text = typeof content === 'string' ? content : String(content == null ? '' : content);

  if (basename === 'go.mod') return { packages: parseGoMod(text, file || null, warnings), warnings };
  if (basename === 'go.sum') return { packages: parseGoSum(text, file || null, warnings), warnings };
  return { packages: [], warnings: ['unsupported-file'] };
}

module.exports = { FILES, parse };
