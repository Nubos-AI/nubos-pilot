const { COMMANDS } = require('./_commands.cjs');

function _renderText(commands) {
  const byCat = new Map();
  for (const c of commands) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const lines = [];
  for (const [cat, items] of byCat) {
    lines.push(cat);
    for (const c of items) {
      lines.push('  ' + c.name.padEnd(10) + c.description);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function run(args) {
  const list = Array.isArray(args) ? args : [];
  if (list.includes('--json')) {
    return { commands: COMMANDS.slice() };
  }
  return { text: _renderText(COMMANDS) };
}

module.exports = { run };
