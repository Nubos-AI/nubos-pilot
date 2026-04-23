'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { collectSnapshot, renderSnapshot, ANSI } = require('../../lib/dashboard.cjs');

const MIN_WATCH_SECONDS = 1;
const MAX_WATCH_SECONDS = 3600;

function _parseArgs(args) {
  const out = { json: false, noColor: false, watch: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json')     { out.json = true; continue; }
    if (a === '--no-color') { out.noColor = true; continue; }
    if (a === '--watch') {
      const raw = args[i + 1];
      if (raw && !raw.startsWith('-')) { out.watch = Number(raw); i += 1; }
      else out.watch = 3;
      continue;
    }
  }
  return out;
}

function _renderOnce(cwd, stdout, parsed) {
  const snap = collectSnapshot(cwd);
  if (parsed.json) {
    stdout.write(JSON.stringify(snap, null, 2) + '\n');
    return;
  }
  const useColor = !parsed.noColor && Boolean(stdout.isTTY);
  stdout.write(renderSnapshot(snap, { color: useColor }) + '\n');
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);

  if (parsed.watch != null) {
    if (!Number.isFinite(parsed.watch) || parsed.watch < MIN_WATCH_SECONDS || parsed.watch > MAX_WATCH_SECONDS) {
      throw new NubosPilotError(
        'dashboard-watch-out-of-range',
        '--watch seconds must be between ' + MIN_WATCH_SECONDS + ' and ' + MAX_WATCH_SECONDS,
        { got: parsed.watch },
      );
    }
    if (parsed.json) {
      throw new NubosPilotError(
        'dashboard-watch-incompatible-json',
        '--watch cannot be combined with --json (use a shell loop if you need JSON polling)',
        {},
      );
    }
    const tty = Boolean(stdout.isTTY);
    const clear = tty ? ANSI.clearScreen : '';
    const render = () => {
      try {
        stdout.write(clear);
        _renderOnce(cwd, stdout, parsed);
      } catch (err) {
        process.stderr.write('[nubos-pilot dashboard] render failed: ' + ((err && err.message) || err) + '\n');
      }
    };
    render();
    const handle = setInterval(render, parsed.watch * 1000);
    const stop = () => {
      clearInterval(handle);
      try { if (tty) stdout.write('\x1b[?25h'); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return new Promise(() => { });
  }

  _renderOnce(cwd, stdout, parsed);
  return 0;
}

module.exports = { run, _parseArgs };
