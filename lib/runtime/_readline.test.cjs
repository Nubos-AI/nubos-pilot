const test = require('node:test');
const assert = require('node:assert/strict');

const { Writable } = require('node:stream');

const rl = require('./_readline.cjs');
// The CLI is the shell-facing end of this contract; its answer formatting is
// what `case "$CHOICE" in` sees. Its own test file is owned elsewhere, so the
// format-contract locks live here, next to the value producer.
const askuserCli = require('../../bin/np-tools/askuser.cjs');
const askuserLib = require('../askuser.cjs');

function makeSink() {
  const chunks = [];
  const w = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  w.toString = () => chunks.join('');
  return w;
}

async function runCli(spec) {
  const stdout = makeSink();
  const stderr = makeSink();
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  let code;
  try {
    code = await askuserCli.run(['--json', JSON.stringify(spec)], { stdout, stderr });
  } finally {
    process.stdout.write = origStdoutWrite;
  }
  return { code, out: stdout.toString(), err: stderr.toString() };
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  return Promise.resolve(fn()).then(
    (val) => { process.stderr.write = orig; return { val, out: chunks.join('') }; },
    (err) => { process.stderr.write = orig; throw err; },
  );
}

test('RL-1: askUserReadline input returns {value, source:readline} when impl injected', async () => {
  rl._setReadlineImplForTests(async () => 'typed');
  try {
    const { val } = await captureStderr(() =>
      rl.askUserReadline({ type: 'input', question: 'Q' }),
    );
    assert.equal(val.value, 'typed');
    assert.equal(val.source, 'readline');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-2: askUserReadline select parses 1-based index into option', async () => {
  rl._setReadlineImplForTests(async () => '2');
  try {
    const { val } = await captureStderr(() =>
      rl.askUserReadline({ type: 'select', question: 'Pick', options: ['A', 'B', 'C'] }),
    );
    assert.equal(val.value, 'B');
    assert.equal(val.source, 'readline');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-3: askUserReadline multiselect parses comma-separated indices', async () => {
  rl._setReadlineImplForTests(async () => '1,3');
  try {
    const { val } = await captureStderr(() =>
      rl.askUserReadline({ type: 'multiselect', question: 'Pick', options: ['A', 'B', 'C'] }),
    );
    assert.deepEqual(val.value, ['A', 'C']);
    assert.equal(val.source, 'readline');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-1: select with {label,description} options returns the label, not the object (P2.4)', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    const { val } = await captureStderr(() =>
      rl.askUserReadline({
        type: 'select',
        question: 'Pick',
        options: [
          { label: 'Abort', description: 'Exit without changes.' },
          { label: 'Overwrite', description: 'Replace the plan.' },
        ],
      }),
    );
    // The defect: this returned the raw object, askuser.cjs JSON.stringify'd it,
    // and `case "$CHOICE" in "Abort")` never matched — silent wrong-branch.
    assert.equal(val.value, 'Abort');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-2: object options render as "label — description", never [object Object] (P2.4)', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    const { out } = await captureStderr(() =>
      rl.askUserReadline({
        type: 'select',
        question: 'Pick',
        options: [{ label: 'Abort', description: 'Exit without changes.' }],
      }),
    );
    assert.ok(!/\[object Object\]/.test(out), 'menu must not render [object Object]');
    assert.match(out, /1\)/);
    assert.match(out, /Abort — Exit without changes\./);
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-3: object option without a description renders the bare label (P2.4)', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    const { out, val } = await captureStderr(() =>
      rl.askUserReadline({ type: 'select', question: 'Pick', options: [{ label: 'Abort' }] }),
    );
    assert.ok(!/—/.test(out.split('\n').find((l) => /1\)/.test(l)) || ''), 'no dangling em dash');
    assert.equal(val.value, 'Abort');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-4: multiselect with object options returns labels (P2.4)', async () => {
  rl._setReadlineImplForTests(async () => '1,3');
  try {
    const { val } = await captureStderr(() =>
      rl.askUserReadline({
        type: 'multiselect',
        question: 'Pick',
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      }),
    );
    assert.deepEqual(val.value, ['A', 'C']);
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-5: the default marker resolves against labels, not object identity (P2.4)', async () => {
  rl._setReadlineImplForTests(async () => '');
  try {
    const { out, val } = await captureStderr(() =>
      rl.askUserReadline({
        type: 'select',
        question: 'Pick',
        options: [{ label: 'A' }, { label: 'B' }],
        def: 'B',
      }),
    );
    // options.indexOf('B') never matched an object — the marker silently vanished.
    assert.match(out, /\[2\]/, 'default marker must point at the matching option');
    assert.equal(val.value, 'B');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-6: no-TTY default is label-normalised too (P2.4)', async () => {
  const { val } = await captureStderr(() =>
    rl.askUserReadline({
      type: 'select',
      question: 'Pick',
      options: [{ label: 'A' }],
      def: { label: 'A', description: 'first' },
    }),
  );
  assert.equal(val.value, 'A', 'an object default must not leak out as an object');
  assert.equal(val.source, 'default');
});

test('RL-OBJ-7: plain string options are unaffected (P2.4 regression guard)', async () => {
  rl._setReadlineImplForTests(async () => '2');
  try {
    const { out, val } = await captureStderr(() =>
      rl.askUserReadline({ type: 'select', question: 'Pick', options: ['A', 'B'] }),
    );
    assert.equal(val.value, 'B');
    assert.match(out, /2\)\S*\s+B/, 'string options still render as before');
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

// ── Fail-closed option specs (P2.4 root cause) ────────────────────────────
// The label-is-the-contract fix only covered `typeof opt.label === 'string'`;
// every other object shape still fell through to String(opt), so the menu
// rendered "[object Object]" AND returned it as the answer — the original
// defect, one guard-clause away.

test('RL-OBJ-8: option object without a label throws instead of rendering [object Object]', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    await assert.rejects(
      () => captureStderr(() =>
        rl.askUserReadline({ type: 'select', question: 'Pick', options: [{ description: 'x' }] }),
      ),
      (err) => err && err.code === 'askuser-invalid-option',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-9: non-string label (number/null) throws askuser-invalid-option', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    for (const bad of [{ label: 42 }, { label: null }, { label: ['a'] }, 42, null]) {
      await assert.rejects(
        () => captureStderr(() =>
          rl.askUserReadline({ type: 'select', question: 'Pick', options: [bad] }),
        ),
        (err) => err && err.code === 'askuser-invalid-option',
        'option ' + JSON.stringify(bad) + ' must be rejected loudly',
      );
    }
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-10: empty / whitespace-only label throws — "" is indistinguishable from a failure', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    for (const bad of ['', { label: '' }, { label: '   ' }]) {
      await assert.rejects(
        () => captureStderr(() =>
          rl.askUserReadline({ type: 'select', question: 'Pick', options: [bad] }),
        ),
        (err) => err && err.code === 'askuser-invalid-option',
      );
    }
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-11: duplicate labels throw — the answer would be ambiguous', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    await assert.rejects(
      () => captureStderr(() =>
        rl.askUserReadline({
          type: 'select',
          question: 'Pick',
          options: [{ label: 'Abort', description: 'first' }, { label: 'Abort', description: 'second' }],
        }),
      ),
      (err) => err && err.code === 'askuser-duplicate-option',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-12: newline/control char in a label throws — it shatters the numbered menu', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    for (const bad of ['Ab\nort', { label: 'Ab\tort' }, { label: 'Ab\rort' }]) {
      await assert.rejects(
        () => captureStderr(() =>
          rl.askUserReadline({ type: 'select', question: 'Pick', options: [bad] }),
        ),
        (err) => err && err.code === 'askuser-invalid-option',
      );
    }
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-13: padded label throws — description is trimmed, the label is not', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    await assert.rejects(
      () => captureStderr(() =>
        rl.askUserReadline({ type: 'select', question: 'Pick', options: [{ label: '  Abort  ' }] }),
      ),
      (err) => err && err.code === 'askuser-invalid-option',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-OBJ-14: non-string description throws instead of being silently dropped', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    await assert.rejects(
      () => captureStderr(() =>
        rl.askUserReadline({ type: 'select', question: 'Pick', options: [{ label: 'A', description: 7 }] }),
      ),
      (err) => err && err.code === 'askuser-invalid-option',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-SPEC-1: select/multiselect without a non-empty options array throws askuser-invalid-spec', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    for (const spec of [
      { type: 'select', question: 'Q' },
      { type: 'select', question: 'Q', options: [] },
      { type: 'multiselect', question: 'Q', options: 'A,B' },
    ]) {
      await assert.rejects(
        () => captureStderr(() => rl.askUserReadline(spec)),
        (err) => err && err.code === 'askuser-invalid-spec',
      );
    }
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-SPEC-2: a select default that is not one of the options throws', async () => {
  rl._setReadlineImplForTests(async () => '');
  try {
    await assert.rejects(
      () => captureStderr(() =>
        rl.askUserReadline({ type: 'select', question: 'Q', options: ['local', 'global'], def: 'Local' }),
      ),
      (err) => err && err.code === 'askuser-invalid-spec',
    );
    await assert.rejects(
      () => captureStderr(() =>
        rl.askUserReadline({ type: 'multiselect', question: 'Q', options: ['A', 'B'], def: ['C'] }),
      ),
      (err) => err && err.code === 'askuser-invalid-spec',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-SPEC-3: confirm default must be a boolean', async () => {
  rl._setReadlineImplForTests(async () => '');
  try {
    await assert.rejects(
      () => captureStderr(() => rl.askUserReadline({ type: 'confirm', question: 'OK?', def: 'Yes' })),
      (err) => err && err.code === 'askuser-invalid-spec',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-SPEC-4: the spec guard also fires in _parseAnswer (claude marker-block path)', () => {
  // claude.cjs prompts via its own marker block and calls _parseAnswer directly,
  // bypassing askUserReadline — the validation must sit on both doors.
  assert.throws(
    () => rl._parseAnswer('select', '1', [{ description: 'no label' }], null),
    (err) => err && err.code === 'askuser-invalid-option',
  );
  assert.throws(
    () => rl._parseAnswer('multiselect', '1', [{ label: 'A' }, { label: 'A' }], null),
    (err) => err && err.code === 'askuser-duplicate-option',
  );
});

test('RL-SPEC-5: a rejected spec never reaches the menu — no [object Object] on stderr', async () => {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  try {
    await assert.rejects(() =>
      rl.askUserReadline({ type: 'select', question: 'Pick', options: [{ description: 'x' }] }),
    );
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(/\[object Object\]/.test(chunks.join('')), false);
  assert.equal(chunks.join(''), '', 'validation must run before anything is rendered');
});

test('RL-SPEC-6: an empty options array falls back to a provided default instead of throwing', () => {
  // Options built from a scan that returned nothing, with a caller-supplied
  // fallback: there is nothing to select, so the default is the only answer.
  assert.doesNotThrow(() => rl._validateSpec('select', [], 'fallback'));
  assert.doesNotThrow(() => rl._validateSpec('multiselect', [], ['fallback']));
  assert.equal(rl._parseAnswer('select', '', [], 'fallback'), 'fallback');
  // Still loud where it must be: empty with no default is unanswerable, and a
  // non-array options value is a spec error regardless of a default.
  assert.throws(
    () => rl._validateSpec('select', [], null),
    (err) => err && err.code === 'askuser-invalid-spec',
  );
  assert.throws(
    () => rl._validateSpec('multiselect', 'A,B', 'x'),
    (err) => err && err.code === 'askuser-invalid-spec',
  );
});

test('RL-4: askUserReadline confirm y → true, n → false', async () => {
  rl._setReadlineImplForTests(async () => 'y');
  try {
    const { val: v1 } = await captureStderr(() =>
      rl.askUserReadline({ type: 'confirm', question: 'OK?' }),
    );
    assert.equal(v1.value, true);

    rl._setReadlineImplForTests(async () => 'n');
    const { val: v2 } = await captureStderr(() =>
      rl.askUserReadline({ type: 'confirm', question: 'OK?' }),
    );
    assert.equal(v2.value, false);
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-5: no TTY + no impl + default set → returns {value:def, source:default}', async () => {
  const origIsTTY = process.stdin.isTTY;
  rl._setReadlineImplForTests(null);
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const res = await rl.askUserReadline({ type: 'input', question: 'Q', def: 'd' });
    assert.equal(res.value, 'd');
    assert.equal(res.source, 'default');
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  }
});

test('RL-6: no TTY + no impl + no default → throws askuser-no-tty', async () => {
  const origIsTTY = process.stdin.isTTY;
  rl._setReadlineImplForTests(null);
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await assert.rejects(
      () => rl.askUserReadline({ type: 'input', question: 'Q' }),
      (err) => err && err.code === 'askuser-no-tty',
    );
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  }
});

test('RL-7: _parseAnswer(input, hello, null, null) returns hello', () => {
  assert.equal(rl._parseAnswer('input', 'hello', null, null), 'hello');
});

test('RL-8: _parseAnswer(select, 99, [A,B], null) throws askuser-invalid-response', () => {
  assert.throws(
    () => rl._parseAnswer('select', '99', ['A', 'B'], null),
    (err) => err && err.code === 'askuser-invalid-response',
  );
});

test('RL-9: _parseAnswer unknown type throws askuser-invalid-type', () => {
  assert.throws(
    () => rl._parseAnswer('mystery', 'x', null, null),
    (err) => err && err.code === 'askuser-invalid-type',
  );
});

// The spec field is `question`. 36 specs across 5 workflows carried the text
// under `prompt` instead, so askUser rendered an undefined question: the dialog
// asked nothing, and the answer gave no hint that it had happened. Both entry
// points must refuse it — askUserReadline for every runtime, and claude.cjs,
// whose marker-block path never reaches askUserReadline at all.
test('RL-Q1: a spec whose question is missing/blank is refused, not asked blindly', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    for (const question of [undefined, null, '', '   ', 42]) {
      await assert.rejects(
        () => rl.askUserReadline({ type: 'input', question }),
        (err) => err.code === 'askuser-missing-question',
        'question=' + JSON.stringify(question) + ' must be refused',
      );
    }
    await assert.rejects(
      () => require('../runtime/claude.cjs').askUser({ type: 'input', prompt: 'Project name?' }),
      (err) => err.code === 'askuser-missing-question',
      'the historic `prompt` key must be refused on the claude path too',
    );
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-10: module exports readline helpers + claude-runtime TTY probe', () => {
  const keys = Object.keys(rl).sort();
  assert.deepEqual(keys, [
    '_hasReadlineImplForTests',
    '_optionDisplay',
    '_optionLabel',
    '_parseAnswer',
    '_readOneLine',
    '_setReadlineImplForTests',
    '_validateQuestion',
    '_validateSpec',
    'askUserReadline',
  ]);
});

test('RL-L1: askUserReadline renders German prompt + multiselect hint when language=de', async () => {
  rl._setReadlineImplForTests(async () => '1');
  try {
    const { out } = await captureStderr(() =>
      rl.askUserReadline({ type: 'multiselect', question: 'Q', options: ['A', 'B'], language: 'de' }),
    );
    assert.match(out, /Mehrfachauswahl: 1,2,6 oder 1 2 6/);
    assert.match(out, /Auswahl/);
    assert.equal(/Choice/.test(out), false);
    assert.equal(/Select multiple/.test(out), false);
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-L2: confirm marker uses [J/n] when language=de and default=true', async () => {
  rl._setReadlineImplForTests(async () => '');
  try {
    const { out } = await captureStderr(() =>
      rl.askUserReadline({ type: 'confirm', question: 'OK?', def: true, language: 'de' }),
    );
    assert.match(out, /\[J\/n\]/);
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

test('RL-L3: _parseAnswer accepts j/ja/nein when language=de', () => {
  assert.equal(rl._parseAnswer('confirm', 'j',    null, null, 'de'), true);
  assert.equal(rl._parseAnswer('confirm', 'ja',   null, null, 'de'), true);
  assert.equal(rl._parseAnswer('confirm', 'JA',   null, null, 'de'), true);
  assert.equal(rl._parseAnswer('confirm', 'nein', null, null, 'de'), false);
});

test('RL-L4: _parseAnswer still accepts y/n in any language', () => {
  assert.equal(rl._parseAnswer('confirm', 'y', null, null, 'de'), true);
  assert.equal(rl._parseAnswer('confirm', 'n', null, null, 'de'), false);
  assert.equal(rl._parseAnswer('confirm', 'y', null, null, 'en'), true);
});

test('RL-L5: _parseAnswer rejects "ja" when language is not de', () => {
  assert.throws(
    () => rl._parseAnswer('confirm', 'ja', null, null, 'en'),
    (err) => err && err.code === 'askuser-invalid-response',
  );
});

test('RL-L6: omitted language defaults to English labels', async () => {
  rl._setReadlineImplForTests(async () => '');
  try {
    const { out } = await captureStderr(() =>
      rl.askUserReadline({ type: 'confirm', question: 'OK?', def: true }),
    );
    assert.match(out, /Choice|\[Y\/n\]/);
  } finally {
    rl._setReadlineImplForTests(null);
  }
});

// ── askuser CLI answer format (the shell-facing contract) ─────────────────

test('RL-CLI-1: confirm prints "true"/"false" — locked, language-independent', async () => {
  askuserLib._setReadlineImplForTests(() => 'y');
  try {
    const yes = await runCli({ type: 'confirm', question: 'OK?' });
    assert.equal(yes.code, 0);
    assert.equal(yes.out, 'true\n', 'workflows compare [[ "$X" == "true" ]], never against "Yes"/"Ja"');
    askuserLib._setReadlineImplForTests(() => 'n');
    const no = await runCli({ type: 'confirm', question: 'OK?' });
    assert.equal(no.out, 'false\n');
    askuserLib._setReadlineImplForTests(() => 'ja');
    const de = await runCli({ type: 'confirm', question: 'OK?', language: 'de' });
    assert.equal(de.out, 'true\n', 'a German "ja" must still print the canonical "true"');
  } finally {
    askuserLib._setReadlineImplForTests(null);
  }
});

test('RL-CLI-2: select prints the label verbatim, multiselect prints a JSON array', async () => {
  askuserLib._setReadlineImplForTests(() => '1');
  try {
    const sel = await runCli({
      type: 'select', question: 'Pick',
      options: [{ label: 'Re-run — overwrite', description: 'd' }, { label: 'Abort' }],
    });
    assert.equal(sel.out, 'Re-run — overwrite\n');
    askuserLib._setReadlineImplForTests(() => '1,2');
    const multi = await runCli({ type: 'multiselect', question: 'Pick', options: ['A', 'B', 'C'] });
    assert.equal(multi.out, '["A","B"]\n', 'multi-value answers are JSON — jq, not `case`');
  } finally {
    askuserLib._setReadlineImplForTests(null);
  }
});

test('RL-CLI-3: a non-renderable (object) answer fails loud, never leaks [object Object]/JSON', async () => {
  const origIsTTY = process.stdin.isTTY;
  askuserLib._setReadlineImplForTests(null);
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const res = await runCli({ type: 'input', question: 'Q', default: { label: 'A', description: 'x' } });
    assert.equal(res.code, 1);
    assert.match(res.err, /"code":\s*"askuser-unsupported-answer"/);
    assert.equal(res.out, '', 'nothing may reach $CHOICE');
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  }
});

test('RL-CLI-4: an invalid option spec surfaces as an error envelope, not a menu', async () => {
  askuserLib._setReadlineImplForTests(() => '1');
  try {
    const res = await runCli({ type: 'select', question: 'Pick', options: [{ description: 'no label' }] });
    assert.equal(res.code, 1);
    assert.match(res.err, /"code":\s*"askuser-invalid-option"/);
    assert.equal(/\[object Object\]/.test(res.out), false);
    assert.equal(res.out, '');
  } finally {
    askuserLib._setReadlineImplForTests(null);
  }
});
