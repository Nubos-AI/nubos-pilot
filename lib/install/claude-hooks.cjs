'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteFileSync, NubosPilotError } = require('../core.cjs');

const STATUSLINE_REL = '.claude/nubos-pilot/hooks/np-statusline.js';
const CTX_MONITOR_REL = '.claude/nubos-pilot/hooks/np-ctx-monitor.js';
const NP_STATUSLINE_MARKER = 'np-statusline.js';
const NP_CTX_MONITOR_MARKER = 'np-ctx-monitor.js';

function _settingsPath(scope, projectRoot) {
  if (scope === 'global') return path.join(os.homedir(), '.claude', 'settings.json');
  return path.join(projectRoot, '.claude', 'settings.local.json');
}

function _readJsonSafe(p) {
  if (!fs.existsSync(p)) return {};
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch { return {}; }
  try { return JSON.parse(raw); } catch (err) {
    throw new NubosPilotError(
      'claude-settings-invalid-json',
      'Cannot parse Claude settings: ' + p + ' — ' + err.message,
      { path: p },
    );
  }
}

function _hookCommand(rel, scope, projectRoot) {
  if (scope === 'global') {
    return 'node "' + path.join('$HOME', rel) + '"';
  }
  return 'node "' + path.join(projectRoot, rel) + '"';
}

function _containsNpHook(entry, marker) {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  for (const h of hooks) {
    if (h && typeof h.command === 'string' && h.command.includes(marker)) return true;
  }
  return false;
}

function _installStatusLine(settings, cmd, force) {
  const existing = settings.statusLine;
  if (existing && typeof existing === 'object' && existing.command) {
    if (String(existing.command).includes(NP_STATUSLINE_MARKER)) {
      settings.statusLine = { type: 'command', command: cmd };
      return { action: 'updated', existed: true };
    }
    if (!force) {
      return { action: 'skipped-existing', existed: true, existingCommand: existing.command };
    }
    settings.statusLine = { type: 'command', command: cmd };
    return { action: 'overwrote', existed: true };
  }
  settings.statusLine = { type: 'command', command: cmd };
  return { action: 'installed', existed: false };
}

function _installPostToolUse(settings, cmd) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
  const list = settings.hooks.PostToolUse;
  for (const entry of list) {
    if (_containsNpHook(entry, NP_CTX_MONITOR_MARKER)) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const h of hooks) {
        if (h && typeof h.command === 'string' && h.command.includes(NP_CTX_MONITOR_MARKER)) {
          h.command = cmd;
          h.type = 'command';
        }
      }
      return { action: 'updated' };
    }
  }
  list.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: cmd }],
  });
  return { action: 'installed' };
}

function _removeStatusLine(settings) {
  const existing = settings.statusLine;
  if (existing && typeof existing === 'object'
      && typeof existing.command === 'string'
      && existing.command.includes(NP_STATUSLINE_MARKER)) {
    delete settings.statusLine;
    return { action: 'removed' };
  }
  return { action: 'not-ours' };
}

function _removePostToolUse(settings) {
  if (!settings.hooks || !Array.isArray(settings.hooks.PostToolUse)) return { action: 'absent' };
  const filtered = [];
  for (const entry of settings.hooks.PostToolUse) {
    if (_containsNpHook(entry, NP_CTX_MONITOR_MARKER)) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const keptHooks = hooks.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(NP_CTX_MONITOR_MARKER)));
      if (keptHooks.length > 0) {
        filtered.push(Object.assign({}, entry, { hooks: keptHooks }));
      }
      continue;
    }
    filtered.push(entry);
  }
  settings.hooks.PostToolUse = filtered;
  if (filtered.length === 0) delete settings.hooks.PostToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { action: 'removed' };
}

function installClaudeHooks(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || process.cwd();
  const scope = o.scope === 'global' ? 'global' : 'local';
  const force = !!o.force;
  const which = o.which || 'both';
  const settingsPath = _settingsPath(scope, projectRoot);

  const statuslineCmd = _hookCommand(STATUSLINE_REL, scope, projectRoot);
  const ctxMonitorCmd = _hookCommand(CTX_MONITOR_REL, scope, projectRoot);

  const statuslineAbs = path.join(scope === 'global' ? os.homedir() : projectRoot, STATUSLINE_REL);
  const ctxMonitorAbs = path.join(scope === 'global' ? os.homedir() : projectRoot, CTX_MONITOR_REL);

  if (which === 'statusline' || which === 'both') {
    if (!fs.existsSync(statuslineAbs)) {
      throw new NubosPilotError(
        'claude-hooks-script-missing',
        'Statusline hook script not found: ' + statuslineAbs + '. Run `npx nubos-pilot` install first.',
        { script: statuslineAbs },
      );
    }
  }
  if (which === 'ctx-monitor' || which === 'both') {
    if (!fs.existsSync(ctxMonitorAbs)) {
      throw new NubosPilotError(
        'claude-hooks-script-missing',
        'Ctx-monitor hook script not found: ' + ctxMonitorAbs,
        { script: ctxMonitorAbs },
      );
    }
  }

  const settings = _readJsonSafe(settingsPath);
  const results = {};

  if (which === 'statusline' || which === 'both') {
    results.statusline = _installStatusLine(settings, statuslineCmd, force);
  }
  if (which === 'ctx-monitor' || which === 'both') {
    results.ctxMonitor = _installPostToolUse(settings, ctxMonitorCmd);
  }

  if (o.dryRun) return { dryRun: true, path: settingsPath, results, settings };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { dryRun: false, path: settingsPath, results };
}

function uninstallClaudeHooks(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || process.cwd();
  const scope = o.scope === 'global' ? 'global' : 'local';
  const settingsPath = _settingsPath(scope, projectRoot);
  if (!fs.existsSync(settingsPath)) return { path: settingsPath, results: { statusline: { action: 'absent' }, ctxMonitor: { action: 'absent' } } };

  const settings = _readJsonSafe(settingsPath);
  const results = {
    statusline: _removeStatusLine(settings),
    ctxMonitor: _removePostToolUse(settings),
  };
  if (o.dryRun) return { dryRun: true, path: settingsPath, results, settings };
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { dryRun: false, path: settingsPath, results };
}

module.exports = {
  installClaudeHooks,
  uninstallClaudeHooks,
  STATUSLINE_REL,
  CTX_MONITOR_REL,
  NP_STATUSLINE_MARKER,
  NP_CTX_MONITOR_MARKER,
  _settingsPath,
  _hookCommand,
};
