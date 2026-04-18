const { renderTwoPartDiff, archiveRejected } = require('../../lib/plan-diff.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs plan-diff <phase> <plan-id>',
    '  np-tools.cjs plan-diff --archive-rejected <phase> <plan-id> --reason "<text>"',
  ].join('\n');
}

function run(argv) {
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(3);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stderr.write(_usage() + '\n');
    return 1;
  }
  try {
    if (args[0] === '--archive-rejected') {
      const phase = args[1];
      const planId = args[2];
      let reason = '';
      for (let i = 3; i < args.length; i++) {
        if (args[i] === '--reason') {
          reason = args[i + 1] == null ? '' : String(args[i + 1]);
        }
      }
      if (!phase || !planId) {
        process.stderr.write(_usage() + '\n');
        return 1;
      }
      const archivePath = archiveRejected({ phase, planId, reason, cwd: process.cwd() });
      process.stdout.write(archivePath + '\n');
      return 0;
    }
    const phase = args[0];
    const planId = args[1];
    if (!phase || !planId) {
      process.stderr.write(_usage() + '\n');
      return 1;
    }
    const result = renderTwoPartDiff({ phase, planId, cwd: process.cwd() });
    if (!result.hasPrior) return 0;
    process.stdout.write(result.combined + '\n');
    return 0;
  } catch (err) {
    if (err && err.name === 'NubosPilotError') {
      process.stderr.write(
        JSON.stringify({ code: err.code, message: err.message, details: err.details }) + '\n',
      );
    } else {
      process.stderr.write(String(err && err.stack || err) + '\n');
    }
    return 1;
  }
}

module.exports = { run };
