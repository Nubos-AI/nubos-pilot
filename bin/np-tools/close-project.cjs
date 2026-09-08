'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { emitInitPayload } = require('../../lib/init-emit.cjs');
const archive = require('../../lib/archive.cjs');
const textMode = require('../../lib/text-mode.cjs');

function _initPayload(cwd) {
  const completion = archive.computeCompletionStatus(cwd);
  const tmDetail = textMode.resolveTextModeDetail(cwd);
  return {
    _workflow: 'close-project',
    cwd,
    project_exists: archive.projectExists(cwd),
    completion,
    summary_path: archive.projectSummaryPath(cwd),
    text_mode: tmDetail.enabled,
    text_mode_source: tmDetail.source,
  };
}

function _emitSummary(cwd) {
  return archive.writeProjectSummary(cwd);
}

function _mark(cwd) {
  return archive.setProjectStatus(cwd, 'completed');
}

function _guardBlockers(cwd, force, verb) {
  const completion = archive.computeCompletionStatus(cwd);
  if (!completion.complete && !force) {
    throw new NubosPilotError(
      'close-project-blocked',
      'project has unresolved blockers — resolve them or pass --force:\n'
        + completion.blockers.map((b) => '  - ' + b).join('\n'),
      { verb, blockers: completion.blockers, status: completion.status },
    );
  }
  return completion;
}

function _unmark(cwd) {
  return archive.setProjectStatus(cwd, 'active');
}

function _parseCarryOver(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function _takeValue(list, i, flag) {
  const v = list[i + 1];
  if (v === undefined || String(v).startsWith('--')) {
    throw new NubosPilotError(
      'close-project-missing-flag-value',
      'close-project: ' + flag + ' requires a value',
      { flag, got: v === undefined ? null : v },
    );
  }
  return v;
}

function _parseArgs(list) {
  const out = { archive: false, force: false, allow_unknown: false, carry_over: null };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--archive') out.archive = true;
    else if (a === '--force') out.force = true;
    else if (a === '--allow-unknown') out.allow_unknown = true;
    else if (a === '--carry-over') { out.carry_over = _parseCarryOver(_takeValue(list, i, a)); i++; }
    else if (a.startsWith('--carry-over=')) out.carry_over = _parseCarryOver(a.slice('--carry-over='.length));
    else if (a === '--no-carry-over') out.carry_over = [];
    else {
      throw new NubosPilotError(
        'close-project-unknown-flag',
        'close-project: unknown flag: ' + String(a),
        {
          flag: a,
          allowed: ['--archive', '--force', '--allow-unknown', '--carry-over', '--no-carry-over'],
        },
      );
    }
  }
  return out;
}

function _close(cwd, flags) {
  const completion = _guardBlockers(cwd, flags.force, 'close');

  const summary = _emitSummary(cwd);
  let marked;
  try {
    marked = _mark(cwd);
  } catch (err) {
    throw new NubosPilotError(
      'close-project-status-flip-failed',
      'PROJECT-SUMMARY.md was written but project_status could not be set ('
        + ((err && err.code) || 'unknown') + '): ' + (err && err.message)
        + ' — the project is half-closed; fix roadmap.yaml and re-run close',
      { summary_path: summary.path, cause: (err && err.code) || null },
    );
  }
  const out = {
    closed: true,
    forced: flags.force === true,
    closed_with_blockers: !completion.complete,
    completion_status: completion.status,
    summary_path: summary.path,
    project_status: marked.project_status,
    archived: false,
  };

  if (!flags.archive) return out;

  const opts = { force: flags.force, completion };
  if (flags.allow_unknown) opts.allow_unknown = true;
  if (flags.carry_over != null) opts.carry_over = flags.carry_over;
  try {
    out.archive = archive.archiveProject(cwd, opts);
    out.archived = true;
  } catch (err) {
    out.archive_error = (err && err.code) || 'archive-failed';
    out.archive_error_message = err && err.message;
  }
  return out;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];
  const flags = _parseArgs(list.slice(1));

  switch (verb) {
    case 'init':
    case undefined: {
      const payload = _initPayload(cwd);
      emitInitPayload(payload, stdout, cwd, 'close-project');
      return payload;
    }
    case 'check': {
      const payload = archive.computeCompletionStatus(cwd);
      stdout.write(JSON.stringify(payload, null, 2));
      return payload;
    }
    case 'write-summary': {
      const result = _emitSummary(cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    case 'mark-completed': {
      _guardBlockers(cwd, flags.force, 'mark-completed');
      const result = _mark(cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    case 'close': {
      const result = _close(cwd, flags);
      stdout.write(JSON.stringify(result, null, 2));
      if (result.archive_error) {
        throw new NubosPilotError(
          'close-project-archive-failed',
          'project was closed but archiving failed (' + result.archive_error + '): '
            + result.archive_error_message
            + ' — the close stands; retry the archive with archive-project do',
          {
            archive_error: result.archive_error,
            summary_path: result.summary_path,
            project_status: result.project_status,
          },
        );
      }
      return result;
    }
    case 'unmark': {
      const result = _unmark(cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    default:
      throw new NubosPilotError(
        'close-project-unknown-verb',
        'close-project: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run };
