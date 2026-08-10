'use strict';

// Per-spawn researcher output schema (ADR-0018).
//
// Every spawn writes to .nubos-pilot/milestones/M<NNN>/research/spawn-<i>.md
// with this exact shape. mergeConsensus consumes parsed objects whose source
// is this file. Drift breaks at write-time, not at merge-time — the merge
// has historically been hash-based on free prose, which silently topic-split
// the swarm.

const schema = {
  name: 'researcher-output',
  artifact: '.nubos-pilot/milestones/M<NNN>/research/spawn-<i>.md',
  description: 'Per-spawn researcher output. mergeConsensus + the reconciler both consume this shape — required fields gate the swarm. Reasoning is mandatory per entry so the reconciler can distinguish orthogonal vs identical evidence paths (ADR-0018 §Reasoning-Trace).',
  frontmatter: {
    required: [
      'schema_version',
      'agent',
      'spawn_index',
      'seed_delta',
      'task_query_hash',
      'decision_count',
      'risk_count',
      'pattern_count',
      'open_question_count',
      'source_count',
    ],
    properties: {
      schema_version: { type: 'integer', minimum: 1, example: 1 },
      agent: { type: 'string', enum: ['np-researcher'] },
      spawn_index: { type: 'integer', minimum: 0 },
      seed_delta: { type: 'integer' },
      task_query_hash: { type: 'string' },
      task_query: { type: 'string' },
      decision_count: { type: 'integer', minimum: 0 },
      risk_count: { type: 'integer', minimum: 0 },
      pattern_count: { type: 'integer', minimum: 0 },
      open_question_count: { type: 'integer', minimum: 0 },
      source_count: { type: 'integer', minimum: 0 },
    },
  },
  body: {
    blocks: {
      heading_pattern: '^###\\s+([DRP]-\\d+):\\s+.+$',
      min_count: 0,
      heading_forbidden_substring: '[object Object]',
      required_fields: [
        { name: 'Reasoning' },
      ],
    },
    patterns: [
      {
        path: 'body.section_decisions',
        pattern: '^##\\s+Decisions\\b',
        flags: 'm',
        min: 1,
        message: '## Decisions section missing (use "_None._" if empty)',
      },
      {
        path: 'body.section_risks',
        pattern: '^##\\s+Risks\\b',
        flags: 'm',
        min: 1,
        message: '## Risks section missing',
      },
      {
        path: 'body.section_patterns',
        pattern: '^##\\s+Patterns\\b',
        flags: 'm',
        min: 1,
        message: '## Patterns section missing',
      },
      {
        path: 'body.section_open_questions',
        pattern: '^##\\s+Open\\s+Questions\\b',
        flags: 'm',
        min: 1,
        message: '## Open Questions section missing',
      },
      {
        path: 'body.section_sources',
        pattern: '^##\\s+Sources\\b',
        flags: 'm',
        min: 1,
        message: '## Sources section missing',
      },
    ],
  },
};

module.exports = schema;
