'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { atomicWriteFileSync, NubosPilotError, withFileLock } = require('../core.cjs');

const STATUSLINE_REL = '.claude/nubos-pilot/hooks/np-statusline.cjs';
const CTX_MONITOR_REL = '.claude/nubos-pilot/hooks/np-ctx-monitor.cjs';
const SECURITY_HOOK_REL = '.claude/nubos-pilot/hooks/np-security-hook.cjs';
const LEARNINGS_HOOK_REL = '.claude/nubos-pilot/hooks/np-learnings-hook.cjs';
const NP_STATUSLINE_MARKER = 'np-statusline.';
const NP_CTX_MONITOR_MARKER = 'np-ctx-monitor.';
const NP_SECURITY_MARKER = 'np-security-hook.';
const NP_LEARNINGS_MARKER = 'np-learnings-hook.';

const SECURITY_HOOKS = Object.freeze([
  { verb: 'session-start', event: 'SessionStart',    matcher: undefined },
  { verb: 'baseline',      event: 'UserPromptSubmit', matcher: undefined },
  { verb: 'scan',          event: 'PostToolUse',      matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { verb: 'review',        event: 'Stop',             matcher: undefined },
  { verb: 'commit',        event: 'PostToolUse',      matcher: 'Bash' },
]);
const SECURITY_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse']);

const LEARNINGS_HOOKS = Object.freeze([
  { verb: 'reset',   event: 'UserPromptSubmit', matcher: undefined },
  { verb: 'capture', event: 'Stop',             matcher: undefined },
  { verb: 'inject',  event: 'SessionStart',     matcher: undefined },
  { verb: 'inject',  event: 'PreCompact',       matcher: undefined },
]);
const LEARNINGS_EVENTS = Object.freeze(['UserPromptSubmit', 'Stop', 'SessionStart', 'PreCompact']);

function _settingsPath(scope, projectRoot) {
  if (scope === 'global') return path.join(os.homedir(), '.claude', 'settings.json');
  return path.join(projectRoot, '.claude', 'settings.local.json');
}

function _readJsonSafe(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new NubosPilotError(
      'claude-settings-unreadable',
      'Cannot read Claude settings: ' + path.basename(p) + ' (' + (err && err.code) + ')',
      { file: path.basename(p), cause: err && err.code },
    );
  }
  if (raw.trim() === '') return {};
  try { return JSON.parse(raw); } catch (err) {
    throw new NubosPilotError(
      'claude-settings-invalid-json',
      'Cannot parse Claude settings: ' + path.basename(p) + ' — ' + (err && err.message),
      { file: path.basename(p) },
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

function _verbOf(command) {
  const m = String(command).match(/"\s+([a-z-]+)\s*$/);
  return m ? m[1] : null;
}

function _installVerbHook(settings, eventName, matcher, cmd, verb, marker) {
  const mark = marker || NP_SECURITY_MARKER;
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks[eventName])) settings.hooks[eventName] = [];
  const list = settings.hooks[eventName];
  for (const entry of list) {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const h of hooks) {
      if (h && typeof h.command === 'string' && h.command.includes(mark) && _verbOf(h.command) === verb) {
        h.command = cmd;
        h.type = 'command';
        if (matcher !== undefined) entry.matcher = matcher;
        return { action: 'updated' };
      }
    }
  }
  const entry = matcher !== undefined
    ? { matcher, hooks: [{ type: 'command', command: cmd }] }
    : { hooks: [{ type: 'command', command: cmd }] };
  list.push(entry);
  return { action: 'installed' };
}

function _installSecurity(settings, scope, projectRoot) {
  const base = _hookCommand(SECURITY_HOOK_REL, scope, projectRoot);
  const results = {};
  for (const h of SECURITY_HOOKS) {
    results[h.verb] = _installVerbHook(settings, h.event, h.matcher, base + ' ' + h.verb, h.verb, NP_SECURITY_MARKER);
  }
  return results;
}

function _installLearnings(settings, scope, projectRoot) {
  const base = _hookCommand(LEARNINGS_HOOK_REL, scope, projectRoot);
  const results = {};
  for (const h of LEARNINGS_HOOKS) {
    results[h.verb] = _installVerbHook(settings, h.event, h.matcher, base + ' ' + h.verb, h.verb, NP_LEARNINGS_MARKER);
  }
  return results;
}

function _removeLearnings(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return { action: 'absent' };
  let removed = 0;
  for (const eventName of LEARNINGS_EVENTS) {
    if (!Array.isArray(settings.hooks[eventName])) continue;
    const filtered = [];
    for (const entry of settings.hooks[eventName]) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const kept = hooks.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(NP_LEARNINGS_MARKER)));
      if (kept.length > 0) {
        filtered.push(kept.length === hooks.length ? entry : Object.assign({}, entry, { hooks: kept }));
      } else {
        removed++;
      }
    }
    settings.hooks[eventName] = filtered;
    if (filtered.length === 0) delete settings.hooks[eventName];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { action: removed > 0 ? 'removed' : 'absent' };
}

function _removeSecurity(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return { action: 'absent' };
  let removed = 0;
  for (const eventName of SECURITY_EVENTS) {
    if (!Array.isArray(settings.hooks[eventName])) continue;
    const filtered = [];
    for (const entry of settings.hooks[eventName]) {
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const kept = hooks.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(NP_SECURITY_MARKER)));
      if (kept.length > 0) {
        filtered.push(kept.length === hooks.length ? entry : Object.assign({}, entry, { hooks: kept }));
      } else {
        removed++;
      }
    }
    settings.hooks[eventName] = filtered;
    if (filtered.length === 0) delete settings.hooks[eventName];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { action: removed > 0 ? 'removed' : 'absent' };
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

  const wantStatusline = which === 'statusline' || which === 'both' || which === 'all';
  const wantCtxMonitor = which === 'ctx-monitor' || which === 'both' || which === 'all';
  const wantSecurity = which === 'security' || which === 'all';
  const wantLearnings = which === 'learnings' || which === 'all';

  const statuslineCmd = _hookCommand(STATUSLINE_REL, scope, projectRoot);
  const ctxMonitorCmd = _hookCommand(CTX_MONITOR_REL, scope, projectRoot);

  const base = scope === 'global' ? os.homedir() : projectRoot;
  const statuslineAbs = path.join(base, STATUSLINE_REL);
  const ctxMonitorAbs = path.join(base, CTX_MONITOR_REL);
  const securityAbs = path.join(base, SECURITY_HOOK_REL);
  const learningsAbs = path.join(base, LEARNINGS_HOOK_REL);

  if (wantStatusline) {
    if (!fs.existsSync(statuslineAbs)) {
      throw new NubosPilotError(
        'claude-hooks-script-missing',
        'Statusline hook script not found: ' + statuslineAbs + '. Run `npx nubos-pilot` install first.',
        { script: statuslineAbs },
      );
    }
  }
  if (wantCtxMonitor) {
    if (!fs.existsSync(ctxMonitorAbs)) {
      throw new NubosPilotError(
        'claude-hooks-script-missing',
        'Ctx-monitor hook script not found: ' + ctxMonitorAbs,
        { script: ctxMonitorAbs },
      );
    }
  }
  if (wantSecurity) {
    if (!fs.existsSync(securityAbs)) {
      throw new NubosPilotError(
        'claude-hooks-script-missing',
        'Security hook script not found: ' + securityAbs,
        { script: securityAbs },
      );
    }
  }
  if (wantLearnings) {
    if (!fs.existsSync(learningsAbs)) {
      throw new NubosPilotError(
        'claude-hooks-script-missing',
        'Learnings hook script not found: ' + learningsAbs,
        { script: learningsAbs },
      );
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  return withFileLock(settingsPath, () => {
    const settings = _readJsonSafe(settingsPath);
    const results = {};

    if (wantStatusline) {
      results.statusline = _installStatusLine(settings, statuslineCmd, force);
    }
    if (wantCtxMonitor) {
      results.ctxMonitor = _installPostToolUse(settings, ctxMonitorCmd);
    }
    if (wantSecurity) {
      results.security = _installSecurity(settings, scope, projectRoot);
    }
    if (wantLearnings) {
      results.learnings = _installLearnings(settings, scope, projectRoot);
    }

    if (o.dryRun) return { dryRun: true, path: settingsPath, results, settings };

    atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { dryRun: false, path: settingsPath, results };
  });
}

function uninstallClaudeHooks(opts) {
  const o = opts || {};
  const projectRoot = o.projectRoot || process.cwd();
  const scope = o.scope === 'global' ? 'global' : 'local';
  const settingsPath = _settingsPath(scope, projectRoot);
  if (!fs.existsSync(settingsPath)) return { path: settingsPath, results: { statusline: { action: 'absent' }, ctxMonitor: { action: 'absent' }, security: { action: 'absent' }, learnings: { action: 'absent' } } };

  return withFileLock(settingsPath, () => {
    const settings = _readJsonSafe(settingsPath);
    const results = {
      statusline: _removeStatusLine(settings),
      ctxMonitor: _removePostToolUse(settings),
      security: _removeSecurity(settings),
      learnings: _removeLearnings(settings),
    };
    if (o.dryRun) return { dryRun: true, path: settingsPath, results, settings };
    atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return { dryRun: false, path: settingsPath, results };
  });
}

module.exports = {
  installClaudeHooks,
  uninstallClaudeHooks,
  STATUSLINE_REL,
  CTX_MONITOR_REL,
  SECURITY_HOOK_REL,
  NP_STATUSLINE_MARKER,
  NP_CTX_MONITOR_MARKER,
  NP_SECURITY_MARKER,
  SECURITY_HOOKS,
  LEARNINGS_HOOK_REL,
  NP_LEARNINGS_MARKER,
  LEARNINGS_HOOKS,
  _settingsPath,
  _hookCommand,
};
