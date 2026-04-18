const fs = require('node:fs');
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

function backupFile(filePath) {
  _refuseSymlink(filePath);
  const base = filePath + '.bak';
  if (!fs.existsSync(base)) {
    try {
      fs.renameSync(filePath, base);
    } catch (err) {
      throw new NubosPilotError(
        'backup-rename-failed',
        'Cannot rename to .bak: ' + (err && err.message),
        { filePath, target: base },
      );
    }
    return base;
  }
  for (let n = 1; n <= MAX_NUMBERED_BACKUPS; n++) {
    const candidate = `${filePath}.bak.${n}`;
    if (!fs.existsSync(candidate)) {
      try {
        fs.renameSync(filePath, candidate);
      } catch (err) {
        throw new NubosPilotError(
          'backup-rename-failed',
          'Cannot rename to ' + candidate + ': ' + (err && err.message),
          { filePath, target: candidate },
        );
      }
      return candidate;
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fallback = `${filePath}.bak.orphan-${ts}`;
  try {
    fs.renameSync(filePath, fallback);
  } catch (err) {
    throw new NubosPilotError(
      'backup-rename-failed',
      'Cannot rename to orphan backup: ' + (err && err.message),
      { filePath, target: fallback },
    );
  }
  return fallback;
}

module.exports = { backupFile, MAX_NUMBERED_BACKUPS };
