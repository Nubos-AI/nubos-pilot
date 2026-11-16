'use strict';

const crypto = require('node:crypto');


const ENV_KEY = 'NUBOS_PILOT_RUN_ID';
const RUN_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

let _cached = null;

function _generate() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(10).toString('hex');
  return 'r-' + ts + '-' + rand;
}

function generateRunId() {
  return _generate();
}

function getRunId() {
  if (_cached) return _cached;
  const fromEnv = process.env[ENV_KEY];
  if (fromEnv && RUN_ID_RE.test(fromEnv)) {
    _cached = fromEnv;
    return _cached;
  }
  _cached = _generate();
  process.env[ENV_KEY] = _cached;
  return _cached;
}

function setRunId(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw new Error('setRunId rejected invalid run_id: ' + JSON.stringify(id));
  }
  _cached = id;
  process.env[ENV_KEY] = id;
  return id;
}

function _resetForTests() {
  _cached = null;
  delete process.env[ENV_KEY];
}

module.exports = {
  ENV_KEY,
  RUN_ID_RE,
  generateRunId,
  getRunId,
  setRunId,
  _resetForTests,
};
