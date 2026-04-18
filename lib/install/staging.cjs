const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('../core.cjs');

const STAGING_SUBPATH = path.join('.claude', 'nubos-pilot.tmp');
const TARGET_SUBPATH = path.join('.claude', 'nubos-pilot');
const CLAUDE_SUBPATH = '.claude';

function _resolveStagingPath(projectRoot) {
  return path.join(projectRoot, STAGING_SUBPATH);
}

function _resolveTargetPath(projectRoot) {
  return path.join(projectRoot, TARGET_SUBPATH);
}

function stageDir(projectRoot) {
  const tmp = _resolveStagingPath(projectRoot);
  try {
    fs.mkdirSync(tmp, { recursive: true });
  } catch (err) {
    throw new NubosPilotError(
      'staging-mkdir-failed',
      'Kann Staging-Verzeichnis nicht anlegen: ' + (err && err.message),
      { tmp },
    );
  }
  return tmp;
}

function cleanStaleStaging(projectRoot) {
  const tmp = _resolveStagingPath(projectRoot);
  if (!fs.existsSync(tmp)) return false;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    throw new NubosPilotError(
      'staging-clean-failed',
      'Kann verwaistes Staging nicht entfernen: ' + (err && err.message),
      { tmp },
    );
  }
  return true;
}

function _dirIsEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

function finalizeSwap(projectRoot) {
  const tmp = _resolveStagingPath(projectRoot);
  const target = _resolveTargetPath(projectRoot);
  const claudeDir = path.join(projectRoot, CLAUDE_SUBPATH);
  if (!fs.existsSync(tmp)) {
    throw new NubosPilotError(
      'staging-swap-failed',
      'Kein Staging-Verzeichnis zum Finalisieren gefunden',
      { phase: 'pre-check', tmp, target },
    );
  }

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    throw new NubosPilotError(
      'staging-swap-failed',
      'Kann .claude/ Parent-Dir nicht anlegen: ' + (err && err.message),
      { phase: 'mkdir-parent', tmp, target },
    );
  }

  let oldPath = null;
  const targetExists = fs.existsSync(target);
  if (targetExists && !_dirIsEmpty(target)) {
    oldPath = path.join(claudeDir, 'nubos-pilot.old-' + Date.now());
    try {
      fs.renameSync(target, oldPath);
      console.error(
        '  [staging] alte Installation nach ' +
          path.basename(oldPath) +
          ' verschoben',
      );
    } catch (err) {
      throw new NubosPilotError(
        'staging-swap-failed',
        'Kann alte Installation nicht beiseite schieben: ' + (err && err.message),
        { phase: 'rename-old', tmp, target, old: oldPath },
      );
    }
  } else if (targetExists) {
    try {
      fs.rmdirSync(target);
    } catch (err) {
      throw new NubosPilotError(
        'staging-swap-failed',
        'Kann leeres Ziel-Dir nicht entfernen: ' + (err && err.message),
        { phase: 'remove-empty-target', tmp, target },
      );
    }
  }

  try {
    fs.renameSync(tmp, target);
    console.error(
      '  [staging] neue Installation nach ' +
        path.basename(target) +
        ' geswapt',
    );
  } catch (err) {
    if (oldPath) {
      try { fs.renameSync(oldPath, target); } catch {}
    }
    throw new NubosPilotError(
      'staging-swap-failed',
      'Kann Staging nicht finalisieren: ' + (err && err.message),
      { phase: 'rename-in', tmp, target, old: oldPath },
    );
  }

  if (oldPath) {
    try {
      fs.rmSync(oldPath, { recursive: true, force: true });
      console.error(
        '  [staging] alte Installation (' +
          path.basename(oldPath) +
          ') entfernt',
      );
    } catch (err) {
      throw new NubosPilotError(
        'staging-swap-failed',
        'Kann alte Installation nicht aufräumen: ' + (err && err.message),
        { phase: 'cleanup-old', tmp, target, old: oldPath },
      );
    }
  }

  return target;
}

module.exports = {
  stageDir,
  finalizeSwap,
  cleanStaleStaging,
};
