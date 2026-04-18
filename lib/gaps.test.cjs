const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } = require('../tests/helpers/fixture.cjs');
const gaps = require('./gaps.cjs');
const roadmap = require('./roadmap.cjs');

const FIXTURE_VERIFICATION = fs.readFileSync(
  path.join(__dirname, '..', 'tests', 'fixtures', 'gaps', 'verification-sample.md'),
  'utf-8',
);
const FIXTURE_AUDIT = fs.readFileSync(
  path.join(__dirname, '..', 'tests', 'fixtures', 'gaps', 'audit-from-file.md'),
  'utf-8',
);

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'first',
        phases: [
          { number: 1, name: 'One', slug: 'one', goal: '', depends_on: [], requirements: [], success_criteria: [], status: 'done', plans: [] },
          { number: 7, name: 'Seven', slug: 'seven', goal: '', depends_on: [6], requirements: [], success_criteria: [], status: 'done', plans: [] },
          { number: 8, name: 'Eight', slug: 'eight', goal: '', depends_on: [7], requirements: [], success_criteria: [], status: 'pending', plans: [] },
        ],
      },
    ],
  };
}

afterEach(cleanupAll);

test('GAP-1: scanVerifications returns gap objects with required shape', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'foo', { '03-VERIFICATION.md': FIXTURE_VERIFICATION });
  const result = gaps.scanVerifications('v1.0', sandbox);
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0);
  for (const g of result) {
    assert.equal(typeof g.source_phase, 'number');
    assert.equal(typeof g.gap_type, 'string');
    assert.equal(typeof g.description, 'string');
    assert.ok(['critical', 'major', 'minor'].includes(g.severity));
  }
});

test('GAP-2: explicit ## Gap: heading produces gap_type=explicit', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'foo', { '03-VERIFICATION.md': FIXTURE_VERIFICATION });
  const result = gaps.scanVerifications('v1.0', sandbox);
  const explicit = result.filter((g) => g.gap_type === 'explicit');
  assert.ok(explicit.length >= 1);
  assert.ok(explicit[0].description.toLowerCase().includes('jwt'));
});

test('GAP-3: unchecked checkbox line produces gap_type=unchecked-box', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'foo', { '03-VERIFICATION.md': FIXTURE_VERIFICATION });
  const result = gaps.scanVerifications('v1.0', sandbox);
  const boxes = result.filter((g) => g.gap_type === 'unchecked-box');
  assert.equal(boxes.length, 2);
});

test('GAP-4: ❌ or FAIL marker produces gap_type=fail-marker', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'foo', { '03-VERIFICATION.md': FIXTURE_VERIFICATION });
  const result = gaps.scanVerifications('v1.0', sandbox);
  const fails = result.filter((g) => g.gap_type === 'fail-marker');
  assert.ok(fails.length >= 2);
});

test('GAP-5: source_phase extracted from directory name NN-slug (semantic, not positional)', () => {

  
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'foo', { '03-VERIFICATION.md': '## Gap: from three\n' });
  seedPhaseDir(sandbox, 7, 'bar', { '07-VERIFICATION.md': '## Gap: from seven\n' });
  const result = gaps.scanVerifications('v1.0', sandbox);
  const three = result.find((g) => /three/.test(g.description));
  const seven = result.find((g) => /seven/.test(g.description));
  assert.equal(three.source_phase, 3);
  assert.equal(seven.source_phase, 7);
});

test('GAP-6: VERIFICATION.md with no gap signals returns empty array', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  seedPhaseDir(sandbox, 3, 'foo', {
    '03-VERIFICATION.md': '# Verification\n\nAll checks passed.\n- [x] Done\n',
  });
  const result = gaps.scanVerifications('v1.0', sandbox);
  assert.deepEqual(result, []);
});

test('GAP-7: parseAuditFile rejects paths outside project root (ASVS V12)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  assert.throws(
    () => gaps.parseAuditFile('/etc/passwd', sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'gaps-invalid-audit-path',
  );
});

test('GAP-8: parseAuditFile parses ## Gap: sections and reads Source phase line', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const auditPath = path.join(sandbox, 'audit.md');
  fs.writeFileSync(auditPath, FIXTURE_AUDIT);
  const result = gaps.parseAuditFile(auditPath, sandbox);
  assert.equal(result.length, 2);
  for (const g of result) {
    assert.equal(g.source_phase, 7);
    assert.equal(g.gap_type, 'explicit');
  }
});

test('GAP-9: parseAuditFile throws gaps-missing-source-phase when line missing', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const auditPath = path.join(sandbox, 'bad-audit.md');
  fs.writeFileSync(auditPath, '# Audit\n\n## Gap: missing source info\n\nNo source phase here.\n');
  assert.throws(
    () => gaps.parseAuditFile(auditPath, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'gaps-missing-source-phase',
  );
});

test('GAP-10: gapsToPhases({insertAfter: null}) appends via addPhase; depends_on=[source]', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const result = gaps.gapsToPhases(
    [{ source_phase: 7, gap_type: 'explicit', description: 'x', severity: 'major' }],
    { insertAfter: null },
    sandbox,
  );
  assert.equal(result.length, 1);

  const ms = roadmap.parseRoadmap(sandbox);
  const added = ms.phases.find((p) => p.number === '9');
  assert.ok(added, 'new phase appended at number 9');
  assert.ok(added.depends_on && added.depends_on.includes('7'));
});

test('GAP-11: gapsToPhases({insertAfter: 7}) uses insertPhaseAfter; phase 8 depends_on untouched', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  gaps.gapsToPhases(
    [{ source_phase: 7, gap_type: 'explicit', description: 'x', severity: 'major' }],
    { insertAfter: 7 },
    sandbox,
  );
  const parsed = roadmap.parseRoadmap(sandbox);
  const decimal = parsed.phases.find((p) => p.number === '7.1');
  const eight = parsed.phases.find((p) => p.number === '8');
  assert.ok(decimal, 'decimal phase 7.1 exists');
  assert.ok(eight.depends_on && eight.depends_on.includes('7'), 'phase 8 depends_on still [7]');
});

test('GAP-12: Pitfall 5 — semantic source_phase, NOT positional insertAfter, drives depends_on', () => {

  

  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  gaps.gapsToPhases(
    [{ source_phase: 7, gap_type: 'explicit', description: 'semantic test', severity: 'major' }],
    { insertAfter: 8 },
    sandbox,
  );
  const parsed = roadmap.parseRoadmap(sandbox);

  const created = parsed.phases.find((p) => p.number === '8.1');
  assert.ok(created, 'decimal 8.1 created');

  assert.ok(
    created.depends_on && created.depends_on.includes('7'),
    'depends_on includes semantic source 7, not positional base 8',
  );
});

test('GAP-13: empty gaps array returns [] and performs no roadmap mutation', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const yamlPath = path.join(sandbox, '.nubos-pilot', 'roadmap.yaml');
  const before = fs.readFileSync(yamlPath, 'utf-8');
  const result = gaps.gapsToPhases([], { insertAfter: null }, sandbox);
  assert.deepEqual(result, []);
  const after = fs.readFileSync(yamlPath, 'utf-8');
  assert.equal(before, after, 'roadmap.yaml untouched for empty gaps');
});
