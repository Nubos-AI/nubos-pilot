'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const registryMod = require('./runtimes-registry.cjs');

function _hashFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function _hashString(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function _listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort();
}

function _listSkillDirs(skillsRoot) {
  if (!skillsRoot || !fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

function _walkFiles(dir) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(dir, rel) : dir;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  }
  return out.sort();
}

function _payloadBase(scope, projectRoot) {
  return scope === 'global' ? os.homedir() : projectRoot;
}

function _toPosix(p) {
  return p.split(path.sep).join('/');
}

function planRuntimeAssets({ selectedRuntimes, scope, projectRoot, workflowsDir, agentsDir, skillsDir }) {
  const base = _payloadBase(scope, projectRoot);
  const workflows = _listMarkdown(workflowsDir);
  const agents = _listMarkdown(agentsDir);
  const skills = _listSkillDirs(skillsDir);
  const plans = [];
  for (const id of selectedRuntimes || []) {
    const meta = registryMod.getRuntimeMeta(id);
    if (!meta) continue;
    const configDir = registryMod.runtimeConfigDir(meta, scope, projectRoot);
    if (meta.commandsSubdir) {
      for (const file of workflows) {
        const targetFile = path.join(configDir, meta.commandsSubdir, file);
        plans.push({
          runtime: id,
          kind: 'command',
          sourceFile: path.join(workflowsDir, file),
          targetFile,
          manifestKey: _toPosix(path.relative(base, targetFile)),
        });
      }
    }
    if (meta.agentsSubdir) {
      for (const file of agents) {
        const sourceFile = path.join(agentsDir, file);
        // Most runtimes read the agent Markdown as-is. Codex needs a TOML
        // definition, so it is rendered rather than copied.
        const rendered = meta.agentFormat === 'codex-toml'
          ? require('./codex-agents.cjs').renderAgentToml({
            sourceFile,
            content: fs.readFileSync(sourceFile, 'utf8'),
          })
          : null;
        const targetFile = rendered
          ? path.join(configDir, meta.agentsSubdir, rendered.name + '.toml')
          : path.join(configDir, meta.agentsSubdir, file);
        plans.push({
          runtime: id,
          kind: 'agent',
          sourceFile,
          targetFile,
          ...(rendered ? { content: rendered.content, deliveredAs: 'codex-toml' } : {}),
          manifestKey: _toPosix(path.relative(base, targetFile)),
        });
      }
    }
    if (meta.skillsSubdir && skillsDir) {
      for (const skill of skills) {
        const skillSrcDir = path.join(skillsDir, skill);
        for (const rel of _walkFiles(skillSrcDir)) {
          const sourceFile = path.join(skillSrcDir, rel);
          const targetFile = path.join(configDir, meta.skillsSubdir, skill, rel);
          plans.push({
            runtime: id,
            kind: 'skill',
            skillName: skill,
            sourceFile,
            targetFile,
            manifestKey: _toPosix(path.relative(base, targetFile)),
          });
        }
      }
    }
    if (meta.deliverAsSkills && meta.skillsSubdir) {
      plans.push(..._planSkillDelivery({ meta, id, configDir, base, workflowsDir, workflows }));
    }
  }
  _assertNoTargetCollision(plans);
  return plans;
}

// Runtimes with no command directory get the workflows as skills. The rendered
// content — not the source file — is what lands on disk, so plans carry
// `content` and the manifest hashes that; otherwise a change to the renderer
// would leave every installed skill looking up-to-date.
function _planSkillDelivery({ meta, id, configDir, base, workflowsDir, workflows }) {
  const codexSkills = require('./codex-skills.cjs');
  const prefix = meta.deliverAsSkills.prefix || '';
  const out = [];
  const sources = [];
  if (meta.deliverAsSkills.commands && workflowsDir) {
    for (const file of workflows) {
      sources.push({ kind: 'command', dir: workflowsDir, file, render: codexSkills.renderWorkflowSkill });
    }
  }
  for (const src of sources) {
    const sourceFile = path.join(src.dir, src.file);
    const rendered = src.render({
      sourceFile,
      content: fs.readFileSync(sourceFile, 'utf8'),
      prefix,
    });
    const targetFile = path.join(configDir, meta.skillsSubdir, rendered.name, 'SKILL.md');
    out.push({
      runtime: id,
      kind: src.kind,
      deliveredAs: 'skill',
      skillName: rendered.name,
      sourceFile,
      targetFile,
      content: rendered.content,
      manifestKey: _toPosix(path.relative(base, targetFile)),
    });
  }
  return out;
}

// Workflow, agent and packaged-skill names share one flat namespace once they
// are all delivered as skills. A silent overwrite would install one and lose
// the other, and the survivor depends on plan order — so refuse instead.
function _assertNoTargetCollision(plans) {
  const seen = new Map();
  for (const plan of plans) {
    const prev = seen.get(plan.manifestKey);
    if (prev && prev.sourceFile !== plan.sourceFile) {
      const { NubosPilotError } = require('../core.cjs');
      throw new NubosPilotError(
        'runtime-asset-name-collision',
        'Two sources target ' + plan.manifestKey,
        { target: plan.manifestKey, sources: [prev.sourceFile, plan.sourceFile] },
      );
    }
    seen.set(plan.manifestKey, plan);
  }
}

function manifestEntriesForPlans(plans) {
  const entries = Object.create(null);
  for (const plan of plans) {
    entries[plan.manifestKey] = typeof plan.content === 'string'
      ? _hashString(plan.content)
      : _hashFile(plan.sourceFile);
  }
  return entries;
}

function writeRuntimeAssets(plans) {
  const written = [];
  for (const plan of plans) {
    fs.mkdirSync(path.dirname(plan.targetFile), { recursive: true });
    if (typeof plan.content === 'string') fs.writeFileSync(plan.targetFile, plan.content);
    else fs.copyFileSync(plan.sourceFile, plan.targetFile);
    written.push(plan.targetFile);
  }
  return written;
}

function removeStaleAssets(staleKeys, scope, projectRoot) {
  const base = _payloadBase(scope, projectRoot);
  const removed = [];
  const dirs = new Set();
  for (const key of staleKeys || []) {
    if (!_isAssetKey(key)) continue;
    const abs = path.join(base, key);
    try {
      fs.unlinkSync(abs);
      removed.push(abs);
      dirs.add(path.dirname(abs));
    } catch {}
  }
  _pruneEmptyDirs(dirs, base);
  return removed;
}

function _isAssetKey(key) {
  if (typeof key !== 'string') return false;
  if (key.startsWith('~/')) return true;
  if (key.startsWith('.')) {
    if (key.startsWith('.claude/commands/')) return true;
    if (key.startsWith('.claude/agents/')) return true;
    if (key.startsWith('.claude/skills/')) return true;
    for (const meta of registryMod.RUNTIMES) {
      const ld = meta.localDir === '.' ? '' : meta.localDir + '/';
      if (meta.commandsSubdir) {
        if (key.startsWith(ld + meta.commandsSubdir + '/')) return true;
      }
      if (meta.agentsSubdir) {
        if (key.startsWith(ld + meta.agentsSubdir + '/')) return true;
      }
      if (meta.skillsSubdir) {
        if (key.startsWith(ld + meta.skillsSubdir + '/')) return true;
      }
    }
  }
  return false;
}

function _pruneEmptyDirs(dirSet, base) {
  const sorted = Array.from(dirSet).sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    let cur = dir;
    while (cur && cur.startsWith(base) && cur !== base) {
      try {
        const entries = fs.readdirSync(cur);
        if (entries.length > 0) break;
        fs.rmdirSync(cur);
      } catch { break; }
      cur = path.dirname(cur);
    }
  }
}

function isAssetManifestKey(key) {
  return _isAssetKey(key);
}

module.exports = {
  planRuntimeAssets,
  manifestEntriesForPlans,
  writeRuntimeAssets,
  removeStaleAssets,
  isAssetManifestKey,
};
