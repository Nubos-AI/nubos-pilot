const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('../core.cjs');

const MAX_NUMBERED_BACKUPS = 99;

function _refuseSymlink(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    throw new NubosPilotError(
      'backup-source-missing',
      'Cannot stat file to back up: ' + (err && err.message),
      { filePath },
    );
  }
  if (st.isSymbolicLink()) {
    throw new NubosPilotError(
      'backup-refuses-symlink',
      'Refusing to back up a symlink (would dereference target): ' + filePath,
      { filePath },
    );
  }
}

function _moveExclusive(filePath, candidate) {
  fs.copyFileSync(filePath, candidate, fs.constants.COPYFILE_EXCL);
  fs.unlinkSync(filePath);
}

function _backupBaseFor(filePath, opts) {
  const destDir = opts && opts.destDir;
  if (!destDir) return filePath + '.bak';
  const rel = (opts && opts.relPath) || path.basename(filePath);
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new NubosPilotError(
      'backup-rel-path-traversal',
      'Refusing to place a backup outside destDir: ' + rel,
      { filePath, relPath: rel, destDir },
    );
  }
  const target = path.join(destDir, rel) + '.bak';
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    throw new NubosPilotError(
      'backup-mkdir-failed',
      'Cannot create backup directory: ' + (err && err.message),
      { filePath, target },
    );
  }
  // The rel check above is lexical, so it cannot see a symlinked subdirectory of
  // destDir: the joined path stays inside destDir as a string while copyFileSync
  // writes through the link. Resolve both ends and re-assert containment — the
  // same realpath+prefix rule bin/install.js applies before it unlinks.
  let realDest;
  let realTargetDir;
  try {
    realDest = fs.realpathSync(destDir);
    realTargetDir = fs.realpathSync(path.dirname(target));
  } catch (err) {
    throw new NubosPilotError(
      'backup-mkdir-failed',
      'Cannot resolve backup directory: ' + (err && err.message),
      { filePath, target },
    );
  }
  if (!(realTargetDir === realDest || realTargetDir.startsWith(realDest + path.sep))) {
    throw new NubosPilotError(
      'backup-dest-escape',
      'Refusing to write a backup outside destDir (symlinked path): ' + rel,
      { filePath, relPath: rel, destDir },
    );
  }
  return target;
}

function backupFile(filePath, opts) {
  _refuseSymlink(filePath);
  const base = _backupBaseFor(filePath, opts);
  try {
    _moveExclusive(filePath, base);
    return base;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw new NubosPilotError(
        'backup-rename-failed',
        'Cannot back up to .bak: ' + (err && err.message),
        { filePath, target: base },
      );
    }
  }
  for (let n = 1; n <= MAX_NUMBERED_BACKUPS; n++) {
    const candidate = `${base}.${n}`;
    try {
      _moveExclusive(filePath, candidate);
      return candidate;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new NubosPilotError(
          'backup-rename-failed',
          'Cannot back up to ' + candidate + ': ' + (err && err.message),
          { filePath, target: candidate },
        );
      }
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fallback = `${base}.orphan-${ts}`;
  try {
    _moveExclusive(filePath, fallback);
  } catch (err) {
    throw new NubosPilotError(
      'backup-rename-failed',
      'Cannot back up to orphan backup: ' + (err && err.message),
      { filePath, target: fallback },
    );
  }
  return fallback;
}

module.exports = { backupFile, MAX_NUMBERED_BACKUPS };
