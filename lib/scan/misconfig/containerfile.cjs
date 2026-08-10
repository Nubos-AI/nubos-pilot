'use strict';

const finding = require('../finding.cjs');

const RULES = Object.freeze({
  RUNS_AS_ROOT: Object.freeze({
    id: 'NPS-0630',
    rule_name: 'container_runs_as_root',
    category: 'container-hardening',
    severity: 'medium',
    cwe: ['CWE-250'],
    reminder: 'The final stage of this image runs as root. Add a dedicated unprivileged user and a `USER` instruction as the last identity change in the final stage.',
  }),
  MUTABLE_BASE_IMAGE: Object.freeze({
    id: 'NPS-0631',
    rule_name: 'mutable_base_image',
    category: 'supply-chain',
    severity: 'medium',
    cwe: ['CWE-1104'],
    reminder: 'A floating base image means two builds of the same source can produce different images. Pin the base image to an explicit version and, ideally, a digest.',
  }),
  UNPINNED_BASE_IMAGE: Object.freeze({
    id: 'NPS-0632',
    rule_name: 'unpinned_base_image_digest',
    category: 'supply-chain',
    severity: 'low',
    cwe: ['CWE-1104'],
    reminder: 'Tags can be moved. Append `@sha256:...` to the base image so the build resolves to one immutable image.',
  }),
  BUILD_SECRET: Object.freeze({
    id: 'NPS-0633',
    rule_name: 'secret_in_build_environment',
    category: 'hardcoded-secret',
    severity: 'high',
    cwe: ['CWE-798'],
    reminder: 'ENV and ARG values are baked into image layers and readable by anyone who can pull the image. Pass the value at runtime or via `RUN --mount=type=secret`, and rotate the exposed credential.',
  }),
  ADD_INSTEAD_OF_COPY: Object.freeze({
    id: 'NPS-0634',
    rule_name: 'add_instead_of_copy',
    category: 'container-hardening',
    severity: 'low',
    reminder: 'ADD has implicit behaviour (archive extraction, remote fetch). Use COPY unless that behaviour is the point.',
  }),
  ADD_REMOTE_URL: Object.freeze({
    id: 'NPS-0635',
    rule_name: 'add_remote_url',
    category: 'supply-chain',
    severity: 'medium',
    cwe: ['CWE-494'],
    reminder: 'ADD of a URL trusts a remote fetch at build time with no integrity check. Download explicitly, verify a checksum or signature, then COPY.',
  }),
  REMOTE_SCRIPT_TO_SHELL: Object.freeze({
    id: 'NPS-0636',
    rule_name: 'remote_script_piped_to_shell',
    category: 'supply-chain',
    severity: 'high',
    cwe: ['CWE-494'],
    reminder: 'Piping a download straight into a shell executes whatever the server returns. Fetch to a file, verify a checksum or signature, then run it.',
  }),
  APT_HYGIENE: Object.freeze({
    id: 'NPS-0637',
    rule_name: 'apt_get_hygiene',
    category: 'container-hardening',
    severity: 'low',
    reminder: 'Use `apt-get install -y --no-install-recommends` and finish the same RUN with `rm -rf /var/lib/apt/lists/*` so the layer carries no recommended extras or package index.',
  }),
  SUDO_IN_BUILD: Object.freeze({
    id: 'NPS-0638',
    rule_name: 'sudo_in_build',
    category: 'container-hardening',
    severity: 'low',
    reminder: 'A build step already runs as its stage user. Switch identity with `USER` instead of shipping sudo into the image.',
  }),
  PRIVILEGED_BUILD: Object.freeze({
    id: 'NPS-0639',
    rule_name: 'privileged_build_step',
    category: 'container-hardening',
    severity: 'high',
    cwe: ['CWE-250'],
    reminder: 'A privileged build step or a mounted Docker socket gives the build full control of the host daemon. Remove it or move the work outside the image build.',
  }),
  WORLD_WRITABLE_CHMOD: Object.freeze({
    id: 'NPS-0640',
    rule_name: 'world_writable_permissions',
    category: 'container-hardening',
    severity: 'medium',
    cwe: ['CWE-732'],
    reminder: 'Mode 777 lets any process in the container rewrite the file. Grant the narrowest mode the runtime user needs.',
  }),
});

const FILES = Object.freeze([
  'Dockerfile',
  'Dockerfile.*',
  '*.Dockerfile',
  'Containerfile',
  'Containerfile.*',
  '*.Containerfile',
]);

const BASENAME_RE = /^(?:dockerfile|containerfile)(?:\.[^/]+)?$/i;
const SUFFIX_RE = /\.(?:dockerfile|containerfile)$/i;
const NON_BUILDFILE_SUFFIX_RE = /\.(?:c?js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|md|txt|py|rb|go|rs|java|cs|php|sh|bash|zsh|html|css|snap|lock|map|test|spec)$/i;
const INSTRUCTION_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/;
const SECRET_KEY_RE = /(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|access[_-]?key|credential)/i;
const NON_SECRET_KEY_RE = /(?:_|^)(?:file|path|dir|name|user|username|enabled|url|uri|header)$/i;
const INTERPOLATION_RE = /\$\{?[A-Za-z_]/;
const ARCHIVE_RE = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|zip|gz|bz2|xz|zst)$/i;
const REMOTE_URL_RE = /^(?:https?|ftps?|git):\/\//i;
const PIPE_RE = /(?<!\|)\|(?!\|)/;
const DOWNLOADER_RE = /\b(?:curl|wget)\b/i;
const SHELL_SINK_RE = /^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k|a)?sh\b/i;
const APT_INSTALL_RE = /\bapt(?:-get)?\s+(?:(?:-|--)\S+\s+)*install\b/i;
const NO_RECOMMENDS_RE = /--no-install-recommends\b/;
const APT_LISTS_CLEANUP_RE = /rm\s+-[a-zA-Z]*f[a-zA-Z]*\s+[^\s]*\/var\/lib\/apt\/lists/;
const SUDO_RE = /\bsudo\s+\S/;
const PRIVILEGED_RE = /--privileged\b/;
const DOCKER_SOCKET_RE = /docker\.sock\b/;
const CHMOD_WORLD_RE = /\bchmod\s+(?:-\S+\s+)*(?:0?777|a\+rwx|ugo\+rwx)\b/i;
const ROOT_USERS = Object.freeze(['root', '0']);
const MAX_STAGE_CHAIN = 64;

function matches(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false;
  const base = relPath.split(/[\\/]/).pop();
  if (!base || base.startsWith('.')) return false;
  if (SUFFIX_RE.test(base)) return true;
  if (!BASENAME_RE.test(base)) return false;
  return !NON_BUILDFILE_SUFFIX_RE.test(base);
}

function _warn(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function _logicalLines(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) continue;
    if (current === null && trimmed === '') continue;
    if (current === null) current = { line: i + 1, parts: [] };
    const continued = trimmed.endsWith('\\');
    current.parts.push(continued ? trimmed.slice(0, -1).trim() : trimmed);
    if (continued) continue;
    out.push({ line: current.line, text: current.parts.filter(Boolean).join(' ') });
    current = null;
  }
  if (current) out.push({ line: current.line, text: current.parts.filter(Boolean).join(' ') });
  return out.filter((entry) => entry.text !== '');
}

function _instructions(content, warnings) {
  const out = [];
  for (const entry of _logicalLines(content)) {
    const m = INSTRUCTION_RE.exec(entry.text);
    if (!m) {
      _warn(warnings, 'unparsable-instruction');
      continue;
    }
    out.push({ name: m[1].toUpperCase(), args: (m[2] || '').trim(), line: entry.line });
  }
  return out;
}

function _parseFrom(args) {
  const tokens = args.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('--')) index += 1;
  const image = tokens[index] || '';
  const alias = tokens[index + 1] && /^as$/i.test(tokens[index + 1]) ? (tokens[index + 2] || null) : null;
  return { image, alias };
}

function _imageRef(image) {
  const at = image.indexOf('@');
  const digest = at >= 0 ? image.slice(at + 1) : null;
  const named = at >= 0 ? image.slice(0, at) : image;
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const tagged = colon > slash;
  return {
    name: tagged ? named.slice(0, colon) : named,
    tag: tagged ? named.slice(colon + 1) : null,
    digest: digest || null,
  };
}

function _stages(instructions) {
  const stages = [];
  for (const ins of instructions) {
    if (ins.name === 'FROM') {
      const parsed = _parseFrom(ins.args);
      stages.push({ image: parsed.image, alias: parsed.alias, line: ins.line, instructions: [] });
      continue;
    }
    if (stages.length) stages[stages.length - 1].instructions.push(ins);
  }
  return stages;
}

function _baseStageIndex(stages, index) {
  const image = stages[index].image;
  if (!image) return -1;
  const wanted = image.toLowerCase();
  for (let i = 0; i < index; i += 1) {
    if (stages[i].alias && stages[i].alias.toLowerCase() === wanted) return i;
  }
  if (/^\d+$/.test(image)) {
    const numeric = Number(image);
    if (numeric < index) return numeric;
  }
  return -1;
}

function _declaredUser(stage) {
  for (let i = stage.instructions.length - 1; i >= 0; i -= 1) {
    const ins = stage.instructions[i];
    if (ins.name === 'USER' && ins.args) return ins;
  }
  return null;
}

function _effectiveUser(stages, index) {
  let cursor = index;
  for (let hops = 0; hops < MAX_STAGE_CHAIN && cursor >= 0; hops += 1) {
    const declared = _declaredUser(stages[cursor]);
    if (declared) return declared;
    cursor = _baseStageIndex(stages, cursor);
  }
  return null;
}

function _unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

function _tokenizeAssignments(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) { current += ch + text[i + 1]; i += 1; continue; }
      if (ch === quote) { quote = null; current += ch; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function _assignments(args) {
  const out = [];
  for (const token of _tokenizeAssignments(args)) {
    const eq = token.indexOf('=');
    if (eq <= 0) { out.push({ key: token, value: null }); continue; }
    out.push({ key: token.slice(0, eq), value: _unquote(token.slice(eq + 1)) });
  }
  return out;
}

function _envPairs(args) {
  if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*=/.test(args)) return _assignments(args);
  const legacy = /^([A-Za-z_][A-Za-z0-9_.-]*)\s+([\s\S]+)$/.exec(args);
  return legacy ? [{ key: legacy[1], value: _unquote(legacy[2]) }] : [];
}

function _isLiteralSecret(key, value) {
  if (!key || typeof value !== 'string') return false;
  if (!SECRET_KEY_RE.test(key) || NON_SECRET_KEY_RE.test(key)) return false;
  const literal = value.trim();
  if (literal === '' || literal.length < 4) return false;
  if (INTERPOLATION_RE.test(literal)) return false;
  if (literal.startsWith('/') || literal.startsWith('./') || literal.startsWith('~/')) return false;
  return true;
}

function _pipesDownloadIntoShell(text) {
  const segments = text.split(PIPE_RE);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (DOWNLOADER_RE.test(segments[i]) && SHELL_SINK_RE.test(segments[i + 1])) return true;
  }
  return false;
}

function _addSources(args) {
  const tokens = _tokenizeAssignments(args).filter((token) => !token.startsWith('--'));
  return tokens.slice(0, Math.max(tokens.length - 1, 0)).map(_unquote);
}

function _finding(rule, file, line, title) {
  return finding.make({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: 'misconfig',
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe || [],
    file,
    line,
    title,
    reminder: rule.reminder,
  });
}

function _baseImageFindings(stages, file, findings, warnings) {
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    if (!stage.image) { _warn(warnings, 'from-without-image'); continue; }
    if (_baseStageIndex(stages, i) >= 0) continue;
    if (stage.image.toLowerCase() === 'scratch') continue;
    if (INTERPOLATION_RE.test(stage.image)) { _warn(warnings, 'unresolved-base-image'); continue; }
    const ref = _imageRef(stage.image);
    if (ref.digest) continue;
    if (!ref.tag) {
      findings.push(_finding(RULES.MUTABLE_BASE_IMAGE, file, stage.line, 'FROM ' + ref.name + ' has no tag and resolves to :latest'));
      continue;
    }
    if (ref.tag.toLowerCase() === 'latest') {
      findings.push(_finding(RULES.MUTABLE_BASE_IMAGE, file, stage.line, 'FROM ' + ref.name + ':latest is a moving base image'));
      continue;
    }
    findings.push(_finding(RULES.UNPINNED_BASE_IMAGE, file, stage.line, 'FROM ' + ref.name + ':' + ref.tag + ' is tagged but not pinned to a digest'));
  }
}

function _rootUserFindings(stages, file, findings, warnings) {
  if (!stages.length) { _warn(warnings, 'no-from-instruction'); return; }
  const finalIndex = stages.length - 1;
  const declared = _effectiveUser(stages, finalIndex);
  if (!declared) {
    findings.push(_finding(RULES.RUNS_AS_ROOT, file, stages[finalIndex].line, 'final stage declares no USER, so the container runs as root'));
    return;
  }
  const name = _unquote(declared.args.split(':')[0]);
  if (INTERPOLATION_RE.test(name)) { _warn(warnings, 'unresolved-user'); return; }
  if (ROOT_USERS.includes(name.toLowerCase())) {
    findings.push(_finding(RULES.RUNS_AS_ROOT, file, declared.line, 'final stage sets USER ' + name + ', so the container runs as root'));
  }
}

function _runFindings(ins, file, findings) {
  const text = ins.args;
  if (_pipesDownloadIntoShell(text)) {
    findings.push(_finding(RULES.REMOTE_SCRIPT_TO_SHELL, file, ins.line, 'RUN pipes a downloaded script straight into a shell'));
  }
  if (PRIVILEGED_RE.test(text) || DOCKER_SOCKET_RE.test(text)) {
    findings.push(_finding(RULES.PRIVILEGED_BUILD, file, ins.line, PRIVILEGED_RE.test(text)
      ? 'RUN requests --privileged'
      : 'RUN reaches the Docker socket'));
  }
  if (APT_INSTALL_RE.test(text)) {
    const missing = [];
    if (!NO_RECOMMENDS_RE.test(text)) missing.push('--no-install-recommends');
    if (!APT_LISTS_CLEANUP_RE.test(text)) missing.push('rm -rf /var/lib/apt/lists/*');
    if (missing.length) {
      findings.push(_finding(RULES.APT_HYGIENE, file, ins.line, 'apt-get install without ' + missing.join(' and ')));
    }
  }
  if (SUDO_RE.test(text)) {
    findings.push(_finding(RULES.SUDO_IN_BUILD, file, ins.line, 'RUN invokes sudo'));
  }
  if (CHMOD_WORLD_RE.test(text)) {
    findings.push(_finding(RULES.WORLD_WRITABLE_CHMOD, file, ins.line, 'RUN makes a path world-writable with chmod 777'));
  }
}

function _addFindings(ins, file, findings) {
  const sources = _addSources(ins.args);
  if (!sources.length) return;
  const url = sources.find((source) => REMOTE_URL_RE.test(source));
  if (url) {
    findings.push(_finding(RULES.ADD_REMOTE_URL, file, ins.line, 'ADD fetches a remote URL at build time'));
    return;
  }
  const archive = sources.find((source) => ARCHIVE_RE.test(source));
  findings.push(_finding(RULES.ADD_INSTEAD_OF_COPY, file, ins.line, archive
    ? 'ADD auto-extracts ' + archive + ' where COPY would be explicit'
    : 'ADD used where COPY would do'));
}

function _secretFindings(ins, file, findings) {
  const pairs = ins.name === 'ENV' ? _envPairs(ins.args) : _assignments(ins.args);
  for (const pair of pairs) {
    if (!_isLiteralSecret(pair.key, pair.value)) continue;
    findings.push(_finding(RULES.BUILD_SECRET, file, ins.line, ins.name + ' ' + pair.key + ' holds a literal secret (value redacted)'));
  }
}

function check(content, opts) {
  const o = opts || {};
  if (content != null && typeof content !== 'string') {
    return { findings: [], warnings: ['invalid-input'] };
  }
  const file = typeof o.file === 'string' && o.file ? o.file : null;
  const findings = [];
  const warnings = [];
  const instructions = _instructions(String(content == null ? '' : content), warnings);
  const stages = _stages(instructions);

  _baseImageFindings(stages, file, findings, warnings);
  for (const ins of instructions) {
    if (ins.name === 'RUN') _runFindings(ins, file, findings);
    else if (ins.name === 'ADD') _addFindings(ins, file, findings);
    else if (ins.name === 'ENV' || ins.name === 'ARG') _secretFindings(ins, file, findings);
  }
  _rootUserFindings(stages, file, findings, warnings);

  return { findings, warnings };
}

module.exports = { RULES, FILES, matches, check };
