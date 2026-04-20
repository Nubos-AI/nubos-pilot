'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const registryMod = require('./runtimes-registry.cjs');

function _hashFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function _listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort();
}

function _payloadBase(scope, projectRoot) {
  return scope === 'global' ? os.homedir() : projectRoot;
}

function _toPosix(p) {
  return p.split(path.sep).join('/');
}

function planRuntimeAssets({ selectedRuntimes, scope, projectRoot, workflowsDir, agentsDir }) {
  const base = _payloadBase(scope, projectRoot);
  const workflows = _listMarkdown(workflowsDir);
  const agents = _listMarkdown(agentsDir);
  const plans = [];
  for (const id of selectedRuntimes || []) {
    const meta = registryMod.getRuntimeMeta(id);
    if (!meta) continue;
    const configDir = registryMod.runtimeConfigDir(meta, scope, projectRoot);
    if (meta.commandsSubdir) {
      for (const file of workflows) {
        const targetFile = path.join(configDir, meta.commandsSubdir, file);
        plans.push({
          runtime: id,
          kind: 'command',
          sourceFile: path.join(workflowsDir, file),
          targetFile,
          manifestKey: _toPosix(path.relative(base, targetFile)),
        });
      }
    }
    if (meta.agentsSubdir) {
      for (const file of agents) {
        const targetFile = path.join(configDir, meta.agentsSubdir, file);
        plans.push({
          runtime: id,
          kind: 'agent',
          sourceFile: path.join(agentsDir, file),
          targetFile,
          manifestKey: _toPosix(path.relative(base, targetFile)),
        });
      }
    }
  }
  return plans;
}

function manifestEntriesForPlans(plans) {
  const entries = Object.create(null);
  for (const plan of plans) {
    entries[plan.manifestKey] = _hashFile(plan.sourceFile);
  }
  return entries;
}

function writeRuntimeAssets(plans) {
  const written = [];
  for (const plan of plans) {
    fs.mkdirSync(path.dirname(plan.targetFile), { recursive: true });
    fs.copyFileSync(plan.sourceFile, plan.targetFile);
    written.push(plan.targetFile);
  }
  return written;
}

function removeStaleAssets(staleKeys, scope, projectRoot) {
  const base = _payloadBase(scope, projectRoot);
  const removed = [];
  const dirs = new Set();
  for (const key of staleKeys || []) {
    if (!_isAssetKey(key)) continue;
    const abs = path.join(base, key);
    try {
      fs.unlinkSync(abs);
      removed.push(abs);
      dirs.add(path.dirname(abs));
    } catch {}
  }
  _pruneEmptyDirs(dirs, base);
  return removed;
}

function _isAssetKey(key) {
  if (typeof key !== 'string') return false;
  if (key.startsWith('~/')) return true;
  if (key.startsWith('.')) {
    if (key.startsWith('.claude/commands/')) return true;
    if (key.startsWith('.claude/agents/')) return true;
    for (const meta of registryMod.RUNTIMES) {
      if (meta.commandsSubdir) {
        if (key.startsWith(meta.localDir + '/' + meta.commandsSubdir + '/')) return true;
      }
      if (meta.agentsSubdir) {
        if (key.startsWith(meta.localDir + '/' + meta.agentsSubdir + '/')) return true;
      }
    }
  }
  return false;
}

function _pruneEmptyDirs(dirSet, base) {
  const sorted = Array.from(dirSet).sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    let cur = dir;
    while (cur && cur.startsWith(base) && cur !== base) {
      try {
        const entries = fs.readdirSync(cur);
        if (entries.length > 0) break;
        fs.rmdirSync(cur);
      } catch { break; }
      cur = path.dirname(cur);
    }
  }
}

function isAssetManifestKey(key) {
  return _isAssetKey(key);
}

module.exports = {
  planRuntimeAssets,
  manifestEntriesForPlans,
  writeRuntimeAssets,
  removeStaleAssets,
  isAssetManifestKey,
};
