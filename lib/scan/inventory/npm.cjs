'use strict';

const { NubosPilotError } = require('../../core.cjs');
const { safeYamlParse } = require('../../yaml.cjs');
const { makePackage, dedupe } = require('./pkgurl.cjs');

const FILES = Object.freeze(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const ECOSYSTEM = 'npm';
const NODE_MODULES = 'node_modules/';
const MAX_TREE_DEPTH = 64;
const REGISTRY_HOST = /^[^@/\s]+\.[^@/\s]+$/;
const YARN_BERRY_MARKER = /^__metadata:/m;
const YARN_VERSION_LINE = /^ {2}"?version"?:?\s+"?([^"\s]+)"?\s*$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function basenameOf(file) {
  const raw = String(file == null ? '' : file);
  const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return raw.slice(cut + 1);
}

function licenseOf(entry) {
  return typeof entry.license === 'string' && entry.license ? entry.license : null;
}

function looksLikeVersion(value) {
  return typeof value === 'string' && /^\d/.test(value);
}

function result(packages, warnings) {
  return { packages: dedupe(packages), warnings: [...new Set(warnings)] };
}

function yamlDocument(content, kind) {
  try {
    return { doc: safeYamlParse(content, { kind }) };
  } catch (err) {
    if (err instanceof NubosPilotError && err.code === 'yaml-parse-failed') {
      return { doc: null, warning: 'malformed-yaml' };
    }
    throw err;
  }
}

function collectNames(target, deps) {
  if (!isPlainObject(deps)) return;
  for (const name of Object.keys(deps)) target.add(name);
}

function lockEntryScope(entry) {
  if (entry.dev === true || entry.devOptional === true) return 'dev';
  if (entry.optional === true) return 'optional';
  return 'prod';
}

function rootDependencyNames(root) {
  const names = new Set();
  if (!isPlainObject(root)) return names;
  collectNames(names, root.dependencies);
  collectNames(names, root.devDependencies);
  collectNames(names, root.optionalDependencies);
  return names;
}

function isTopLevelInstall(key) {
  return key.startsWith(NODE_MODULES) && key.indexOf(NODE_MODULES) === key.lastIndexOf(NODE_MODULES);
}

function packageLockEntries(packages, source, warnings) {
  const directNames = rootDependencyNames(packages['']);
  const out = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    const marker = key.lastIndexOf(NODE_MODULES);
    if (marker < 0) continue;
    if (!isPlainObject(entry)) { warnings.push('malformed-entry'); continue; }
    if (entry.link === true) continue;
    const name = key.slice(marker + NODE_MODULES.length).replace(/\/+$/, '');
    if (!name) { warnings.push('unnamed-entry'); continue; }
    if (!entry.version) { warnings.push('missing-version'); continue; }
    out.push(makePackage({
      ecosystem: ECOSYSTEM,
      name,
      version: String(entry.version),
      scope: lockEntryScope(entry),
      direct: isTopLevelInstall(key) && directNames.has(name),
      source,
      license: licenseOf(entry),
    }));
  }
  return out;
}

function walkLegacyTree(tree, out, warnings, source, depth) {
  if (depth > MAX_TREE_DEPTH) { warnings.push('tree-too-deep'); return; }
  for (const [name, entry] of Object.entries(tree)) {
    if (!isPlainObject(entry)) { warnings.push('malformed-entry'); continue; }
    if (entry.link === true) continue;
    if (!entry.version) warnings.push('missing-version');
    else {
      out.push(makePackage({
        ecosystem: ECOSYSTEM,
        name,
        version: String(entry.version),
        scope: lockEntryScope(entry),
        direct: false,
        source,
        license: licenseOf(entry),
      }));
    }
    if (isPlainObject(entry.dependencies)) {
      walkLegacyTree(entry.dependencies, out, warnings, source, depth + 1);
    }
  }
}

function parsePackageLock(content, source) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return { packages: [], warnings: ['malformed-json'] };
  }
  if (!isPlainObject(doc)) return { packages: [], warnings: ['malformed-json'] };

  const warnings = [];
  if (isPlainObject(doc.packages)) {
    return result(packageLockEntries(doc.packages, source, warnings), warnings);
  }
  if (isPlainObject(doc.dependencies)) {
    warnings.push('lockfile-v1');
    const out = [];
    walkLegacyTree(doc.dependencies, out, warnings, source, 0);
    return result(out, warnings);
  }
  return { packages: [], warnings: ['no-packages'] };
}

function nameVersion(name, version) {
  const underscore = version.indexOf('_');
  const trimmed = underscore >= 0 ? version.slice(0, underscore) : version;
  if (!name || !trimmed) return null;
  return { name, version: trimmed };
}

function pnpmKeyToNameVersion(key) {
  let raw = String(key == null ? '' : key).trim();
  const paren = raw.indexOf('(');
  if (paren >= 0) raw = raw.slice(0, paren);
  if (raw.startsWith('/')) raw = raw.slice(1);

  const firstSlash = raw.indexOf('/');
  if (firstSlash > 0
    && REGISTRY_HOST.test(raw.slice(0, firstSlash))
    && raw.slice(firstSlash + 1).includes('/')) {
    raw = raw.slice(firstSlash + 1);
  }

  const lastSlash = raw.lastIndexOf('/');
  if (lastSlash > 0 && /^\d/.test(raw.slice(lastSlash + 1))) {
    return nameVersion(raw.slice(0, lastSlash), raw.slice(lastSlash + 1));
  }
  const lastAt = raw.lastIndexOf('@');
  if (lastAt > 0) return nameVersion(raw.slice(0, lastAt), raw.slice(lastAt + 1));
  return null;
}

function pnpmDirectNames(doc) {
  const direct = { prod: new Set(), dev: new Set(), optional: new Set() };
  if (isPlainObject(doc.importers)) {
    for (const importer of Object.values(doc.importers)) {
      if (!isPlainObject(importer)) continue;
      collectNames(direct.prod, importer.dependencies);
      collectNames(direct.dev, importer.devDependencies);
      collectNames(direct.optional, importer.optionalDependencies);
    }
  }
  collectNames(direct.prod, doc.dependencies);
  collectNames(direct.dev, doc.devDependencies);
  collectNames(direct.optional, doc.optionalDependencies);
  return direct;
}

function pnpmScope(entry, direct, name) {
  if (entry.dev === true || entry.devOptional === true) return 'dev';
  if (entry.optional === true) return 'optional';
  if (entry.dev === false) return 'prod';
  if (direct.prod.has(name)) return 'prod';
  if (direct.dev.has(name)) return 'dev';
  if (direct.optional.has(name)) return 'optional';
  return 'unknown';
}

function pnpmEntryMap(doc) {
  if (isPlainObject(doc.packages) && Object.keys(doc.packages).length) return doc.packages;
  if (isPlainObject(doc.snapshots) && Object.keys(doc.snapshots).length) return doc.snapshots;
  return isPlainObject(doc.packages) ? doc.packages : null;
}

function parsePnpmLock(content, source) {
  const { doc, warning } = yamlDocument(content, 'pnpm-lock');
  if (warning) return { packages: [], warnings: [warning] };
  if (!isPlainObject(doc)) return { packages: [], warnings: ['malformed-yaml'] };

  const entries = pnpmEntryMap(doc);
  if (!entries) return { packages: [], warnings: ['no-packages'] };

  const direct = pnpmDirectNames(doc);
  const warnings = [];
  const out = [];
  for (const [key, raw] of Object.entries(entries)) {
    const entry = isPlainObject(raw) ? raw : {};
    const parsed = pnpmKeyToNameVersion(key);
    if (!parsed) { warnings.push('unparseable-package-key'); continue; }
    if (!looksLikeVersion(parsed.version)) { warnings.push('unresolvable-version'); continue; }
    out.push(makePackage({
      ecosystem: ECOSYSTEM,
      name: parsed.name,
      version: parsed.version,
      scope: pnpmScope(entry, direct, parsed.name),
      direct: direct.prod.has(parsed.name)
        || direct.dev.has(parsed.name)
        || direct.optional.has(parsed.name),
      source,
      license: licenseOf(entry),
    }));
  }
  return result(out, warnings);
}

function descriptorName(descriptor) {
  const unquoted = String(descriptor == null ? '' : descriptor)
    .trim()
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .trim();
  if (!unquoted) return null;
  const at = unquoted.indexOf('@', 1);
  if (at < 1) return unquoted;
  return unquoted.slice(0, at) || null;
}

function parseYarnBerry(content, source) {
  const { doc, warning } = yamlDocument(content, 'yarn-lock');
  if (warning) return { packages: [], warnings: [warning] };
  if (!isPlainObject(doc)) return { packages: [], warnings: ['malformed-yaml'] };

  const warnings = [];
  const out = [];
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata') continue;
    if (!isPlainObject(entry)) { warnings.push('malformed-entry'); continue; }
    const resolution = typeof entry.resolution === 'string' ? entry.resolution : '';
    if (resolution.includes('@workspace:') || String(key).includes('@workspace:')) continue;
    const name = descriptorName(String(key).split(',')[0]);
    if (!name) { warnings.push('unparseable-descriptor'); continue; }
    if (!entry.version) { warnings.push('missing-version'); continue; }
    out.push(makePackage({
      ecosystem: ECOSYSTEM,
      name,
      version: String(entry.version),
      scope: 'unknown',
      direct: false,
      source,
      license: null,
    }));
  }
  return result(out, warnings);
}

function yarnHeaderNames(line, warnings) {
  const header = line.trim();
  if (!header.endsWith(':')) { warnings.push('unparseable-block-header'); return []; }
  const names = new Set();
  for (const part of header.slice(0, -1).split(',')) {
    const name = descriptorName(part);
    if (name) names.add(name);
    else warnings.push('unparseable-descriptor');
  }
  return [...names];
}

function parseYarnClassic(content, source) {
  const warnings = [];
  const out = [];
  let names = [];
  let version = null;

  const flush = () => {
    if (names.length) {
      if (!version) warnings.push('missing-version');
      else {
        for (const name of names) {
          out.push(makePackage({
            ecosystem: ECOSYSTEM,
            name,
            version,
            scope: 'unknown',
            direct: false,
            source,
            license: null,
          }));
        }
      }
    }
    names = [];
    version = null;
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      flush();
      names = yarnHeaderNames(line, warnings);
      continue;
    }
    if (!names.length || version !== null) continue;
    const match = YARN_VERSION_LINE.exec(line);
    if (match) version = match[1];
  }
  flush();

  return result(out, warnings);
}

function parseYarnLock(content, source) {
  if (YARN_BERRY_MARKER.test(content)) return parseYarnBerry(content, source);
  return parseYarnClassic(content, source);
}

function parse(content, opts) {
  if (typeof content !== 'string') {
    throw new NubosPilotError(
      'inventory-invalid-content',
      'npm lockfile parsing requires string content',
      { type: typeof content },
    );
  }
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  const source = file || null;
  switch (basenameOf(file)) {
    case 'package-lock.json': return parsePackageLock(content, source);
    case 'pnpm-lock.yaml': return parsePnpmLock(content, source);
    case 'yarn.lock': return parseYarnLock(content, source);
    default: return { packages: [], warnings: ['unsupported-file'] };
  }
}

module.exports = {
  FILES,
  parse,
};
