'use strict';

const schema = {
  name: 'verification',
  artifact: 'M<NNN>-VERIFICATION.md',
  description: 'Output schema for /np:verify-work. Frontmatter is the canonical machine-readable signal; body blocks must match the H3-colon style produced by lib/verify.cjs::renderVerificationMd. Drift breaks /np:close-project aggregation.',
  frontmatter: {
    required: [
      'schema_version',
      'milestone',
      'milestone_status',
      'sc_total',
      'passed',
      'failed',
      'deferred',
      'pending',
    ],
    properties: {
      schema_version: { type: 'integer', minimum: 2, example: 2 },
      milestone: { type: 'string', example: 'M001' },
      milestone_name: { type: 'string' },
      verified: { type: 'string', example: '2026-05-12' },
      milestone_status: { type: 'string', enum: ['verified', 'failed', 'deferred'] },
      sc_total: { type: 'integer', minimum: 0 },
      passed: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
      deferred: { type: 'integer', minimum: 0 },
      pending: { type: 'integer', minimum: 0 },
    },
    invariants: [
      {
        lhs: 'frontmatter.sc_total',
        op: '===',
        rhs: 'frontmatter.passed + frontmatter.failed + frontmatter.deferred + frontmatter.pending',
        message: 'sc_total must equal passed + failed + deferred + pending',
      },
    ],
  },
  body: {
    blocks: {
      heading_pattern: '^###\\s+(SC-\\d+):\\s+.+$',
      min_count: 1,
      heading_forbidden_substring: '[object Object]',
      required_fields: [
        { name: 'Status', enum: ['Pass', 'Fail', 'Defer', 'Pending'] },
        { name: 'Classified by' },
        { name: 'Evidence' },
      ],
    },
    patterns: [
      {
        path: 'body.milestone_status_header',
        pattern: '^\\*\\*Milestone Status:\\*\\*\\s+(verified|failed|deferred)\\b',
        flags: 'm',
        min: 1,
        message: 'human-readable "**Milestone Status:**" header missing (must mirror frontmatter milestone_status)',
      },
    ],
  },
};

module.exports = schema;
