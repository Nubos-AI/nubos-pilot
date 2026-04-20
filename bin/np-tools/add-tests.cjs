const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, atomicWriteFileSync, withFileLock } = require('../../lib/core.cjs');
const { getPhase } = require('../../lib/roadmap.cjs');
const layout = require('../../lib/layout.cjs');
const { parseVerificationMd, milestoneVerificationPath } = require('../../lib/verify.cjs');

const BEGIN_MARKER = '// >>> np:add-tests begin';
const END_MARKER = '// <<< np:add-tests end';

function _validateMilestoneArg(raw) {
  if (raw == null || raw === '' || !/^\d+$/.test(String(raw))) {
    throw new NubosPilotError(
      'add-tests-invalid-phase',
      'add-tests requires a positive integer milestone argument',
      { value: raw == null ? '' : String(raw) },
    );
  }
  return Number(raw);
}

function _resolveTestTarget(mNum, cwd) {
  const def = getPhase(mNum, cwd);
  const slug = layout.slugify(def.name || 'milestone');
  const mIdStr = layout.mId(mNum);
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return {
        pkg_root: dir,
        target_path: path.join(dir, 'test', 'uat', mIdStr.toLowerCase() + '-' + slug + '.test.cjs'),
        milestone_id: mIdStr, slug,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    pkg_root: path.resolve(cwd),
    target_path: path.join(path.resolve(cwd), 'test', 'uat', mIdStr.toLowerCase() + '-' + slug + '.test.cjs'),
    milestone_id: mIdStr, slug,
  };
}

function _loadCases(mNum, cwd) {
  const mDir = layout.findMilestoneDir(mNum, cwd);
  if (!mDir) {
    throw new NubosPilotError(
      'add-tests-phase-dir-missing',
      'Milestone directory not found for milestone ' + mNum,
      { milestone: mNum },
    );
  }
  const vp = milestoneVerificationPath(mNum, cwd);
  if (!fs.existsSync(vp)) {
    throw new NubosPilotError(
      'add-tests-verification-missing',
      'VERIFICATION.md not found — run `/np:verify-work ' + mNum + '` first',
      { path: vp },
    );
  }
  const all = parseVerificationMd(vp);
  const passes = all.filter((c) => c.status === 'Pass');
  const skips = all.filter((c) => c.status === 'Fail' || c.status === 'Defer');
  return { all, passes, skips, verification_path: vp };
}

function _jsString(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

function _renderBlock(milestoneId, passes, skips) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(BEGIN_MARKER + ' (' + milestoneId + ', generated ' + date + ')');
  lines.push("const { test } = require('node:test');");
  lines.push("const assert = require('node:assert');");
  lines.push('');
  for (const c of passes) {
    lines.push('test(' + _jsString(c.id + ': ' + c.text) + ', () => {');
    lines.push('  // TODO: implement UAT for ' + c.id);
    lines.push('  assert.ok(true);');
    lines.push('});');
  }
  for (const c of skips) {
    lines.push('test.skip(' + _jsString(c.id + ': ' + c.text) + ', { todo: ' + _jsString('Deferred: ' + c.status) + ' }, () => {});');
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

function _mergeBlock(existing, block) {
  if (!existing) {
    return block + '\n';
  }

  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {

    return existing.replace(/\n*$/, '\n') + block + '\n';
  }
  const before = existing.slice(0, beginIdx);
  const after = existing.slice(endIdx + END_MARKER.length);
  return before + block + after;
}

function _emitTests(mNum, cwd) {
  const { passes, skips } = _loadCases(mNum, cwd);
  const target = _resolveTestTarget(mNum, cwd);
  fs.mkdirSync(path.dirname(target.target_path), { recursive: true });
  const block = _renderBlock(target.milestone_id, passes, skips);
  return withFileLock(target.target_path, () => {
    let existing = null;
    try { existing = fs.readFileSync(target.target_path, 'utf-8'); } catch { existing = null; }
    const next = _mergeBlock(existing, block);
    atomicWriteFileSync(target.target_path, next);
    return {
      ok: true,
      target_path: target.target_path,
      pass_count: passes.length,
      skip_count: skips.length,
    };
  });
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];

  switch (verb) {
    case 'init': {
      const mNum = _validateMilestoneArg(list[1]);
      const target = _resolveTestTarget(mNum, cwd);
      const { passes, skips, verification_path } = _loadCases(mNum, cwd);
      const payload = {
        _workflow: 'add-tests',
        milestone: mNum,
        milestone_id: target.milestone_id,
        target_path: target.target_path,
        verification_path,
        pass_cases: passes,
        skip_cases: skips,
      };
      stdout.write(JSON.stringify(payload, null, 2));
      return payload;
    }
    case 'emit': {
      const mNum = _validateMilestoneArg(list[1]);
      const result = _emitTests(mNum, cwd);
      stdout.write(JSON.stringify(result));
      return result;
    }
    default:
      throw new NubosPilotError(
        'add-tests-unknown-verb',
        'add-tests: unknown verb: ' + String(verb),
        { verb },
      );
  }
}

module.exports = { run, BEGIN_MARKER, END_MARKER };
