#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectStateDir, NubosPilotError } = require('./lib/core.cjs');
const { getPhase } = require('./lib/roadmap.cjs');
const { paddedPhase, phaseSlug, findPhaseDir } = require('./lib/phase.cjs');
const { parsePlan, listPlans } = require('./lib/plan.cjs');
const { loadTaskGraph } = require('./lib/tasks.cjs');
const { COMMANDS } = require('./bin/np-tools/_commands.cjs');

const initWorkflows = {
  'plan-phase':          require('./bin/np-tools/plan-phase.cjs'),
  'discuss-phase':       require('./bin/np-tools/discuss-phase.cjs'),
  'discuss-phase-power': require('./bin/np-tools/discuss-phase-power.cjs'),
  'research-phase':      require('./bin/np-tools/research-phase.cjs'),
  'new-project':         require('./bin/np-tools/new-project.cjs'),
  'new-milestone':       require('./bin/np-tools/new-milestone.cjs'),
  'plan-milestone-gaps': require('./bin/np-tools/plan-milestone-gaps.cjs'),

  'execute-phase':       require('./bin/np-tools/execute-phase.cjs'),
  'execute-plan':        require('./bin/np-tools/execute-plan.cjs'),
  'autonomous':          require('./bin/np-tools/autonomous.cjs'),
  'verify-work':         require('./bin/np-tools/verify-work.cjs'),
  'add-tests':           require('./bin/np-tools/add-tests.cjs'),
  'pause-work':          require('./bin/np-tools/pause-work.cjs'),
  'resume-work':         require('./bin/np-tools/resume-work.cjs'),

  'ai-integration-phase': require('./bin/np-tools/ai-integration-phase.cjs'),
  'ui-phase':             require('./bin/np-tools/ui-phase.cjs'),
  'ui-review':            require('./bin/np-tools/ui-review.cjs'),
  'eval-review':          require('./bin/np-tools/eval-review.cjs'),

  'code-review':          require('./bin/np-tools/code-review.cjs'),

  'add-todo':             require('./bin/np-tools/add-todo.cjs'),
};

const topLevelCommands = {
  'agent-skills': require('./bin/np-tools/agent-skills.cjs'),

  'commit-task':  require('./bin/np-tools/commit-task.cjs'),
  'checkpoint':   require('./bin/np-tools/checkpoint.cjs'),

  'undo':         require('./bin/np-tools/undo.cjs'),
  'undo-task':    require('./bin/np-tools/undo-task.cjs'),
  'reset-slice':  require('./bin/np-tools/reset-slice.cjs'),
  'skip':         require('./bin/np-tools/skip.cjs'),
  'park':         require('./bin/np-tools/park.cjs'),
  'unpark':       require('./bin/np-tools/unpark.cjs'),
  'askuser':        require('./bin/np-tools/askuser.cjs'),
  'commit':         require('./bin/np-tools/commit.cjs'),
  'config-get':     require('./bin/np-tools/config.cjs'),
  'dispatch':       require('./bin/np-tools/dispatch.cjs'),
  'doctor':         require('./bin/np-tools/doctor.cjs'),
  'generate-slug':  require('./bin/np-tools/slug.cjs'),
  'metrics':        require('./bin/np-tools/metrics.cjs'),
  'phase':          require('./bin/np-tools/phase.cjs'),
  'plan-diff':      require('./bin/np-tools/plan-diff.cjs'),
  'queue':          require('./bin/np-tools/queue.cjs'),
  'resolve-model':  require('./bin/np-tools/resolve-model.cjs'),
  'stats':          require('./bin/np-tools/stats.cjs'),
  'triage':         require('./bin/np-tools/triage.cjs'),
};

const THRESHOLD = 16 * 1024;

function _resolveStateDir(cwd) {
  try {
    return projectStateDir(cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') {
      const boot = path.join(path.resolve(cwd), '.planning');
      if (fs.existsSync(boot)) return boot;
    }
    throw err;
  }
}

function _resolvePhaseDir(n, cwd) {
  try {
    const hit = findPhaseDir(n, cwd);
    if (hit) return hit;
  } catch (err) {
    if (!err || err.code !== 'not-in-project') throw err;
  }
  const padded = paddedPhase(n);
  const stateDir = _resolveStateDir(cwd);
  const phasesRoot = path.join(stateDir, 'phases');
  let entries;
  try {
    entries = fs.readdirSync(phasesRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const matches = entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name === padded || e.name.startsWith(padded + '-'))
    .map((e) => e.name)
    .sort((a, b) => b.length - a.length);
  if (matches.length === 0) return null;
  return path.join(phasesRoot, matches[0]);
}

function _sanitizeLabel(s) {
  return String(s).replace(/[^a-zA-Z0-9-]/g, '_');
}

function emit(payload, _stdout, _cwd) {
  const stdout = _stdout || process.stdout;
  const cwd = _cwd || process.cwd();
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf-8') <= THRESHOLD) {
    stdout.write(json);
    return;
  }
  const stateDir = _resolveStateDir(cwd);
  const tmpDir = path.join(stateDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const workflow = _sanitizeLabel(payload && payload._workflow ? payload._workflow : 'init');
  const suffix = process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(tmpDir, 'init-' + workflow + '-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, 'utf-8');
  stdout.write('@file:' + tmpPath);
}

function _makePhasePayload(n, cwd, workflowLabel) {
  const padded = paddedPhase(n);
  const phase = getPhase(n, cwd);
  const phase_dir = _resolvePhaseDir(n, cwd);
  const stateDir = _resolveStateDir(cwd);
  let has_context = false;
  let has_research = false;
  let has_plans = false;
  if (phase_dir) {
    has_context = fs.existsSync(path.join(phase_dir, padded + '-CONTEXT.md'));
    has_research = fs.existsSync(path.join(phase_dir, padded + '-RESEARCH.md'));
    has_plans = listPlans(phase_dir).length > 0;
  }
  return {
    _workflow: workflowLabel,
    phase_number: String(n),
    padded_phase: padded,
    phase_slug: phase_dir ? path.basename(phase_dir).slice(padded.length + 1) : phaseSlug(phase.name),
    phase_name: phase.name,
    phase_dir,
    phase_found: !!phase_dir,
    roadmap_path: path.join(stateDir, 'ROADMAP.md'),
    state_path: path.join(stateDir, 'STATE.md'),
    has_context,
    has_research,
    has_plans,
    goal: phase.goal,
    requirements: phase.requirements,
    success_criteria: phase.success_criteria,
  };
}

function composeInit(workflow, args, cwd) {
  const useCwd = cwd || process.cwd();
  switch (workflow) {
    case 'phase-op':
      return _makePhasePayload(args[0], useCwd, 'phase-op');
    case 'plan-phase': {
      const base = _makePhasePayload(args[0], useCwd, 'plan-phase');
      if (base.phase_dir) {
        base.planned_plans = listPlans(base.phase_dir);
        base.context_path = base.has_context
          ? path.join(base.phase_dir, base.padded_phase + '-CONTEXT.md')
          : null;
        base.research_path = base.has_research
          ? path.join(base.phase_dir, base.padded_phase + '-RESEARCH.md')
          : null;
      } else {
        base.planned_plans = [];
        base.context_path = null;
        base.research_path = null;
      }
      return base;
    }
    case 'execute-phase': {
      const base = _makePhasePayload(args[0], useCwd, 'execute-phase');
      base.plans = [];
      if (base.phase_dir) {
        for (const planPath of listPlans(base.phase_dir)) {
          const parsed = parsePlan(planPath);
          const planDir = path.dirname(planPath);
          const tg = loadTaskGraph(planDir);
          base.plans.push({
            plan_path: planPath,
            plan_frontmatter: parsed.frontmatter,
            tasks_dir: path.join(planDir, 'tasks'),
            task_count: tg.tasks.length,
            waves: tg.waves,
            warnings: tg.warnings,
          });
        }
      }
      return base;
    }
    default: {
      if (args[0]) {
        try {
          return _makePhasePayload(args[0], useCwd, workflow);
        } catch (err) {
          if (err && err.code === 'phase-not-found') {
            return { _workflow: workflow, phase_found: false, phase_number: String(args[0]) };
          }
          throw err;
        }
      }
      return { _workflow: workflow, phase_found: false };
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  try {
    const cmd = args[0];
    let payload;
    switch (cmd) {
      case 'init': {
        const wf = args[1];

        

        
        if (wf && Object.prototype.hasOwnProperty.call(initWorkflows, wf)) {
          const rc = initWorkflows[wf].run(args.slice(2));
          if (rc && typeof rc.then === 'function') {
            rc.then((code) => {
              if (typeof code === 'number' && code !== 0) process.exit(code);
            }).catch((err) => {
              process.stderr.write(String((err && err.stack) || err) + '\n');
              process.exit(1);
            });
          } else if (typeof rc === 'number' && rc !== 0) {
            process.exit(rc);
          }
          return;
        }
        payload = composeInit(wf, args.slice(2));
        break;
      }
      case 'next':
        payload = require('./bin/np-tools/next.cjs').run(args.slice(1));
        break;
      case 'progress':
        payload = require('./bin/np-tools/progress.cjs').run(args.slice(1));
        break;
      case 'state':
        payload = require('./bin/np-tools/state.cjs').run(args.slice(1));
        break;
      case 'help':
        payload = require('./bin/np-tools/help.cjs').run(args.slice(1));
        break;
      default: {

        
        if (cmd && Object.prototype.hasOwnProperty.call(topLevelCommands, cmd)) {
          const rc = topLevelCommands[cmd].run(args.slice(1));
          if (rc && typeof rc.then === 'function') {
            rc.then((code) => {
              if (typeof code === 'number' && code !== 0) process.exit(code);
            }).catch((err) => {
              process.stderr.write(String((err && err.stack) || err) + '\n');
              process.exit(1);
            });
          } else if (typeof rc === 'number' && rc !== 0) {
            process.exit(rc);
          }
          return;
        }
        throw new NubosPilotError(
          'unknown-command',
          'Unknown command: ' + cmd,
          { cmd },
        );
      }
    }
    emit(payload);
  } catch (err) {
    const code = (err && err.code) || 'init-internal-error';
    const message = (err && err.message) || String(err);
    const details = (err && err.details) || null;
    fs.writeSync(2, JSON.stringify({ error: { code, message, details } }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  composeInit,
  emit,
  _makePhasePayload,
  main,
  COMMANDS,
  initWorkflows,
  topLevelCommands,
};
