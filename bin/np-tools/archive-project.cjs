'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const archive = require('../../lib/archive.cjs');

function _parseCarryOver(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function _takeValue(list, i, flag) {
  const v = list[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    throw new NubosPilotError(
      'archive-project-missing-flag-value',
      'archive-project: ' + flag + ' requires a value',
      { flag, got: v === undefined ? null : v },
    );
  }
  return v;
}

function _parseArgs(list) {
  const out = {
    force: false, allow_unknown: false, carry_over: null, name: null, rel_path: null,
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--force') out.force = true;
    else if (a === '--allow-unknown') out.allow_unknown = true;
    else if (a === '--carry-over') { out.carry_over = _parseCarryOver(_takeValue(list, i, a)); i++; }
    else if (a.startsWith('--carry-over=')) out.carry_over = _parseCarryOver(a.slice('--carry-over='.length));
    else if (a === '--no-carry-over') out.carry_over = [];
    else if (a === '--name') { out.name = _takeValue(list, i, a); i++; }
    else if (a === '--rel') { out.rel_path = _takeValue(list, i, a); i++; }
    else {
      throw new NubosPilotError(
        'archive-project-unknown-flag',
        'archive-project: unknown flag: ' + String(a),
        {
          flag: a,
          allowed: ['--force', '--allow-unknown', '--carry-over', '--no-carry-over', '--name', '--rel'],
        },
      );
    }
  }
  return out;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];
  const rest = list.slice(1);
  const flags = _parseArgs(rest);

  switch (verb) {
    case 'status':
    case 'check': {
      const payload = {
        project_exists: archive.projectExists(cwd),
        completion: archive.computeCompletionStatus(cwd),
        archive_root: archive.archiveRoot(cwd),
      };
      stdout.write(JSON.stringify(payload, null, 2));
      return payload;
    }
    case 'do':
    case 'create': {
      const opts = {};
      if (flags.force) opts.force = true;
      if (flags.allow_unknown) opts.allow_unknown = true;
      if (flags.carry_over != null) opts.carry_over = flags.carry_over;
      const result = archive.archiveProject(cwd, opts);
      stdout.write(JSON.stringify(result, null, 2));
      return result;
    }
    case 'list': {
      const items = archive.listArchives(cwd);
      stdout.write(JSON.stringify(items, null, 2));
      return items;
    }
    case 'read': {
      if (!flags.name) {
        throw new NubosPilotError(
          'archive-read-missing-name',
          'archive-project read requires --name <archive-dir-name>',
          { args: list.slice() },
        );
      }
      if (!flags.rel_path) {
        throw new NubosPilotError(
          'archive-read-missing-rel',
          'archive-project read requires --rel <relative-path>',
          { args: list.slice() },
        );
      }
      const content = archive.readArchiveFile(cwd, flags.name, flags.rel_path);
      stdout.write(content);
      return { ok: true };
    }
    default:
      throw new NubosPilotError(
        'archive-project-unknown-verb',
        'archive-project: unknown verb: ' + String(verb),
        { verb, allowed: ['status', 'do', 'list', 'read'] },
      );
  }
}

module.exports = { run };
