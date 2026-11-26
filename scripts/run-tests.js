#!/usr/bin/env node
'use strict';

/**
 * Portable test runner.
 *
 * `node --test tests/` works on Node 20 but resolves the directory as a module
 * path on Node 22, so CI failed on the newer runtime. This discovers the test
 * files itself and passes explicit paths, which behaves identically on Node 20
 * and 22, on Linux, macOS and Windows.
 *
 *   npm test              run everything
 *   npm test -- claims    run only tests/claims.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const testsDir = path.join(__dirname, '..', 'tests');
const filter = process.argv[2];

const files = fs
  .readdirSync(testsDir)
  .filter((file) => file.endsWith('.test.js'))
  .filter((file) => !filter || file.includes(filter))
  .sort()
  .map((file) => path.join('tests', file));

if (!files.length) {
  console.error(`No test files found${filter ? ` matching "${filter}"` : ''}.`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s):\n  ${files.join('\n  ')}\n`);

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Test run killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
