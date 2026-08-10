'use strict';

const path = require('node:path');

const { makePackage } = require('./pkgurl.cjs');
const { parseToml } = require('./toml.cjs');

const FILES = Object.freeze([
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pyproject.toml',
]);

const ECOSYSTEM = 'PyPI';

const DEV_TOKENS = Object.freeze([
  'dev', 'devel', 'develop', 'development', 'test', 'tests', 'testing', 'lint',
]);

const DEV_GROUPS = Object.freeze(['dev', 'test', 'lint']);

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;

const DIRECT_REFERENCE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*@\s*(\S.*)$/;

const EDITABLE_OPTION = /^(?:-e|--editable)[=\s]+(.*)$/;

const EXACT_CLAUSE = /^\s*===?\s*([^\s,;]+)\s*$/;

const OPERATOR_START = /^[<>=!~]/;

const LOCAL_PATH = /^(?:[.~/]|[A-Za-z]:[\\/])/;

const VCS_SCHEME = /^(?:git|hg|svn|bzr)\+/i;

const POETRY_PIN = /^(?:==)?(\d[A-Za-z0-9.+!-]*)$/;

const PIPFILE_EQUALITY = /^===?/;

function warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function addPackage(packages, warnings, fields) {
  try {
    packages.push(makePackage({ ecosystem: ECOSYSTEM, ...fields }));
  } catch {
    warn(warnings, 'invalid-package');
  }
}

function isUrlLike(text) {
  return VCS_SCHEME.test(text) || text.includes('://') || text.startsWith('file:');
}

function exactVersion(specifier) {
  if (!specifier) return null;
  for (const clause of specifier.split(',')) {
    const match = EXACT_CLAUSE.exec(clause);
    if (match && !match[1].includes('*')) return match[1];
  }
  return null;
}

function readRequirement(raw) {
  const body = String(raw).split(';')[0].split(/\s--/)[0].trim();
  if (!body) return { kind: 'empty' };
  if (isUrlLike(body) || LOCAL_PATH.test(body)) return { kind: 'url' };

  const reference = DIRECT_REFERENCE.exec(body);
  if (reference) return { kind: 'direct', name: reference[1], version: null };

  const match = REQUIREMENT.exec(body);
  if (!match) return { kind: 'malformed' };

  const specifier = match[2].trim().replace(/^\((.*)\)$/, '$1').trim();
  return {
    kind: 'requirement',
    name: match[1],
    version: exactVersion(specifier),
    suspicious: specifier !== '' && !OPERATOR_START.test(specifier),
  };
}

function isRequirementsFile(file) {
  const base = path.basename(file);
  if (!/\.txt$/i.test(base)) return false;
  if (/requirements/i.test(base)) return true;
  return path.basename(path.dirname(file)).toLowerCase() === 'requirements';
}

function requirementsScope(file) {
  const stem = path.basename(file).toLowerCase().replace(/\.[^.]*$/, '');
  return stem.split(/[-_.]/).some((token) => DEV_TOKENS.includes(token)) ? 'dev' : 'prod';
}

function joinContinuations(text) {
  const lines = [];
  let buffer = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const continued = line.endsWith('\\');
    const body = continued ? line.slice(0, -1) : line;
    buffer = buffer === null ? body : buffer + ' ' + body.trim();
    if (continued) continue;
    lines.push(buffer);
    buffer = null;
  }
  if (buffer !== null) lines.push(buffer);
  return lines;
}

function stripComment(line) {
  const match = /(^|\s)#/.exec(line);
  return match ? line.slice(0, match.index) : line;
}

function parseRequirements(text, file, warnings) {
  const scope = requirementsScope(file);
  const source = file || null;
  const packages = [];

  for (const logical of joinContinuations(text)) {
    const line = stripComment(logical).trim();
    if (!line) continue;

    if (line.startsWith('-')) {
      const editable = EDITABLE_OPTION.exec(line);
      if (editable && isUrlLike(editable[1].trim())) warn(warnings, 'unsupported-requirement');
      continue;
    }

    const parsed = readRequirement(line);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'url') {
      warn(warnings, 'unsupported-requirement');
      continue;
    }
    if (parsed.kind === 'malformed') {
      warn(warnings, 'malformed-requirement');
      continue;
    }
    if (parsed.kind === 'direct') warn(warnings, 'unsupported-requirement');
    if (parsed.suspicious) warn(warnings, 'malformed-requirement');

    addPackage(packages, warnings, {
      name: parsed.name,
      version: parsed.version,
      scope,
      direct: true,
      source,
    });
  }
  return packages;
}

function poetryLockScope(entry) {
  if (entry.category === 'dev') return 'dev';
  if (entry.optional === true) return 'optional';
  if (typeof entry.category === 'string' && entry.category.trim()) return 'prod';
  return 'unknown';
}

function lockEntries(root, warnings) {
  const entries = root && Array.isArray(root.package) ? root.package : null;
  if (!entries) {
    warn(warnings, 'no-packages');
    return [];
  }
  return entries;
}

function lockEntryName(entry, warnings) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    warn(warnings, 'malformed-package');
    return '';
  }
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) warn(warnings, 'malformed-package');
  return name;
}

function lockEntryVersion(entry, warnings) {
  const version = typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : null;
  if (!version) warn(warnings, 'missing-version');
  return version;
}

function parsePoetryLock(root, source, warnings) {
  const packages = [];
  for (const entry of lockEntries(root, warnings)) {
    const name = lockEntryName(entry, warnings);
    if (!name) continue;
    addPackage(packages, warnings, {
      name,
      version: lockEntryVersion(entry, warnings),
      scope: poetryLockScope(entry),
      direct: false,
      source,
    });
  }
  return packages;
}

function isLocalUvSource(entry) {
  const source = plainObject(entry.source);
  if (!source) return false;
  return Object.prototype.hasOwnProperty.call(source, 'editable')
    || Object.prototype.hasOwnProperty.call(source, 'virtual');
}

function parseUvLock(root, source, warnings) {
  const packages = [];
  for (const entry of lockEntries(root, warnings)) {
    const name = lockEntryName(entry, warnings);
    if (!name) continue;
    if (isLocalUvSource(entry)) {
      warn(warnings, 'local-project');
      continue;
    }
    addPackage(packages, warnings, {
      name,
      version: lockEntryVersion(entry, warnings),
      scope: 'unknown',
      direct: false,
      source,
    });
  }
  return packages;
}

function collectPipfileSection(section, scope, source, packages, warnings) {
  if (section == null) return;
  const table = plainObject(section);
  if (!table) {
    warn(warnings, 'malformed-section');
    return;
  }
  for (const [name, entry] of Object.entries(table)) {
    if (!name.trim()) {
      warn(warnings, 'malformed-package');
      continue;
    }
    const spec = plainObject(entry);
    const raw = spec && typeof spec.version === 'string' ? spec.version.trim() : '';
    const version = raw.replace(PIPFILE_EQUALITY, '').trim() || null;
    if (!version) warn(warnings, 'missing-version');
    addPackage(packages, warnings, { name: name.trim(), version, scope, direct: true, source });
  }
}

function parsePipfileLock(text, source, warnings) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    warn(warnings, 'invalid-json');
    return [];
  }
  if (!plainObject(lock)) {
    warn(warnings, 'unexpected-lock-shape');
    return [];
  }
  const packages = [];
  collectPipfileSection(lock.default, 'prod', source, packages, warnings);
  collectPipfileSection(lock.develop, 'dev', source, packages, warnings);
  return packages;
}

function collectRequirementList(list, scope, source, packages, warnings) {
  if (list == null) return;
  if (!Array.isArray(list)) {
    warn(warnings, 'malformed-dependency');
    return;
  }
  for (const item of list) {
    if (typeof item !== 'string') {
      warn(warnings, 'malformed-dependency');
      continue;
    }
    const parsed = readRequirement(item);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'url') {
      warn(warnings, 'unsupported-requirement');
      continue;
    }
    if (parsed.kind === 'malformed') {
      warn(warnings, 'malformed-dependency');
      continue;
    }
    if (parsed.kind === 'direct') warn(warnings, 'unsupported-requirement');
    addPackage(packages, warnings, {
      name: parsed.name,
      version: parsed.version,
      scope,
      direct: true,
      source,
    });
  }
}

function poetryPin(value) {
  const raw = String(value).trim();
  if (!raw || raw.includes(',') || raw.includes('*') || raw.includes('|')) return null;
  const match = POETRY_PIN.exec(raw);
  return match ? match[1] : null;
}

function collectPoetryTable(table, scope, source, packages, warnings) {
  const deps = plainObject(table);
  if (!deps) return;
  for (const [name, value] of Object.entries(deps)) {
    if (name === 'python' || !name.trim()) continue;

    let version = null;
    let entryScope = scope;
    if (typeof value === 'string') {
      version = poetryPin(value);
    } else if (Array.isArray(value)) {
      version = null;
    } else if (plainObject(value)) {
      if (typeof value.version === 'string') version = poetryPin(value.version);
      if (value.optional === true && scope === 'prod') entryScope = 'optional';
    } else {
      warn(warnings, 'malformed-dependency');
      continue;
    }

    addPackage(packages, warnings, { name, version, scope: entryScope, direct: true, source });
  }
}

function parsePyproject(root, source, warnings) {
  const packages = [];

  const project = plainObject(root.project);
  if (project) {
    collectRequirementList(project.dependencies, 'prod', source, packages, warnings);
    const groups = plainObject(project['optional-dependencies']);
    if (groups) {
      for (const [group, list] of Object.entries(groups)) {
        const scope = DEV_GROUPS.includes(group.toLowerCase()) ? 'dev' : 'optional';
        collectRequirementList(list, scope, source, packages, warnings);
      }
    }
  }

  const poetry = plainObject(plainObject(root.tool) && root.tool.poetry);
  if (poetry) {
    collectPoetryTable(poetry.dependencies, 'prod', source, packages, warnings);
    collectPoetryTable(poetry['dev-dependencies'], 'dev', source, packages, warnings);
    const groups = plainObject(poetry.group);
    if (groups) {
      for (const group of Object.values(groups)) {
        const table = plainObject(group);
        if (table) collectPoetryTable(table.dependencies, 'dev', source, packages, warnings);
      }
    }
  }

  return packages;
}

function parse(content, opts) {
  const file = opts && typeof opts.file === 'string' ? opts.file : '';
  const basename = path.basename(file);
  const text = typeof content === 'string' ? content : String(content == null ? '' : content);
  const warnings = [];
  const source = file || null;

  if (basename === 'Pipfile.lock') {
    return { packages: parsePipfileLock(text, source, warnings), warnings };
  }

  if (basename === 'poetry.lock' || basename === 'uv.lock' || basename === 'pyproject.toml') {
    let root;
    try {
      root = parseToml(text);
    } catch {
      return { packages: [], warnings: ['invalid-toml'] };
    }
    if (basename === 'poetry.lock') return { packages: parsePoetryLock(root, source, warnings), warnings };
    if (basename === 'uv.lock') return { packages: parseUvLock(root, source, warnings), warnings };
    return { packages: parsePyproject(root, source, warnings), warnings };
  }

  if (isRequirementsFile(file)) {
    return { packages: parseRequirements(text, file, warnings), warnings };
  }

  return { packages: [], warnings: ['unsupported-file'] };
}

module.exports = { FILES, parse };
