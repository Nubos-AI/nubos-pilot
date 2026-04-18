const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const phase = require('./phase.cjs');
const { NubosPilotError } = require('./core.cjs');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-phase-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot', 'phases'), { recursive: true });
  return dir;
}

function rmSandbox(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function withSandbox(fn) {
  const dir = makeSandbox();
  try { return fn(dir); } finally { rmSandbox(dir); }
}

test('PH-1 paddedPhase(3) === "03"', () => {
  assert.equal(phase.paddedPhase(3), '03');
});

test('PH-2 paddedPhase("3") === "03"', () => {
  assert.equal(phase.paddedPhase('3'), '03');
});

test('PH-3 paddedPhase(10) === "10"', () => {
  assert.equal(phase.paddedPhase(10), '10');
});

test('PH-4 paddedPhase("2.1") === "02.1"', () => {
  assert.equal(phase.paddedPhase('2.1'), '02.1');
});

test('PH-5 paddedPhase("12.3") === "12.3"', () => {
  assert.equal(phase.paddedPhase('12.3'), '12.3');
});

test('PH-6 paddedPhase("abc") throws NubosPilotError(phase-not-found)', () => {
  try {
    phase.paddedPhase('abc');
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof NubosPilotError, 'expected NubosPilotError');
    assert.equal(err.code, 'phase-not-found');
    assert.deepEqual(err.details, { got: 'abc' });
  }
});

test('PH-7 paddedPhase(0) === "00"', () => {
  assert.equal(phase.paddedPhase(0), '00');
});

test('PH-8 phaseSlug("Core Lib — Parsers & Dispatcher") === "core-lib-parsers-dispatcher"', () => {
  assert.equal(phase.phaseSlug('Core Lib — Parsers & Dispatcher'), 'core-lib-parsers-dispatcher');
});

test('PH-9 phaseSlug("AI/ML") === "ai-ml"', () => {
  assert.equal(phase.phaseSlug('AI/ML'), 'ai-ml');
});

test('PH-10 phaseSlug("   spaced   ") === "spaced"', () => {
  assert.equal(phase.phaseSlug('   spaced   '), 'spaced');
});

test('PH-11 phaseSlug("123-NUMBERS") === "123-numbers"', () => {
  assert.equal(phase.phaseSlug('123-NUMBERS'), '123-numbers');
});

test('PH-12 findPhaseDir(3, sandbox) returns absolute path ending in phases/03-core-lib', () => {
  withSandbox((sandbox) => {
    fs.mkdirSync(path.join(sandbox, '.nubos-pilot', 'phases', '03-core-lib'), { recursive: true });
    const result = phase.findPhaseDir(3, sandbox);
    assert.ok(result, 'expected non-null');
    assert.ok(path.isAbsolute(result), 'expected absolute path');
    assert.ok(result.endsWith(path.join('phases', '03-core-lib')), `expected suffix phases/03-core-lib, got ${result}`);
  });
});

test('PH-13 findPhaseDir(999, sandbox) returns null (no throw)', () => {
  withSandbox((sandbox) => {
    assert.equal(phase.findPhaseDir(999, sandbox), null);
  });
});

test('PH-14 findPhaseDir when phases/ dir absent returns null (not throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-phase-nop-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  try {
    assert.equal(phase.findPhaseDir(3, dir), null);
  } finally {
    rmSandbox(dir);
  }
});

test('PH-15 findPhaseDir("2.1") finds 02.1-hotfix', () => {
  withSandbox((sandbox) => {
    fs.mkdirSync(path.join(sandbox, '.nubos-pilot', 'phases', '02.1-hotfix'), { recursive: true });
    const result = phase.findPhaseDir('2.1', sandbox);
    assert.ok(result);
    assert.ok(result.endsWith(path.join('phases', '02.1-hotfix')), `got ${result}`);
  });
});

test('PH-16 findPhaseDir prefers longer slug-bearing match over bare padded', () => {
  withSandbox((sandbox) => {
    const phases = path.join(sandbox, '.nubos-pilot', 'phases');
    fs.mkdirSync(path.join(phases, '03'), { recursive: true });
    fs.mkdirSync(path.join(phases, '03-full-slug'), { recursive: true });
    const result = phase.findPhaseDir(3, sandbox);
    assert.ok(result);
    assert.ok(
      result.endsWith(path.join('phases', '03-full-slug')),
      `expected longer-slug winner, got ${result}`
    );
  });
});

test('PH-17 createPhaseDir creates phases/04-base-workflows/', () => {
  withSandbox((sandbox) => {
    const result = phase.createPhaseDir(4, 'base-workflows', sandbox);
    assert.ok(path.isAbsolute(result));
    assert.ok(result.endsWith(path.join('phases', '04-base-workflows')), `got ${result}`);
    assert.ok(fs.statSync(result).isDirectory());
  });
});

test('PH-18 createPhaseDir is idempotent for same (n, slug)', () => {
  withSandbox((sandbox) => {
    const a = phase.createPhaseDir(4, 'base-workflows', sandbox);
    const b = phase.createPhaseDir(4, 'base-workflows', sandbox);
    assert.equal(a, b);
  });
});

test('PH-19 createPhaseDir throws phase-slug-mismatch on conflict', () => {
  withSandbox((sandbox) => {
    fs.mkdirSync(
      path.join(sandbox, '.nubos-pilot', 'phases', '04-something-else'),
      { recursive: true }
    );
    try {
      phase.createPhaseDir(4, 'base-workflows', sandbox);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof NubosPilotError, 'expected NubosPilotError');
      assert.equal(err.code, 'phase-slug-mismatch');
      assert.equal(err.details.existing_slug, 'something-else');
      assert.equal(err.details.expected_slug, 'base-workflows');
    }
  });
});

test('PH-20 createPhaseDir leaves no sidecar lock file behind', () => {
  withSandbox((sandbox) => {
    phase.createPhaseDir(4, 'base-workflows', sandbox);
    const entries = fs.readdirSync(path.join(sandbox, '.nubos-pilot', 'phases'));
    const locks = entries.filter((n) => n.includes('.lock') || n.startsWith('.phase-create'));
    assert.deepEqual(locks, [], `stale lock artefacts: ${locks.join(',')}`);
  });
});

test('PH-21 integration: repo-style phase tree resolves 03-core-lib-parsers-dispatcher-capability-layer', () => {

  

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-phase-integ-'));
  try {
    fs.mkdirSync(
      path.join(dir, '.nubos-pilot', 'phases', '03-core-lib-parsers-dispatcher-capability-layer'),
      { recursive: true }
    );
    const result = phase.findPhaseDir(3, dir);
    assert.ok(result);
    assert.ok(
      result.endsWith(path.join('phases', '03-core-lib-parsers-dispatcher-capability-layer')),
      `got ${result}`
    );
  } finally {
    rmSandbox(dir);
  }
});
