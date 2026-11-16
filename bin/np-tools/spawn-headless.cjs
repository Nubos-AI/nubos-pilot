'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child_process = require('node:child_process');

const { NubosPilotError, atomicWriteFileSync, appendJsonl, findProjectRoot } = require('../../lib/core.cjs');
const learningsInject = require('../../lib/learnings/inject.cjs');
const runContext = require('../../lib/run-context.cjs');
const safePath = require('../../lib/safe-path.cjs');
const headlessGuard = require('../../lib/headless-guard.cjs');
const compress = require('../../lib/compress.cjs');
const elision = require('../../lib/elision.cjs');
const elisionProxy = require('../../lib/elision-proxy.cjs');
const steering = require('../../lib/output-steering.cjs');
const logger = require('../../lib/logger.cjs').child('spawn-headless');
const args = require('./_args.cjs');

const PROXY_START_TIMEOUT_MS = 5000;

function _startCompressionProxy(cwd) {
  const upstream = process.env.ANTHROPIC_BASE_URL || '';
  return new Promise((resolve, reject) => {
    const proc = child_process.fork(path.join(__dirname, '_elision-proxy-entry.cjs'), [], {
      env: Object.assign({}, process.env, { ELISION_PROXY_CWD: cwd, ELISION_PROXY_UPSTREAM: upstream }),
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { }
      reject(new NubosPilotError('elision-proxy-start-timeout', 'compression proxy did not report ready in time', {}));
    }, PROXY_START_TIMEOUT_MS);
    proc.once('message', (m) => {
      clearTimeout(timer);
      if (m && m.ready) resolve({ proc, baseUrl: m.baseUrl });
      else { try { proc.kill(); } catch { } reject(new NubosPilotError('elision-proxy-start-failed', String(m && m.error), {})); }
    });
    proc.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function _sha256(s) {
  return crypto.createHash('sha256').update(s == null ? '' : String(s)).digest('hex');
}

function _spawnTrailPath(cwd) {
  let root;
  try { root = findProjectRoot(cwd); }
  catch { root = cwd; }
  return path.join(root, '.nubos-pilot', 'audit', 'spawns.jsonl');
}

function _parseClaudeJsonOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') return { parse_ok: false };
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return { parse_ok: false };
    const out = { parse_ok: true };
    if (typeof parsed.model === 'string') out.model_actual = parsed.model;
    const usage = parsed.usage;
    if (usage && typeof usage === 'object') {
      if (typeof usage.input_tokens === 'number') out.tokens_in = usage.input_tokens;
      if (typeof usage.output_tokens === 'number') out.tokens_out = usage.output_tokens;
    }
    return out;
  } catch { return { parse_ok: false }; }
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_BYTES = 4 * 1024;

function _assertInsideCwdOrTmp(p, cwd, label) {
  return safePath.assertInsideCwdOrTmp(p, cwd, label, 'spawn-headless-path-traversal');
}

function _resolveAgentPath(agent, cwd) {
  if (typeof agent !== 'string' || !agent.match(/^[a-zA-Z0-9_-]+$/)) {
    throw new NubosPilotError(
      'spawn-headless-invalid-agent-name',
      '--agent must be a simple identifier (alphanumeric, dash, underscore)',
      { agent },
    );
  }
  const candidates = [
    path.join(cwd, '.nubos-pilot', 'agents', agent + '.md'),
    path.join(cwd, '.claude', 'agents', agent + '.md'),
    path.join(__dirname, '..', '..', 'agents', agent + '.md'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; }
    catch { }
  }
  throw new NubosPilotError(
    'spawn-headless-agent-not-found',
    'Agent file not found for `' + agent + '` (searched: .nubos-pilot/agents, .claude/agents, package agents/)',
    { agent, searched: candidates },
  );
}

function _readPromptFile(promptPath, cwd) {
  const resolved = _assertInsideCwdOrTmp(promptPath, cwd, '--prompt-path');
  try { return fs.readFileSync(resolved, 'utf-8'); }
  catch (err) {
    throw new NubosPilotError(
      'spawn-headless-prompt-unreadable',
      '--prompt-path could not be read',
      { path: promptPath, cause: err && err.message },
    );
  }
}

function _ensureOutputDir(outputPath, cwd) {
  const resolved = _assertInsideCwdOrTmp(outputPath, cwd, '--output-path');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function _claudeBinary() {
  const env = process.env.NUBOS_PILOT_CLAUDE_BIN;
  if (env && env.trim()) return env.trim();
  return 'claude';
}

const _SPAWN_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'HOSTNAME',
  'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'TERM', 'COLORTERM',
  'NODE', 'NVM_DIR', 'NODE_OPTIONS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'REQUESTS_CA_BUNDLE',
  'CI', 'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD',
  'EDITOR', 'VISUAL',
  'NUBOS_PILOT_CLAUDE_BIN',
]);
const _SPAWN_ENV_PREFIXES = ['NUBOS_PILOT_', 'CLAUDE_', 'ANTHROPIC_'];
const _SECRET_DENY_SUBSTRING = /(API_KEY|TOKEN|SECRET|PASSWORD|PWD|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION|USERPASS|DSN|PRIVATE_KEY|JWT)/i;
const _SECRET_APPROVED_EXACT = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

function _filterSpawnEnv(parentEnv) {
  const out = Object.create(null);
  const passthrough = (parentEnv.NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const passthroughSet = new Set(passthrough);
  for (const key of Object.keys(parentEnv)) {
    if (passthroughSet.has(key)) { out[key] = parentEnv[key]; continue; }
    if (_SPAWN_ENV_ALLOW.has(key)) { out[key] = parentEnv[key]; continue; }
    if (_SPAWN_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      if (_SECRET_APPROVED_EXACT.has(key)) { out[key] = parentEnv[key]; continue; }
      if (_SECRET_DENY_SUBSTRING.test(key)) continue;
      out[key] = parentEnv[key];
      continue;
    }
  }
  delete out.NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH;
  return out;
}

const _STDERR_REDACTORS = [
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { kind: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{16,}/g },
  { kind: 'aws-key-id', re: /AKIA[0-9A-Z]{12,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { kind: 'bearer', re: /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi },
  { kind: 'basic-auth', re: /(Basic\s+)[A-Za-z0-9+/=]{16,}/gi },
  { kind: 'url-userinfo', re: /([a-z]+:\/\/)[^\s/]+:[^\s/@]+@/gi },
];

function _redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const r of _STDERR_REDACTORS) {
    out = out.replace(r.re, (match, p1) => {
      if (p1) return p1 + '[REDACTED:' + r.kind + ']';
      return '[REDACTED:' + r.kind + ']';
    });
  }
  return out;
}

function _composePrompt(agentBody, userPrompt) {
  return agentBody.trimEnd() + '\n\n---\n\n' + userPrompt.trimEnd() + '\n';
}

function _maybeCompressPrompt(prompt, cwd) {
  const none = { prompt, stats: null };
  const cx = elision.compressionContext(cwd);
  if (!cx.enabled) return none;
  try {
    const out = compress.compressPrompt(prompt, { minBlockBytes: cx.minBlockBytes, store: cx.store });
    if (!out || out.stats.blocks_compressed === 0) return none;
    return { prompt: out.text, stats: out.stats };
  } catch (err) {
    logger.warn('compression skipped', { cause: err && err.message });
    return none;
  }
}

function _stripFrontmatter(md) {
  if (!md.startsWith('---\n')) return md;
  const end = md.indexOf('\n---\n', 4);
  if (end === -1) return md;
  return md.slice(end + 5);
}

function _defaultResolveKind(agent, cwd) {
  const { resolveFromConfig } = require('./resolve-model.cjs');
  return resolveFromConfig({ agentOrTier: agent, cwd });
}

async function _runOffHost(o) {
  const dispatch = o.dispatchImpl || require('../../lib/runtime/dispatch.cjs').dispatchOffHost;
  const startedAt = o.startedAt;
  let result = null;
  let errObj = null;
  try {
    result = await dispatch({ agent: o.agent, task: o.userPrompt, cwd: o.cwd });
  } catch (err) {
    errObj = {
      code: (err && err.code) || 'spawn-headless-offhost-failed',
      message: (err && err.message) || 'off-host dispatch failed',
    };
  }
  const endedAt = new Date().toISOString();
  const content = result ? (result.content || '') : '';

  const envelope = JSON.stringify({
    type: 'result',
    result: content,
    model: result ? result.model : null,
    provider: result ? result.provider : null,
    is_error: !!errObj,
  });
  atomicWriteFileSync(o.resolvedOutput, envelope, 'utf-8', 0o600);

  const exitCode = errObj ? 2 : 0;
  const spawnTrailPath = _spawnTrailPath(o.cwd);
  const spawnRecord = {
    run_id: o.runId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    agent: o.agent,
    bin: 'off-host:' + (result ? result.provider : 'unknown'),
    exit_code: exitCode,
    timed_out: false,
    prompt_sha256: _sha256(o.userPrompt),
    prompt_bytes: Buffer.byteLength(o.userPrompt || '', 'utf-8'),
    response_sha256: _sha256(content),
    response_bytes: Buffer.byteLength(content, 'utf-8'),
    stderr_excerpt: errObj ? _redactSecrets(String(errObj.message)).slice(-STDERR_TAIL_BYTES) : '',
    model_actual: result ? result.model : null,
    tokens_in: null,
    tokens_out: null,
    payload_parse_ok: !errObj,
    runtime: result ? result.provider : 'off-host',
  };
  try { appendJsonl(spawnTrailPath, spawnRecord, { maxLineBytes: 16 * 1024, mode: 0o600 }); }
  catch (err) {
    throw new NubosPilotError(
      'spawn-headless-audit-persist-failed',
      'spawn-trail append failed; refusing to commit response without audit record',
      { file: 'spawns.jsonl', cause: (err && err.code) || 'unknown' },
    );
  }

  const payload = {
    agent: o.agent,
    output_path: o.outputPath,
    output_path_resolved: o.resolvedOutput,
    exit_code: exitCode,
    stderr_excerpt: spawnRecord.stderr_excerpt,
    bin: spawnRecord.bin,
    timed_out: false,
    run_id: o.runId,
    spawn_trail_path: spawnTrailPath,
    model_actual: spawnRecord.model_actual,
    tokens_in: null,
    tokens_out: null,
    payload_parse_ok: spawnRecord.payload_parse_ok,
    off_host: true,
  };
  o.stdout.write(JSON.stringify(payload) + '\n');
  return exitCode;
}

async function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];

  if (headlessGuard.isHeadless(process.env)) {
    throw new NubosPilotError(
      'spawn-headless-reentrant',
      'refusing to spawn a nested headless `claude` (NUBOS_PILOT_HEADLESS is set) — recursion guard',
      { depth: headlessGuard.currentDepth(process.env) },
    );
  }
  if (headlessGuard.depthExceeded(process.env)) {
    throw new NubosPilotError(
      'spawn-headless-depth-exceeded',
      'refusing to spawn headless `claude`: hook depth ' + headlessGuard.currentDepth(process.env)
        + ' has reached the cap ' + headlessGuard.maxDepth(process.env) + ' (recursion guard)',
      { depth: headlessGuard.currentDepth(process.env), max: headlessGuard.maxDepth(process.env) },
    );
  }

  const agent = args.getFlag(list, '--agent');
  if (!agent) {
    throw new NubosPilotError(
      'spawn-headless-missing-agent',
      'spawn-headless requires --agent <name>',
      { hint: 'agent is the basename of an .md file under agents/ (without extension)' },
    );
  }
  const promptPath = args.getFlag(list, '--prompt-path');
  if (!promptPath) {
    throw new NubosPilotError(
      'spawn-headless-missing-prompt-path',
      'spawn-headless requires --prompt-path <file>',
      {},
    );
  }
  const outputPath = args.getFlag(list, '--output-path');
  if (!outputPath) {
    throw new NubosPilotError(
      'spawn-headless-missing-output-path',
      'spawn-headless requires --output-path <file>',
      {},
    );
  }
  const timeoutRaw = args.getFlag(list, '--timeout-ms');
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new NubosPilotError(
      'spawn-headless-invalid-timeout',
      '--timeout-ms must be a positive number ≥ 1000',
      { value: timeoutRaw },
    );
  }

  const agentPath = _resolveAgentPath(agent, cwd);
  let agentBody = _stripFrontmatter(fs.readFileSync(agentPath, 'utf-8'));
  const _os = elision.compressionContext(cwd).outputSteering;
  if (_os && _os.enabled) agentBody = steering.enrichSystemPrompt(agentBody, _os.profile);
  const userPrompt = learningsInject.appendInjection(_readPromptFile(promptPath, cwd), cwd);
  let composedPrompt = _composePrompt(agentBody, userPrompt);
  const resolvedOutput = _ensureOutputDir(outputPath, cwd);

  const runId = runContext.getRunId();

  const resolveKind = context.resolveImpl || _defaultResolveKind;
  let routed;
  try { routed = resolveKind(agent, cwd); } catch { routed = { kind: 'native' }; }
  if (routed && routed.kind === 'openai-compat') {
    return _runOffHost({
      agent, userPrompt, resolvedOutput, outputPath, cwd, runId, stdout,
      startedAt: new Date().toISOString(),
      dispatchImpl: context.dispatchImpl,
    });
  }

  const compression = _maybeCompressPrompt(composedPrompt, cwd);
  composedPrompt = compression.prompt;

  let lockRoot;
  try { lockRoot = findProjectRoot(cwd); }
  catch { lockRoot = cwd; }
  const lock = headlessGuard.tryAcquireSpawnLock(lockRoot, agent);
  if (!lock.acquired) {
    throw new NubosPilotError(
      'spawn-headless-locked',
      'another headless run for agent `' + agent + '` is already active in this project (concurrency guard)',
      { agent, holder: lock.holder || null },
    );
  }

  const childEnv = _filterSpawnEnv(process.env);
  Object.assign(childEnv, headlessGuard.childSpawnEnv(process.env));

  let proxyProc = null;
  if (elisionProxy.proxyEnabled(cwd)) {
    try {
      const started = await _startCompressionProxy(cwd);
      proxyProc = started.proc;
      childEnv.ANTHROPIC_BASE_URL = started.baseUrl;
    } catch (err) {
      logger.warn('compression proxy unavailable; spawning without it', { cause: err && err.message });
    }
  }

  const bin = _claudeBinary();
  const claudeArgs = ['-p', '--output-format', 'json'];
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = child_process.spawnSync(bin, claudeArgs, {
      cwd,
      input: composedPrompt,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf-8',
      env: childEnv,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    throw new NubosPilotError(
      'spawn-headless-spawn-failed',
      'failed to spawn `' + bin + '`: ' + (err && err.message),
      { bin, cause: err && err.code },
    );
  } finally {
    if (proxyProc) { try { proxyProc.kill(); } catch { } }
    lock.release();
  }
  if (result.error && result.error.code === 'ENOENT') {
    throw new NubosPilotError(
      'spawn-headless-claude-not-found',
      'binary `' + bin + '` not found on PATH (set NUBOS_PILOT_CLAUDE_BIN to override)',
      { bin },
    );
  }
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new NubosPilotError(
      'spawn-headless-timed-out',
      'subprocess `' + bin + '` exceeded --timeout-ms ' + timeoutMs,
      { bin, timeoutMs },
    );
  }

  const endedAt = new Date().toISOString();
  const stderrTail = _redactSecrets((result.stderr || '').slice(-STDERR_TAIL_BYTES));
  const exitCode = result.status == null ? 1 : Number(result.status);

  const claudeMeta = _parseClaudeJsonOutput(result.stdout || '');
  const spawnTrailPath = _spawnTrailPath(cwd);
  const spawnRecord = {
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    agent,
    bin: path.basename(bin),
    exit_code: exitCode,
    timed_out: !!(result.error && result.error.code === 'ETIMEDOUT'),
    prompt_sha256: _sha256(composedPrompt),
    prompt_bytes: Buffer.byteLength(composedPrompt, 'utf-8'),
    response_sha256: _sha256(result.stdout || ''),
    response_bytes: Buffer.byteLength(result.stdout || '', 'utf-8'),
    stderr_excerpt: stderrTail,
    model_actual: claudeMeta.model_actual || null,
    tokens_in: claudeMeta.tokens_in == null ? null : claudeMeta.tokens_in,
    tokens_out: claudeMeta.tokens_out == null ? null : claudeMeta.tokens_out,
    payload_parse_ok: claudeMeta.parse_ok,
    compression: compression.stats || null,
  };
  try { appendJsonl(spawnTrailPath, spawnRecord, { maxLineBytes: 16 * 1024, mode: 0o600 }); }
  catch (err) {
    throw new NubosPilotError(
      'spawn-headless-audit-persist-failed',
      'spawn-trail append failed; refusing to commit response without audit record',
      { file: 'spawns.jsonl', cause: (err && err.code) || 'unknown' },
    );
  }
  atomicWriteFileSync(resolvedOutput, result.stdout || '', 'utf-8', 0o600);

  const payload = {
    agent,
    output_path: outputPath,
    output_path_resolved: resolvedOutput,
    exit_code: exitCode,
    stderr_excerpt: stderrTail,
    bin,
    timed_out: !!(result.error && result.error.code === 'ETIMEDOUT'),
    run_id: runId,
    spawn_trail_path: spawnTrailPath,
    model_actual: spawnRecord.model_actual,
    tokens_in: spawnRecord.tokens_in,
    tokens_out: spawnRecord.tokens_out,
    payload_parse_ok: spawnRecord.payload_parse_ok,
    compression: compression.stats || null,
  };
  stdout.write(JSON.stringify(payload) + '\n');
  if (exitCode !== 0) return 2;
  return 0;
}

module.exports = { run, _filterSpawnEnv, _redactSecrets };
