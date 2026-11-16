'use strict';

// CLI surface for the roadmap graph renderer (ADR-0027).
//
// Read-only by construction: there is no verb that writes roadmap.yaml. The
// diagram is a view of the plan, and the plan's source of truth stays a
// reviewable text file under git.

const fs = require('node:fs');

const graph = require('../../lib/roadmap-graph.cjs');
const { collectTree } = require('../../lib/planning-tree.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs roadmap-graph [--format mermaid|dot] [--level milestone|slice|task]',
    '                            [--direction TD|LR] [--milestone <N>]',
    '                            [--markdown] [--out <path>] [--json]',
    '',
    'Renders roadmap.yaml as a dependency graph. The edges already exist in the',
    'data — milestone depends_on (ADR-0006), task depends_on in the plan',
    'frontmatter, and the serial slice order the executor enforces — but every',
    'other view flattens them into a list, so "what unblocks when this slice',
    'lands" has to be reconstructed by hand.',
    '',
    'Formats:',
    '  mermaid  (default)  renders inline in the VitePress docs and most previewers',
    '  dot                 Graphviz, for layout control',
    '',
    'Levels: milestone (coarse), slice, task (default).',
    '',
    'Slice order renders as a bold "wave" edge: slices run serially, tasks inside',
    'one slice run in parallel. A task depends_on inside a slice is drawn as a',
    'normal edge, since an intra-wave ordering constraint is the exception.',
    '',
    'A depends_on naming a milestone that does not exist is reported as a dangling',
    'dependency rather than drawn — that is a defect in roadmap.yaml, and omitting',
    'it silently would hide it.',
    '',
    'Read-only: no verb writes roadmap.yaml.',
  ].join('\n');
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const cwd = context.cwd || process.cwd();
  const rest = Array.isArray(argv) ? argv.slice() : [];

  if (rest.includes('-h') || rest.includes('--help')) {
    stdout.write(_usage() + '\n');
    return 0;
  }

  try {
    const format = getFlag(rest, '--format') || 'mermaid';
    if (!graph.FORMATS.includes(format)) {
      stderr.write(JSON.stringify({
        code: 'roadmap-graph-bad-format',
        message: '--format must be one of ' + graph.FORMATS.join(' | '),
        details: { format, allowed: graph.FORMATS },
      }) + '\n');
      return 1;
    }

    const level = getFlag(rest, '--level') || 'task';
    if (!graph.LEVELS.includes(level)) {
      stderr.write(JSON.stringify({
        code: 'roadmap-graph-bad-level',
        message: '--level must be one of ' + graph.LEVELS.join(' | '),
        details: { level, allowed: graph.LEVELS },
      }) + '\n');
      return 1;
    }

    const milestoneRaw = getFlag(rest, '--milestone');
    let milestone = null;
    if (milestoneRaw !== undefined) {
      const n = Number(milestoneRaw);
      if (!Number.isInteger(n) || n < 1) {
        stderr.write(JSON.stringify({
          code: 'roadmap-graph-bad-milestone',
          message: '--milestone must be a positive integer',
          details: { milestone: milestoneRaw },
        }) + '\n');
        return 1;
      }
      milestone = n;
    }

    const milestones = collectTree(cwd, { milestone });
    const rendered = graph.render(milestones, {
      format,
      level,
      direction: getFlag(rest, '--direction') === 'LR' ? 'LR' : 'TD',
    });

    const body = rest.includes('--markdown')
      ? graph.toMarkdown(rendered, getFlag(rest, '--title') || null)
      : rendered.text;

    const out = getFlag(rest, '--out');
    if (out) {
      fs.writeFileSync(out, body + '\n', 'utf-8');
    }

    if (rest.includes('--json')) {
      stdout.write(JSON.stringify({
        ok: true,
        format: rendered.format,
        level,
        out: out || null,
        stats: rendered.stats,
        dangling_dependencies: rendered.graph.dangling_dependencies,
        text: out ? undefined : body,
      }, null, 2) + '\n');
    } else if (!out) {
      stdout.write(body + '\n');
    } else {
      stdout.write(JSON.stringify({ ok: true, out, stats: rendered.stats }, null, 2) + '\n');
    }

    // A dangling dependency is a roadmap defect, so it goes to stderr even on a
    // successful render — a diagram that quietly omits an edge is worse than no
    // diagram, because it reads as complete.
    for (const d of rendered.graph.dangling_dependencies) {
      if (d.kind === 'slice-condition') {
        stderr.write('[roadmap-graph] dangling condition: ' + (d.milestone || '?') + '/' + d.to
          + ' has a `when` on ' + d.from + ', which that milestone does not declare'
          + ' — run `slice-plan lint`\n');
        continue;
      }
      stderr.write('[roadmap-graph] dangling dependency: ' + d.to + ' depends_on ' + d.from
        + ', which no milestone declares\n');
    }

    return 0;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'roadmap-graph-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
