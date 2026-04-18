const { readState } = require('../../lib/state.cjs');

function run(_args, cwd) {
  const useCwd = cwd || process.cwd();
  try {
    const s = readState(useCwd);
    return s.frontmatter;
  } catch (err) {

    const code = err && err.code ? String(err.code) : 'state-not-found';
    const message = err && err.message ? err.message : 'STATE.md not readable';
    return { error: { code, message, details: err && err.details ? err.details : null } };
  }
}

module.exports = { run };
