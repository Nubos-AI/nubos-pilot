const fs = require('node:fs');
const path = require('node:path');
const { projectStateDir, withFileLock, NubosPilotError } = require('./core.cjs');

function paddedPhase(n) {
  const s = String(n);
  const m = s.match(/^(\d+)(\.\d+)?$/);
  if (!m) {
    throw new NubosPilotError(
      'phase-not-found',
      'Invalid phase number: ' + s,
      { got: n }
    );
  }
  return m[1].padStart(2, '0') + (m[2] || '');
}

function phaseSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function _listPhaseEntries(phasesRoot) {
  try {
    return fs.readdirSync(phasesRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function findPhaseDir(n, cwd = process.cwd()) {
  const padded = paddedPhase(n);
  const phasesRoot = path.join(projectStateDir(cwd), 'phases');
  const entries = _listPhaseEntries(phasesRoot);
  if (entries === null) return null;

  const matches = entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name === padded || e.name.startsWith(padded + '-'))
    .map((e) => e.name)
    .sort((a, b) => b.length - a.length);

  if (matches.length === 0) return null;
  return path.join(phasesRoot, matches[0]);
}

function _extractSlugTail(name, padded) {
  if (name === padded) return '';
  if (name.startsWith(padded + '-')) return name.slice(padded.length + 1);
  return null;
}

function createPhaseDir(n, slug, cwd = process.cwd()) {
  const padded = paddedPhase(n);
  const cleanSlug = phaseSlug(slug);
  if (cleanSlug === '') {
    throw new NubosPilotError(
      'phase-not-found',
      'Invalid slug: ' + slug,
      { slug }
    );
  }

  const phasesRoot = path.join(projectStateDir(cwd), 'phases');
  fs.mkdirSync(phasesRoot, { recursive: true });

  return withFileLock(path.join(phasesRoot, '.phase-create'), () => {
    const entries = _listPhaseEntries(phasesRoot) || [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const tail = _extractSlugTail(e.name, padded);
      if (tail === null) continue;
      const existingPath = path.join(phasesRoot, e.name);
      if (tail === cleanSlug) return existingPath;
      throw new NubosPilotError(
        'phase-slug-mismatch',
        `Phase ${padded} already exists with different slug`,
        {
          padded,
          expected_slug: cleanSlug,
          existing_slug: tail,
          existing_path: existingPath,
        }
      );
    }
    const target = path.join(phasesRoot, padded + '-' + cleanSlug);
    fs.mkdirSync(target, { recursive: true });
    return target;
  });
}

module.exports = { findPhaseDir, createPhaseDir, phaseSlug, paddedPhase };
