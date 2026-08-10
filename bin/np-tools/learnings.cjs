'use strict';

const path = require('node:path');
const child_process = require('node:child_process');

const { tryReadConfigPath } = require('../../lib/config.cjs');
const ledger = require('../../lib/learnings/capture-ledger.cjs');
const extract = require('../../lib/learnings/extract.cjs');
const inject = require('../../lib/learnings/inject.cjs');
const headlessGuard = require('../../lib/headless-guard.cjs');
const args = require('./_args.cjs');

function _readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const timer = setTimeout(() => { try { process.stdin.removeAllListeners(); } catch {} resolve(buf); }, 800);
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

function _safeParse(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

async function _payload(argv) {
  const inline = args.getFlag(argv, '--payload', { allowDashValues: true });
  if (inline !== undefined) return _safeParse(inline);
  if (argv.includes('--stdin')) return _safeParse(await _readStdin());
  return {};
}

function _cfg(cwd) {
  return {
    auto_capture: tryReadConfigPath(cwd, 'learnings.auto_capture', true) !== false,
    max_per_hour: Number(tryReadConfigPath(cwd, 'learnings.max_captures_per_hour', 10)) || 10,
    max_in_a_row: Number(tryReadConfigPath(cwd, 'learnings.max_in_a_row', 3)) || 3,
    timeout_ms: Number(tryReadConfigPath(cwd, 'learnings.timeout_ms', 120000)) || 120000,
    max_files: Number(tryReadConfigPath(cwd, 'learnings.max_files', 30)) || 30,
  };
}

function _spawnWorker(cwd, sid) {
  const npTools = path.join(__dirname, '..', '..', 'np-tools.cjs');
  try {
    const child = child_process.spawn(
      process.execPath,
      [npTools, 'learnings', 'run-extract', '--session', sid],
      { cwd, detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch { return false; }
}

function _emit(stdout, obj) { stdout.write(JSON.stringify(obj) + '\n'); }

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];
  const verb = list[0];

  if (headlessGuard.isHeadless(process.env)) return 0;

  const cfg = _cfg(cwd);

  if (verb === 'capture') {
    if (!cfg.auto_capture) { _emit(stdout, { captured: false, reason: 'disabled' }); return 0; }
    const payload = await _payload(list);
    const sid = payload.session_id || args.getFlag(list, '--session') || '';
    if (!sid) { _emit(stdout, { captured: false, reason: 'no-session' }); return 0; }
    const gate = ledger.tryRecordCapture(sid, { maxPerHour: cfg.max_per_hour, maxStreak: cfg.max_in_a_row });
    if (!gate.allowed) { _emit(stdout, { captured: false, reason: gate.reason }); return 0; }
    _spawnWorker(cwd, sid);
    _emit(stdout, { captured: true, spawned: true });
    return 0;
  }

  if (verb === 'reset') {
    const payload = await _payload(list);
    const sid = payload.session_id || args.getFlag(list, '--session') || '';
    if (sid) ledger.resetStreak(sid);
    return 0;
  }

  if (verb === 'inject') {
    let block;
    try { block = inject.buildInjection(cwd, {}); }
    catch { return 0; }
    if (!block.text) return 0;
    _emit(stdout, {
      hookSpecificOutput: {
        hookEventName: args.getFlag(list, '--event') || 'SessionStart',
        additionalContext: block.text,
      },
    });
    return 0;
  }

  if (verb === 'run-extract') {
    const sid = args.getFlag(list, '--session') || '';
    try {
      const result = await extract.runExtract({ cwd, sid, config: cfg });
      _emit(stdout, result);
    } catch (err) {
      _emit(stdout, { ran: false, reason: 'error', error: String(err && err.code || err) });
    }
    return 0;
  }

  _emit(stdout, { error: 'unknown-verb', verb: verb || null, verbs: ['capture', 'reset', 'inject', 'run-extract'] });
  return verb ? 1 : 0;
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(3)).then((c) => process.exit(c)).catch(() => process.exit(0));
}
