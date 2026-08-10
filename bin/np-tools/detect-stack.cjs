'use strict';

const stack = require('../../lib/stack.cjs');
const args = require('./_args.cjs');

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(argv) ? argv : [];

  const detected = stack.detectStack(cwd);

  if (list.includes('--lint-commands')) {
    stdout.write(stack.lintCommands(cwd).join(' ') + '\n');
    return 0;
  }
  if (list.includes('--ids')) {
    stdout.write(detected.ids.join(' ') + '\n');
    return 0;
  }
  const only = args.getFlag(list, '--stack');
  if (only !== undefined) {
    stdout.write(String(detected.ids.includes(only)) + '\n');
    return 0;
  }

  stdout.write(JSON.stringify({
    ids: detected.ids,
    stacks: detected.stacks,
    runners: detected.runners,
    lint_commands: stack.lintCommands(cwd),
  }) + '\n');
  return 0;
}

module.exports = { run };
