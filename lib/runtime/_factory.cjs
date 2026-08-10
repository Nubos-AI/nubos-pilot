'use strict';

const { askUserReadline } = require('./_readline.cjs');

async function askUser(spec) {
  return askUserReadline({
    type: spec && spec.type,
    question: spec && spec.question,
    options: spec && spec.options,
    def: spec ? spec.default : undefined,
    language: spec && spec.language,
  });
}

function makeReadlineAdapter(meta) {
  return { ...meta, askUser };
}

module.exports = { makeReadlineAdapter };
