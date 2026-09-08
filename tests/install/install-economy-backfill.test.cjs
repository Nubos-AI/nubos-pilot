const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = require('../../bin/install.js');

function mkStateDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-eco-backfill-'));
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

test('backfill: a config without agents.economy gets ultra written in', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local', agents: { research: true } });

  assert.equal(install._backfillEconomyDefault(stateDir), 'backfilled');
  assert.equal(readCfg(stateDir).agents.economy, 'ultra');
  assert.equal(readCfg(stateDir).agents.research, true); // siblings preserved
});

test('backfill: a config with no agents block gets one created with ultra', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local' });

  assert.equal(install._backfillEconomyDefault(stateDir), 'backfilled');
  assert.equal(readCfg(stateDir).agents.economy, 'ultra');
});

test('backfill: an explicit agents.economy is NEVER overwritten', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  for (const mode of ['off', 'lite', 'full', 'ultra']) {
    writeCfg(stateDir, { agents: { economy: mode } });
    assert.equal(install._backfillEconomyDefault(stateDir), 'preserved');
    assert.equal(readCfg(stateDir).agents.economy, mode);
  }
});

test('backfill: a legacy agents.economy_critic is treated as deliberate and preserved', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { agents: { economy_critic: false } });

  assert.equal(install._backfillEconomyDefault(stateDir), 'preserved');
  const cfg = readCfg(stateDir);
  assert.equal(cfg.agents.economy_critic, false);
  assert.equal(cfg.agents.economy, undefined);
});

test('backfill: dryRun reports the action without writing', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeCfg(stateDir, { scope: 'local' });

  assert.equal(install._backfillEconomyDefault(stateDir, { dryRun: true }), 'backfilled');
  assert.equal(readCfg(stateDir).agents, undefined); // not written
});

test('backfill: missing or unparseable config is a safe no-op', (t) => {
  const { root, stateDir } = mkStateDir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  assert.equal(install._backfillEconomyDefault(stateDir), 'absent');
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{ not json');
  assert.equal(install._backfillEconomyDefault(stateDir), 'unparseable');
});
