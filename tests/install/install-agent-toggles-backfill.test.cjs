const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = require('../../bin/install.js');

function mkStateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-agent-toggle-backfill-'));
  const stateDir = path.join(root, '.nubos-pilot');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

function writeCfg(stateDir, obj) {
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(obj, null, 2));
}

function readCfg(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
}

test('agent-toggle backfill: absent architect/test_writer get true written in', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local', agents: { research: true } });

  const added = install._backfillAgentToggles(stateDir);
  assert.deepEqual(added.sort(), ['architect', 'test_writer']);
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.architect, true);
  assert.equal(cfg.agents.test_writer, true);
  assert.equal(cfg.agents.research, true); // siblings preserved
});

test('agent-toggle backfill: no agents block gets one created with both toggles', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local' });

  const added = install._backfillAgentToggles(stateDir);
  assert.deepEqual(added.sort(), ['architect', 'test_writer']);
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.architect, true);
  assert.equal(cfg.agents.test_writer, true);
});

test('agent-toggle backfill: explicit false is NEVER overwritten', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { agents: { architect: false, test_writer: true } });

  const added = install._backfillAgentToggles(stateDir);
  assert.deepEqual(added, []);
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.architect, false);
  assert.equal(cfg.agents.test_writer, true);
});

test('agent-toggle backfill: only the missing toggle is added', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { agents: { architect: false } });

  const added = install._backfillAgentToggles(stateDir);
  assert.deepEqual(added, ['test_writer']);
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.architect, false); // untouched
  assert.equal(cfg.agents.test_writer, true);
});

test('agent-toggle backfill: dryRun reports keys without writing', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local' });

  const added = install._backfillAgentToggles(stateDir, { dryRun: true });
  assert.deepEqual(added.sort(), ['architect', 'test_writer']);
  assert.equal(readCfg(stateDir).agents, undefined); // not written
});

test('agent-toggle backfill: missing or unparseable config is a safe no-op', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  assert.deepEqual(install._backfillAgentToggles(stateDir), []);
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{ not json');
  assert.deepEqual(install._backfillAgentToggles(stateDir), []);
});

test('combined backfill: economy default + agent toggles applied in a single read/write pass', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local', agents: { research: true } });

  const result = install._backfillConfigDefaults(stateDir);
  assert.equal(result.economy, 'backfilled');
  assert.deepEqual(result.toggles.sort(), ['architect', 'test_writer']);
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.economy, 'ultra');
  assert.equal(cfg.agents.architect, true);
  assert.equal(cfg.agents.test_writer, true);
  assert.equal(cfg.agents.research, true);
});

test('combined backfill: preserves explicit choices and is a no-op when nothing is missing', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { agents: { economy: 'off', architect: false, test_writer: false } });

  const result = install._backfillConfigDefaults(stateDir);
  assert.equal(result.economy, 'preserved');
  assert.deepEqual(result.toggles, []);
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.economy, 'off');
  assert.equal(cfg.agents.architect, false);
  assert.equal(cfg.agents.test_writer, false);
});
