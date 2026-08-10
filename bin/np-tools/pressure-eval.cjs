'use strict';

// CLI surface for the behavioural compliance harness (ADR-0024).
//
// Offline verbs (`lint`, `list`, `coverage`, `evaluate`, `report`) are what CI
// runs: they never call a model. `prompt` is the seam to the live half — pipe
// its output through `spawn-headless` against the agent under test, capture the
// reply, and feed it back through `evaluate`. That split is deliberate: the
// live run costs tokens and is non-deterministic, so it stays opt-in and out of
// the suite.

const fs = require('node:fs');
const path = require('node:path');
const pressure = require('../../lib/pressure.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

const AGENTS_DIR = path.resolve(__dirname, '..', '..', 'agents');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs pressure-eval lint [--dir <path>]',
    '  np-tools.cjs pressure-eval list [--agent <np-*>] [--rule <1-12>] [--json]',
    '  np-tools.cjs pressure-eval coverage [--json]',
    '  np-tools.cjs pressure-eval prompt --fixture <PRS-ID>',
    '  np-tools.cjs pressure-eval evaluate --fixture <PRS-ID> --response-file <path> [--no-citation]',
    '  np-tools.cjs pressure-eval report --responses-file <path.jsonl> [--no-citation]',
    '',
    'Behavioural compliance under stacked pressure. A fixture stacks at least',
    pressure.MIN_PRESSURES + ' independent pressures and forces a discrete choice; a response passes',
    'only when it picks the compliant option AND cites the rule that forced it.',
    '',
    'Offline verbs never call a model. To run the live half:',
    '  np-tools.cjs pressure-eval prompt --fixture PRS-R08-EXECUTOR-WORKAROUND > /tmp/p.txt',
    '  # hand /tmp/p.txt to the agent under test, save its reply to /tmp/r.txt',
    '  np-tools.cjs pressure-eval evaluate --fixture PRS-R08-EXECUTOR-WORKAROUND --response-file /tmp/r.txt',
    '',
    '`report` reads JSONL of {"fixture_id":"…","response":"…"} and exits non-zero',
    'when any verdict fails — that is the model-swap regression gate (ADR-0021).',
  ].join('\n');
}

function _knownAgents() {
  try {
    return fs.readdirSync(AGENTS_DIR)
      .filter((f) => f.startsWith('np-') && f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function _findFixture(fixtures, id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) {
    const err = new Error('Unknown fixture: ' + String(id));
    err.name = 'NubosPilotError';
    err.code = 'pressure-unknown-fixture';
    err.details = { id, available: fixtures.map((f) => f.id) };
    throw err;
  }
  return fx;
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    stdout.write(_usage() + '\n');
    return args.length === 0 ? 1 : 0;
  }

  const verb = args[0];
  const rest = args.slice(1);
  const requireCitation = !rest.includes('--no-citation');

  try {
    const dir = getFlag(rest, '--dir');
    const fixtures = pressure.loadFixtures(dir);

    switch (verb) {
      case 'lint': {
        // loadFixtures already threw on any defect; reaching here IS the pass.
        stdout.write(JSON.stringify({
          ok: true,
          total: fixtures.length,
          dir: dir || pressure.FIXTURES_DIR,
          ids: fixtures.map((f) => f.id),
        }, null, 2) + '\n');
        return 0;
      }

      case 'list': {
        const agent = getFlag(rest, '--agent');
        const ruleRaw = getFlag(rest, '--rule');
        let list = fixtures;
        if (agent) list = list.filter((f) => f.agent === agent);
        if (ruleRaw !== undefined) {
          const n = Number(ruleRaw);
          if (!Number.isInteger(n) || n < 1 || n > 12) {
            stderr.write(JSON.stringify({
              code: 'pressure-bad-rule-filter',
              message: '--rule must be an integer in 1..12',
              details: { rule: ruleRaw },
            }) + '\n');
            return 1;
          }
          list = list.filter((f) => f.rule === n);
        }
        const rows = list.map((f) => ({
          id: f.id, rule: f.rule, agent: f.agent, title: f.title,
          pressures: f.pressures, rationalizations: f.rationalizations.length,
        }));
        if (rest.includes('--json')) {
          stdout.write(JSON.stringify(rows, null, 2) + '\n');
          return 0;
        }
        if (rows.length === 0) {
          stdout.write('No fixtures match.\n');
          return 0;
        }
        for (const r of rows) {
          stdout.write(
            'Rule ' + String(r.rule).padStart(2, ' ') + '  ' + r.agent.padEnd(24, ' ')
            + r.id + '\n           ' + r.title
            + '\n           pressures: ' + r.pressures.join(', ')
            + '  |  counters: ' + r.rationalizations + '\n',
          );
        }
        return 0;
      }

      case 'coverage': {
        const cov = pressure.coverage(fixtures, _knownAgents());
        if (rest.includes('--json')) {
          stdout.write(JSON.stringify(cov, null, 2) + '\n');
          return 0;
        }
        stdout.write('Fixtures: ' + cov.total_fixtures + '\n');
        stdout.write('Rules covered:   ' + cov.rules_covered.join(', ') + '\n');
        stdout.write('Rules uncovered: ' + (cov.uncovered_rules.join(', ') || '(none)') + '\n');
        stdout.write('Agents covered:  ' + cov.agents_covered.length + '\n');
        stdout.write('Pressure use:    '
          + Object.entries(cov.pressure_histogram).map(([k, v]) => k + '=' + v).join('  ') + '\n');
        return 0;
      }

      case 'prompt': {
        const id = getFlag(rest, '--fixture');
        if (!id) {
          stderr.write(JSON.stringify({
            code: 'pressure-missing-fixture',
            message: '--fixture <PRS-ID> is required',
            details: {},
          }) + '\n');
          return 1;
        }
        stdout.write(pressure.renderPrompt(_findFixture(fixtures, id)) + '\n');
        return 0;
      }

      case 'evaluate': {
        const id = getFlag(rest, '--fixture');
        const file = getFlag(rest, '--response-file');
        if (!id || !file) {
          stderr.write(JSON.stringify({
            code: 'pressure-missing-evaluate-args',
            message: '--fixture <PRS-ID> and --response-file <path> are both required',
            details: { fixture: id || null, response_file: file || null },
          }) + '\n');
          return 1;
        }
        const text = fs.readFileSync(file, 'utf-8');
        const verdict = pressure.evaluate(_findFixture(fixtures, id), text, { requireCitation });
        stdout.write(JSON.stringify(verdict, null, 2) + '\n');
        // Exit code carries the verdict so a shell caller does not have to parse
        // JSON to branch on it.
        return verdict.compliant ? 0 : 1;
      }

      case 'report': {
        const file = getFlag(rest, '--responses-file');
        if (!file) {
          stderr.write(JSON.stringify({
            code: 'pressure-missing-responses-file',
            message: '--responses-file <path.jsonl> is required',
            details: {},
          }) + '\n');
          return 1;
        }
        const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
        const verdicts = [];
        for (const [i, line] of lines.entries()) {
          let rec;
          try {
            rec = JSON.parse(line);
          } catch (err) {
            stderr.write(JSON.stringify({
              code: 'pressure-responses-invalid-json',
              message: 'Line ' + (i + 1) + ' of the responses file is not valid JSON',
              details: { line: i + 1, cause: err && err.message },
            }) + '\n');
            return 1;
          }
          verdicts.push(pressure.evaluate(
            _findFixture(fixtures, rec && rec.fixture_id),
            rec && rec.response,
            { requireCitation },
          ));
        }
        const summary = pressure.summarize(verdicts);
        stdout.write(JSON.stringify(Object.assign({}, summary, { verdicts }), null, 2) + '\n');
        return summary.ok ? 0 : 1;
      }

      default: {
        stderr.write(JSON.stringify({
          code: 'pressure-unknown-verb',
          message: 'Unknown verb: ' + verb,
          details: { verb, allowed: ['lint', 'list', 'coverage', 'prompt', 'evaluate', 'report'] },
        }) + '\n');
        return 1;
      }
    }
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'pressure-eval-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
