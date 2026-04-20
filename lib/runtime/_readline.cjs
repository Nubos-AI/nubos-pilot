const readline = require('node:readline');
const { NubosPilotError } = require('../core.cjs');

let _readlineImpl = null;

function _setReadlineImplForTests(impl) {
  _readlineImpl = impl || null;
}

function _readOneLine() {
  if (_readlineImpl) return Promise.resolve(_readlineImpl());
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });
    let done = false;
    rl.once('line', (line) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (done) return;
      done = true;
      resolve('');
    });
    rl.once('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function _parseAnswer(type, rawLine, options, def) {
  const line = (rawLine == null ? '' : String(rawLine)).trim();
  if (type === 'select') {
    if (line === '' && def != null) return def;
    const n = Number(line);
    if (!Number.isInteger(n) || n < 1 || !options || n > options.length) {
      throw new NubosPilotError(
        'askuser-invalid-response',
        'Invalid select index: ' + line,
        { line, optionsCount: options ? options.length : 0 },
      );
    }
    return options[n - 1];
  }
  if (type === 'multiselect') {
    if (line === '' && def != null) return def;
    const parts = line.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const picks = [];
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || !options || n > options.length) {
        throw new NubosPilotError(
          'askuser-invalid-response',
          'Invalid multiselect index: ' + p,
          { line, part: p },
        );
      }
      picks.push(options[n - 1]);
    }
    return picks;
  }
  if (type === 'confirm') {
    if (line === '' && def != null) return def;
    if (/^y(es)?$/i.test(line)) return true;
    if (/^n(o)?$/i.test(line)) return false;
    if (def != null) return def;
    throw new NubosPilotError(
      'askuser-invalid-response',
      'Invalid confirm answer: ' + line,
      { line },
    );
  }
  if (type === 'input') {
    if (line === '' && def != null) return def;
    return rawLine == null ? '' : String(rawLine);
  }
  throw new NubosPilotError(
    'askuser-invalid-type',
    'Unknown askUser type: ' + type,
    { type },
  );
}

const NUBOS_BLUE = '\x1b[38;5;33m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RESET = '\x1b[0m';

function _stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function _defaultDisplay(type, options, def) {
  if (def == null) {
    if (type === 'confirm') return '[y/n]';
    return '';
  }
  if (type === 'confirm') {
    if (def === true) return '[Y/n]';
    if (def === false) return '[y/N]';
    return '[y/n]';
  }
  if (type === 'select') {
    if (options) {
      const idx = options.indexOf(def);
      if (idx >= 0) return '[' + (idx + 1) + ']';
    }
    return '[' + String(def) + ']';
  }
  if (type === 'multiselect') {
    if (Array.isArray(def) && options) {
      const idxs = def.map((v) => options.indexOf(v));
      if (idxs.every((i) => i >= 0)) return '[' + idxs.map((i) => i + 1).join(',') + ']';
    }
    return '[' + (Array.isArray(def) ? def.join(',') : String(def)) + ']';
  }
  return '[' + String(def) + ']';
}

async function askUserReadline({ type, question, options, def }) {
  const hasTTY = !!process.stdin.isTTY;
  if (!hasTTY && !_readlineImpl) {
    if (def != null) return { value: def, source: 'default' };
    throw new NubosPilotError(
      'askuser-no-tty',
      'askUser cannot prompt without TTY',
      { question },
    );
  }
  process.stderr.write('\n');
  process.stderr.write('  ' + ANSI_YELLOW + _stripAnsi(question) + ANSI_RESET + '\n');
  process.stderr.write('\n');
  if (type === 'select' || type === 'multiselect') {
    if (options) {
      for (let i = 0; i < options.length; i++) {
        process.stderr.write(
          '  ' + NUBOS_BLUE + (i + 1) + ')' + ANSI_RESET + ' ' + String(options[i]) + '\n',
        );
      }
    }
    process.stderr.write('\n');
    if (type === 'multiselect') {
      process.stderr.write('  Select multiple: 1,2,6 or 1 2 6\n');
      process.stderr.write('\n');
    }
  }
  const marker = _defaultDisplay(type, options, def);
  process.stderr.write('  Choice' + (marker ? ' ' + marker : '') + ': ');
  const line = await _readOneLine();
  return { value: _parseAnswer(type, line, options, def), source: 'readline' };
}

module.exports = { askUserReadline, _readOneLine, _parseAnswer, _setReadlineImplForTests };
