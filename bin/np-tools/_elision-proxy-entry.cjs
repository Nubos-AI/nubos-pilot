'use strict';

const proxy = require('../../lib/elision-proxy.cjs');

proxy.start({
  cwd: process.env.ELISION_PROXY_CWD || process.cwd(),
  upstream: process.env.ELISION_PROXY_UPSTREAM || undefined,
}).then(({ baseUrl }) => {
  if (process.send) process.send({ ready: true, baseUrl });
}).catch((err) => {
  if (process.send) process.send({ ready: false, error: String(err && err.message) });
  process.exit(1);
});
