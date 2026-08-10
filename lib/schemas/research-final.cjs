'use strict';

// Final research artifact — written by np-researcher-reconciler after the
// k parallel spawns + deterministic mergeConsensus. This is the file the
// downstream planner reads. Schema is intentionally strict so contested
// decisions, agreement scores, and reasoning-trace classifications are all
// machine-readable, not buried in prose.

const schema = {
  name: 'research-final',
  artifact: 'M<NNN>-RESEARCH.md',
  description: 'Reconciler output — the consumed research artifact. Frontmatter exposes agreement metrics + contested-decision count so the disagreement hard-gate and downstream consumers (plan-phase, plan-checker) have machine-readable signals.',
  frontmatter: {
    required: [
      'schema_version',
      'milestone',
      'type',
      'agent',
      'k',
      'agreement_score',
      'contested_count',
      'reconciler_verdict',
      'decision_count',
      'risk_count',
      'pattern_count',
      'open_question_count',
      'source_count',
    ],
    properties: {
      schema_version: { type: 'integer', minimum: 2, example: 2 },
      milestone: { type: 'string', example: 'M001' },
      type: { type: 'string', enum: ['research'] },
      agent: { type: 'string', enum: ['np-researcher-reconciler'] },
      k: { type: 'integer', minimum: 1 },
      agreement_score: { type: 'number' },
      contested_count: { type: 'integer', minimum: 0 },
      reconciler_verdict: {
        type: 'string',
        enum: ['clean', 'issues_flagged', 'needs_re_spawn'],
      },
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
    },
    patterns: [
      {
        path: 'body.section_summary',
        pattern: '^##\\s+Reconciler\\s+Summary\\b',
        flags: 'm',
        min: 1,
        message: '## Reconciler Summary section missing',
      },
      {
        path: 'body.section_final_decisions',
        pattern: '^##\\s+Final\\s+Decisions\\b',
        flags: 'm',
        min: 1,
        message: '## Final Decisions section missing',
      },
      {
        path: 'body.section_contested',
        pattern: '^##\\s+Contested\\s+Decisions\\b',
        flags: 'm',
        min: 1,
        message: '## Contested Decisions section missing (use "_None._" if all agree)',
      },
      {
        path: 'body.section_risks',
        pattern: '^##\\s+Final\\s+Risks\\b',
        flags: 'm',
        min: 1,
        message: '## Final Risks section missing',
      },
      {
        path: 'body.section_patterns',
        pattern: '^##\\s+Final\\s+Patterns\\b',
        flags: 'm',
        min: 1,
        message: '## Final Patterns section missing',
      },
      {
        path: 'body.section_open_questions',
        pattern: '^##\\s+Final\\s+Open\\s+Questions\\b',
        flags: 'm',
        min: 1,
        message: '## Final Open Questions section missing',
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
