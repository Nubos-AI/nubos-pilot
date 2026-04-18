const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const YAML = require('yaml');

const { scanVerifications, parseAuditFile } = require('../../lib/gaps.cjs');
const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function _parseFlags(args) {
  const flags = { from: null, insertAfter: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') {
      flags.from = args[++i];
    } else if (a === '--insert-after') {
      const raw = args[++i];
      const n = Number(raw);
      if (raw == null || !Number.isInteger(n)) {
        throw new NubosPilotError(
          'invalid-insert-after',
          '--insert-after requires an integer phase number',
          { value: raw == null ? '' : String(raw) },
        );
      }
      flags.insertAfter = n;
    }
  }
  return flags;
}

function _readMilestoneId(cwd) {

  
  try {
    const { readState } = require('../../lib/state.cjs');
    const st = readState(cwd);
    if (st && st.frontmatter && st.frontmatter.milestone) {
      return String(st.frontmatter.milestone);
    }
  } catch (_err) {  }
  let stateDir;
  try { stateDir = projectStateDir(cwd); } catch (_err) {
    stateDir = path.join(path.resolve(cwd), '.nubos-pilot');
  }
  const yamlPath = path.join(stateDir, 'roadmap.yaml');
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const doc = YAML.parse(raw);
  if (!doc || !Array.isArray(doc.milestones) || doc.milestones.length === 0) {
    throw new NubosPilotError(
      'gaps-no-milestone',
      'roadmap.yaml has no milestones',
      { path: yamlPath },
    );
  }
  return String(doc.milestones[0].id);
}

function _agentSkills() {
  try {
    const agents = require('../../lib/agents.cjs');
    if (typeof agents.getAgentSkills === 'function') {
      return { planner: agents.getAgentSkills('np-planner') };
    }
  } catch (_err) {  }
  return { planner: null };
}

function _emit(payload, stdout, cwd) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf-8') <= INLINE_THRESHOLD_BYTES) {
    stdout.write(json);
    return;
  }

  

  let tmpDir;
  try {
    tmpDir = path.join(projectStateDir(cwd), '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (_err) {
    tmpDir = os.tmpdir();
  }
  const suffix = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(tmpDir, 'init-plan-milestone-gaps-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const flags = _parseFlags(args || []);
  const milestoneId = _readMilestoneId(cwd);
  const mode = flags.from ? 'from-file' : 'scan';
  const gaps = flags.from
    ? parseAuditFile(flags.from, cwd)
    : scanVerifications(milestoneId, cwd);
  const payload = {
    _workflow: 'plan-milestone-gaps',
    milestoneId,
    mode,
    gaps,
    insertAfter: flags.insertAfter,
    agent_skills: _agentSkills(),
  };
  _emit(payload, stdout, cwd);
  return payload;
}

module.exports = { run, _parseFlags, INLINE_THRESHOLD_BYTES };
