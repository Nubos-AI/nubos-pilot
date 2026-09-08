'use strict';

const schema = {
  name: 'validation',
  artifact: 'M<NNN>-VALIDATION.md',
  description: 'Output schema for /np:validate-phase. Frontmatter must report covered/under_sampled/uncovered counts and nyquist_compliant. The aggregator reads frontmatter — do not rely on body grep.',
  frontmatter: {
    required: [
      'phase',
      'audited_at',
      'requirements_total',
      'covered',
      'under_sampled',
      'uncovered',
      'nyquist_compliant',
      'status',
    ],
    properties: {
      phase: { type: 'integer', minimum: 1 },
      slug: { type: 'string' },
      audited_at: { type: 'string', example: '2026-05-12T14:00:00Z' },
      requirements_total: { type: 'integer', minimum: 0 },
      covered: { type: 'integer', minimum: 0 },
      under_sampled: { type: 'integer', minimum: 0 },
      uncovered: { type: 'integer', minimum: 0 },
      nyquist_compliant: { type: 'boolean' },
      status: { type: 'string', enum: ['clean', 'issues_found', 'skipped'] },
    },
    invariants: [
      {
        lhs: 'frontmatter.requirements_total',
        op: '===',
        rhs: 'frontmatter.covered + frontmatter.under_sampled + frontmatter.uncovered',
        message: 'requirements_total must equal covered + under_sampled + uncovered',
      },
    ],
  },
  body: {
    patterns: [
      {
        path: 'body.summary',
        pattern: '^##\\s+Summary\\b',
        flags: 'm',
        min: 1,
        message: '## Summary section missing',
      },
      {
        path: 'body.covered',
        pattern: '^##\\s+Covered\\b',
        flags: 'm',
        min: 1,
        message: '## Covered section missing',
      },
      {
        path: 'body.under_sampled',
        pattern: '^##\\s+Under-Sampled\\b',
        flags: 'm',
        min: 1,
        message: '## Under-Sampled section missing',
      },
      {
        path: 'body.uncovered',
        pattern: '^##\\s+Uncovered\\b',
        flags: 'm',
        min: 1,
        message: '## Uncovered section missing',
      },
    ],
  },
};

module.exports = schema;
