const {
  _readOneLine,
  _parseAnswer,
  _hasReadlineImplForTests,
  askUserReadline,
} = require('./_readline.cjs');
const { NubosPilotError } = require('../core.cjs');
const { resolveLanguage } = require('../language.cjs');

function _resolveLangForCwd() {
  try { return resolveLanguage(process.cwd()); }
  catch { return 'en'; }
}

function _emitClaudeMarkerBlock({ type, question, options, def }) {
  const payload = {
    type,
    question,
    options: options || null,
    default: def === undefined ? null : def,
  };
  const block = '<!-- askUser v1 -->\n<!-- ' + JSON.stringify(payload) + ' -->\n';
  process.stdout.write(block);
  return _readOneLine();
}

async function askUser(spec) {
  const type = spec && spec.type;
  const question = spec && spec.question;
  const options = spec && spec.options;
  const def = spec ? spec.default : undefined;
  const hasTTY = !!process.stdin.isTTY;
  if (hasTTY) {
    return askUserReadline({ type, question, options, def });
  }
  if (!_hasReadlineImplForTests()) {
    if (def !== undefined && def !== null) {
      return { value: def, source: 'default' };
    }
    throw new NubosPilotError(
      'askuser-no-tty',
      'askUser cannot prompt without TTY (Claude Code Bash has no interactive stdin). Fall back to plain-text numbered list.',
      { question, type },
    );
  }
  const line = await _emitClaudeMarkerBlock({ type, question, options, def });
  const lang = (spec && spec.language) || _resolveLangForCwd();
  return { value: _parseAnswer(type, line, options, def, lang), source: 'askUserQuestion' };
}

module.exports = {
  name: 'claude',
  detectHints: {
    env: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    pathBinary: 'claude',
    diskMarkers: ['.claude/'],
  },
  capabilities: {
    askUserQuestion: true,
    slashCommands: true,
    agentsMd: 'CLAUDE.md',
    textMode: 'off',
    modelResolution: 'profile',
  },
  paths: {
    payload: '.claude/nubos-pilot/',
    commands: '.claude/commands/',
    agents: '.claude/agents/',
    agentsMd: 'CLAUDE.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Claude Code konsumiert. '
    + 'Interaktive Prompts laufen über Claudes native Frage-Dialog (marker block auf stdout).',
  askUser,
};
