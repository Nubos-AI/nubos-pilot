'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeAssets = require('./runtime-assets.cjs');

function _mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function _seedSource(root) {
  const workflowsDir = path.join(root, 'workflows');
  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'np-council'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'np-shadcn', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'np-shadcn', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, '.draft'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'np-incomplete'), { recursive: true });

  fs.writeFileSync(path.join(workflowsDir, 'execute-phase.md'), '# wf');
  fs.writeFileSync(path.join(agentsDir, 'np-executor.md'), '# agent');
  fs.writeFileSync(path.join(skillsDir, 'np-council', 'SKILL.md'), '# council');
  fs.writeFileSync(path.join(skillsDir, 'np-shadcn', 'SKILL.md'), '# shadcn');
  fs.writeFileSync(path.join(skillsDir, 'np-shadcn', 'rules', 'react.md'), '# rules');
  fs.writeFileSync(path.join(skillsDir, 'np-shadcn', 'assets', 'preset.json'), '{}');
  fs.writeFileSync(path.join(skillsDir, '.draft', 'SKILL.md'), '# hidden');
  fs.writeFileSync(path.join(skillsDir, 'np-incomplete', 'README.md'), '# no skill md');

  return { workflowsDir, agentsDir, skillsDir };
}

test('planRuntimeAssets: discovers skills automatically and skips invalid dirs', () => {
  const root = _mkTmp('np-skills-plan-');
  try {
    const { workflowsDir, agentsDir, skillsDir } = _seedSource(root);
    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });

    const plans = runtimeAssets.planRuntimeAssets({
      selectedRuntimes: ['claude'],
      scope: 'local',
      projectRoot,
      workflowsDir,
      agentsDir,
      skillsDir,
    });

    const skills = plans.filter((p) => p.kind === 'skill');
    const skillNames = new Set(skills.map((p) => p.skillName));
    assert.deepStrictEqual([...skillNames].sort(), ['np-council', 'np-shadcn'],
      'only directories with SKILL.md and no leading dot are taken');

    const shadcnFiles = skills
      .filter((p) => p.skillName === 'np-shadcn')
      .map((p) => p.manifestKey)
      .sort();
    assert.deepStrictEqual(shadcnFiles, [
      '.claude/skills/np-shadcn/SKILL.md',
      '.claude/skills/np-shadcn/assets/preset.json',
      '.claude/skills/np-shadcn/rules/react.md',
    ], 'walk yields nested files with posix manifest keys');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planRuntimeAssets: skips skills for runtimes without skillsSubdir', () => {
  const root = _mkTmp('np-skills-skip-');
  try {
    const { workflowsDir, agentsDir, skillsDir } = _seedSource(root);
    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });

    const plans = runtimeAssets.planRuntimeAssets({
      selectedRuntimes: ['codex', 'gemini', 'cursor'],
      scope: 'local',
      projectRoot,
      workflowsDir,
      agentsDir,
      skillsDir,
    });

    assert.strictEqual(plans.filter((p) => p.kind === 'skill').length, 0,
      'no skill plans for runtimes without skillsSubdir');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRuntimeAssets: copies nested skill files into runtime config dir', () => {
  const root = _mkTmp('np-skills-write-');
  try {
    const { workflowsDir, agentsDir, skillsDir } = _seedSource(root);
    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });

    const plans = runtimeAssets.planRuntimeAssets({
      selectedRuntimes: ['claude'],
      scope: 'local',
      projectRoot,
      workflowsDir,
      agentsDir,
      skillsDir,
    });
    runtimeAssets.writeRuntimeAssets(plans);

    assert.ok(fs.existsSync(path.join(projectRoot, '.claude/skills/np-council/SKILL.md')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude/skills/np-shadcn/SKILL.md')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude/skills/np-shadcn/rules/react.md')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude/skills/np-shadcn/assets/preset.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manifestEntriesForPlans: hashes every skill file', () => {
  const root = _mkTmp('np-skills-hash-');
  try {
    const { workflowsDir, agentsDir, skillsDir } = _seedSource(root);
    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });

    const plans = runtimeAssets.planRuntimeAssets({
      selectedRuntimes: ['claude'],
      scope: 'local',
      projectRoot,
      workflowsDir,
      agentsDir,
      skillsDir,
    });
    const entries = runtimeAssets.manifestEntriesForPlans(plans);
    const skillKeys = Object.keys(entries).filter((k) => k.includes('/skills/'));

    assert.ok(skillKeys.length >= 4, 'each nested skill file gets its own manifest key');
    for (const k of skillKeys) {
      assert.match(entries[k], /^[a-f0-9]{64}$/, k + ' has sha256 hash');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isAssetManifestKey: recognises skill paths for all runtimes that opted in', () => {
  assert.strictEqual(runtimeAssets.isAssetManifestKey('.claude/skills/np-council/SKILL.md'), true);
  assert.strictEqual(runtimeAssets.isAssetManifestKey('.claude/skills/np-shadcn/rules/react.md'), true);
  assert.strictEqual(runtimeAssets.isAssetManifestKey('~/.claude/skills/np-council/SKILL.md'), true);
  assert.strictEqual(runtimeAssets.isAssetManifestKey('.codex/skills/np-council/SKILL.md'), false,
    'codex did not opt into skills');
  assert.strictEqual(runtimeAssets.isAssetManifestKey('.claude/nubos-pilot/state.json'), false);
});

test('removeStaleAssets: deletes nested skill files and prunes empty dirs', () => {
  const root = _mkTmp('np-skills-stale-');
  try {
    const { workflowsDir, agentsDir, skillsDir } = _seedSource(root);
    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });

    const plans = runtimeAssets.planRuntimeAssets({
      selectedRuntimes: ['claude'],
      scope: 'local',
      projectRoot,
      workflowsDir,
      agentsDir,
      skillsDir,
    });
    runtimeAssets.writeRuntimeAssets(plans);

    const stale = [
      '.claude/skills/np-shadcn/SKILL.md',
      '.claude/skills/np-shadcn/rules/react.md',
      '.claude/skills/np-shadcn/assets/preset.json',
    ];
    runtimeAssets.removeStaleAssets(stale, 'local', projectRoot);

    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.claude/skills/np-shadcn')), false,
      'empty skill directory tree pruned');
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.claude/skills/np-council/SKILL.md')), true,
      'untouched skills remain');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
