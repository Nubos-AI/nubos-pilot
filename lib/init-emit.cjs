'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { projectStateDir } = require('./core.cjs');

const INLINE_THRESHOLD_BYTES = 16 * 1024;

function emitJsonPayload(payload, stdout, cwd, filenamePrefix) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf-8') <= INLINE_THRESHOLD_BYTES) {
    stdout.write(json);
    return;
  }
  let tmpDir;
  try {
    tmpDir = path.join(projectStateDir(cwd), '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch { tmpDir = os.tmpdir(); }
  const suffix = process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const tmpPath = path.join(tmpDir, filenamePrefix + '-' + suffix + '.json');
  fs.writeFileSync(tmpPath, json, { encoding: 'utf-8', mode: 0o600 });
  stdout.write('@file:' + tmpPath);
}

function emitInitPayload(payload, stdout, cwd, workflow) {
  return emitJsonPayload(payload, stdout, cwd, 'init-' + workflow);
}

module.exports = { emitInitPayload, emitJsonPayload, INLINE_THRESHOLD_BYTES };
