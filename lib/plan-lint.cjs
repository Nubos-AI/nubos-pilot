'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter } = require('./frontmatter.cjs');

const POSIX_BASELINE = Object.freeze(new Set([
  'true', 'false', ':', 'echo', 'printf', 'test', '[', '[[',
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'grep', 'egrep', 'fgrep', 'find', 'xargs',
  'ls', 'mkdir', 'cp', 'mv', 'touch',
  'pwd', 'cd', 'set', 'unset', 'export', 'exit', 'read', 'shift',
  'diff', 'patch', 'tar', 'gzip', 'gunzip', 'zip', 'unzip',
  'env', 'sleep', 'date', 'time', 'which', 'type', 'command',
  'basename', 'dirname', 'realpath', 'readlink', 'stat', 'du', 'df',
  'seq', 'tee', 'nl', 'rev', 'paste', 'join', 'comm', 'expr', 'column',
  'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'jq', 'yq', 'xmllint',
]));

const stack = require('./stack.cjs');

const VERIFY_TOOLING = Object.freeze(new Set([
  ...stack.knownCommands(),
  'git', 'make', 'docker', 'docker-compose', 'podman', 'nubos',
  'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno',
  'php', 'composer', 'artisan', 'phpunit', 'pest', 'pint', 'phpstan', 'psalm',
  'python', 'python3', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'pytest', 'tox', 'ruff', 'mypy',
  'ruby', 'bundle', 'rake', 'rspec', 'rubocop',
  'go', 'gofmt', 'golangci-lint',
  'cargo', 'rustc', 'rustfmt', 'clippy',
  'dotnet', 'swift', 'xcodebuild', 'gradle', 'gradlew', 'mvn', 'java', 'kotlin', 'kotlinc',
  'dart', 'flutter', 'elixir', 'mix', 'terraform', 'kubectl', 'helm',
  'eslint', 'prettier', 'tsc', 'jest', 'vitest', 'playwright', 'cypress',
  'pre-commit', 'shellcheck', 'markdownlint', 'vale',
  'just', 'task', 'mise', 'moon', 'earthly',
  'bazel', 'buck2', 'meson', 'ninja', 'cmake', 'scons',
  'nx', 'turbo', 'lerna', 'gulp', 'grunt', 'vite', 'webpack', 'rollup', 'esbuild', 'biome',
  'sbt', 'lein', 'clojure', 'clj', 'boot', 'gleam', 'rebar3', 'stack', 'cabal',
  'zig', 'nim', 'nimble', 'crystal', 'shards', 'dub',
  'rye', 'pdm', 'hatch', 'nox', 'pixi',
  'ktlint', 'detekt', 'swiftlint', 'swiftformat',
]));

const VERIFY_ALLOWED_COMMANDS = Object.freeze(
  new Set([...POSIX_BASELINE, ...VERIFY_TOOLING]),
);

const VERIFY_FORWARDERS = Object.freeze(new Map([
  ['env', 'env'], ['time', 'plain'], ['nohup', 'plain'], ['setsid', 'plain'],
  ['command', 'plain'], ['builtin', 'plain'],
  ['nice', 'optarg'], ['ionice', 'optarg'], ['chrt', 'optarg'],
  ['stdbuf', 'optarg'], ['timeout', 'timeout'], ['xargs', 'optarg'],
  ['docker', 'docker'], ['podman', 'docker'], ['docker-compose', 'compose'],
]));

const GIT_READONLY_SUBCOMMANDS = Object.freeze(new Set([
  'diff', 'status', 'log', 'show', 'ls-files', 'ls-tree', 'cat-file', 'grep',
  'blame', 'shortlog', 'rev-parse', 'rev-list', 'describe', 'branch', 'tag',
  'merge-base', 'symbolic-ref', 'name-rev', 'count-objects', 'verify-commit',
  'verify-tag', 'check-ignore', 'check-attr', 'diff-tree', 'diff-index', 'whatchanged',
]));

const PY_MODULE_ALLOW = Object.freeze(new Set([
  'pip', 'venv', 'pytest', 'unittest', 'build', 'compileall', 'json.tool',
  'mypy', 'ruff', 'black', 'flake8', 'tox', 'coverage', 'pdb', 'site', 'ensurepip',
]));

const AWK_ESCAPES = Object.freeze([
  { re: /\bsystem\s*\(/, what: 'system()' },
  { re: /\|\s*&?\s*["']/, what: 'a pipe to a command string' },
  { re: /\bclose\s*\(/, what: 'close() on a command stream' },
  { re: /\bENVIRON\s*\[/, what: 'ENVIRON[]' },
]);

const TAR_EXEC_FLAGS = Object.freeze([
  '--to-command', '--use-compress-program', '--checkpoint-action', '-I', '--rsh-command',
]);

const VERIFY_SHELLS = Object.freeze(new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']));

const VERIFY_INTERPRETERS = Object.freeze(new Map([
  ['node', ['-e', '--eval', '-p', '--print']],
  ['deno', ['eval']],
  ['bun', ['-e', '--eval']],
  ['php', ['-r']],
  ['python', ['-c']], ['python3', ['-c']],
  ['ruby', ['-e']],
  ['perl', ['-e', '-E']],
]));

const VERIFY_DENIED_COMMANDS = Object.freeze(new Map([
  ['eval', 'executes a constructed string'],
  ['source', 'executes an arbitrary file in the current shell'],
  ['.', 'executes an arbitrary file in the current shell'],
  ['exec', 'replaces the shell process'],
  ['curl', 'fetches remote content'],
  ['wget', 'fetches remote content'],
  ['aria2c', 'fetches remote content'],
  ['httpie', 'fetches remote content'],
  ['lwp-request', 'fetches remote content'],
  ['nc', 'opens a network connection'],
  ['ncat', 'opens a network connection'],
  ['netcat', 'opens a network connection'],
  ['socat', 'opens a network connection'],
  ['telnet', 'opens a network connection'],
  ['ssh', 'opens a remote shell'],
  ['scp', 'transfers files over the network'],
  ['sftp', 'transfers files over the network'],
  ['rsync', 'transfers files, potentially over the network'],
  ['sudo', 'escalates privileges'],
  ['doas', 'escalates privileges'],
  ['su', 'escalates privileges'],
  ['rm', 'deletes files — a <verify> block is a check, not a mutation'],
  ['rmdir', 'deletes directories — a <verify> block is a check, not a mutation'],
  ['ln', 'rewrites the filesystem layout'],
  ['chmod', 'changes file permissions'],
  ['chown', 'changes file ownership'],
  ['dd', 'writes raw blocks'],
  ['mkfs', 'formats a filesystem'],
  ['shutdown', 'halts the machine'],
  ['reboot', 'halts the machine'],
  ['kill', 'signals arbitrary processes'],
  ['killall', 'signals arbitrary processes'],
  ['pkill', 'signals arbitrary processes'],
  ['crontab', 'installs a persistent job'],
  ['at', 'schedules a detached job'],
  ['systemctl', 'controls system services'],
  ['launchctl', 'controls system services'],
  ['base64', 'is the standard decode-and-pipe-to-sh carrier'],
  ['openssl', 'can fetch remote content (s_client) and decode payloads'],
]));

const INTERPRETER_PREFIXES = Object.freeze(new Set([
  'node', 'npx', 'pnpm', 'yarn', 'npm', 'bun', 'bunx',
  'php', 'composer', 'python', 'python3', 'pipx', 'uv', 'poetry',
  'ruby', 'bundle', 'go',
]));

const SHELL_KEYWORD_SKIP = Object.freeze(new Set([
  'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'done', 'fi',
  'time', '!', '{', '}', 'function', 'coproc',
]));

const SHELL_KEYWORD_WORDLIST = Object.freeze(new Set(['for', 'select']));

const WORKING_TREE_READERS = Object.freeze([
  /\bupdate-docs\b/i,
  /\bgit\s+(diff|status|ls-files|log)/i,
  /\bfind\s+\S+\s+-newer\b/i,
  /\bpre-commit\s+run\b/i,
  /\bphpstan\s+analyse\b/i,
  /\bpint\b/i,
  /\beslint\b/i,
  /\btsc\b/i,
]);

function _readJsonSafe(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function _resolveKnownVerbs(opts) {
  if (Array.isArray(opts && opts.knownVerbs)) return new Set(opts.knownVerbs);
  try {
    const cmds = require('../bin/np-tools/_commands.cjs');
    if (Array.isArray(cmds.COMMANDS)) {
      return new Set(cmds.COMMANDS.map((c) => c.name));
    }
  } catch {}
  return new Set();
}

function _resolveScripts(cwd) {
  const byId = stack.scriptsByManifest(cwd);
  return {
    composer: byId.php || new Set(),
    npm: byId.node || new Set(),
  };
}

function _binaryExists(cwd, relPath) {
  try { return fs.existsSync(path.join(cwd, relPath)); }
  catch { return false; }
}

function _ansiCUnescape(s) {
  return String(s).replace(
    /\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|.)/g,
    (m, g) => {
      if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
      if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
      if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
      const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', "'": "'", '"': '"' };
      return Object.prototype.hasOwnProperty.call(map, g) ? map[g] : g;
    },
  );
}

function _lex(src) {
  const s = String(src || '');
  const tokens = [];
  const subs = [];
  const redirects = [];
  let i = 0;
  let word = null;

  const flush = () => { if (word) { tokens.push({ type: 'word', ...word }); word = null; } };
  const put = (ch) => {
    if (!word) word = { value: '', static: true, quoted: false };
    word.value += ch;
  };
  const mark = () => { if (!word) word = { value: '', static: true, quoted: false }; word.static = false; };

  const readBalanced = (from, open, close) => {
    let depth = 0, j = from, q = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (q) {
        if (c === '\\' && q === '"') { j++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '\\') { j++; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return { body: s.slice(from + 1, j), end: j }; }
    }
    return { body: s.slice(from + 1), end: s.length };
  };

  while (i < s.length) {
    const c = s[i];

    if (c === '\\') {
      if (i + 1 < s.length && s[i + 1] === '\n') { i += 2; continue; }
      put(s[i + 1] != null ? s[i + 1] : '\\');
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const body = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      if (!word) word = { value: '', static: true, quoted: true };
      word.quoted = true;
      word.value += body;
      i = end === -1 ? s.length : end + 1;
      continue;
    }

    if (c === '$' && s[i + 1] === "'") {
      const end = s.indexOf("'", i + 2);
      const body = end === -1 ? s.slice(i + 2) : s.slice(i + 2, end);
      if (!word) word = { value: '', static: true, quoted: true };
      word.quoted = true;
      word.value += _ansiCUnescape(body);
      i = end === -1 ? s.length : end + 1;
      continue;
    }

    if (c === '$' && s[i + 1] === '"') { i++; continue; }

    if (c === '"') {
      if (!word) word = { value: '', static: true, quoted: true };
      word.quoted = true;
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\') { word.value += s[j + 1] != null ? s[j + 1] : ''; j++; continue; }
        if (s[j] === '$' && s[j + 1] === '(' && s[j + 2] === '(') {
          const { end } = readBalanced(j + 1, '(', ')');
          word.static = false; j = end; continue;
        }
        if (s[j] === '$' && s[j + 1] === '(') {
          const { body, end } = readBalanced(j + 1, '(', ')');
          subs.push(body); word.static = false; j = end; continue;
        }
        if (s[j] === '`') {
          const end = s.indexOf('`', j + 1);
          subs.push(s.slice(j + 1, end === -1 ? s.length : end));
          word.static = false; j = end === -1 ? s.length : end; continue;
        }
        if (s[j] === '$') { word.static = false; continue; }
        word.value += s[j];
      }
      i = j + 1;
      continue;
    }

    if (c === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
      const { end } = readBalanced(i + 1, '(', ')');
      mark();
      i = end + 1;
      continue;
    }

    if (c === '$' && s[i + 1] === '(') {
      const { body, end } = readBalanced(i + 1, '(', ')');
      subs.push(body);
      mark();
      i = end + 1;
      continue;
    }

    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      subs.push(s.slice(i + 1, end === -1 ? s.length : end));
      mark();
      i = end === -1 ? s.length : end + 1;
      continue;
    }

    if (c === '$') {
      mark();
      let j = i + 1;
      if (s[j] === '{') { const e = s.indexOf('}', j); j = e === -1 ? s.length : e + 1; }
      else { while (j < s.length && /[A-Za-z0-9_@*#?$!-]/.test(s[j])) j++; }
      i = j;
      continue;
    }

    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const { body, end } = readBalanced(i + 1, '(', ')');
      subs.push(body);
      flush();
      i = end + 1;
      continue;
    }

    if (c === '<' || c === '>') {
      if (word && word.static && !word.quoted && /^\d+$/.test(word.value)) word = null;
      else flush();
      let op = c;
      if (s[i + 1] === c) { op += c; i++; if (s[i + 1] === c) { op += c; i++; } }
      else if (s[i + 1] === '&') { op += '&'; i++; }
      i++;
      while (i < s.length && /[ \t]/.test(s[i])) i++;
      let target = '';
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i];
        const end = s.indexOf(q, i + 1);
        target = s.slice(i + 1, end === -1 ? s.length : end);
        i = end === -1 ? s.length : end + 1;
      } else {
        while (i < s.length && !/[\s;|&()<>]/.test(s[i])) { target += s[i]; i++; }
      }
      redirects.push({ op, target });
      continue;
    }

    if (c === '#' && !word) { while (i < s.length && s[i] !== '\n') i++; continue; }

    if (/[\s]/.test(c)) { flush(); if (c === '\n') tokens.push({ type: 'op', value: ';' }); i++; continue; }

    if (c === ';' || c === '&' || c === '|') {
      flush();
      let op = c;
      if (s[i + 1] === c) { op += c; i++; }
      tokens.push({ type: 'op', value: op });
      i++;
      continue;
    }

    if (c === '(' || c === ')' || c === '{' || c === '}') {
      if ((c === '{' || c === '}') && word) { put(c); i++; continue; }
      if ((c === '{' || c === '}') && !/[\s;&|]/.test(s[i + 1] || ' ')) { put(c); i++; continue; }
      flush();
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }

    put(c);
    i++;
  }
  flush();
  return { tokens, subs, redirects };
}

const _ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

function _atCommandPosition(words) {
  return words.every((w) => (w.static && !w.quoted && SHELL_KEYWORD_SKIP.has(w.value))
    || (!w.quoted && _ASSIGN_RE.test(w.value)));
}

function _wordsToCommand(words) {
  let k = 0;
  for (;;) {
    if (k >= words.length) return null;
    const w = words[k];
    const plain = w.static && !w.quoted;
    if (plain && SHELL_KEYWORD_WORDLIST.has(w.value)) return null;
    if (plain && SHELL_KEYWORD_SKIP.has(w.value)) { k++; continue; }
    if (!w.quoted && _ASSIGN_RE.test(w.value)) { k++; continue; }
    break;
  }
  return {
    word: words[k],
    rest: words.slice(k + 1),
    full: words.map((w) => w.value).join(' '),
  };
}

function _tokensToCommands(tokens) {
  const out = [];
  let cur = [];
  const caseStack = [];
  const top = () => caseStack[caseStack.length - 1];

  const flush = () => { if (cur.length) { const c = _wordsToCommand(cur); if (c) out.push(c); } cur = []; };

  for (const t of tokens) {
    const st = top();

    if (st && st.phase === 'subject') {
      if (t.type === 'word' && t.static && !t.quoted && t.value === 'in') st.phase = 'pattern';
      continue;
    }
    if (st && st.phase === 'pattern') {
      if (t.type === 'op' && t.value === ')') st.phase = 'body';
      else if (t.type === 'word' && t.static && !t.quoted && t.value === 'esac') caseStack.pop();
      continue;
    }

    if (t.type === 'op') {
      flush();
      if (t.value === ';;' && st) st.phase = 'pattern';
      continue;
    }

    if (t.static && !t.quoted && t.value === 'esac' && st) { flush(); caseStack.pop(); continue; }
    if (t.static && !t.quoted && t.value === 'case' && _atCommandPosition(cur)) {
      flush();
      caseStack.push({ phase: 'subject' });
      continue;
    }
    cur.push(t);
  }
  flush();
  return out;
}

function _commandsInLine(line) {
  const stripped = String(line || '').trim();
  if (!stripped || stripped.startsWith('#')) return [];
  const { tokens, subs, redirects } = _lex(stripped);
  const cmds = _tokensToCommands(tokens).map((c) => ({
    command: c.word.value,
    word: c.word,
    rest: c.rest,
    full: c.full,
    redirects,
  }));
  for (const sub of subs) cmds.push(..._commandsInLine(sub));
  return cmds;
}

const { verifyCommandLines: _verifyCommandLines } = require('./verify-block.cjs');

function _forwardTarget(kind, rest) {
  let i = 0;
  const val = (w) => (w ? w.value : '');
  if (kind === 'env') {
    while (i < rest.length) {
      const v = val(rest[i]);
      if (v === '-i' || v === '-') { i++; continue; }
      if (v === '-u' || v === '--unset') { i += 2; continue; }
      if (_ASSIGN_RE.test(v)) { i++; continue; }
      break;
    }
    return i < rest.length ? i : -1;
  }
  if (kind === 'plain') {
    while (i < rest.length && /^-/.test(val(rest[i]))) i++;
    return i < rest.length ? i : -1;
  }
  if (kind === 'timeout') {
    while (i < rest.length) {
      const v = val(rest[i]);
      if (v === '-s' || v === '--signal' || v === '-k' || v === '--kill-after') { i += 2; continue; }
      if (/^-/.test(v)) { i++; continue; }
      if (/^[0-9]+(\.[0-9]+)?[smhd]?$/.test(v)) { i++; continue; }
      break;
    }
    return i < rest.length ? i : -1;
  }
  if (kind === 'optarg') {
    const takesArg = new Set(['-n', '-c', '-p', '-P', '-I', '-i', '-L', '-l',
      '-s', '-d', '-a', '-E', '-e', '-o', '-O', '--max-args', '--max-procs',
      '--replace', '--delimiter', '--arg-file', '--eof', '--adjustment']);
    while (i < rest.length) {
      const v = val(rest[i]);
      if (!/^-/.test(v)) break;
      if (/^--?[A-Za-z-]+=/.test(v)) { i++; continue; }
      if (takesArg.has(v)) { i += 2; continue; }
      if (/^-[A-Za-z]\S+$/.test(v)) { i++; continue; }
      i++;
    }
    return i < rest.length ? i : -1;
  }
  if (kind === 'docker' || kind === 'compose') {
    let sub = val(rest[i]);
    if (kind === 'compose' || sub === 'compose') {
      if (sub === 'compose') i++;
      while (i < rest.length && /^-/.test(val(rest[i]))) i++;
      sub = val(rest[i]);
    }
    if (sub !== 'exec' && sub !== 'run') return -1;
    i++;
    const takesArg = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir',
      '-v', '--volume', '-l', '--label', '--name', '--network', '--entrypoint',
      '--env-file', '-p', '--publish']);
    while (i < rest.length) {
      const v = val(rest[i]);
      if (!/^-/.test(v)) break;
      if (/^--?[A-Za-z-]+=/.test(v)) { i++; continue; }
      if (takesArg.has(v)) { i += 2; continue; }
      i++;
    }
    i++;
    return i < rest.length ? i : -1;
  }
  return -1;
}

function _denyVerdict(name, why) {
  return { ok: false, reason: 'verify-command-denied',
    hint: '"' + name + '" is not allowed in a <verify> block — it ' + why
      + '. The orchestrator executes verify blocks with bash -c; a mechanical '
      + 'check must be a deterministic, local command.' };
}

function _validateCommand(cmd, ctx, depth) {
  const d = depth || 0;
  const { command, rest, full } = cmd;
  const word = cmd.word || { value: command, static: true };

  if (d > 8) return { ok: false, reason: 'verify-command-denied',
    hint: 'command forwarding nests deeper than the audit follows ("' + full.slice(0, 60)
      + '") — a <verify> block must not chain command wrappers this deeply' };

  if (word.static === false) {
    return { ok: false, reason: 'verify-command-dynamic',
      hint: 'the command name is built at runtime ("' + full.slice(0, 60) + '") — a '
        + '<verify> block must name the command it runs literally, so it can be audited' };
  }

  const bare = command.replace(/^.*\//, '');

  if (VERIFY_DENIED_COMMANDS.has(command) || VERIFY_DENIED_COMMANDS.has(bare)) {
    return _denyVerdict(command,
      VERIFY_DENIED_COMMANDS.get(command) || VERIFY_DENIED_COMMANDS.get(bare));
  }

  if (VERIFY_FORWARDERS.has(bare)) {
    const kind = VERIFY_FORWARDERS.get(bare);
    const idx = _forwardTarget(kind, rest);
    if (idx === -1) return { ok: true };
    const inner = {
      command: rest[idx].value,
      word: rest[idx],
      rest: rest.slice(idx + 1),
      full: rest.slice(idx).map((w) => w.value).join(' '),
    };
    const innerCtx = (kind === 'docker' || kind === 'compose')
      ? { ...ctx, remote: true } : ctx;
    return _validateCommand(inner, innerCtx, d + 1);
  }

  if (bare === 'find') {
    const inner = [];
    for (let i = 0; i < rest.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(rest[i].value)) continue;
      const words = [];
      for (let j = i + 1; j < rest.length && rest[j].value !== ';' && rest[j].value !== '+'; j++) {
        words.push(rest[j]);
      }
      if (words.length) {
        inner.push({
          command: words[0].value, word: words[0], rest: words.slice(1),
          full: words.map((w) => w.value).join(' '),
        });
      }
    }
    return inner.length ? { ok: true, innerCommands: inner } : { ok: true };
  }

  if (bare === 'git') {
    let i = 0;
    while (i < rest.length && /^-/.test(rest[i].value)) {
      i += (rest[i].value === '-c' || rest[i].value === '-C') ? 2 : 1;
    }
    const sub = rest[i] ? rest[i].value : null;
    if (!sub) return { ok: true };
    if (GIT_READONLY_SUBCOMMANDS.has(sub)) return { ok: true };
    return { ok: false, reason: 'verify-git-subcommand-not-allowed',
      hint: '"git ' + sub + '" is not a read-only git subcommand. A <verify> block may only '
        + 'inspect the repository (diff/status/log/ls-files/rev-parse/…); anything that '
        + 'fetches, writes or runs hooks is not a mechanical check.' };
  }

  if (['awk', 'gawk', 'mawk', 'nawk'].includes(bare)) {
    const prog = rest.find((w) => !/^-/.test(w.value));
    if (prog && prog.static !== false) {
      const hit = AWK_ESCAPES.find((e) => e.re.test(prog.value));
      if (hit) {
        return { ok: false, reason: 'verify-inline-code',
          hint: 'the awk program uses ' + hit.what + ' to run an external command — '
            + 'that is arbitrary code smuggled into plan text, not a mechanical check' };
      }
    }
  }

  if (bare === 'tar') {
    const hit = rest.find((w) => TAR_EXEC_FLAGS.some(
      (f) => w.value === f || w.value.startsWith(f + '=')));
    if (hit) {
      return { ok: false, reason: 'verify-inline-code',
        hint: '"tar ' + hit.value + '" makes tar run an external command per member' };
    }
  }

  if ((bare === 'python' || bare === 'python3') ) {
    const mIdx = rest.findIndex((w) => w.value === '-m');
    if (mIdx !== -1) {
      const mod = rest[mIdx + 1];
      if (!mod || mod.static === false || !PY_MODULE_ALLOW.has(mod.value)) {
        return { ok: false, reason: 'verify-command-not-allowed',
          hint: '"python -m ' + (mod ? mod.value : '?') + '" executes an arbitrary module. '
            + 'Only check/build modules are allowed (' + [...PY_MODULE_ALLOW].slice(0, 6).join(', ') + ', …).' };
      }
      return { ok: true };
    }
  }

  if (VERIFY_SHELLS.has(bare)) return _validateShellCall(command, rest, ctx, d);
  if (VERIFY_INTERPRETERS.has(bare)) {
    const flags = VERIFY_INTERPRETERS.get(bare);
    const hit = rest.find((w) => flags.includes(w.value));
    if (hit) {
      return { ok: false, reason: 'verify-inline-code',
        hint: '"' + bare + ' ' + hit.value + ' <code>" runs an inline program a shell-level '
          + 'lint cannot see into — it is indistinguishable from the same flag carrying code '
          + 'that shells out and fetches a remote payload. Put the check in a committed '
          + 'script, or express it with test/grep.' };
    }
  }

  if (INTERPRETER_PREFIXES.has(bare)) {
    return _validateInterpreterCall(bare, rest.map((w) => w.value), full, ctx);
  }

  if (command.includes('/')) {
    if (ctx.remote) return { ok: true, hint: 'path not checkable (container / after cd)' };
    if (_binaryExists(ctx.cwd, command)) return { ok: true };
    if (/^(\.\/)?(vendor\/bin|node_modules\/\.bin|bin|scripts)\//.test(command)) {
      return { ok: true, hint: 'binary not present at lint-time but path is conventional' };
    }
    return { ok: false, reason: 'path-not-found',
      hint: 'verify path "' + command + '" does not exist; check the project layout' };
  }

  if (VERIFY_ALLOWED_COMMANDS.has(bare) || ctx.allowExtra.has(bare)) return { ok: true };

  return { ok: false, reason: 'verify-command-not-allowed',
    hint: '"' + command + '" is not on the <verify> allow-list. Verify blocks are executed '
      + 'with bash -c, so unknown commands are refused rather than assumed benign. If this '
      + "is one of the project's own tools, register it in .nubos-pilot/config.json under "
      + '`plan_lint.verify_allow_commands`; otherwise express the check with an allowed tool.' };
}

function _validateShellCall(command, rest, ctx, depth) {
  const cIdx = rest.findIndex((w) => w.value === '-c');
  if (cIdx !== -1) {
    const prog = rest[cIdx + 1];
    if (!prog) return { ok: true };
    if (prog.static === false) {
      return { ok: false, reason: 'verify-command-dynamic',
        hint: '`' + command + ' -c` is handed a string built at runtime — its contents cannot be audited' };
    }
    return { ok: true, recurse: prog.value, depth: (depth || 0) + 1 };
  }
  const script = rest.find((w) => !/^-/.test(w.value));
  if (!script) {
    return { ok: false, reason: 'verify-shell-stdin',
      hint: '"' + command + '" without a script argument reads its program from stdin '
        + '(here-string/heredoc/pipe) — that is arbitrary code the lint cannot see' };
  }
  if (script.static === false) {
    return { ok: false, reason: 'verify-command-dynamic',
      hint: 'the script path handed to "' + command + '" is built at runtime' };
  }
  if (ctx.remote) return { ok: true };
  if (/^\//.test(script.value)) {
    return { ok: false, reason: 'verify-script-outside-repo',
      hint: '"' + command + ' ' + script.value + '" runs a script from an absolute path outside '
        + 'the repo — a verify block may only run scripts committed to the project' };
  }
  return { ok: true };
}

function _validateInterpreterCall(interp, rest, full, ctx) {
  if (interp === 'node' && rest.length >= 1) {
    const target = rest[0];
    if (/np-tools\.cjs$/.test(target)) {
      const verb = rest[1];
      if (!verb || verb.startsWith('-')) {
        return { ok: false, reason: 'np-tools-missing-verb',
          hint: 'np-tools.cjs requires a verb as second argument' };
      }
      if (!ctx.knownVerbs.has(verb)) {
        return { ok: false, reason: 'np-tools-unknown-verb',
          hint: 'verb "' + verb + '" is not a registered np-tools command (see _commands.cjs)' };
      }
      return { ok: true };
    }
    if (/\.(c?js|mjs)$/.test(target)) {
      if (_binaryExists(ctx.cwd, target)) return { ok: true };
      return { ok: false, reason: 'node-script-not-found',
        hint: 'node script "' + target + '" not found at lint-time' };
    }
    return { ok: true };
  }
  if (interp === 'npm' || interp === 'pnpm' || interp === 'yarn') {
    let i = 0;
    if (rest[i] === 'run' || rest[i] === 'run-script' || rest[i] === 'exec') i++;
    const script = rest[i];
    if (!script || script.startsWith('-')) return { ok: true };
    if (ctx.scripts.npm.has(script)) return { ok: true };
    if (['install', 'ci', 'test', 'audit', 'update', 'outdated'].includes(script)) {
      return { ok: true };
    }
    return { ok: false, reason: 'npm-script-not-declared',
      hint: '"' + script + '" is not declared in package.json scripts' };
  }
  if (interp === 'composer') {
    const script = rest[0];
    if (!script || script.startsWith('-')) return { ok: true };
    if (ctx.scripts.composer.has(script)) return { ok: true };
    const builtin = new Set([
      'install', 'update', 'require', 'remove', 'dump-autoload', 'dumpautoload',
      'show', 'why', 'depends', 'why-not', 'audit', 'check-platform-reqs',
      'create-project', 'init', 'self-update', 'about', 'archive', 'browse',
      'clear-cache', 'clearcache', 'config', 'diagnose', 'exec', 'fund',
      'global', 'home', 'licenses', 'list', 'outdated', 'prohibits', 'reinstall',
      'run-script', 'run', 'search', 'status', 'suggests', 'validate',
    ]);
    if (builtin.has(script)) return { ok: true };
    return { ok: false, reason: 'composer-script-not-declared',
      hint: '"' + script + '" is neither a composer builtin nor declared in composer.json scripts' };
  }
  if (interp === 'npx' || interp === 'bunx' || interp === 'pnpx') return { ok: true };
  if (interp === 'php') return { ok: true };
  if (['ruby', 'python', 'python3', 'go', 'bun'].includes(interp)) return { ok: true };
  if (interp === 'bundle') return { ok: true };
  return { ok: true };
}

function _lintRedirects(cmds, line, findings) {
  const seen = new Set();
  for (const cmd of cmds || []) {
    const redirects = cmd && cmd.redirects;
    if (!Array.isArray(redirects) || redirects.length === 0 || seen.has(redirects)) continue;
    seen.add(redirects);
    for (const r of redirects) {
      if (!/^\/dev\/(tcp|udp)\//.test(r.target)) continue;
      findings.push({
        category: 'verify-command-unknown',
        severity: 'critical',
        target: '<verify> block',
        message: '`' + r.op + ' ' + r.target + '` — bash opens a network socket for /dev/tcp '
          + 'and /dev/udp redirections; a mechanical check must be local',
        hint: 'remove the /dev/tcp redirection — a <verify> block must not talk to the network',
        raw: { reason: 'verify-network-redirect', command: r.target, line },
      });
    }
  }
}

function lintVerifyCommands(planBody, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const ctx = {
    cwd,
    knownVerbs: _resolveKnownVerbs(opts),
    scripts: _resolveScripts(cwd),
    allowExtra: new Set((opts && opts.allowExtraCommands) || []),
    remote: false,
  };
  const findings = [];
  {
    for (const line of _verifyCommandLines(planBody || '')) {
      const seeded = _commandsInLine(line);
      if (!seeded.length) continue;
      _lintRedirects(seeded, line, findings);

      const queue = seeded.map((c) => ({ cmd: c, depth: 0 }));
      const lineCtx = { ...ctx };
      let guard = 0;
      while (queue.length) {
        if (++guard > 500) break;
        const { cmd, depth } = queue.shift();
        if (cmd.command === 'cd' && cmd.rest.some((w) => !/^-/.test(w.value))) lineCtx.remote = true;
        const verdict = _validateCommand(cmd, lineCtx, depth);
        if (verdict.ok && verdict.recurse != null) {
          const nested = _commandsInLine(verdict.recurse);
          _lintRedirects(nested, line, findings);
          for (const n of nested) queue.push({ cmd: n, depth: (verdict.depth || depth) + 1 });
          continue;
        }
        if (verdict.ok && verdict.innerCommands) {
          for (const n of verdict.innerCommands) queue.push({ cmd: n, depth: depth + 1 });
          continue;
        }
        if (verdict.ok) continue;
        findings.push({
          category: 'verify-command-unknown',
          severity: 'critical',
          target: '<verify> block',
          message: '`' + cmd.full + '` — ' + (verdict.hint || verdict.reason || 'unknown command'),
          hint: verdict.hint || null,
          raw: { reason: verdict.reason, command: cmd.command, line },
        });
      }
    }
  }
  return findings;
}

function _verifyReadsWorkingTree(verifyText) {
  const t = String(verifyText || '');
  for (const re of WORKING_TREE_READERS) {
    if (re.test(t)) return true;
  }
  return false;
}

function lintParallelTaskRaces(tasks) {
  const findings = [];
  const groups = new Map();
  for (const t of tasks || []) {
    const key = t.slice || '__default__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const parallel = group.filter((t) => {
      const d = t.depends_on;
      return !Array.isArray(d) || d.length === 0;
    });
    if (parallel.length < 2) continue;
    for (const a of parallel) {
      if (!_verifyReadsWorkingTree(a.verifyText)) continue;
      const conflicts = parallel.filter(
        (b) => b.id !== a.id
          && Array.isArray(b.files_modified)
          && b.files_modified.length > 0,
      );
      if (conflicts.length === 0) continue;
      findings.push({
        category: 'parallel-task-implicit-dependency',
        severity: 'critical',
        target: a.id,
        message: 'task ' + a.id + ' is marked parallel (depends_on:[]) but its <verify> reads the working tree, ' +
          'creating an implicit ordering against sibling task(s) that modify files: ' +
          conflicts.map((c) => c.id).join(', '),
        hint: 'set depends_on to [' + conflicts.map((c) => '"' + c.id + '"').join(', ') + '] OR ' +
          'replace the working-tree-reading verify with a stateless check',
        raw: { task: a.id, conflicts: conflicts.map((c) => c.id) },
      });
    }
  }
  return findings;
}

const OVER_SPECIFICATION_SIGNALS = [
  {
    name: 'schema-ddl',
    re: /^(\s*)?(CREATE\s+TABLE|ALTER\s+(TABLE|COLUMN)|Schema::(create|table)|->\s*(string|integer|bigInteger|foreignId|timestamp)\s*\()/im,
    hint: 'schema DDL belongs to the executor — the plan describes intent (e.g. "subscriptions table with columns the framework dictates"), not exact column shape',
  },
  {
    name: 'framework-timestamped-filename',
    re: /\b\d{4}_\d{2}_\d{2}_\d{6}_[a-z_]+\.php\b/,
    hint: 'framework-controlled migration filenames are publish-time output, not plan input — use a glob pattern in files_modified',
  },
  {
    name: 'inline-code-snippet',
    re: /```(?:[a-z]+)?\n[\s\S]{200,}\n```/,
    hint: 'large code blocks in PLAN.md push implementation into the planner — describe what the code must achieve, let the executor write it',
  },
];

function lintOverSpecification(planBody) {
  const findings = [];
  const body = String(planBody || '');
  for (const sig of OVER_SPECIFICATION_SIGNALS) {
    const m = body.match(sig.re);
    if (m) {
      findings.push({
        category: 'plan-over-specifies-implementation',
        severity: 'major',
        target: 'PLAN.md body',
        message: 'over-specification signal: ' + sig.name + ' (matched: ' +
          String(m[0]).replace(/\s+/g, ' ').slice(0, 80) + ')',
        hint: sig.hint,
        raw: { signal: sig.name, snippet: String(m[0]).slice(0, 200) },
      });
    }
  }
  return findings;
}

const MIRROR_PHRASES = Object.freeze([
  /\b(?:fully\s+)?mirror(?:s|ing|ed)?\b/i,
  /\bsame\s+pattern\s+as\b/i,
  /\bthe\s+same\s+pattern\b/i,
  /\bfollow(?:s|ing)?\s+the\s+[^.\n]{0,40}?pattern\b/i,
  /\banalogous(?:ly)?\s+to\b/i,
  /\bidentical(?:ly)?\s+to\b/i,
  /\bmodel?led?\s+(?:on|after)\b/i,
  /\bcopy\s+the\s+[^.\n]{0,40}?pattern\b/i,
  /\bin\s+the\s+same\s+way\s+as\b/i,
  /\b1:1\b/,
  /\beins\s+zu\s+eins\b/i,
  /\b(?:wider)?spieg(?:el|l)\w{0,3}\b/i,
  /\bgespiegelt\b/i,
  /\banalog\s+(?:zu|zum|zur)\b/i,
  /\bnach\s+dem\s+(?:Muster|Vorbild)\b/i,
  /\bgenauso\s+wie\b/i,
  /\bidentisch\s+(?:zu|mit)\b/i,
  /\borientiere\s+dich\s+an\b/i,
  /\b(?:übernimm|uebernimm)\s+das\s+Muster\b/i,
  /\b(?:gleiche|selbe|dasselbe|das\s+gleiche)\s+Muster\b/i,
]);

const CODE_TOKEN_PATTERNS = Object.freeze([
  { re: /`([^`\n]{2,120})`/g },
  { re: /\b[\w.-]{1,64}(?:\/[\w.-]{1,64}){1,8}\.[A-Za-z]{1,6}\b/g, requires: '/' },
  { re: /\b[A-Z][a-z0-9]{1,40}(?:[A-Z][A-Za-z0-9]{0,40}){1,8}(?:::\w{1,60}|->\w{1,60}|\(\))?/g },
  { re: /\b[A-Za-z_]\w{0,60}(?:::|->)\w{1,60}/g },
]);

const MAX_SCANNED_SENTENCE = 4000;

const PATTERN_REFS_BLOCK_RE = /<pattern_refs>[\s\S]*?<\/pattern_refs>/gi;
const PATTERN_REF_TAG_RE = /<pattern_ref\b((?:"[^"]*"|[^>])*?)\/?>/gi;
const DEVIATION_TAG_RE = /<deviation\b((?:"[^"]*"|[^>])*?)\/?>/gi;
const AT_WITH_LINE_RE = /^[^\s:]+(?::\d+(?:-\d+)?)$/;
const DEVIATION_REQUIRED_ATTRS = Object.freeze(['ref', 'from', 'to', 'reason']);

function _tagAttrs(attrChunk) {
  const attrs = {};
  for (const m of String(attrChunk).matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = m[2].trim();
  }
  return attrs;
}

function _lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function _normalizeToken(token) {
  return String(token)
    .trim()
    .replace(/^[`'"(\[]+|[`'"),.;:\]]+$/g, '')
    .replace(/\(\)$/, '')
    .toLowerCase();
}

function _identities(value) {
  const bare = _normalizeToken(String(value).replace(/:\d+(?:-\d+)?$/, ''));
  if (!bare) return [];
  const basename = bare.split('/').pop().replace(/\.[a-z0-9]{1,6}$/, '');
  const out = [bare, basename];
  for (const part of basename.split(/::|->/)) out.push(part);
  return out.filter((s) => s.length >= 3);
}

function _coveredIdentities(patternRefs) {
  const covered = new Set();
  for (const ref of patternRefs) {
    for (const value of [ref.attrs.at, ref.attrs.symbol]) {
      if (!value) continue;
      for (const id of _identities(value)) covered.add(id);
    }
  }
  return covered;
}

function _codeTokensIn(paragraph) {
  const out = [];
  const text = String(paragraph).slice(0, MAX_SCANNED_SENTENCE);
  for (const { re, requires } of CODE_TOKEN_PATTERNS) {
    if (requires && !text.includes(requires)) continue;
    for (const m of text.matchAll(re)) {
      const token = _normalizeToken(m[1] || m[0]);
      if (token.length < 3) continue;
      if (!/[a-z]/i.test(token)) continue;
      out.push(token);
    }
  }
  return [...new Set(out)];
}

function _isCovered(token, covered) {
  return _identities(token).some((id) => covered.has(id));
}

function _sentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=[\s<]|$)|<\/[A-Za-z][^>]*>|\n[ \t]*\n/g)) {
    const end = m.index + m[0].length;
    out.push({ text: text.slice(start, end), start });
    start = end;
  }
  if (start < text.length) out.push({ text: text.slice(start), start });
  return out.filter((s) => s.text.trim());
}

function lintPatternClaims(raw, opts) {
  const planKind = (opts && opts.planKind) || 'slice';
  if (planKind === 'task') return [];

  const text = String(raw || '');
  const findings = [];

  const blocks = [...text.matchAll(PATTERN_REFS_BLOCK_RE)]
    .map((m) => ({ body: m[0], offset: m.index }));

  const patternRefs = [];
  for (const block of blocks) {
    for (const m of block.body.matchAll(PATTERN_REF_TAG_RE)) {
      patternRefs.push({ attrs: _tagAttrs(m[1]), index: block.offset + m.index });
    }
  }

  for (const ref of patternRefs) {
    const label = ref.attrs.symbol || ref.attrs.at || '(unnamed)';
    const target = 'PLAN.md:' + _lineOf(text, ref.index);
    if (!ref.attrs.at) {
      findings.push({
        category: 'pattern-claim-unverified',
        severity: 'critical',
        target,
        message: '<pattern_ref> for "' + label + '" has no at="path:line" — the mirrored '
          + 'implementation was never located, so its behaviour cannot be verified',
        hint: 'add at="path:line" and list the same path:line in <files_read>',
        raw: { symbol: ref.attrs.symbol || null },
      });
    } else if (!AT_WITH_LINE_RE.test(ref.attrs.at)) {
      findings.push({
        category: 'pattern-claim-unverified',
        severity: 'critical',
        target,
        message: '<pattern_ref> for "' + label + '" has at="' + ref.attrs.at
          + '" without a line number — the evidence rule requires path:line',
        hint: 'use at="path:line" (or path:line-line) exactly as in <files_read>',
        raw: { at: ref.attrs.at },
      });
    }
    if (!ref.attrs.behavior) {
      findings.push({
        category: 'pattern-claim-unverified',
        severity: 'critical',
        target,
        message: '<pattern_ref> for "' + label + '" has no behavior= — a reference without an '
          + 'observed-behaviour claim cannot contradict an acceptance criterion',
        hint: 'state what the code actually does, e.g. behavior="firstOrCreate — idempotent; '
          + 'a second call is a no-op"',
        raw: { symbol: ref.attrs.symbol || null, at: ref.attrs.at || null },
      });
    }
  }

  const deviations = [];
  for (const block of blocks) {
    for (const m of block.body.matchAll(DEVIATION_TAG_RE)) {
      deviations.push({ attrs: _tagAttrs(m[1]), index: block.offset + m.index });
    }
  }

  for (const dev of deviations) {
    const missing = DEVIATION_REQUIRED_ATTRS.filter((a) => !dev.attrs[a]);
    if (missing.length === 0) continue;
    findings.push({
      category: 'pattern-claim-unverified',
      severity: 'critical',
      target: 'PLAN.md:' + _lineOf(text, dev.index),
      message: '<deviation> is missing required attribute(s): ' + missing.join(', ')
        + ' — a deviation that does not say what it deviates from is not auditable',
      hint: 'every <deviation> needs ref=, from=, to= and reason=',
      raw: { missing },
    });
  }

  const covered = _coveredIdentities(patternRefs);
  const scannable = text.replace(PATTERN_REFS_BLOCK_RE, (block) => block.replace(/[^\n]/g, ' '));
  const seenClaims = new Set();
  for (const sentence of _sentences(scannable)) {
    const phrase = MIRROR_PHRASES.map((re) => sentence.text.match(re)).find(Boolean);
    if (!phrase) continue;
    const tokens = _codeTokensIn(sentence.text);
    if (tokens.length === 0) continue;
    if (tokens.some((t) => _isCovered(t, covered))) continue;
    const key = sentence.text.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (seenClaims.has(key)) continue;
    seenClaims.add(key);
    const start = sentence.start;
    const paragraph = sentence.text;
    findings.push({
      category: 'pattern-claim-unverified',
      severity: 'critical',
      target: 'PLAN.md:' + _lineOf(scannable, start + paragraph.indexOf(phrase[0])),
      message: 'plan tells the executor to mirror an existing implementation ("'
        + phrase[0].trim() + '" → ' + tokens.slice(0, 3).join(', ')
        + ') but no <pattern_ref> records what that implementation actually does',
      hint: 'add <pattern_ref symbol="…" at="path:line" behavior="…observed behaviour…"/> to '
        + '<reality_check><pattern_refs>, plus a <deviation> if an acceptance criterion needs '
        + 'behaviour the reference does not have',
      raw: { phrase: phrase[0].trim(), tokens: tokens.slice(0, 5) },
    });
  }

  return findings;
}

function lintPlan(planBody, opts) {
  const raw = (opts && typeof opts.raw === 'string') ? opts.raw : planBody;
  return [
    ...lintVerifyCommands(planBody, opts),
    ...lintOverSpecification(raw),
    ...lintPatternClaims(raw, opts),
  ];
}

function lintTaskFile(planMdPath, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const raw = fs.readFileSync(planMdPath, 'utf-8');
  const { frontmatter, body } = extractFrontmatter(raw);
  return {
    path: planMdPath,
    frontmatter: frontmatter || {},
    findings: lintPlan(body, { ...opts, cwd, raw }),
  };
}

module.exports = {
  lintVerifyCommands,
  lintParallelTaskRaces,
  lintOverSpecification,
  lintPatternClaims,
  lintPlan,
  MIRROR_PHRASES,
  lintTaskFile,
  POSIX_BASELINE,
  VERIFY_ALLOWED_COMMANDS,
  VERIFY_DENIED_COMMANDS,
  VERIFY_FORWARDERS,
  VERIFY_SHELLS,
  VERIFY_INTERPRETERS,
  INTERPRETER_PREFIXES,
  WORKING_TREE_READERS,
};
