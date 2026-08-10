'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { NubosPilotError } = require('../../core.cjs');
const { assertInsideBase } = require('../../safe-path.cjs');
const { scanContent, _looksCatastrophic } = require('../../security/scan.cjs');
const { search: knowledgeSearch } = require('../../knowledge.cjs');
const { recordSearchEvidence } = require('../../nubosloop-audit.cjs');
const elision = require('../../elision.cjs');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_GREP_MATCHES = 200;
const MAX_GLOB_RESULTS = 500;
const MAX_WALK_ENTRIES = 20000;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'coverage', '.next', 'dist', 'build', 'vendor']);

const DEFAULT_BASH_TIMEOUT_MS = 120000;
const MAX_BASH_OUTPUT = 30000;

const BASH_DENYLIST = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\/\*|\$HOME)(\s|$)/, why: 'recursive delete of / or $HOME' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bmkfs(\.\w+)?\b/, why: 'filesystem format' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: 'raw write to a device' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: 'redirect into a block device' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, why: 'pipe-from-network into a shell' },
  { re: /\bsudo\b/, why: 'privilege escalation' },
  { re: /\bchmod\s+(-R\s+)?0?777\s+\//, why: 'world-writable on /' },
  { re: /\bgit\b[^\n]*\bpush\b/, why: 'git push (publishing is out of scope for an executor)' },
];

function _looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function _walk(root, onFile) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (++count > MAX_WALK_ENTRIES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name) && !ent.name.startsWith('.')) stack.push(full);
      } else if (ent.isFile()) {
        onFile(full);
      }
    }
  }
}

function _globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function _read(args, ctx) {
  const rel = args && args.path;
  if (typeof rel !== 'string' || !rel) throw new NubosPilotError('tool-bad-args', 'Read requires a "path"', {});
  const abs = assertInsideBase(ctx.cwd, rel, 'Read path');
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE_BYTES) throw new NubosPilotError('tool-file-too-large', 'file exceeds 1MB: ' + path.basename(abs), {});
  const buf = fs.readFileSync(abs);
  if (_looksBinary(buf)) return '[binary file omitted: ' + path.basename(abs) + ']';
  const lines = buf.toString('utf-8').split('\n');
  const offset = Math.max(0, (args && Number(args.offset)) || 0);
  const limit = Math.min(MAX_READ_LINES, (args && Number(args.limit)) || MAX_READ_LINES);
  const slice = lines.slice(offset, offset + limit);
  return slice.map((l, i) => (offset + i + 1) + '\t' + l).join('\n');
}

function _glob(args, ctx) {
  const pattern = (args && args.pattern) || '**/*';
  const re = _globToRegex(pattern);
  const matches = [];
  _walk(ctx.cwd, (full) => {
    if (matches.length >= MAX_GLOB_RESULTS) return;
    const relPath = path.relative(ctx.cwd, full);
    if (re.test(relPath)) matches.push(relPath);
  });
  matches.sort();
  if (!matches.length) return 'no files match: ' + pattern;
  return matches.join('\n');
}

function _grep(args, ctx) {
  const pattern = args && args.pattern;
  if (typeof pattern !== 'string' || !pattern) throw new NubosPilotError('tool-bad-args', 'Grep requires a "pattern"', {});
  if (_looksCatastrophic(pattern)) {
    throw new NubosPilotError('tool-bad-args', 'Grep pattern rejected as potentially catastrophic (ReDoS)', {});
  }
  let re;
  try { re = new RegExp(pattern, (args && args.ignore_case) ? 'i' : ''); }
  catch { throw new NubosPilotError('tool-bad-args', 'Grep pattern is not a valid regex', {}); }
  const globRe = (args && args.glob) ? _globToRegex(args.glob) : null;
  const out = [];
  _walk(ctx.cwd, (full) => {
    if (out.length >= MAX_GREP_MATCHES) return;
    const relPath = path.relative(ctx.cwd, full);
    if (globRe && !globRe.test(relPath)) return;
    let buf;
    try { buf = fs.readFileSync(full); } catch { return; }
    if (buf.length > MAX_FILE_BYTES || _looksBinary(buf)) return;
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= MAX_GREP_MATCHES) break;
      if (re.test(lines[i])) out.push(relPath + ':' + (i + 1) + ':' + lines[i].slice(0, 300));
    }
  });
  if (!out.length) return 'no matches for /' + pattern + '/';
  return out.join('\n');
}

function _scanNote(relPath, content, ctx) {
  let res;
  try { res = scanContent({ filePath: relPath, content, customRulesPath: ctx && ctx.customRulesPath }); }
  catch { return '\n[security] scan unavailable for this write (scanner error) — content NOT verified'; }
  const findings = (res && res.findings) || [];
  if (!findings.length) return '';
  const lines = findings.slice(0, 10).map((f) => '  - ' + f.severity + ' ' + f.category + ' @ line ' + f.line + ': ' + f.rule_name);
  return '\n[security] ' + findings.length + ' finding(s) in the written content — review before relying on it:\n' + lines.join('\n');
}

function _assertNotSymlinkLeaf(abs, label) {
  let lst;
  try { lst = fs.lstatSync(abs); } catch { return; }
  if (lst.isSymbolicLink()) {
    throw new NubosPilotError('tool-path-symlink', label + ' resolves to a symlink — refused (workspace confinement)', { file: path.basename(abs) });
  }
}

function _write(args, ctx) {
  const rel = args && args.path;
  if (typeof rel !== 'string' || !rel) throw new NubosPilotError('tool-bad-args', 'Write requires a "path"', {});
  if (typeof (args && args.content) !== 'string') throw new NubosPilotError('tool-bad-args', 'Write requires string "content"', {});
  const abs = assertInsideBase(ctx.cwd, rel, 'Write path');
  _assertNotSymlinkLeaf(abs, 'Write path');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, 'utf-8');
  return 'wrote ' + rel + ' (' + Buffer.byteLength(args.content, 'utf-8') + ' bytes)' + _scanNote(rel, args.content, ctx);
}

function _edit(args, ctx) {
  const rel = args && args.path;
  const oldStr = args && args.old_string;
  const newStr = args && args.new_string;
  if (typeof rel !== 'string' || !rel) throw new NubosPilotError('tool-bad-args', 'Edit requires a "path"', {});
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
    throw new NubosPilotError('tool-bad-args', 'Edit requires string "old_string" and "new_string"', {});
  }
  const abs = assertInsideBase(ctx.cwd, rel, 'Edit path');
  _assertNotSymlinkLeaf(abs, 'Edit path');
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE_BYTES) throw new NubosPilotError('tool-file-too-large', 'file exceeds 1MB: ' + path.basename(abs), {});
  const before = fs.readFileSync(abs, 'utf-8');
  const replaceAll = !!(args && args.replace_all);
  const occurrences = before.split(oldStr).length - 1;
  if (occurrences === 0) throw new NubosPilotError('tool-edit-no-match', 'old_string not found in ' + rel, {});
  if (occurrences > 1 && !replaceAll) {
    throw new NubosPilotError('tool-edit-ambiguous', 'old_string occurs ' + occurrences + 'x in ' + rel + ' — pass replace_all or make it unique', {});
  }
  const after = replaceAll
    ? before.split(oldStr).join(newStr)
    : (() => { const idx = before.indexOf(oldStr); return before.slice(0, idx) + newStr + before.slice(idx + oldStr.length); })();
  fs.writeFileSync(abs, after, 'utf-8');
  return 'edited ' + rel + ' (' + (replaceAll ? occurrences + ' replacements' : '1 replacement') + ')' + _scanNote(rel, after, ctx);
}

function _bash(args, ctx) {
  const cmd = args && args.command;
  if (typeof cmd !== 'string' || !cmd.trim()) throw new NubosPilotError('tool-bad-args', 'Bash requires a "command"', {});
  for (const entry of BASH_DENYLIST) {
    if (entry.re.test(cmd)) return 'Error: bash-command-blocked: ' + entry.why;
  }
  const timeout = Math.min(600000, Math.max(1000, (ctx && Number(ctx.bashTimeoutMs)) || (args && Number(args.timeout_ms)) || DEFAULT_BASH_TIMEOUT_MS));
  const res = spawnSync('/bin/sh', ['-c', cmd], {
    cwd: ctx.cwd,
    timeout,
    encoding: 'utf-8',
    maxBuffer: MAX_BASH_OUTPUT * 4,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') return 'Error: bash-timeout: command exceeded ' + timeout + 'ms';
    return 'Error: bash-spawn-failed: ' + (res.error.code || res.error.message);
  }
  let out = (res.stdout || '') + (res.stderr || '');
  let truncated = '';
  if (out.length > MAX_BASH_OUTPUT) { out = out.slice(0, MAX_BASH_OUTPUT); truncated = '\n[output truncated at ' + MAX_BASH_OUTPUT + ' chars]'; }
  const code = res.status == null ? '?' : res.status;
  return '[exit ' + code + ']\n' + out + truncated;
}

function _knowledgeSearch(args, ctx) {
  const query = args && (args.query || args.q);
  if (typeof query !== 'string' || !query.trim()) {
    throw new NubosPilotError('tool-bad-args', 'knowledge-search requires a "query"', {});
  }
  const limit = Math.min(50, Math.max(1, (args && Number(args.limit)) || 10));
  if (ctx && ctx.taskId) {
    try { recordSearchEvidence(ctx.taskId, query, ctx.cwd, ctx.agent); } catch {}
  }
  let res;
  try { res = knowledgeSearch(query, ctx.cwd, { limit }); }
  catch (err) { return 'knowledge-search: index unavailable (' + ((err && err.code) || 'error') + ')'; }
  const hits = (res && res.hits) || [];
  if (!hits.length) return 'knowledge-search: no results for "' + query + '"';
  return hits.map((h) => h.rel_path + ':' + h.line_start + ' (score ' + h.score + ')\n  ' + String(h.preview || '').slice(0, 200)).join('\n');
}

function _contextExpand(args, ctx) {
  const hash = args && args.hash;
  if (typeof hash !== 'string' || !hash) throw new NubosPilotError('tool-bad-args', 'context-expand requires a "hash"', {});
  const res = elision.retrieve(hash, ctx && ctx.cwd);
  if (res.status === 'ok') return res.original;
  if (res.status === 'expired') {
    return 'Error: context-expand: marker ' + hash + ' has expired (its retention window elapsed) and is no longer retrievable';
  }
  return 'Error: context-expand: no stored original for ' + hash;
}

const TOOLS = {
  'context-expand': {
    run: _contextExpand,
    schema: {
      type: 'function',
      function: {
        name: 'context-expand',
        description: 'Retrieve the full original text behind a ⟦elided:<hash>⟧ marker that appeared in an earlier tool result (large outputs are compressed in place). Pass the 12-char hash. Only call this when you actually need the elided detail.',
        parameters: {
          type: 'object',
          properties: {
            hash: { type: 'string', description: 'The 12-character hash from a ⟦elided:<hash>⟧ marker.' },
          },
          required: ['hash'],
        },
      },
    },
  },
  'knowledge-search': {
    run: _knowledgeSearch,
    schema: {
      type: 'function',
      function: {
        name: 'knowledge-search',
        description: 'Search the project knowledge base (codebase docs, prior learnings) before writing code. Returns ranked "path:line (score)" hits. Call this first — it satisfies the Rule-9 search bar.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text search query.' },
            limit: { type: 'integer', description: 'Max hits (default 10).' },
          },
          required: ['query'],
        },
      },
    },
  },
  Read: {
    run: _read,
    schema: {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file from the workspace. Returns up to 2000 lines, each prefixed with its 1-based line number.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            offset: { type: 'integer', description: 'Zero-based line to start from.' },
            limit: { type: 'integer', description: 'Maximum number of lines to return.' },
          },
          required: ['path'],
        },
      },
    },
  },
  Glob: {
    run: _glob,
    schema: {
      type: 'function',
      function: {
        name: 'Glob',
        description: 'List workspace files matching a glob (supports *, **, ?). Ignores node_modules/.git/vendor and dotdirs.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts".' } },
          required: ['pattern'],
        },
      },
    },
  },
  Grep: {
    run: _grep,
    schema: {
      type: 'function',
      function: {
        name: 'Grep',
        description: 'Search workspace file contents by regex. Returns up to 200 "relpath:line:text" matches.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'JavaScript regular expression.' },
            glob: { type: 'string', description: 'Optional glob to restrict which files are scanned.' },
            ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
          },
          required: ['pattern'],
        },
      },
    },
  },
  Write: {
    run: _write,
    schema: {
      type: 'function',
      function: {
        name: 'Write',
        description: 'Create or overwrite a workspace file with the given content. Confined to the workspace; content is security-scanned.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            content: { type: 'string', description: 'Full file content to write.' },
          },
          required: ['path', 'content'],
        },
      },
    },
  },
  Edit: {
    run: _edit,
    schema: {
      type: 'function',
      function: {
        name: 'Edit',
        description: 'Replace an exact string in a workspace file. old_string must be unique unless replace_all is set.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
  },
  Bash: {
    run: _bash,
    schema: {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Run a shell command in the workspace. Timed out and output-capped; catastrophic commands are blocked. Returns "[exit N]\\n<output>".',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
            timeout_ms: { type: 'integer', description: 'Optional timeout (ms), capped at 600000.' },
          },
          required: ['command'],
        },
      },
    },
  },
};

const READ_ONLY_TOOL_NAMES = Object.freeze(['Read', 'Glob', 'Grep']);
const MUTATING_TOOL_NAMES = Object.freeze(['Write', 'Edit']);
const SEARCH_TOOL_NAME = 'knowledge-search';
const EXPAND_TOOL_NAME = 'context-expand';
const IMPLEMENTED_TOOL_NAMES = Object.freeze([...READ_ONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES, 'Bash', SEARCH_TOOL_NAME, EXPAND_TOOL_NAME]);

function toolsetFor(declaredNames, opts) {
  const o = opts || {};
  const declared = Array.isArray(declaredNames) ? declaredNames : [];
  let allowed = READ_ONLY_TOOL_NAMES.slice();
  if (!o.readOnly) {
    allowed = allowed.concat(MUTATING_TOOL_NAMES);
    if (o.allowBash === true) allowed.push('Bash');
  }
  const names = declared.filter((n) => allowed.includes(n));
  if (o.withSearch && !names.includes(SEARCH_TOOL_NAME)) names.push(SEARCH_TOOL_NAME);
  if (o.withExpand && !names.includes(EXPAND_TOOL_NAME)) names.push(EXPAND_TOOL_NAME);
  const extraCtx = o.ctx || {};
  return {
    names,
    schemas: names.map((n) => TOOLS[n].schema),
    execute(name, argsJson, ctx) {
      return execute(name, argsJson, Object.assign({}, extraCtx, ctx), names);
    },
  };
}

function execute(name, argsJson, ctx, allowed) {
  if (allowed && !allowed.includes(name)) {
    return 'Error: tool "' + name + '" is not available to this agent';
  }
  const tool = TOOLS[name];
  if (!tool) return 'Error: unknown tool "' + name + '"';
  let args = {};
  if (typeof argsJson === 'string' && argsJson.trim()) {
    try { args = JSON.parse(argsJson); }
    catch { return 'Error: tool "' + name + '" received arguments that are not valid JSON'; }
  } else if (argsJson && typeof argsJson === 'object') {
    args = argsJson;
  }
  try {
    return String(tool.run(args, ctx || { cwd: process.cwd() }));
  } catch (err) {
    if (err && err.name === 'NubosPilotError') return 'Error: ' + err.code + ': ' + err.message;
    return 'Error: ' + ((err && err.message) || 'tool execution failed');
  }
}

module.exports = {
  TOOLS,
  READ_ONLY_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  SEARCH_TOOL_NAME,
  EXPAND_TOOL_NAME,
  IMPLEMENTED_TOOL_NAMES,
  BASH_DENYLIST,
  toolsetFor,
  execute,
  _globToRegex,
};
