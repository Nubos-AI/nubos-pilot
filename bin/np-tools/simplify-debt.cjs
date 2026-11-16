'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const debt = require('../../lib/economy-debt.cjs');

function _parseFlags(list) {
  const out = { _: [], file: null, line: null, category: null, note: null, status: null, json: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') out.json = true;
    else if (a === '--file') out.file = list[++i];
    else if (a.startsWith('--file=')) out.file = a.slice('--file='.length);
    else if (a === '--line') out.line = list[++i];
    else if (a.startsWith('--line=')) out.line = a.slice('--line='.length);
    else if (a === '--category') out.category = list[++i];
    else if (a.startsWith('--category=')) out.category = a.slice('--category='.length);
    else if (a === '--note') out.note = list[++i];
    else if (a.startsWith('--note=')) out.note = a.slice('--note='.length);
    else if (a === '--status') out.status = list[++i];
    else if (a.startsWith('--status=')) out.status = a.slice('--status='.length);
    else out._.push(a);
  }
  return out;
}

function _renderList(entries, status) {
  if (entries.length === 0) {
    return status === 'resolved'
      ? 'No resolved economy-debt entries.'
      : 'Economy-debt ledger is empty. Lean already.';
  }
  const lines = entries.map((e) => {
    const where = e.line > 0 ? e.file + ':' + e.line : (e.file || '(no file)');
    const mark = e.status === 'resolved' ? '[x]' : '[ ]';
    return mark + ' ' + e.id + '  ' + e.category.padEnd(18) + ' ' + where + '\n      ' + e.note;
  });
  const open = entries.filter((e) => e.status === 'open').length;
  const resolved = entries.length - open;
  lines.push('');
  lines.push('total: ' + entries.length + ' (' + open + ' open, ' + resolved + ' resolved)');
  return lines.join('\n');
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = (list[0] || 'list').trim();
  const flags = _parseFlags(list.slice(1));

  if (verb === 'add') {
    const note = flags.note != null ? flags.note : flags._.join(' ');
    const entry = debt.addEntry(
      { file: flags.file, line: flags.line, category: flags.category, note },
      cwd,
    );
    stdout.write(JSON.stringify({ ok: true, action: 'add', was_new: entry.was_new, entry }) + '\n');
    return 0;
  }

  if (verb === 'resolve') {
    const id = flags._[0];
    const entry = debt.resolveEntry(id, cwd);
    stdout.write(JSON.stringify({ ok: true, action: 'resolve', entry }) + '\n');
    return 0;
  }

  if (verb === 'list') {
    const status = flags.status || 'open';
    const entries = debt.listEntries(status, cwd);
    if (flags.json) {
      stdout.write(JSON.stringify({ ok: true, action: 'list', status, count: entries.length, entries }, null, 2) + '\n');
    } else {
      stdout.write(_renderList(entries, status) + '\n');
    }
    return 0;
  }

  throw new NubosPilotError(
    'simplify-debt-unknown-verb',
    "simplify-debt verb must be 'add', 'list', or 'resolve' (got: " + verb + ')',
    { verb },
  );
}

module.exports = { run, _parseFlags, _renderList };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
