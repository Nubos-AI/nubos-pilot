const { COMMANDS, localizedCommands, categoryLabel } = require('./_commands.cjs');
const { resolveLanguage } = require('../../lib/language.cjs');

function _renderText(commands, language) {
  const byCat = new Map();
  for (const c of commands) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const lines = [];
  for (const [cat, items] of byCat) {
    lines.push(categoryLabel(cat, language));
    for (const c of items) {
      lines.push('  ' + c.name.padEnd(10) + c.description);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function _resolveLangForCwd(cwd) {
  try { return resolveLanguage(cwd || process.cwd()); }
  catch { return 'en'; }
}

function run(args, ctx) {
  const list = Array.isArray(args) ? args : [];
  const cwd = (ctx && ctx.cwd) || process.cwd();
  const language = _resolveLangForCwd(cwd);
  const cmds = localizedCommands(language);
  if (list.includes('--json')) {
    return { commands: cmds };
  }
  return { text: _renderText(cmds, language) };
}

module.exports = { run, _renderText };
