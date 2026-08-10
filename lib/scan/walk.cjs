'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('../core.cjs');
const { _globToRegExp } = require('../security/scan.cjs');
const { assertInsideBase } = require('../safe-path.cjs');

const BINARY_PROBE_BYTES = 8192;
const BINARY_NONTEXT_RATIO = 0.3;
const TEXT_CONTROL_BYTES = new Set([9, 10, 12, 13, 27]);
const MAX_WARNINGS = 200;
const MAX_CAUSE_CHARS = 200;

const DEFAULT_DIR_EXCLUDES = Object.freeze([
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/target/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/out/**',
  '**/.cache/**',
]);

const DEFAULT_GENERATED_EXCLUDES = Object.freeze([
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/Pipfile.lock',
  '**/poetry.lock',
  '**/go.sum',
]);

const DEFAULT_EXCLUDES = Object.freeze([
  ...DEFAULT_DIR_EXCLUDES,
  ...DEFAULT_GENERATED_EXCLUDES,
]);

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 5000,
});

function _posix(p) {
  return String(p).replace(/\\/g, '/');
}

function _relPath(root, full) {
  return _posix(path.relative(root, full));
}

function _nonNegativeInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function _compileGlobs(globs) {
  const compiled = [];
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue;
    try { compiled.push(_globToRegExp(g)); }
    catch { continue; }
  }
  return compiled;
}

function _matchesAny(candidate, regexes) {
  for (const re of regexes) {
    if (re.test(candidate)) return true;
  }
  return false;
}

function _looksBinary(buf) {
  if (buf.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b === 127 || (b < 32 && !TEXT_CONTROL_BYTES.has(b))) nonText++;
  }
  return nonText / buf.length > BINARY_NONTEXT_RATIO;
}

function _splitLines(content) {
  if (content === '') return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function _readTextFile(full, size) {
  const fd = fs.openSync(full, 'r');
  try {
    if (size === 0) return { content: '', bytes: 0 };
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    const probeEnd = Math.min(size, BINARY_PROBE_BYTES);
    while (off < probeEnd) {
      const n = fs.readSync(fd, buf, off, probeEnd - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (_looksBinary(buf.subarray(0, off))) return null;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { content: buf.subarray(0, off).toString('utf-8'), bytes: off };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function _warn(state, warning) {
  if (state.warnings.length < MAX_WARNINGS) {
    state.warnings.push(warning);
    return;
  }
  if (state.warnings.length === MAX_WARNINGS) {
    state.warnings.push({
      code: 'walk-warnings-truncated',
      message: 'warning list capped at ' + MAX_WARNINGS + ' entries',
      limit: MAX_WARNINGS,
    });
  }
}

function _stop(state, code, message, cap) {
  state.stopped = true;
  _warn(state, { code, message, cap, limit: state.limits[cap] });
}

function _validateRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new NubosPilotError(
      'walk-invalid-root',
      'walk requires a non-empty root path string',
      { got: typeof root },
    );
  }
  const rootAbs = path.resolve(root);
  let stat;
  try { stat = fs.statSync(rootAbs); }
  catch (err) {
    throw new NubosPilotError(
      'walk-root-unreadable',
      'walk root cannot be read',
      { root: path.basename(rootAbs), cause: (err && err.code) || 'unknown' },
    );
  }
  if (!stat.isDirectory()) {
    throw new NubosPilotError(
      'walk-root-not-a-directory',
      'walk root must be a directory',
      { root: path.basename(rootAbs) },
    );
  }
  return rootAbs;
}

function _validateExtractors(extractors) {
  if (!Array.isArray(extractors) || extractors.length === 0) {
    throw new NubosPilotError(
      'walk-no-extractors',
      'walk requires a non-empty array of extractors',
      { got: Array.isArray(extractors) ? 'empty-array' : typeof extractors },
    );
  }
  const seen = new Set();
  for (const extractor of extractors) {
    if (!extractor || typeof extractor !== 'object'
        || typeof extractor.name !== 'string' || extractor.name.trim() === '') {
      throw new NubosPilotError(
        'walk-invalid-extractor',
        'every extractor needs a non-empty string name',
        { got: extractor && typeof extractor === 'object' ? typeof extractor.name : typeof extractor },
      );
    }
    if (seen.has(extractor.name)) {
      throw new NubosPilotError(
        'walk-duplicate-extractor',
        'extractor names must be unique',
        { name: extractor.name },
      );
    }
    seen.add(extractor.name);
    if (typeof extractor.onFile !== 'function'
        && typeof extractor.onLine !== 'function'
        && typeof extractor.onFileEnd !== 'function') {
      throw new NubosPilotError(
        'walk-extractor-without-hooks',
        'extractor must define at least one of onFile, onLine, onFileEnd',
        { name: extractor.name },
      );
    }
  }
  return extractors;
}

function _collect(bucket, returned) {
  if (returned === undefined || returned === null) return;
  if (Array.isArray(returned)) {
    for (const item of returned) {
      if (item !== undefined && item !== null) bucket.push(item);
    }
    return;
  }
  bucket.push(returned);
}

function _runHook(extractor, hookName, args, state, ctx, failed) {
  const hook = extractor[hookName];
  if (typeof hook !== 'function') return;
  try {
    _collect(state.results.get(extractor.name), hook.apply(extractor, args));
  } catch (err) {
    failed.add(extractor.name);
    _warn(state, {
      code: 'walk-extractor-failed',
      message: 'extractor ' + extractor.name + ' threw in ' + hookName,
      extractor: extractor.name,
      hook: hookName,
      path: ctx.relPath,
      cause: err && err.message ? String(err.message).slice(0, MAX_CAUSE_CHARS) : 'unknown',
    });
  }
}

function _feedExtractors(state, ctx, content) {
  const failed = new Set();

  for (const extractor of state.extractors) {
    _runHook(extractor, 'onFile', [ctx], state, ctx, failed);
  }

  const lineExtractors = state.extractors.filter(
    (e) => typeof e.onLine === 'function' && !failed.has(e.name),
  );
  if (lineExtractors.length > 0) {
    const lines = _splitLines(content);
    state.stats.linesScanned += lines.length;
    for (let i = 0; i < lines.length; i++) {
      for (const extractor of lineExtractors) {
        if (failed.has(extractor.name)) continue;
        _runHook(extractor, 'onLine', [lines[i], i + 1, ctx], state, ctx, failed);
      }
    }
  }

  for (const extractor of state.extractors) {
    if (failed.has(extractor.name)) continue;
    _runHook(extractor, 'onFileEnd', [ctx], state, ctx, failed);
  }
}

function _insideRoot(state, full, relPath, label) {
  try {
    assertInsideBase(state.root, full, label);
    return true;
  } catch (err) {
    _warn(state, {
      code: 'walk-outside-root',
      message: 'entry resolves outside the walk root',
      path: relPath,
      cause: (err && err.code) || 'unknown',
    });
    return false;
  }
}

function _visitFile(full, relPath, state) {
  if (_matchesAny(relPath, state.excludes)) {
    state.stats.filesSkipped++;
    return;
  }
  if (state.includes && !_matchesAny(relPath, state.includes)) {
    state.stats.filesSkipped++;
    return;
  }
  if (state.stats.filesVisited >= state.limits.maxFiles) {
    _stop(state, 'walk-max-files', 'stopped: maxFiles cap reached', 'maxFiles');
    return;
  }
  if (!_insideRoot(state, full, relPath, 'walk file')) {
    state.stats.filesSkipped++;
    return;
  }

  let size;
  try { size = fs.statSync(full).size; }
  catch (err) {
    state.stats.filesSkipped++;
    _warn(state, {
      code: 'walk-file-unreadable',
      message: 'file could not be stat-ed',
      path: relPath,
      cause: (err && err.code) || 'unknown',
    });
    return;
  }

  if (size > state.limits.maxFileBytes) {
    state.stats.filesSkipped++;
    _warn(state, {
      code: 'walk-file-too-large',
      message: 'skipped: file exceeds the maxFileBytes cap',
      cap: 'maxFileBytes',
      limit: state.limits.maxFileBytes,
      path: relPath,
      size,
    });
    return;
  }
  if (state.stats.bytesRead + size > state.limits.maxTotalBytes) {
    _stop(state, 'walk-max-total-bytes', 'stopped: maxTotalBytes cap reached', 'maxTotalBytes');
    return;
  }

  let read;
  try { read = _readTextFile(full, size); }
  catch (err) {
    state.stats.filesSkipped++;
    _warn(state, {
      code: 'walk-file-unreadable',
      message: 'file could not be read',
      path: relPath,
      cause: (err && err.code) || 'unknown',
    });
    return;
  }
  if (read === null) {
    state.stats.filesSkipped++;
    return;
  }

  state.stats.filesVisited++;
  state.stats.bytesRead += read.bytes;

  _feedExtractors(state, Object.freeze({
    file: full,
    relPath,
    ext: path.extname(relPath).toLowerCase(),
    size,
  }), read.content);
}

function _visitDir(full, relPath, state) {
  if (_matchesAny(relPath + '/', state.excludes)) return;
  if (!_insideRoot(state, full, relPath, 'walk directory')) return;
  if (state.followSymlinks) {
    let real;
    try { real = fs.realpathSync(full); }
    catch { real = full; }
    if (state.seenDirs.has(real)) {
      _warn(state, { code: 'walk-cycle-skipped', message: 'directory already visited', path: relPath });
      return;
    }
    state.seenDirs.add(real);
  }
  _walkDir(full, state);
}

function _visitSymlink(full, relPath, state) {
  let target = null;
  try { target = fs.statSync(full, { throwIfNoEntry: false }) || null; }
  catch { target = null; }
  const kind = target === null
    ? 'broken'
    : target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';

  if (!state.followSymlinks) {
    if (kind !== 'directory') state.stats.filesSkipped++;
    _warn(state, {
      code: 'walk-symlink-skipped',
      message: 'symlinked ' + kind + ' not followed',
      path: relPath,
      kind,
    });
    return;
  }

  let real = null;
  try { real = fs.realpathSync(full); }
  catch { real = null; }
  if (real === null) {
    state.stats.filesSkipped++;
    _warn(state, { code: 'walk-symlink-unresolvable', message: 'symlink target does not resolve', path: relPath, kind });
    return;
  }

  try { assertInsideBase(state.root, full, 'walk symlink'); }
  catch (err) {
    if (kind !== 'directory') state.stats.filesSkipped++;
    _warn(state, {
      code: 'walk-symlink-outside-root',
      message: 'symlink resolves outside the walk root',
      path: relPath,
      kind,
      cause: (err && err.code) || 'unknown',
    });
    return;
  }

  if (kind === 'directory') {
    if (state.seenDirs.has(real)) {
      _warn(state, { code: 'walk-symlink-cycle', message: 'symlink would revisit a directory', path: relPath });
      return;
    }
    state.seenDirs.add(real);
    _walkDir(full, state);
    return;
  }
  if (kind === 'file') {
    _visitFile(full, relPath, state);
    return;
  }
  state.stats.filesSkipped++;
  _warn(state, { code: 'walk-symlink-skipped', message: 'symlinked ' + kind + ' not followed', path: relPath, kind });
}

function _walkDir(dir, state) {
  if (state.stopped) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) {
    _warn(state, {
      code: 'walk-dir-unreadable',
      message: 'directory could not be listed',
      path: _relPath(state.root, dir),
      cause: (err && err.code) || 'unknown',
    });
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (state.stopped) return;
    const full = path.join(dir, entry.name);
    const relPath = _relPath(state.root, full);
    if (entry.isSymbolicLink()) {
      _visitSymlink(full, relPath, state);
    } else if (entry.isDirectory()) {
      _visitDir(full, relPath, state);
    } else if (entry.isFile()) {
      _visitFile(full, relPath, state);
    } else {
      state.stats.filesSkipped++;
    }
  }
}

function walk(root, extractors, opts) {
  const o = opts || {};
  _validateExtractors(extractors);
  const rootAbs = _validateRoot(root);

  const state = {
    root: rootAbs,
    extractors,
    limits: {
      maxFileBytes: _nonNegativeInt(o.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
      maxTotalBytes: _nonNegativeInt(o.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
      maxFiles: _nonNegativeInt(o.maxFiles, DEFAULT_LIMITS.maxFiles),
    },
    excludes: _compileGlobs(Array.isArray(o.exclude) ? o.exclude : DEFAULT_EXCLUDES),
    includes: Array.isArray(o.include) && o.include.length > 0 ? _compileGlobs(o.include) : null,
    followSymlinks: o.followSymlinks === true,
    results: new Map(extractors.map((e) => [e.name, []])),
    warnings: [],
    stats: { filesVisited: 0, filesSkipped: 0, bytesRead: 0, linesScanned: 0 },
    stopped: false,
    seenDirs: new Set(),
  };

  if (state.followSymlinks) {
    try { state.seenDirs.add(fs.realpathSync(rootAbs)); }
    catch { state.seenDirs.add(rootAbs); }
  }

  _walkDir(rootAbs, state);

  return { results: state.results, stats: state.stats, warnings: state.warnings };
}

module.exports = {
  walk,
  DEFAULT_EXCLUDES,
  DEFAULT_DIR_EXCLUDES,
  DEFAULT_GENERATED_EXCLUDES,
  DEFAULT_LIMITS,
};
