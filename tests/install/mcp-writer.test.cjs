const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeMcpConfig, DEFAULT_MCP_TOKEN, DEFAULT_MCP_URL, _resolveTarget }
  = require('../../lib/install/mcp-writer.cjs');

function mkTmp(scope) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'np-mcp-' + scope + '-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-mcp-home-' + scope + '-'));
  return { project, home };
}

test('claude local: writes .mcp.json with http-transport and bearer', (t) => {
  const { project, home } = mkTmp('claude-local');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  writeMcpConfig({ runtime: 'claude', scope: 'local', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8'));
  assert.equal(cfg.mcpServers.nubos.type, 'http');
  assert.equal(cfg.mcpServers.nubos.url, DEFAULT_MCP_URL);
  assert.equal(cfg.mcpServers.nubos.headers.Authorization, 'Bearer ' + DEFAULT_MCP_TOKEN);
});

test('claude local: preserves pre-existing mcp entries', (t) => {
  const { project, home } = mkTmp('claude-merge');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { other: { command: 'npx', args: ['-y', 'other'] } },
  }));
  writeMcpConfig({ runtime: 'claude', scope: 'local', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8'));
  assert.ok(cfg.mcpServers.other, 'other server preserved');
  assert.ok(cfg.mcpServers.nubos, 'nubos server added');
});

test('claude global: writes ~/.claude.json', (t) => {
  const { project, home } = mkTmp('claude-global');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeMcpConfig({ runtime: 'claude', scope: 'global', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
  assert.equal(cfg.mcpServers.nubos.url, DEFAULT_MCP_URL);
});

test('codex: appends [mcp_servers.nubos] section to ~/.codex/config.toml', (t) => {
  const { project, home } = mkTmp('codex');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeMcpConfig({ runtime: 'codex', scope: 'local', projectRoot: project, home });
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
  assert.match(toml, /\[mcp_servers\.nubos\]/);
  assert.match(toml, /command = "npx"/);
  assert.match(toml, /mcp-remote/);
  assert.match(toml, new RegExp('Bearer ' + DEFAULT_MCP_TOKEN));
});

test('codex: idempotent — second call does not double-append', (t) => {
  const { project, home } = mkTmp('codex-idempotent');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeMcpConfig({ runtime: 'codex', scope: 'local', projectRoot: project, home });
  const first = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
  const result = writeMcpConfig({ runtime: 'codex', scope: 'local', projectRoot: project, home });
  const second = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
  assert.equal(first, second, 'content unchanged on second write');
  assert.equal(result.reason, 'already-configured');
});

test('gemini local: writes .gemini/settings.json with httpUrl', (t) => {
  const { project, home } = mkTmp('gemini-local');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeMcpConfig({ runtime: 'gemini', scope: 'local', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(path.join(project, '.gemini', 'settings.json'), 'utf-8'));
  assert.equal(cfg.mcpServers.nubos.httpUrl, DEFAULT_MCP_URL);
  assert.equal(cfg.mcpServers.nubos.headers.Authorization, 'Bearer ' + DEFAULT_MCP_TOKEN);
});

test('opencode local: writes opencode.json with type=remote', (t) => {
  const { project, home } = mkTmp('opencode-local');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeMcpConfig({ runtime: 'opencode', scope: 'local', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf-8'));
  assert.equal(cfg.mcp.nubos.type, 'remote');
  assert.equal(cfg.mcp.nubos.url, DEFAULT_MCP_URL);
  assert.equal(cfg.$schema, 'https://opencode.ai/config.json');
});

test('opencode global: writes ~/.config/opencode/opencode.json', (t) => {
  const { project, home } = mkTmp('opencode-global');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeMcpConfig({ runtime: 'opencode', scope: 'global', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(
    path.join(home, '.config', 'opencode', 'opencode.json'), 'utf-8'));
  assert.equal(cfg.mcp.nubos.type, 'remote');
});

test('env override: NUBOS_MCP_TOKEN and NUBOS_MCP_URL win over defaults', (t) => {
  const { project, home } = mkTmp('env-override');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const oldToken = process.env.NUBOS_MCP_TOKEN;
  const oldUrl = process.env.NUBOS_MCP_URL;
  process.env.NUBOS_MCP_TOKEN = 'custom-token';
  process.env.NUBOS_MCP_URL = 'https://mcp.example.com/';
  t.after(() => {
    if (oldToken === undefined) delete process.env.NUBOS_MCP_TOKEN;
    else process.env.NUBOS_MCP_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.NUBOS_MCP_URL;
    else process.env.NUBOS_MCP_URL = oldUrl;
  });
  writeMcpConfig({ runtime: 'claude', scope: 'local', projectRoot: project, home });
  const cfg = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8'));
  assert.equal(cfg.mcpServers.nubos.url, 'https://mcp.example.com/');
  assert.equal(cfg.mcpServers.nubos.headers.Authorization, 'Bearer custom-token');
});

test('dryRun: does not write to disk', (t) => {
  const { project, home } = mkTmp('dry-run');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = writeMcpConfig({ runtime: 'claude', scope: 'local', projectRoot: project, home, dryRun: true });
  assert.equal(result.wouldWrite, true);
  assert.ok(!fs.existsSync(path.join(project, '.mcp.json')));
});

test('unknown runtime throws', () => {
  assert.throws(() => writeMcpConfig({
    runtime: 'bogus', projectRoot: '/tmp', home: '/tmp',
  }), (err) => err.code === 'unknown-runtime');
});

test('_resolveTarget: local-scope codex still uses home config.toml', () => {
  const t = _resolveTarget('codex', 'local', '/tmp/project', '/tmp/home');
  assert.equal(t.kind, 'codex-toml');
  assert.equal(t.path, '/tmp/home/.codex/config.toml');
});

test('end-to-end via install: --mcp flag triggers MCP config write', async (t) => {
  const install = require('../../bin/install.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-install-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\nname: test\n---\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
    flags: { agent: 'claude', scope: 'local', mcp: true },
  });

  const mcpPath = path.join(root, '.mcp.json');
  assert.ok(fs.existsSync(mcpPath), '.mcp.json must be written when --mcp flag set');
  const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
  assert.equal(cfg.mcpServers.nubos.type, 'http');
});

test('end-to-end: without --mcp, no .mcp.json is created', async (t) => {
  const install = require('../../bin/install.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-install-nomcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\nname: test\n---\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
    flags: { agent: 'claude', scope: 'local', mcp: false },
  });

  assert.ok(!fs.existsSync(path.join(root, '.mcp.json')),
    '.mcp.json must NOT be written when --mcp flag absent');
});
