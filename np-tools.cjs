#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectStateDir, installSignalCleanup, NubosPilotError } = require('./lib/core.cjs');
const { COMMANDS } = require('./bin/np-tools/_commands.cjs');

const initWorkflows = {
  'plan-milestone':      require('./bin/np-tools/plan-milestone.cjs'),
  'discuss-phase':       require('./bin/np-tools/discuss-phase.cjs'),
  'research-phase':      require('./bin/np-tools/research-phase.cjs'),
  'new-project':         require('./bin/np-tools/new-project.cjs'),
  'discuss-project':     require('./bin/np-tools/discuss-project.cjs'),
  'new-milestone':       require('./bin/np-tools/new-milestone.cjs'),
  'propose-milestones':  require('./bin/np-tools/propose-milestones.cjs'),

  'execute-milestone':   require('./bin/np-tools/execute-milestone.cjs'),
  'verify-work':         require('./bin/np-tools/verify-work.cjs'),
  'close-project':       require('./bin/np-tools/close-project.cjs'),
  'add-tests':           require('./bin/np-tools/add-tests.cjs'),
  'pause-work':          require('./bin/np-tools/pause-work.cjs'),
  'resume-work':         require('./bin/np-tools/resume-work.cjs'),

  'add-todo':             require('./bin/np-tools/add-todo.cjs'),
};

const topLevelCommands = {
  'agent-skills': require('./bin/np-tools/agent-skills.cjs'),
  'derive-tier':  require('./bin/np-tools/derive-tier.cjs'),
  'verify-reliability': require('./bin/np-tools/verify-reliability.cjs'),
  'task-verify-cmd': require('./bin/np-tools/task-verify-cmd.cjs'),
  'learnings':    require('./bin/np-tools/learnings.cjs'),
  'skill-audit':  require('./bin/np-tools/skill-audit.cjs'),

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
  'economy-mode':   require('./bin/np-tools/economy-mode.cjs'),
  'scan-codebase':  require('./bin/np-tools/scan-codebase.cjs'),
  'update-docs':    require('./bin/np-tools/update-docs.cjs'),
  'graph-impact':   require('./bin/np-tools/graph-impact.cjs'),
  'doctor':         require('./bin/np-tools/doctor.cjs'),
  'generate-slug':  require('./bin/np-tools/slug.cjs'),
  'metrics':        require('./bin/np-tools/metrics.cjs'),
  'resolve-model':  require('./bin/np-tools/resolve-model.cjs'),
  'stats':          require('./bin/np-tools/stats.cjs'),
  'rollup':         require('./bin/np-tools/rollup.cjs'),
  'lang-directive': require('./bin/np-tools/lang-directive.cjs'),
  'text-mode':      require('./bin/np-tools/text-mode.cjs'),
  'detect-runtime': require('./bin/np-tools/detect-runtime.cjs'),
  'detect-stack': require('./bin/np-tools/detect-stack.cjs'),
  'template-path':  require('./bin/np-tools/template-path.cjs'),
  'update-phase-meta': require('./bin/np-tools/update-phase-meta.cjs'),
  'phase-meta':     require('./bin/np-tools/phase-meta.cjs'),
  'state-dir':      require('./bin/np-tools/state-dir.cjs'),
  'render-template': require('./bin/np-tools/render-template.cjs'),
  'render-todo':     require('./bin/np-tools/render-todo.cjs'),
  'handoff-write':   require('./bin/np-tools/handoff-write.cjs'),
  'handoff-read':    require('./bin/np-tools/handoff-read.cjs'),
  'handoff-list':    require('./bin/np-tools/handoff-list.cjs'),
  'handoff-status':  require('./bin/np-tools/handoff-status.cjs'),
  'messages-send':    require('./bin/np-tools/messages-send.cjs'),
  'messages-inbox':   require('./bin/np-tools/messages-inbox.cjs'),
  'messages-archive': require('./bin/np-tools/messages-archive.cjs'),
  'messages-thread':  require('./bin/np-tools/messages-thread.cjs'),
  'memory-index':     require('./bin/np-tools/memory-index.cjs'),
  'memory-query':     require('./bin/np-tools/memory-query.cjs'),
  'memory-add':       require('./bin/np-tools/memory-add.cjs'),
  'memory-rebuild':   require('./bin/np-tools/memory-rebuild.cjs'),
  'memory-stats':     require('./bin/np-tools/memory-stats.cjs'),
  'worktree-create':   require('./bin/np-tools/worktree-create.cjs'),
  'worktree-remove':   require('./bin/np-tools/worktree-remove.cjs'),
  'worktree-list':     require('./bin/np-tools/worktree-list.cjs'),
  'worktree-ff-merge': require('./bin/np-tools/worktree-ff-merge.cjs'),
  'dashboard':         require('./bin/np-tools/dashboard.cjs'),
  'simplify-debt':     require('./bin/np-tools/simplify-debt.cjs'),
  'archive-project':   require('./bin/np-tools/archive-project.cjs'),

  ...initWorkflows,

  'thread-resume':  require('./bin/np-tools/thread-resume.cjs'),
  'state-incr':     require('./bin/np-tools/state-incr.cjs'),
  'session-aggregate':     require('./bin/np-tools/session-aggregate.cjs'),
  'session-pointer-write': require('./bin/np-tools/session-pointer-write.cjs'),
  'workspace-scan': require('./bin/np-tools/workspace-scan.cjs'),
  'knowledge-index':  require('./bin/np-tools/knowledge-index.cjs'),
  'knowledge-search': require('./bin/np-tools/knowledge-search.cjs'),
  'knowledge-stats':  require('./bin/np-tools/knowledge-stats.cjs'),
  'elision-get':      require('./bin/np-tools/elision-get.cjs'),
  'elision-bench':    require('./bin/np-tools/elision-bench.cjs'),
  'context-stats':    require('./bin/np-tools/context-stats.cjs'),
  'session-snapshot-write': require('./bin/np-tools/session-snapshot-write.cjs'),
  'session-snapshot-read':  require('./bin/np-tools/session-snapshot-read.cjs'),

  'plan-lint':       require('./bin/np-tools/plan-lint.cjs'),
  'output-lint':     require('./bin/np-tools/output-lint.cjs'),
  'researcher-reconcile': require('./bin/np-tools/researcher-reconcile.cjs'),

  'loop-state-read':    require('./bin/np-tools/loop-state-read.cjs'),
  'loop-state-record':  require('./bin/np-tools/loop-state-record.cjs'),
  'loop-evaluate':       require('./bin/np-tools/loop-evaluate.cjs'),
  'loop-preflight':      require('./bin/np-tools/loop-preflight.cjs'),
  'loop-run-round':      require('./bin/np-tools/loop-run-round.cjs'),
  'loop-audit-tool-use': require('./bin/np-tools/loop-audit-tool-use.cjs'),
  'loop-stuck':          require('./bin/np-tools/loop-stuck.cjs'),
  'loop-metrics':       require('./bin/np-tools/loop-metrics.cjs'),
  'spawn-headless':     require('./bin/np-tools/spawn-headless.cjs'),
  'spawn-offhost':      require('./bin/np-tools/spawn-offhost.cjs'),
  'security':           require('./bin/np-tools/security.cjs'),
  'scan':               require('./bin/np-tools/scan.cjs'),
  'learning-log':      require('./bin/np-tools/learning-log.cjs'),
  'learning-match':    require('./bin/np-tools/learning-match.cjs'),
  'learning-list':     require('./bin/np-tools/learning-list.cjs'),
  'gate-candidates':   require('./bin/np-tools/gate-candidates.cjs'),
  'pressure-eval':     require('./bin/np-tools/pressure-eval.cjs'),
  'resume-doc':        require('./bin/np-tools/resume-doc.cjs'),
  'otlp-export':       require('./bin/np-tools/otlp-export.cjs'),
  'roadmap-graph':     require('./bin/np-tools/roadmap-graph.cjs'),
  'slice-plan':        require('./bin/np-tools/slice-plan.cjs'),
  'isolation':         require('./bin/np-tools/isolation.cjs'),
  'acp':               require('./bin/np-tools/acp.cjs'),
};

const THRESHOLD = 16 * 1024;

function _resolveStateDir(cwd) {
  return projectStateDir(cwd);
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

function _writeErrorEnvelope(err) {
  const code = (err && err.code) || 'internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  try {
    process.stderr.write(JSON.stringify({ error: { code, message, details } }) + '\n');
  } catch {
    try { process.stderr.write(String(message) + '\n'); } catch {}
  }
}

function handleRunResult(rc) {
  if (rc && typeof rc.then === 'function') {
    rc.then((code) => {
      if (typeof code === 'number' && code !== 0) process.exit(code);
    }).catch((err) => {
      _writeErrorEnvelope(err);
      process.exit(1);
    });
  } else if (typeof rc === 'number' && rc !== 0) {
    process.exit(rc);
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
        if (!wf || !Object.prototype.hasOwnProperty.call(initWorkflows, wf)) {
          throw new NubosPilotError(
            'unknown-init-workflow',
            'Unknown init workflow: ' + String(wf),
            { workflow: wf, available: Object.keys(initWorkflows) },
          );
        }
        handleRunResult(initWorkflows[wf].run(args.slice(2)));
        return;
      }
      case 'state':
        payload = require('./bin/np-tools/state.cjs').run(args.slice(1));
        break;
      case 'help': {
        const helpPayload = require('./bin/np-tools/help.cjs').run(args.slice(1));
        if (helpPayload && typeof helpPayload.text === 'string') {
          process.stdout.write(helpPayload.text);
          return;
        }
        payload = helpPayload;
        break;
      }
      default: {
        if (cmd && Object.prototype.hasOwnProperty.call(topLevelCommands, cmd)) {
          handleRunResult(topLevelCommands[cmd].run(args.slice(1)));
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

if (require.main === module) { installSignalCleanup(); main(); }

module.exports = {
  emit,
  main,
  COMMANDS,
  initWorkflows,
  topLevelCommands,
};
