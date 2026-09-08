'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { safeYamlParse } = require('./yaml.cjs');
const {
  NubosPilotError,
  projectStateDir,
  atomicWriteFileSync,
  withFileLock,
} = require('./core.cjs');
const layout = require('./layout.cjs');
const verify = require('./verify.cjs');
const safePath = require('./safe-path.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { listPhases } = require('./roadmap.cjs');
const {
  validateSchemaVersion: _validateRoadmapSchema,
  CURRENT_SCHEMA_VERSION: ROADMAP_SCHEMA_VERSION,
} = require('./roadmap-schema.cjs');

const ARCHIVE_DIRNAME = 'archive';
const ARCHIVE_MANIFEST = 'ARCHIVE.json';

const ARCHIVED_ITEMS = Object.freeze([
  'PROJECT.md',
  'PROJECT-SUMMARY.md',
  'REQUIREMENTS.md',
  'RULES.md',
  'ROADMAP.md',
  'STATE.md',
  'roadmap.yaml',
  'milestones',
  'phases',
  'codebase',
  'references',
  'metrics',
  'notes',
  'checkpoints',
  'economy-debt',
  'messages',
  'threads',
  'handoffs',
  'todos',
  'reports',
  'knowledge',
  'session',
]);

const CARRY_OVER_DEFAULTS = Object.freeze([
  'knowledge/learnings.json',
  'knowledge/solutions',
]);

const PRESERVED_TOP_LEVEL = Object.freeze([
  'config.json',
  'security-rules.json',
  'prose-auth.json',
  'archive',
  '.tmp',
  '.gitignore',
  'state',
  'worktrees',
  'memory',
  'bin',
  'agents',
  'templates',
  'backups',
  'audit',
  'elision',
  'run',
]);

function _unknownStateArtifacts(stateDir) {
  const known = new Set([...ARCHIVED_ITEMS, ...PRESERVED_TOP_LEVEL]);
  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((n) => !n.startsWith('.') && !known.has(n)).sort();
}

function _stateDirOrNull(cwd) {
  try { return projectStateDir(cwd); }
  catch (err) {
    if (err && (err.code === 'not-in-project' || err.code === 'ENOENT')) return null;
    throw err;
  }
}

function projectMdPath(cwd) {
  const sd = _stateDirOrNull(cwd);
  if (sd) return path.join(sd, 'PROJECT.md');
  return path.join(cwd, '.nubos-pilot', 'PROJECT.md');
}

function archiveRoot(cwd) {
  const sd = _stateDirOrNull(cwd);
  if (sd) return path.join(sd, ARCHIVE_DIRNAME);
  return path.join(cwd, '.nubos-pilot', ARCHIVE_DIRNAME);
}

function projectExists(cwd) {
  try {
    return fs.statSync(projectMdPath(cwd)).isFile();
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function _readProjectStatusFromRoadmap(cwd) {
  const yamlPath = path.join(projectStateDir(cwd), 'roadmap.yaml');
  try {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const doc = safeYamlParse(raw, { kind: 'archive' });
    if (doc && typeof doc.project_status === 'string') return doc.project_status;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
  }
  return null;
}

function _readProjectName(cwd) {
  try {
    const md = fs.readFileSync(projectMdPath(cwd), 'utf-8');
    const m = md.match(/^#\s+([^\n]+)/m);
    if (m) return m[1].replace(/—.*$/, '').trim();
  } catch {}
  return 'project';
}

function _safeReadText(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
}

function _safeFrontmatter(raw) {
  try { return extractFrontmatter(raw).frontmatter || {}; }
  catch { return {}; }
}

function _coerceInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
  return null;
}

function _statusCountsFromBlocks(raw) {
  const counts = { sc_count: 0, passed: 0, failed: 0, deferred: 0, pending: 0 };
  for (const b of verify._scBlocks(raw)) {
    counts.sc_count++;
    const status = verify._readField(b.block, 'Status');
    if (status === 'Pass') counts.passed++;
    else if (status === 'Fail') counts.failed++;
    else if (status === 'Defer') counts.deferred++;
    else counts.pending++;
  }
  return counts;
}

function _parseVerificationStatus(filePath) {
  const raw = _safeReadText(filePath);
  if (raw == null) {
    return { exists: false, milestone_status: null, sc_count: 0, passed: 0, failed: 0, deferred: 0, pending: 0, source: 'missing' };
  }
  const fm = _safeFrontmatter(raw);
  const headerMatch = raw.match(/\*\*Milestone Status:\*\*\s*(\S+)/i);
  const headerStatus = headerMatch ? headerMatch[1].trim() : null;

  const fmStatus = typeof fm.milestone_status === 'string' ? fm.milestone_status.trim() : null;
  const fmTotal = _coerceInt(fm.sc_total);
  const fmPassed = _coerceInt(fm.passed);
  const fmFailed = _coerceInt(fm.failed);
  const fmDeferred = _coerceInt(fm.deferred);
  const fmPending = _coerceInt(fm.pending);

  const fmComplete = fmStatus != null && fmTotal != null && fmPassed != null
    && fmFailed != null && fmDeferred != null && fmPending != null;

  if (fmComplete) {
    return {
      exists: true,
      milestone_status: fmStatus,
      sc_count: fmTotal,
      passed: fmPassed,
      failed: fmFailed,
      deferred: fmDeferred,
      pending: fmPending,
      source: 'frontmatter',
    };
  }

  const blockCounts = _statusCountsFromBlocks(raw);
  return {
    exists: true,
    milestone_status: fmStatus || headerStatus,
    sc_count: blockCounts.sc_count,
    passed: blockCounts.passed,
    failed: blockCounts.failed,
    deferred: blockCounts.deferred,
    pending: blockCounts.pending,
    source: 'body',
  };
}

function _validationBodyCounts(raw) {
  const fmBlock = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  const body = fmBlock ? fmBlock[1] : raw;

  let uncoveredSection = body.match(/^##\s+Uncovered\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  let underSection = body.match(/^##\s+Under-Sampled\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);

  const _emptyMarker = /\bnone\b|^\s*$/i;
  function _countH3In(section) {
    if (!section) return 0;
    const inner = section[1] || '';
    if (_emptyMarker.test(inner.trim())) return 0;
    return (inner.match(/^###\s+/gm) || []).length;
  }

  return {
    uncovered: _countH3In(uncoveredSection),
    under_sampled: _countH3In(underSection),
  };
}

function _parseValidationStatus(filePath) {
  const raw = _safeReadText(filePath);
  if (raw == null) {
    return { exists: false, uncovered: 0, under_sampled: 0, covered: 0, nyquist_compliant: null, source: 'missing' };
  }
  const fm = _safeFrontmatter(raw);
  const fmCovered = _coerceInt(fm.covered);
  const fmUnder = _coerceInt(fm.under_sampled);
  const fmUncovered = _coerceInt(fm.uncovered);
  const fmNyquist = typeof fm.nyquist_compliant === 'boolean'
    ? fm.nyquist_compliant
    : (fm.nyquist_compliant === 'true' ? true : fm.nyquist_compliant === 'false' ? false : null);

  if (fmCovered != null && fmUnder != null && fmUncovered != null) {
    return {
      exists: true,
      covered: fmCovered,
      under_sampled: fmUnder,
      uncovered: fmUncovered,
      nyquist_compliant: fmNyquist != null ? fmNyquist : (fmUnder === 0 && fmUncovered === 0),
      source: 'frontmatter',
    };
  }

  const counts = _validationBodyCounts(raw);
  return {
    exists: true,
    covered: 0,
    under_sampled: counts.under_sampled,
    uncovered: counts.uncovered,
    nyquist_compliant: counts.under_sampled === 0 && counts.uncovered === 0,
    source: 'body',
  };
}

function computeCompletionStatus(cwd) {
  if (!projectExists(cwd)) {
    return {
      status: 'no-project',
      complete: false,
      archivable: false,
      recorded_status: null,
      milestones: [],
      blockers: ['PROJECT.md not present'],
    };
  }

  let phases;
  try {
    phases = listPhases(cwd);
  } catch (err) {
    return {
      status: 'incomplete',
      complete: false,
      archivable: false,
      recorded_status: null,
      milestones: [],
      blockers: ['roadmap.yaml not parseable: ' + (err && err.message)],
    };
  }

  const blockers = [];
  const milestones = [];

  if (phases.length === 0) {
    blockers.push('roadmap.yaml has no milestones');
  }

  for (const ph of phases) {
    const mNum = Number(ph.number);
    if (!Number.isInteger(mNum)) continue;
    const verPath = verify.milestoneVerificationPath(mNum, cwd);
    const valPath = path.join(layout.milestoneDir(mNum, cwd), layout.mId(mNum) + '-VALIDATION.md');
    const ver = _parseVerificationStatus(verPath);
    const val = _parseValidationStatus(valPath);

    const entry = {
      id: layout.mId(mNum),
      number: mNum,
      name: ph.name || '',
      roadmap_status: ph.complete ? 'done' : 'pending',
      verification: ver,
      validation: val,
    };
    milestones.push(entry);

    if (!ver.exists) {
      blockers.push(layout.mId(mNum) + ': VERIFICATION.md missing');
    } else {
      if (ver.failed > 0) blockers.push(layout.mId(mNum) + ': ' + ver.failed + ' SC failed');
      if (ver.pending > 0) blockers.push(layout.mId(mNum) + ': ' + ver.pending + ' SC pending');
      if (ver.sc_count === 0) {
        blockers.push(layout.mId(mNum) + ': VERIFICATION.md has 0 SC blocks (parse failure or empty)');
      }
      if (ver.milestone_status === 'failed' && ver.failed === 0) {
        blockers.push(layout.mId(mNum) + ': milestone status is failed but no SC marked Fail (review needed)');
      }
    }
    if (!val.exists) {
      blockers.push(layout.mId(mNum) + ': VALIDATION.md missing');
    } else {
      if (val.uncovered > 0) blockers.push(layout.mId(mNum) + ': ' + val.uncovered + ' requirement(s) UNCOVERED');
    }
  }

  const recordedStatus = _readProjectStatusFromRoadmap(cwd);
  const complete = phases.length > 0 && blockers.length === 0;

  return {
    status: complete ? 'complete' : 'incomplete',
    complete,
    archivable: complete || recordedStatus === 'completed',
    recorded_status: recordedStatus,
    milestones,
    blockers,
  };
}

function _ensureArchiveDir(slug, date, cwd) {
  const root = archiveRoot(cwd);
  fs.mkdirSync(root, { recursive: true });
  let target = path.join(root, slug + '-' + date);
  if (!fs.existsSync(target)) return target;
  for (let i = 2; i < 100; i++) {
    const candidate = path.join(root, slug + '-' + date + '-' + i);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new NubosPilotError(
    'archive-collision',
    'archive: more than 99 archives for same slug+date — aborting',
    { slug, date },
  );
}

function _moveEntry(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      _copyTree(src, dst);
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

function _copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.cpSync(src, dst, { recursive: true });
  } catch (err) {
    throw new NubosPilotError(
      'archive-copy-failed',
      'failed to copy ' + path.basename(src),
      { source: path.basename(src), dest: path.basename(dst), cause: err && err.code },
    );
  }
}

function _toPosixCarryName(name) {
  return String(name).split(path.sep).join('/');
}

function _carryPathSegments(name) {
  const segments = _toPosixCarryName(name).split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(seg)) {
      throw new NubosPilotError(
        'archive-carry-path-invalid',
        `carry-over path segment '${seg}' is not allowed in '${name}'`,
        { name, segment: seg },
      );
    }
  }
  return segments;
}

function archiveProject(cwd, opts) {
  const o = opts || {};
  const force = o.force === true;
  const allowUnknown = o.allow_unknown === true;
  const carryOverExplicit = Array.isArray(o.carry_over);
  const carryOver = carryOverExplicit ? o.carry_over.slice() : CARRY_OVER_DEFAULTS.slice();
  const stateDir = projectStateDir(cwd);

  if (!projectExists(cwd)) {
    throw new NubosPilotError(
      'archive-no-project',
      'no project to archive (PROJECT.md missing)',
      { path: projectMdPath(cwd) },
    );
  }

  const completion = o.completion || computeCompletionStatus(cwd);
  if (!completion.archivable && !force) {
    throw new NubosPilotError(
      'archive-not-complete',
      'project is not complete — pass force=true to archive anyway',
      { blockers: completion.blockers },
    );
  }

  const worktreesDir = path.join(stateDir, 'worktrees');
  if (fs.existsSync(worktreesDir)) {
    const ents = fs.readdirSync(worktreesDir).filter((n) => n !== '.gitkeep');
    if (ents.length > 0 && !force) {
      throw new NubosPilotError(
        'archive-worktrees-present',
        'active worktrees exist — clean up first or pass force=true',
        { worktrees: ents },
      );
    }
  }

  // An explicitly named carry-over path that matches nothing is a typo, and a typo
  // here is silent data loss: the item still moves into the archive with everything
  // else, nothing is restored, and `carried_over: []` reads exactly like "there was
  // nothing to carry". That is how `--carry-over learnings,solutions` — the form our
  // own docs prescribed — quietly discarded the learnings store on every project
  // switch. Defaults stay silent: a fresh project legitimately has no store yet.
  // Checked here, before the first move, because archiveProject has no rollback.
  if (carryOverExplicit) {
    for (const name of carryOver) {
      const segments = _carryPathSegments(name);
      if (segments.length === 0) continue;
      if (fs.existsSync(path.join(stateDir, ...segments))) continue;
      throw new NubosPilotError(
        'archive-carry-not-found',
        `carry-over path '${_toPosixCarryName(name)}' does not exist under the project state dir`,
        { name: _toPosixCarryName(name), defaults: CARRY_OVER_DEFAULTS.slice() },
      );
    }
  }

  const unknown = allowUnknown ? [] : _unknownStateArtifacts(stateDir);
  if (unknown.length > 0) {
    throw new NubosPilotError(
      'archive-unknown-state-artifact',
      `project state holds entries the archiver does not classify: ${unknown.join(', ')} — `
        + 'add each to ARCHIVED_ITEMS or PRESERVED_TOP_LEVEL in lib/archive.cjs, '
        + 'or pass allow_unknown=true to leave them in place',
      {
        unknown,
        archived_items: ARCHIVED_ITEMS.slice(),
        preserved_top_level: PRESERVED_TOP_LEVEL.slice(),
      },
    );
  }

  const projectName = _readProjectName(cwd);
  const slug = layout.slugify(projectName) || 'project';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const archiveDir = _ensureArchiveDir(slug, date, cwd);
  const lockPath = path.join(stateDir, '.archive-lock');

  return withFileLock(lockPath, () => {
    fs.mkdirSync(archiveDir, { recursive: true });

    const manifestPath = path.join(archiveDir, ARCHIVE_MANIFEST);
    const archivedAt = new Date().toISOString();
    const manifest = {
      schema_version: 1,
      status: 'in-progress',
      archived_at: archivedAt,
      slug,
      project_name: projectName,
      completion_status: completion.status,
      milestones_count: completion.milestones.length,
      blockers_at_archive: completion.blockers,
      moved: [],
      carried_over: [],
      skipped_unknown: allowUnknown ? _unknownStateArtifacts(stateDir) : [],
      forced: force === true,
      archived_with_blockers: !completion.complete,
    };
    const persistManifest = () => atomicWriteFileSync(
      manifestPath,
      JSON.stringify(manifest, null, 2),
    );
    persistManifest();

    for (const name of ARCHIVED_ITEMS) {
      const src = path.join(stateDir, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(archiveDir, name);
      _moveEntry(src, dst);
      manifest.moved.push(name);
      persistManifest();
    }

    for (const name of carryOver) {
      const segments = _carryPathSegments(name);
      if (segments.length === 0) continue;
      const archived = path.join(archiveDir, ...segments);
      if (!fs.existsSync(archived)) continue;
      const restored = path.join(stateDir, ...segments);
      _copyTree(archived, restored);
      manifest.carried_over.push(_toPosixCarryName(name));
      persistManifest();
    }

    manifest.status = 'complete';
    persistManifest();

    return {
      archive_dir: archiveDir,
      slug,
      date,
      project_name: projectName,
      moved: manifest.moved,
      carried_over: manifest.carried_over,
      skipped_unknown: manifest.skipped_unknown,
      forced: manifest.forced,
      archived_with_blockers: manifest.archived_with_blockers,
      completion_status: completion.status,
    };
  });
}

function listArchives(cwd) {
  const root = archiveRoot(cwd);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (err) { if (err && err.code === 'ENOENT') return []; throw err; }

  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const manifestPath = path.join(dir, ARCHIVE_MANIFEST);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch {}
    out.push({
      name: e.name,
      path: dir,
      slug: manifest && manifest.slug || null,
      project_name: manifest && manifest.project_name || null,
      archived_at: manifest && manifest.archived_at || null,
      completion_status: manifest && manifest.completion_status || null,
      milestones_count: manifest && manifest.milestones_count || 0,
      forced: manifest && manifest.forced === true,
      status: (manifest && manifest.status) || (manifest ? 'complete' : 'unknown'),
    });
  }
  out.sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));
  return out;
}

function readArchiveFile(cwd, archiveName, relPath) {
  const root = path.resolve(archiveRoot(cwd));
  let archiveDir;
  try {
    archiveDir = safePath.assertInsideBase(root, path.join(root, archiveName), 'archive-name');
  } catch (err) {
    if (err && (err.code === 'safe-path-outside-base' || err.code === 'safe-path-invalid-input')) {
      throw new NubosPilotError('archive-path-escape', 'archive name escapes archive root', { archiveName, cause: err.code });
    }
    throw err;
  }
  let full;
  try {
    full = safePath.assertInsideBase(archiveDir, path.join(archiveDir, relPath), 'archive-rel');
  } catch (err) {
    if (err && (err.code === 'safe-path-outside-base' || err.code === 'safe-path-invalid-input')) {
      throw new NubosPilotError('archive-path-escape', 'rel path escapes archive', { relPath, cause: err.code });
    }
    throw err;
  }
  return fs.readFileSync(full, 'utf-8');
}

function setProjectStatus(cwd, status) {
  if (status !== 'completed' && status !== 'active') {
    throw new NubosPilotError(
      'archive-invalid-project-status',
      'project_status must be "active" or "completed"',
      { got: status },
    );
  }
  const yamlPath = path.join(projectStateDir(cwd), 'roadmap.yaml');
  return withFileLock(yamlPath, () => {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const doc = safeYamlParse(raw, { kind: 'archive' }) || {};
    _validateRoadmapSchema(doc, yamlPath);
    doc.project_status = status;
    doc.schema_version = ROADMAP_SCHEMA_VERSION;
    if (status === 'completed') doc.completed_at = new Date().toISOString();
    atomicWriteFileSync(yamlPath, YAML.stringify(doc, { indent: 2 }));
    return { project_status: status, path: yamlPath };
  });
}

function projectSummaryPath(cwd) {
  return path.join(projectStateDir(cwd), 'PROJECT-SUMMARY.md');
}

function renderProjectSummary(cwd) {
  const completion = computeCompletionStatus(cwd);
  const projectName = _readProjectName(cwd);
  const ts = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# ' + projectName + ' — Project Summary');
  lines.push('');
  lines.push('**Closed:** ' + ts);
  lines.push('**Status:** ' + completion.status);
  lines.push('**Milestones:** ' + completion.milestones.length);
  lines.push('');
  lines.push('## Milestones');
  lines.push('');
  for (const m of completion.milestones) {
    lines.push('### ' + m.id + ' — ' + (m.name || ''));
    lines.push('- **Roadmap status:** ' + m.roadmap_status);
    if (m.verification.exists) {
      lines.push('- **Verification:** ' + (m.verification.milestone_status || '—') +
        ' (' + m.verification.sc_count + ' SC, ' + m.verification.failed + ' failed, ' + m.verification.pending + ' pending)');
    } else {
      lines.push('- **Verification:** missing');
    }
    if (m.validation.exists) {
      lines.push('- **Validation:** ' + m.validation.uncovered + ' uncovered, ' + m.validation.under_sampled + ' under-sampled');
    } else {
      lines.push('- **Validation:** missing');
    }
    lines.push('');
  }
  if (completion.blockers.length > 0) {
    lines.push('## Blockers at close');
    lines.push('');
    for (const b of completion.blockers) lines.push('- ' + b);
    lines.push('');
  }
  return lines.join('\n');
}

function writeProjectSummary(cwd) {
  const target = projectSummaryPath(cwd);
  const md = renderProjectSummary(cwd);
  return withFileLock(target, () => {
    atomicWriteFileSync(target, md);
    return { path: target };
  });
}

module.exports = {
  ARCHIVE_DIRNAME,
  ARCHIVED_ITEMS,
  CARRY_OVER_DEFAULTS,
  PRESERVED_TOP_LEVEL,
  projectMdPath,
  archiveRoot,
  projectExists,
  computeCompletionStatus,
  archiveProject,
  listArchives,
  readArchiveFile,
  setProjectStatus,
  projectSummaryPath,
  renderProjectSummary,
  writeProjectSummary,
};
