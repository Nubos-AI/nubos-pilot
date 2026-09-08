#!/usr/bin/env node
'use strict';

// Retain the existing entry point; Node enforces coverage in the same test run.
process.exitCode = require('./run-tests.cjs').run({ coverage: true });
