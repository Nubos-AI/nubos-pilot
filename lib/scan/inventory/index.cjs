'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('../../core.cjs');
const { DEFAULT_DIR_EXCLUDES } = require('../walk.cjs');
const { _globToRegExp } = require('../../security/scan.cjs');
const pkgurl = require('./pkgurl.cjs');

const PARSERS = Object.freeze([
  require('./npm.cjs'),
  require('./python.cjs'),
  require('./go.cjs'),
  require('./cargo.cjs'),
  require('./composer.cjs'),
  require('./ruby.cjs'),
  require('./maven.cjs'),
]);

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFESTS = 200;
const MAX_DEPTH = 12;

const REQUIREMENTS_NAME_RE = /requirements/i;
const REQUIREMENTS_DIR_RE = /(?:^|\/)requirements\//i;

function _byFile() {
  const map = new Map();
  for (const parser of PARSERS) {
    for (const basename of parser.FILES || []) {
      if (!map.has(basename)) map.set(basename, parser);
    }
  }
  return map;
}

const BY_FILE = _byFile();

function _pythonParser() {
  for (const parser of PARSERS) {
    if ((parser.FILES || []).includes('requirements.txt')) return parser;
  }
  return null;
}

function parserFor(relPath) {
  const posix = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  const basename = posix.slice(posix.lastIndexOf('/') + 1);
  const direct = BY_FILE.get(basename);
  if (direct) return direct;
  if (!basename.toLowerCase().endsWith('.txt')) return null;
  if (REQUIREMENTS_NAME_RE.test(basename) || REQUIREMENTS_DIR_RE.test(posix)) return _pythonParser();
  return null;
}

function _excludeMatchers(excludes) {
  const globs = Array.isArray(excludes) ? excludes : DEFAULT_DIR_EXCLUDES;
  const matchers = [];
  for (const glob of globs) {
    if (typeof glob !== 'string' || !glob) continue;
    try { matchers.push(_globToRegExp(glob)); } catch {}
  }
  return { globs, matchers };
}

function _isExcluded(relPath, name, exclude) {
  if (exclude.globs.includes(name)) return true;
  for (const re of exclude.matchers) {
    if (re.test(relPath)) return true;
  }
  return false;
}

function discover(root, opts) {
  const o = opts || {};
  if (typeof root !== 'string' || !root) {
    throw new NubosPilotError('inventory-missing-root', 'discover requires a root directory', {});
  }
  const exclude = _excludeMatchers(o.exclude);
  const found = [];
  const warnings = [];
  const stack = [{ dir: root, rel: '', depth: 0 }];

  while (stack.length) {
    const { dir, rel, depth } = stack.pop();
    if (depth > MAX_DEPTH) {
      warnings.push('max-depth-reached');
      continue;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { warnings.push('unreadable-directory'); continue; }

    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      const relPath = rel ? rel + '/' + entry.name : entry.name;
      if (_isExcluded(relPath, entry.name, exclude)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ dir: path.join(dir, entry.name), rel: relPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const parser = parserFor(relPath);
      if (!parser) continue;
      if (found.length >= MAX_MANIFESTS) {
        warnings.push('max-manifests-reached');
        return { manifests: found, warnings: [...new Set(warnings)] };
      }
      found.push({ relPath, absPath: path.join(dir, entry.name), basename: entry.name });
    }
  }

  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { manifests: found, warnings: [...new Set(warnings)] };
}

function _readManifest(absPath, warnings) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch { warnings.push('unreadable-manifest'); return null; }
  if (stat.size > MAX_MANIFEST_BYTES) {
    warnings.push('manifest-too-large');
    return null;
  }
  try { return fs.readFileSync(absPath, 'utf-8'); }
  catch { warnings.push('unreadable-manifest'); return null; }
}

function collect(root, opts) {
  const o = opts || {};
  const { manifests, warnings: discoveryWarnings } = discover(root, o);
  const warnings = [...discoveryWarnings];
  const perFile = [];
  const all = [];

  for (const manifest of manifests) {
    const parser = parserFor(manifest.relPath);
    if (!parser) continue;
    const content = _readManifest(manifest.absPath, warnings);
    if (content == null) continue;

    let result;
    try { result = parser.parse(content, { file: manifest.relPath }); }
    catch (err) {
      warnings.push('parser-threw');
      perFile.push({ file: manifest.relPath, packages: 0, warnings: ['parser-threw'], error: err && err.code });
      continue;
    }
    const packages = Array.isArray(result && result.packages) ? result.packages : [];
    const fileWarnings = Array.isArray(result && result.warnings) ? result.warnings : [];
    for (const w of fileWarnings) warnings.push(w);
    all.push(...packages);
    perFile.push({ file: manifest.relPath, packages: packages.length, warnings: fileWarnings });
  }

  const packages = pkgurl.dedupe(all);
  return {
    root,
    packages,
    files: perFile,
    warnings: [...new Set(warnings)],
    ecosystems: [...new Set(packages.map((p) => p.ecosystem))].sort(),
    counts: _counts(packages),
  };
}

function _counts(packages) {
  const byScope = { prod: 0, dev: 0, optional: 0, unknown: 0 };
  const byEcosystem = {};
  let direct = 0;
  let versioned = 0;
  for (const p of packages) {
    byScope[p.scope] = (byScope[p.scope] || 0) + 1;
    byEcosystem[p.ecosystem] = (byEcosystem[p.ecosystem] || 0) + 1;
    if (p.direct) direct += 1;
    if (p.version) versioned += 1;
  }
  return { total: packages.length, direct, versioned, by_scope: byScope, by_ecosystem: byEcosystem };
}

function byEcosystem(packages) {
  const map = new Map();
  for (const p of Array.isArray(packages) ? packages : []) {
    if (!p || !p.ecosystem) continue;
    if (!map.has(p.ecosystem)) map.set(p.ecosystem, []);
    map.get(p.ecosystem).push(p);
  }
  return map;
}

function gatable(packages, ignoreScopes) {
  const ignored = new Set(Array.isArray(ignoreScopes) ? ignoreScopes : []);
  return (Array.isArray(packages) ? packages : []).filter((p) => p && !ignored.has(p.scope));
}

module.exports = {
  PARSERS,
  MAX_MANIFEST_BYTES,
  MAX_MANIFESTS,
  MAX_DEPTH,
  parserFor,
  discover,
  collect,
  byEcosystem,
  gatable,
};
