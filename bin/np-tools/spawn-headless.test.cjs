'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const spawnHeadless = require('./spawn-headless.cjs');
const runContext = require('../../lib/run-context.cjs');
const headlessGuard = require('../../lib/headless-guard.cjs');

// Tests that rely on POSIX permission enforcement (chmod) are unreliable
// when the runner is root (Forgejo docker container), since root bypasses
// read/write permission checks. Skip them in that environment.
const _isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const testPerm = _isRoot ? test.skip : test;

function _mockClaude(r, name, body) {
  const p = path.join(r, name);
  fs.writeFileSync(p, body, 'utf-8');
  fs.chmodSync(p, 0o755);
  return p;
}

const _sandboxes = [];
const _envBackup = {};

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-spawn-headless-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'agents', 'np-test-critic.md'),
    '---\nname: np-test-critic\ntools: Read, Write\n---\n\n# Role\n\nYou are a test critic.\n',
    'utf-8',
  );
  _sandboxes.push(r);
  return r;
}

function _cap() {
  let s = '';
  return { stub: { write: (x) => { s += String(x); return true; } }, get: () => s };
}

afterEach(() => {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  for (const k of Object.keys(_envBackup)) {
    if (_envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = _envBackup[k];
    delete _envBackup[k];
  }
  runContext._resetForTests();
});

function _setEnv(k, v) {
  _envBackup[k] = process.env[k];
  if (v == null) delete process.env[k];
  else process.env[k] = v;
}

test('SH-1: spawn-headless requires --agent', async () => {
  const r = _mkRoot();
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run([], { cwd: r, stdout: cap.stub }),
    (err) => err && err.code === 'spawn-headless-missing-agent',
  );
});

test('SH-2: spawn-headless requires --prompt-path', async () => {
  const r = _mkRoot();
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(['--agent', 'np-test-critic'], { cwd: r, stdout: cap.stub }),
    (err) => err && err.code === 'spawn-headless-missing-prompt-path',
  );
});

test('SH-3: spawn-headless requires --output-path', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'do the audit', 'utf-8');
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-missing-output-path',
  );
});

test('SH-4: spawn-headless rejects path traversal on prompt-path', async () => {
  const r = _mkRoot();
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(
      ['--agent', 'np-test-critic',
        '--prompt-path', '/etc/passwd',
        '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-path-traversal',
  );
});

test('SH-5: spawn-headless rejects unknown agent', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(
      ['--agent', 'np-does-not-exist',
        '--prompt-path', 'p.md',
        '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-agent-not-found',
  );
});

test('SH-6: spawn-headless rejects invalid agent name (path-injection guard)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(
      ['--agent', '../../etc/passwd',
        '--prompt-path', 'p.md',
        '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-invalid-agent-name',
  );
});

test('SH-7: spawn-headless reports claude-not-found when binary missing', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', path.join(r, 'no-such-binary'));
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(
      ['--agent', 'np-test-critic',
        '--prompt-path', 'p.md',
        '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-claude-not-found',
  );
});

test('SH-8: spawn-headless captures stdout to output-path on success (mock binary)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = path.join(r, 'mock-claude.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\nprintf \'{"verdict":"passed","blockers_count":0,"report_path":null}\\n\'\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const cap = _cap();
  const rc = await spawnHeadless.run(
    ['--agent', 'np-test-critic',
      '--prompt-path', 'p.md',
      '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  assert.equal(rc, 0, 'success returns exit 0');
  const payload = JSON.parse(cap.get());
  assert.equal(payload.exit_code, 0);
  assert.equal(payload.agent, 'np-test-critic');
  const written = fs.readFileSync(path.join(r, 'out.json'), 'utf-8');
  assert.match(written, /"verdict":"passed"/);
});

test('SH-9: spawn-headless surfaces non-zero subprocess exit (mock failure)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = path.join(r, 'mock-fail.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\necho boom >&2\nexit 7\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const cap = _cap();
  const rc = await spawnHeadless.run(
    ['--agent', 'np-test-critic',
      '--prompt-path', 'p.md',
      '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  assert.equal(rc, 2, 'non-zero subprocess returns rc=2');
  const payload = JSON.parse(cap.get());
  assert.equal(payload.exit_code, 7);
  assert.match(payload.stderr_excerpt, /boom/);
});

test('SH-10: spawn-headless rejects --timeout-ms below 1000', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const cap = _cap();
  await assert.rejects(
    async () => spawnHeadless.run(
      ['--agent', 'np-test-critic',
        '--prompt-path', 'p.md',
        '--output-path', 'out.json',
        '--timeout-ms', '500'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-invalid-timeout',
  );
});

test('SH-11: spawn-headless writes output atomically (no .tmp residue)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = path.join(r, 'mock-claude.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\nprintf \'{"verdict":"passed","blockers_count":0,"report_path":null}\\n\'\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const cap = _cap();
  const rc = await spawnHeadless.run(
    ['--agent', 'np-test-critic',
      '--prompt-path', 'p.md',
      '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  assert.equal(rc, 0);
  const written = fs.readFileSync(path.join(r, 'out.json'), 'utf-8');
  assert.match(written, /"verdict":"passed"/);
  const residue = fs.readdirSync(r).filter((n) => /\.\d+\.[0-9a-f]{12}\.tmp$/.test(n));
  assert.deepEqual(residue, [], 'atomicWriteFileSync must not leave .tmp behind');
});

test('SH-ENV-EX-1 _filterSpawnEnv uses exact-match approved-set — ANTHROPIC_API_KEY_OLD does NOT pass', () => {
  const filtered = spawnHeadless._filterSpawnEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'good',
    ANTHROPIC_API_KEY_OLD: 'rotated-leak',
    CLAUDE_CODE_OAUTH_TOKEN: 'good2',
    CLAUDE_CODE_OAUTH_TOKEN_BACKUP: 'backup-leak',
  });
  assert.equal(filtered.ANTHROPIC_API_KEY, 'good');
  assert.equal(filtered.CLAUDE_CODE_OAUTH_TOKEN, 'good2');
  assert.equal(filtered.ANTHROPIC_API_KEY_OLD, undefined, 'rotated keys must not slip through startsWith');
  assert.equal(filtered.CLAUDE_CODE_OAUTH_TOKEN_BACKUP, undefined);
});

test('SH-ENV-EX-2 prefix-corridor secrets (CLAUDE_BEARER, CLAUDE_PROXY_AUTH, NUBOS_PILOT_DB_DSN) blocked by substring deny', () => {
  const filtered = spawnHeadless._filterSpawnEnv({
    PATH: '/usr/bin',
    CLAUDE_BEARER: 'sk-x',
    CLAUDE_PROXY_AUTH: 'pw',
    CLAUDE_SESSION: 'sess-x',
    ANTHROPIC_COOKIE: 'cookie-x',
    NUBOS_PILOT_DB_DSN: 'postgres://u:p@h/db',
    NUBOS_PILOT_GITLAB_USERPASS: 'u:p',
    CLAUDE_BASE_URL: 'https://api',
  });
  assert.equal(filtered.CLAUDE_BEARER, undefined);
  assert.equal(filtered.CLAUDE_PROXY_AUTH, undefined);
  assert.equal(filtered.CLAUDE_SESSION, undefined);
  assert.equal(filtered.ANTHROPIC_COOKIE, undefined);
  assert.equal(filtered.NUBOS_PILOT_DB_DSN, undefined);
  assert.equal(filtered.NUBOS_PILOT_GITLAB_USERPASS, undefined);
  assert.equal(filtered.CLAUDE_BASE_URL, 'https://api', 'non-secret CLAUDE_ vars must still pass');
});

test('SH-ENV-EX-3 NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH overrides deny pattern', () => {
  const filtered = spawnHeadless._filterSpawnEnv({
    PATH: '/usr/bin',
    NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH: 'DATABASE_PASSWORD',
    DATABASE_PASSWORD: 'pw',
  });
  assert.equal(filtered.DATABASE_PASSWORD, 'pw', 'explicit passthrough must override deny');
  assert.equal(filtered.NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH, undefined, 'config var itself must not leak');
});

test('SH-ENV-EX-4 proxy/TLS env vars pass through (corporate networks)', () => {
  const filtered = spawnHeadless._filterSpawnEnv({
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://p:8080',
    HTTPS_PROXY: 'http://p:8080',
    NO_PROXY: 'localhost,.internal',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/ca.pem',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  for (const k of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','NODE_TLS_REJECT_UNAUTHORIZED']) {
    assert.ok(filtered[k] !== undefined, k + ' must pass through');
  }
});

test('SH-ENV-EX-5 CI-detection vars pass through (CI, GITHUB_ACTIONS, GITLAB_CI)', () => {
  const filtered = spawnHeadless._filterSpawnEnv({
    PATH: '/usr/bin',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITLAB_CI: 'true',
    BUILDKITE: 'true',
  });
  assert.equal(filtered.CI, 'true');
  assert.equal(filtered.GITHUB_ACTIONS, 'true');
  assert.equal(filtered.GITLAB_CI, 'true');
  assert.equal(filtered.BUILDKITE, 'true');
});

test('SH-REDACT-1 _redactSecrets strips well-known token patterns from stderr-tail', () => {
  const cases = [
    ['Error: sk-ant-api03-xxxxxxxxxxxxxxxxxxxxx invalid', 'anthropic-key'],
    ['401 from sk-proj-xxxxxxxxxxxxxxxxxxxxxx', 'openai-key'],
    ['failed gh_pat ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'github-token'],
    ['gitlab glpat-xxxxxxxxxxxxxxxxxxxxx', 'gitlab-pat'],
    ['Bearer abcdef1234567890abcdef1234567890 expired', 'bearer'],
    ['conn https://user:secret-pass@db.example.com/x', 'url-userinfo'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.zzzz signature mismatch', 'jwt'],
  ];
  for (const [input, kind] of cases) {
    const out = spawnHeadless._redactSecrets(input);
    assert.ok(out.includes('[REDACTED:' + kind + ']'),
      'expected ' + kind + ' redaction in: ' + JSON.stringify(out));
  }
});

test('SH-REDACT-2 _redactSecrets is a no-op on safe text', () => {
  const safe = 'connection refused (econnrefused), retrying in 3s';
  assert.equal(spawnHeadless._redactSecrets(safe), safe);
});

testPerm('SH-AUDIT-FIRST spawn-trail is written BEFORE caller-visible output (audit-first)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = path.join(r, 'mock.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\nprintf \'{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}\\n\'\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  _setEnv('NUBOS_PILOT_RUN_ID', 'r-audit-first-test');
  // Make audit dir read-only AFTER ensuring parent exists, so appendJsonl fails.
  fs.mkdirSync(path.join(r, '.nubos-pilot', 'audit'), { recursive: true });
  fs.chmodSync(path.join(r, '.nubos-pilot', 'audit'), 0o500);
  const cap = _cap();
  let thrown = null;
  try {
    await spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    );
  } catch (err) { thrown = err; }
  // Restore perms so cleanup works.
  fs.chmodSync(path.join(r, '.nubos-pilot', 'audit'), 0o700);
  assert.ok(thrown, 'audit failure must hard-throw');
  assert.equal(thrown.code, 'spawn-headless-audit-persist-failed');
  assert.equal(fs.existsSync(path.join(r, 'out.json')), false,
    'output must NOT exist if audit append failed (audit-first invariant)');
});

test('SH-PARSE-OK payload_parse_ok=false when claude returns non-JSON output', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = path.join(r, 'mock-plain.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\necho "not json output"\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  _setEnv('NUBOS_PILOT_RUN_ID', 'r-parse-test');
  const cap = _cap();
  await spawnHeadless.run(
    ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  const payload = JSON.parse(cap.get());
  assert.equal(payload.payload_parse_ok, false);
  assert.equal(payload.model_actual, null);
  const trailLine = fs.readFileSync(path.join(r, '.nubos-pilot', 'audit', 'spawns.jsonl'), 'utf-8').split('\n').filter(Boolean)[0];
  const rec = JSON.parse(trailLine);
  assert.equal(rec.payload_parse_ok, false);
});

test('SH-ENV-1 _filterSpawnEnv drops secret-bearing env vars (CI_JOB_TOKEN, GITLAB_TOKEN, AWS_*, NPM_TOKEN, GITHUB_TOKEN)', () => {
  const parent = {
    PATH: '/usr/bin', HOME: '/h', LANG: 'C.UTF-8',
    CI_JOB_TOKEN: 'gitlab-secret',
    GITLAB_TOKEN: 'glpat-xxx',
    GITHUB_TOKEN: 'gho_xxx',
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 'wjalrxu',
    NPM_TOKEN: 'npm_xxx',
    OPENAI_API_KEY: 'sk-x',
    STRIPE_SECRET_KEY: 'sk_live_x',
    DATABASE_PASSWORD: 'pw',
  };
  const filtered = spawnHeadless._filterSpawnEnv(parent);
  assert.equal(filtered.PATH, '/usr/bin');
  assert.equal(filtered.HOME, '/h');
  assert.equal(filtered.LANG, 'C.UTF-8');
  for (const k of ['CI_JOB_TOKEN','GITLAB_TOKEN','GITHUB_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','NPM_TOKEN','OPENAI_API_KEY','STRIPE_SECRET_KEY','DATABASE_PASSWORD']) {
    assert.equal(filtered[k], undefined, k + ' must NOT be forwarded to child');
  }
});

test('SH-ENV-2 _filterSpawnEnv forwards ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN by default', () => {
  const filtered = spawnHeadless._filterSpawnEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    CLAUDE_CODE_OAUTH_TOKEN: 'ccoauth-xxx',
  });
  assert.equal(filtered.ANTHROPIC_API_KEY, 'sk-ant-xxx');
  assert.equal(filtered.CLAUDE_CODE_OAUTH_TOKEN, 'ccoauth-xxx');
});

test('SH-ENV-3 NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH allow-lists by exact key name', () => {
  const parent = {
    PATH: '/usr/bin',
    NUBOS_PILOT_SPAWN_ENV_PASSTHROUGH: 'CUSTOM_VAR,ALSO_THIS',
    CUSTOM_VAR: 'fwd1',
    ALSO_THIS: 'fwd2',
    NOT_LISTED: 'drop',
  };
  const filtered = spawnHeadless._filterSpawnEnv(parent);
  assert.equal(filtered.CUSTOM_VAR, 'fwd1');
  assert.equal(filtered.ALSO_THIS, 'fwd2');
  assert.equal(filtered.NOT_LISTED, undefined);
});

test('SH-TRAIL-1 spawn writes append-only spawn-trail record with run_id + prompt/response sha256 + timing', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'do the audit', 'utf-8');
  const mockBin = path.join(r, 'mock-claude.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\nprintf \'{"model":"claude-sonnet-4-6","usage":{"input_tokens":42,"output_tokens":7},"verdict":"passed"}\\n\'\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  _setEnv('NUBOS_PILOT_RUN_ID', 'r-traceme-deadbeef');
  const cap = _cap();
  const rc = await spawnHeadless.run(
    ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  assert.equal(rc, 0);
  const payload = JSON.parse(cap.get());
  assert.equal(payload.run_id, 'r-traceme-deadbeef');
  assert.equal(payload.model_actual, 'claude-sonnet-4-6');
  assert.equal(payload.tokens_in, 42);
  assert.equal(payload.tokens_out, 7);
  assert.ok(payload.spawn_trail_path && payload.spawn_trail_path.endsWith('audit/spawns.jsonl'));

  const trail = fs.readFileSync(payload.spawn_trail_path, 'utf-8').split('\n').filter(Boolean);
  assert.equal(trail.length, 1);
  const rec = JSON.parse(trail[0]);
  assert.equal(rec.run_id, 'r-traceme-deadbeef');
  assert.equal(rec.agent, 'np-test-critic');
  assert.equal(rec.exit_code, 0);
  assert.equal(rec.model_actual, 'claude-sonnet-4-6');
  assert.equal(rec.tokens_in, 42);
  assert.equal(rec.tokens_out, 7);
  assert.ok(rec.prompt_sha256 && rec.prompt_sha256.length === 64);
  assert.ok(rec.response_sha256 && rec.response_sha256.length === 64);
  assert.ok(rec.prompt_bytes > 0);
  assert.ok(rec.response_bytes > 0);
  assert.ok(Number.isFinite(rec.duration_ms) && rec.duration_ms >= 0);
});

test('SH-TRAIL-1b run_id is seeded BEFORE spawn so the child env inherits NUBOS_PILOT_RUN_ID', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  // Mock-claude echoes its own ENV var so we can prove the child saw it.
  const mockBin = path.join(r, 'mock-claude.sh');
  fs.writeFileSync(mockBin,
    '#!/bin/sh\ncat > /dev/null\nprintf \'{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"run_id_from_child":"\'$NUBOS_PILOT_RUN_ID\'"}\\n\'\n',
    'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  // Crucially: do NOT set NUBOS_PILOT_RUN_ID; the lazy-seed must happen.
  runContext._resetForTests();
  const cap = _cap();
  await spawnHeadless.run(
    ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  const payload = JSON.parse(cap.get());
  const childRunId = JSON.parse(fs.readFileSync(path.join(r, 'out.json'), 'utf-8')).run_id_from_child;
  assert.ok(payload.run_id, 'parent must have a run_id');
  assert.equal(childRunId, payload.run_id, 'child must inherit parent NUBOS_PILOT_RUN_ID via filtered env');
});

test('SH-TRAIL-2 two sequential spawns append two parseable trail lines (jsonl integrity)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit X', 'utf-8');
  const mockBin = path.join(r, 'mock.sh');
  fs.writeFileSync(mockBin, '#!/bin/sh\ncat > /dev/null\nprintf \'{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}\\n\'\n', 'utf-8');
  fs.chmodSync(mockBin, 0o755);
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  _setEnv('NUBOS_PILOT_RUN_ID', 'r-test-multi-aaa1');
  const cap = _cap();
  for (let i = 0; i < 2; i++) {
    await spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out' + i + '.json'],
      { cwd: r, stdout: cap.stub },
    );
  }
  const trailPath = path.join(r, '.nubos-pilot', 'audit', 'spawns.jsonl');
  const lines = fs.readFileSync(trailPath, 'utf-8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});

test('SH-GUARD-1 refuses to spawn when NUBOS_PILOT_HEADLESS=1 (reentrancy guard)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = _mockClaude(r, 'mock.sh', '#!/bin/sh\ncat > /dev/null\necho "{}"\n');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  _setEnv('NUBOS_PILOT_HEADLESS', '1');
  const cap = _cap();
  await assert.rejects(
    spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-reentrant',
  );
  assert.equal(fs.existsSync(path.join(r, 'out.json')), false, 'no claude must be spawned inside a headless run');
});

test('SH-GUARD-2 refuses to spawn when hook depth has reached the cap (depth guard)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = _mockClaude(r, 'mock.sh', '#!/bin/sh\ncat > /dev/null\necho "{}"\n');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  _setEnv('NUBOS_PILOT_HOOK_DEPTH', '1');
  const cap = _cap();
  await assert.rejects(
    spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-depth-exceeded',
  );
});

test('SH-GUARD-3 child env carries NUBOS_PILOT_HEADLESS=1 and depth=1 (one level deep only)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = _mockClaude(r, 'mock.sh',
    '#!/bin/sh\ncat > /dev/null\nprintf \'{"hl":"\'$NUBOS_PILOT_HEADLESS\'","depth":"\'$NUBOS_PILOT_HOOK_DEPTH\'"}\\n\'\n');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const cap = _cap();
  const rc = await spawnHeadless.run(
    ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
    { cwd: r, stdout: cap.stub },
  );
  assert.equal(rc, 0);
  const child = JSON.parse(fs.readFileSync(path.join(r, 'out.json'), 'utf-8'));
  assert.equal(child.hl, '1', 'child claude must run with NUBOS_PILOT_HEADLESS=1');
  assert.equal(child.depth, '1', 'child claude must run at hook depth 1');
});

test('SH-GUARD-4 refuses to spawn while a live lock for the same agent is held (concurrency guard)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = _mockClaude(r, 'mock.sh', '#!/bin/sh\ncat > /dev/null\necho "{}"\n');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const held = headlessGuard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(held.acquired, true);
  const cap = _cap();
  try {
    await assert.rejects(
      spawnHeadless.run(
        ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
        { cwd: r, stdout: cap.stub },
      ),
      (err) => err && err.code === 'spawn-headless-locked',
    );
  } finally {
    held.release();
  }
});

test('SH-GUARD-5 lock is released after a successful spawn (re-spawnable)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = _mockClaude(r, 'mock.sh', '#!/bin/sh\ncat > /dev/null\necho "{}"\n');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const cap = _cap();
  for (let i = 0; i < 2; i++) {
    const rc = await spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out' + i + '.json'],
      { cwd: r, stdout: cap.stub },
    );
    assert.equal(rc, 0, 'sequential spawns must each acquire and release the lock');
  }
  assert.equal(fs.existsSync(headlessGuard._lockPath(r, 'np-test-critic')), false, 'no lock residue after spawns');
});

test('SH-GUARD-6 a held lock for one agent does NOT block a different agent (per-agent scope)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'agents', 'np-other-critic.md'),
    '---\nname: np-other-critic\n---\n\n# Role\n',
    'utf-8',
  );
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  const mockBin = _mockClaude(r, 'mock.sh', '#!/bin/sh\ncat > /dev/null\necho "{}"\n');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', mockBin);
  const held = headlessGuard.tryAcquireSpawnLock(r, 'np-test-critic');
  assert.equal(held.acquired, true);
  const cap = _cap();
  try {
    const rc = await spawnHeadless.run(
      ['--agent', 'np-other-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    );
    assert.equal(rc, 0, 'a different agent must spawn while np-test-critic is locked');
  } finally {
    held.release();
  }
});

test('SH-GUARD-7 lock is released even when the spawn errors (claude-not-found)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'audit', 'utf-8');
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', path.join(r, 'no-such-binary'));
  const cap = _cap();
  await assert.rejects(
    spawnHeadless.run(
      ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
      { cwd: r, stdout: cap.stub },
    ),
    (err) => err && err.code === 'spawn-headless-claude-not-found',
  );
  assert.equal(fs.existsSync(headlessGuard._lockPath(r, 'np-test-critic')), false,
    'the per-agent lock must not leak when the spawn fails');
});

test('SH-ENV-4 NUBOS_PILOT_/CLAUDE_/ANTHROPIC_ prefixed vars pass through (whitelisted prefix)', () => {
  const parent = {
    PATH: '/usr/bin',
    NUBOS_PILOT_DEBUG: '1',
    NUBOS_PILOT_LOG_LEVEL: 'warn',
    CLAUDE_FOO: 'bar',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    UNRELATED_FOO: 'drop',
  };
  const filtered = spawnHeadless._filterSpawnEnv(parent);
  assert.equal(filtered.NUBOS_PILOT_DEBUG, '1');
  assert.equal(filtered.NUBOS_PILOT_LOG_LEVEL, 'warn');
  assert.equal(filtered.CLAUDE_FOO, 'bar');
  assert.equal(filtered.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(filtered.UNRELATED_FOO, undefined);
});

test('SH-OFFHOST-1: openai-compat routing runs dispatchOffHost and writes a {result} envelope (no claude -p)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'review this diff', 'utf-8');
  const cap = _cap();
  let claudeWasCalled = false;
  _setEnv('NUBOS_PILOT_CLAUDE_BIN', path.join(r, 'nonexistent-claude-should-not-run'));
  let dispatchArgs = null;
  const code = await spawnHeadless.run(
    ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
    {
      cwd: r,
      stdout: cap.stub,
      resolveImpl: () => ({ kind: 'openai-compat', provider: 'ollama', model: 'qwen2.5-coder:32b' }),
      dispatchImpl: async (o) => { dispatchArgs = o; return { content: 'REVIEW: 0 risks', model: 'qwen2.5-coder:32b', provider: 'ollama' }; },
    },
  );
  assert.equal(code, 0);
  // dispatch received the agent + the prompt body as the task
  assert.equal(dispatchArgs.agent, 'np-test-critic');
  assert.match(dispatchArgs.task, /review this diff/);
  // output is the claude-compatible {result} envelope so review/extract parse it unchanged
  const out = JSON.parse(fs.readFileSync(path.join(r, 'out.json'), 'utf-8'));
  assert.equal(out.result, 'REVIEW: 0 risks');
  assert.equal(out.provider, 'ollama');
  // caller-visible payload marks it off-host and the native claude bin was never invoked
  const payload = JSON.parse(cap.get().trim());
  assert.equal(payload.off_host, true);
  assert.equal(payload.exit_code, 0);
  assert.equal(claudeWasCalled, false);
});

test('SH-OFFHOST-2: a failing off-host dispatch returns exit 2 with an empty result (soft-fail parity)', async () => {
  const r = _mkRoot();
  fs.writeFileSync(path.join(r, 'p.md'), 'review', 'utf-8');
  const cap = _cap();
  const code = await spawnHeadless.run(
    ['--agent', 'np-test-critic', '--prompt-path', 'p.md', '--output-path', 'out.json'],
    {
      cwd: r,
      stdout: cap.stub,
      resolveImpl: () => ({ kind: 'openai-compat', provider: 'ollama', model: 'x' }),
      dispatchImpl: async () => { const e = new Error('provider unreachable'); e.code = 'preflight-failed'; throw e; },
    },
  );
  assert.equal(code, 2);
  const out = JSON.parse(fs.readFileSync(path.join(r, 'out.json'), 'utf-8'));
  assert.equal(out.result, '');
  assert.equal(out.is_error, true);
});
