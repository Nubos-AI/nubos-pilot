const test = require('node:test');
const assert = require('node:assert/strict');

const rl = require('./_readline.cjs');

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

test('RL-10: module exports exactly askUserReadline, _readOneLine, _parseAnswer, _setReadlineImplForTests', () => {
  const keys = Object.keys(rl).sort();
  assert.deepEqual(keys, [
    '_parseAnswer',
    '_readOneLine',
    '_setReadlineImplForTests',
    'askUserReadline',
  ]);
});
