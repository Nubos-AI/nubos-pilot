#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectStateDir, NubosPilotError } = require('./lib/core.cjs');
const { COMMANDS } = require('./bin/np-tools/_commands.cjs');

const initWorkflows = {
  'plan-milestone':      require('./bin/np-tools/plan-milestone.cjs'),
  'discuss-phase':       require('./bin/np-tools/discuss-phase.cjs'),
  'research-phase':      require('./bin/np-tools/research-phase.cjs'),
  'new-project':         require('./bin/np-tools/new-project.cjs'),
  'discuss-project':     require('./bin/np-tools/discuss-project.cjs'),
  'new-milestone':       require('./bin/np-tools/new-milestone.cjs'),

  'execute-milestone':   require('./bin/np-tools/execute-milestone.cjs'),
  'verify-work':         require('./bin/np-tools/verify-work.cjs'),
  'add-tests':           require('./bin/np-tools/add-tests.cjs'),
  'pause-work':          require('./bin/np-tools/pause-work.cjs'),
  'resume-work':         require('./bin/np-tools/resume-work.cjs'),

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
  'scan-codebase':  require('./bin/np-tools/scan-codebase.cjs'),
  'update-docs':    require('./bin/np-tools/update-docs.cjs'),
  'doctor':         require('./bin/np-tools/doctor.cjs'),
  'generate-slug':  require('./bin/np-tools/slug.cjs'),
  'metrics':        require('./bin/np-tools/metrics.cjs'),
  'resolve-model':  require('./bin/np-tools/resolve-model.cjs'),
  'stats':          require('./bin/np-tools/stats.cjs'),
  'lang-directive': require('./bin/np-tools/lang-directive.cjs'),
  'text-mode':      require('./bin/np-tools/text-mode.cjs'),
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
  emit,
  main,
  COMMANDS,
  initWorkflows,
  topLevelCommands,
};
