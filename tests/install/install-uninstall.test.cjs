const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'bin', 'install.js');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

// Snapshot every path under root with its bytes, so a dry-run can be asserted
// write-free at the FILESYSTEM level rather than at the parser boundary.
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) { out.set(rel + '/', 'dir'); walk(full); }
      else if (e.isFile()) out.set(rel, fs.readFileSync(full, 'utf-8'));
      else out.set(rel, 'other');
    }
  };
  walk(root);
  return out;
}

function diffTrees(before, after) {
  const changes = [];
  for (const [k, v] of after) {
    if (!before.has(k)) changes.push('created: ' + k);
    else if (before.get(k) !== v) changes.push('modified: ' + k);
  }
  for (const k of before.keys()) if (!after.has(k)) changes.push('deleted: ' + k);
  return changes.sort();
}

async function seedInstall(root) {
  const install = require('../../bin/install.js');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'], agent: 'claude', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });
}

test('install-uninstall: removes manifest-tracked files, strips managed blocks, leaves .bak files (D-20)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'a.md'), 'payload a');
  fs.writeFileSync(path.join(payloadDir, 'b.md'), 'payload b');
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '1.0.0',
    timestamp: '2026-04-16T00:00:00Z',
    files: { 'a.md': 'aa', 'b.md': 'bb' },
  }));

  const claude = [
    '# My Project',
    '',
    '<!-- nubos-pilot:begin v1 -->',
    'managed content',
    '<!-- nubos-pilot:end -->',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), claude);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), claude);

  fs.writeFileSync(path.join(payloadDir, 'a.md.bak'), 'prior user version');

  await install.runUninstall({ cwd: root });

  assert.ok(!fs.existsSync(path.join(payloadDir, 'a.md')), 'manifest-tracked a.md removed');
  assert.ok(!fs.existsSync(path.join(payloadDir, 'b.md')), 'manifest-tracked b.md removed');
  assert.ok(!fs.existsSync(path.join(payloadDir, '.manifest.json')), 'manifest self-destruct');

  assert.ok(fs.existsSync(path.join(payloadDir, 'a.md.bak')),
    '.bak files must be left untouched');

  const claudeAfter = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  const agentsAfter = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
  assert.ok(!claudeAfter.includes('nubos-pilot:begin'), 'CLAUDE.md managed block stripped');
  assert.ok(!agentsAfter.includes('nubos-pilot:begin'), 'AGENTS.md managed block stripped');
  assert.ok(claudeAfter.includes('# My Project'), 'user content preserved in CLAUDE.md');
});

test('install-uninstall: OpenCode uninstall is surgical — removes .opencode/nubos-pilot/ only, user content in .opencode/ survives (8.1 D-02)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall-opencode-surgical');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\nname: test\n---\n# Test\n\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude', 'opencode'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.opencode', 'nubos-pilot', 'AGENTS.md')),
    'precondition: .opencode/nubos-pilot/AGENTS.md present after install');
  const userFile = path.join(root, '.opencode', 'user-owned.md');
  fs.writeFileSync(userFile, 'user-owned sibling in .opencode/');
  await install.runUninstall({ cwd: root });
  assert.ok(!fs.existsSync(path.join(root, '.opencode', 'nubos-pilot')),
    '.opencode/nubos-pilot/ must be removed on uninstall');
  assert.ok(fs.existsSync(userFile),
    'user-owned file in .opencode/ must survive uninstall (surgical scoping)');
  assert.equal(fs.readFileSync(userFile, 'utf-8'), 'user-owned sibling in .opencode/',
    'user content bytes unchanged');
  assert.ok(fs.existsSync(path.join(root, '.opencode')),
    '.opencode/ parent survives because user-owned sibling is non-empty');
});

test('install-uninstall: OpenCode parent .opencode/ is rmdir-ed when empty after uninstall (8.1 D-02)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall-opencode-empty-parent');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\nname: test\n---\n# Test\n\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['opencode'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.opencode', 'nubos-pilot')),
    'precondition: .opencode/nubos-pilot/ present after install');
  await install.runUninstall({ cwd: root });
  assert.ok(!fs.existsSync(path.join(root, '.opencode')),
    'empty .opencode/ parent must be rmdir-ed after uninstall');
});

// P2.5: _runUninstallLocked deleted the hook scripts but never called
// uninstallClaudeHooks, so 8 hook entries + statusLine kept pointing at deleted
// files and fired on every session. The shims were never in the manifest, so the
// unlink loop could not see them either.
test('install-uninstall: removes hook registrations and bin shims (P2.5)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall-hooks');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'], agent: 'claude', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });

  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  assert.ok(fs.existsSync(settingsPath), 'precondition: install registered hooks');
  const before = fs.readFileSync(settingsPath, 'utf-8');
  assert.match(before, /nubos/i, 'precondition: settings reference nubos hooks');
  const shim = path.join(root, '.nubos-pilot', 'bin', 'np-tools.cjs');
  assert.ok(fs.existsSync(shim), 'precondition: shim written');

  await install.runUninstall({ cwd: root });

  const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : '';
  assert.ok(!/nubos-pilot\/hooks/.test(after),
    'no hook registration may still point at the deleted scripts');
  assert.ok(!fs.existsSync(shim), 'the np-tools shim must be removed');
});

// D1 (data loss): `uninstall` was the ONLY subcommand whose dispatch dropped
// flags.dryRun on the floor. parseInstallFlags accepted --dry-run (so no error
// surfaced) and the real, destructive uninstall ran anyway. The parser-level
// tests could not see it: they only ever asserted parseInstallFlags' return
// value, never whether the flag reached the consumer. This test runs the CLI and
// diffs the whole tree.
test('install-uninstall: `uninstall --dry-run` touches nothing on disk (D1)', async (t) => {
  const root = mkTmp('uninstall-dryrun');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  await seedInstall(root);

  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  assert.ok(fs.readdirSync(payloadDir).length > 0, 'precondition: payload installed');
  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')), 'precondition: CLAUDE.md present');
  assert.ok(fs.existsSync(path.join(root, '.nubos-pilot', 'bin', 'np-tools.cjs')),
    'precondition: shim present');

  const before = snapshotTree(root);
  const out = execFileSync(process.execPath, [CLI, 'uninstall', '--dry-run'], {
    cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const after = snapshotTree(root);

  assert.match(out, /"dryRun":\s*true/, 'must report a dry-run summary');
  assert.deepEqual(diffTrees(before, after), [],
    'a dry-run uninstall must not create, modify or delete ANY path');
});

test('install-uninstall: `uninstall --dry-run` reports what it would remove (D1)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall-dryrun-plan');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  await seedInstall(root);

  const res = await install.runUninstall({ cwd: root, dryRun: true });
  assert.equal(res.dryRun, true, 'result must be flagged as a preview');
  assert.equal(res.uninstalled, false, 'a preview must never claim it uninstalled');
  assert.ok(Array.isArray(res.wouldRemove) && res.wouldRemove.length > 0,
    'the preview must list the paths a real uninstall would remove');
  assert.ok(res.wouldRemove.some((e) => /np-tools\.cjs/.test(e)),
    'the plan must include the bin shims');
  assert.ok(res.wouldRemove.some((e) => /CLAUDE\.md/.test(e)),
    'the plan must include the managed-markdown edit');

  // The real thing still works after a preview.
  const real = await install.runUninstall({ cwd: root });
  assert.equal(real.uninstalled, true);
  assert.ok(!fs.existsSync(path.join(root, '.nubos-pilot', 'bin', 'np-tools.cjs')));
});

test('install-uninstall: `uninstall bogus` is rejected instead of silently uninstalling (D1)', async (t) => {
  const root = mkTmp('uninstall-extra-args');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  await seedInstall(root);
  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  const before = snapshotTree(root);

  assert.throws(() => {
    execFileSync(process.execPath, [CLI, 'uninstall', 'bogus'], {
      cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, /./, 'an unknown positional must fail loudly, not uninstall for real');

  assert.deepEqual(diffTrees(before, snapshotTree(root)), [],
    'a rejected command must not have uninstalled anything');
  assert.ok(fs.readdirSync(payloadDir).length > 0, 'payload survives');
});

// The defect class, not the instance: a flag the parser accepts but the
// subcommand never reads is the trap. Every flag must either reach a consumer or
// be rejected for that subcommand.
test('install-uninstall: flags uninstall cannot honour are rejected, not swallowed (D1 class)', async (t) => {
  const root = mkTmp('uninstall-flag-class');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  await seedInstall(root);
  const before = snapshotTree(root);

  for (const arg of ['--agent=gemini', '--agents=claude,codex', '--all', '--scope=global', '--yes']) {
    assert.throws(() => {
      execFileSync(process.execPath, [CLI, 'uninstall', arg], {
        cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    }, /./, 'uninstall must reject ' + arg + ' rather than accept and ignore it');
  }
  assert.deepEqual(diffTrees(before, snapshotTree(root)), [],
    'no rejected invocation may have uninstalled anything');
});

// Same class, different subcommand: parseInstallFlags eats --scope before
// runInstallHooks' own parser sees it, and the dispatch never forwarded
// flags.scope — so `install-hooks --scope=global` silently wrote local.
test('install-uninstall: `install-hooks --scope=global` reaches the consumer (D1 class)', async (t) => {
  const install = require('../../bin/install.js');
  const seedRoot = mkTmp('hooks-scope-seed');
  const root = mkTmp('hooks-scope');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'np-home-'));
  t.after(() => { try { fs.rmSync(seedRoot, { recursive: true, force: true }); } catch {} });
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  t.after(() => { try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });

  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  });

  // Global payload in $HOME. `root` is a fresh project with no config.json, so
  // scope can ONLY come from the flag — if the dispatch swallows it (the defect),
  // the fallback is 'local' and the command fails on a missing project payload.
  await install.runInstall({
    cwd: seedRoot,
    mode: 'init',
    flags: { agents: ['claude'], agent: 'claude', scope: 'global', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });
  fs.rmSync(path.join(fakeHome, '.claude', 'settings.json'), { force: true });
  assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'nubos-pilot', 'hooks')),
    'precondition: global payload installed in $HOME');

  execFileSync(process.execPath, [CLI, 'install-hooks', '--scope=global'], {
    cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: fakeHome },
  });

  assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')),
    '--scope=global must register hooks in $HOME, not in the project');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.local.json')),
    '--scope=global must NOT write the project-local settings file');
});
