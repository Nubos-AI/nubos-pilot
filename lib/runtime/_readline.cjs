const readline = require('node:readline');
const { NubosPilotError } = require('../core.cjs');
const { resolveLanguage, normalizeLanguage } = require('../language.cjs');

const LABELS = Object.freeze({
  en: {
    choice: 'Choice',
    multiselect_hint: 'Select multiple: 1,2,6 or 1 2 6',
  },
  de: {
    choice: 'Auswahl',
    multiselect_hint: 'Mehrfachauswahl: 1,2,6 oder 1 2 6',
  },
});

function _labelsFor(language) {
  const lang = normalizeLanguage(language || 'en');
  return LABELS[lang] || LABELS.en;
}

function _resolveLangForCwd() {
  try { return resolveLanguage(process.cwd()); }
  catch { return 'en'; }
}

let _readlineImpl = null;

function _setReadlineImplForTests(impl) {
  _readlineImpl = impl || null;
}

function _hasReadlineImplForTests() {
  return _readlineImpl != null;
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

// Workflows pass options in two shapes: plain strings, and AskUserQuestion's
// native { label, description } objects. The object shape used to reach
// String(opt) — rendering "[object Object]" — and to be returned verbatim, so
// askuser.cjs JSON.stringify'd it and no `case "$CHOICE" in "Abort")` ever
// matched. The label IS the contract; everything downstream compares against it.
//
// So there is nothing to guess at: an option that cannot yield a usable label
// is a caller bug. String(opt) as a fallback only relocated the defect (any
// shape but `typeof opt.label === 'string'` still produced "[object Object]"
// in the menu AND as the answer). Fail closed instead — silent → loud.
const OPTION_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const KNOWN_TYPES = Object.freeze(['select', 'multiselect', 'confirm', 'input']);

function _describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    let json;
    try { json = JSON.stringify(value); } catch { json = null; }
    if (!json) return Object.prototype.toString.call(value);
    return json.length > 120 ? json.slice(0, 117) + '...' : json;
  }
  return typeof value + ' ' + JSON.stringify(String(value));
}

function _optionLabel(opt) {
  if (typeof opt === 'string') return opt;
  if (opt && typeof opt === 'object' && !Array.isArray(opt) && typeof opt.label === 'string') {
    return opt.label;
  }
  throw new NubosPilotError(
    'askuser-invalid-option',
    'askUser option must be a string or { label: string }, got: ' + _describe(opt),
    { option: _describe(opt) },
  );
}

function _optionDisplay(opt) {
  const label = _optionLabel(opt);
  if (opt && typeof opt === 'object') {
    const desc = typeof opt.description === 'string' ? opt.description.trim() : '';
    return desc ? label + ' — ' + desc : label;
  }
  return label;
}

// The label survives verbatim into `CHOICE=$(… askuser …)` and is matched by
// `case "$CHOICE" in`, so every property that breaks that round-trip is a spec
// error: "" is indistinguishable from a failure, a newline shatters the
// numbered menu and yields a multi-line $CHOICE, padding survives into the
// case arm (descriptions are trimmed, labels never are), and two identical
// labels make the answer ambiguous for caller and default marker alike.
function _validateOption(opt, i) {
  const label = _optionLabel(opt);
  const where = 'askUser option ' + (i + 1);
  if (label.trim() === '') {
    throw new NubosPilotError(
      'askuser-invalid-option',
      where + ' has an empty label — an empty answer is indistinguishable from a failure',
      { index: i, option: _describe(opt) },
    );
  }
  if (OPTION_CONTROL_CHARS.test(label)) {
    throw new NubosPilotError(
      'askuser-invalid-option',
      where + ' label contains a control character (newline/tab/CR): ' + JSON.stringify(label),
      { index: i, label },
    );
  }
  if (label !== label.trim()) {
    throw new NubosPilotError(
      'askuser-invalid-option',
      where + ' label has leading/trailing whitespace: ' + JSON.stringify(label)
        + ' — the label is returned verbatim, so the padding reaches `case "$CHOICE"`',
      { index: i, label },
    );
  }
  if (opt && typeof opt === 'object' && opt.description != null && typeof opt.description !== 'string') {
    throw new NubosPilotError(
      'askuser-invalid-option',
      where + ' has a non-string description: ' + _describe(opt.description),
      { index: i, description: _describe(opt.description) },
    );
  }
  return label;
}

// The spec field is `question`. A spec carrying the text under any other key
// (`prompt` was the historic mistake) renders an undefined question: the dialog
// still appears, but asks nothing. Callers cannot see that from the answer, so
// this is checked at every entry point that owns a question rather than inside
// _validateSpec, which _parseAnswer also calls without one.
function _validateQuestion(question, type) {
  if (typeof question !== 'string' || question.trim() === '') {
    throw new NubosPilotError(
      'askuser-missing-question',
      'askUser spec needs a non-empty question string, got: ' + _describe(question)
        + ' (the field is named "question")',
      { type, question: _describe(question) },
    );
  }
}

function _validateSpec(type, options, def) {
  if (!KNOWN_TYPES.includes(type)) {
    throw new NubosPilotError(
      'askuser-invalid-type',
      'Unknown askUser type: ' + type,
      { type },
    );
  }
  if (type !== 'select' && type !== 'multiselect') {
    if (type === 'confirm' && def != null && typeof def !== 'boolean') {
      throw new NubosPilotError(
        'askuser-invalid-spec',
        'askUser confirm default must be a boolean, got: ' + _describe(def),
        { type, default: _describe(def) },
      );
    }
    return;
  }
  if (!Array.isArray(options) || options.length === 0) {
    // An empty options array with a fallback default is legitimate — options
    // built from a scan that returned nothing, where the caller supplied the
    // value to fall back to. There is nothing to select, so the default is the
    // only answer; return without the membership check below (seen is empty). A
    // non-array options value is still a spec error, and an empty list with no
    // default is unanswerable — both stay loud.
    if (Array.isArray(options) && def != null) return;
    throw new NubosPilotError(
      'askuser-invalid-spec',
      'askUser ' + type + ' needs a non-empty options array'
        + (Array.isArray(options) ? ' (or a default to fall back to)' : '')
        + ', got: ' + _describe(options),
      { type, options: _describe(options) },
    );
  }
  const seen = new Map();
  for (let i = 0; i < options.length; i++) {
    const label = _validateOption(options[i], i);
    if (seen.has(label)) {
      throw new NubosPilotError(
        'askuser-duplicate-option',
        'askUser options ' + (seen.get(label) + 1) + ' and ' + (i + 1) + ' share the label '
          + JSON.stringify(label) + ' — the answer would be ambiguous',
        { label, indices: [seen.get(label), i] },
      );
    }
    seen.set(label, i);
  }
  if (def == null) return;
  const wanted = type === 'multiselect' && Array.isArray(def) ? def : [def];
  for (const d of wanted) {
    const label = _optionLabel(d);
    if (!seen.has(label)) {
      throw new NubosPilotError(
        'askuser-invalid-spec',
        'askUser default ' + JSON.stringify(label) + ' is not one of the options — pressing Enter '
          + 'would return a value the caller never offered',
        { label, options: [...seen.keys()] },
      );
    }
  }
}

function _normalizeDefault(type, def) {
  if (def == null) return def;
  if (type === 'select') return _optionLabel(def);
  if (type === 'multiselect') {
    return Array.isArray(def) ? def.map(_optionLabel) : _optionLabel(def);
  }
  return def;
}

function _parseAnswer(type, rawLine, options, def, language, skipValidate) {
  // The claude.cjs marker-block door and direct callers land here without a
  // prior guard, so validate — unless askUserReadline already did before render
  // (it passes skipValidate, so the readline path validates once, not twice).
  if (!skipValidate) _validateSpec(type, options, def);
  const line = (rawLine == null ? '' : String(rawLine)).trim();
  if (type === 'select') {
    if (line === '' && def != null) return _normalizeDefault(type, def);
    const n = Number(line);
    if (!Number.isInteger(n) || n < 1 || !options || n > options.length) {
      throw new NubosPilotError(
        'askuser-invalid-response',
        'Invalid select index: ' + line,
        { line, optionsCount: options ? options.length : 0 },
      );
    }
    return _optionLabel(options[n - 1]);
  }
  if (type === 'multiselect') {
    if (line === '' && def != null) return _normalizeDefault(type, def);
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
      picks.push(_optionLabel(options[n - 1]));
    }
    return picks;
  }
  if (type === 'confirm') {
    if (line === '' && def != null) return def;
    if (/^y(es)?$/i.test(line)) return true;
    if (/^n(o)?$/i.test(line)) return false;
    if (normalizeLanguage(language || 'en') === 'de') {
      if (/^j(a)?$/i.test(line)) return true;
      if (/^nein$/i.test(line)) return false;
    }
    if (def != null) return def;
    throw new NubosPilotError(
      'askuser-invalid-response',
      'Invalid confirm answer: ' + line,
      { line },
    );
  }
  if (line === '' && def != null) return def;
  return rawLine == null ? '' : String(rawLine);
}

const NUBOS_BLUE = '\x1b[38;5;33m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RESET = '\x1b[0m';

function _stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function _confirmGlyphs(language) {
  return normalizeLanguage(language || 'en') === 'de'
    ? { yes: 'j', no: 'n' }
    : { yes: 'y', no: 'n' };
}

function _defaultDisplay(type, options, def, language) {
  if (def == null) {
    if (type === 'confirm') {
      const g = _confirmGlyphs(language);
      return '[' + g.yes + '/' + g.no + ']';
    }
    return '';
  }
  if (type === 'confirm') {
    const g = _confirmGlyphs(language);
    if (def === true) return '[' + g.yes.toUpperCase() + '/' + g.no + ']';
    if (def === false) return '[' + g.yes + '/' + g.no.toUpperCase() + ']';
    return '[' + g.yes + '/' + g.no + ']';
  }
  if (type === 'select') {
    if (options) {
      const wanted = _optionLabel(def);
      const idx = options.findIndex((o) => _optionLabel(o) === wanted);
      if (idx >= 0) return '[' + (idx + 1) + ']';
    }
    return '[' + String(def) + ']';
  }
  if (type === 'multiselect') {
    if (Array.isArray(def) && options) {
      const idxs = def.map((v) => {
        const wanted = _optionLabel(v);
        return options.findIndex((o) => _optionLabel(o) === wanted);
      });
      if (idxs.every((i) => i >= 0)) return '[' + idxs.map((i) => i + 1).join(',') + ']';
    }
    return '[' + (Array.isArray(def) ? def.map(_optionLabel).join(',') : _optionLabel(def)) + ']';
  }
  return '[' + String(def) + ']';
}

async function askUserReadline({ type, question, options, def, language }) {
  // Before the TTY branch: a broken spec must be loud even on the no-TTY
  // default path, where nothing is ever rendered to catch the eye.
  _validateQuestion(question, type);
  _validateSpec(type, options, def);
  const hasTTY = !!process.stdin.isTTY;
  if (!hasTTY && !_readlineImpl) {
    if (def != null) return { value: _normalizeDefault(type, def), source: 'default' };
    throw new NubosPilotError(
      'askuser-no-tty',
      'askUser cannot prompt without TTY',
      { question },
    );
  }
  const lang = language || _resolveLangForCwd();
  const labels = _labelsFor(lang);
  process.stderr.write('\n');
  process.stderr.write('  ' + ANSI_YELLOW + _stripAnsi(question) + ANSI_RESET + '\n');
  process.stderr.write('\n');
  if (type === 'select' || type === 'multiselect') {
    if (options) {
      for (let i = 0; i < options.length; i++) {
        process.stderr.write(
          '  ' + NUBOS_BLUE + (i + 1) + ')' + ANSI_RESET + ' ' + _optionDisplay(options[i]) + '\n',
        );
      }
    }
    process.stderr.write('\n');
    if (type === 'multiselect') {
      process.stderr.write('  ' + labels.multiselect_hint + '\n');
      process.stderr.write('\n');
    }
  }
  const marker = _defaultDisplay(type, options, def, lang);
  process.stderr.write('  ' + labels.choice + (marker ? ' ' + marker : '') + ': ');
  const line = await _readOneLine();
  return { value: _parseAnswer(type, line, options, def, lang, true), source: 'readline' };
}

module.exports = {
  askUserReadline,
  _readOneLine,
  _parseAnswer,
  _optionLabel,
  _optionDisplay,
  _validateSpec,
  _validateQuestion,
  _setReadlineImplForTests,
  _hasReadlineImplForTests,
};
