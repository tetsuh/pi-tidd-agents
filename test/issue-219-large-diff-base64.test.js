'use strict';

// Issue #219: fingerprint_pr_diff checked canonical Base64 with a regular expression whose `(?:…{4})*` repetition V8
// backtracks recursively, so a diff of a few MB overflowed the stack before the first gate. The decode/re-encode
// round trip alone decides canonical Base64: Node's decoder skips characters outside the alphabet and accepts the
// URL-safe one, so anything but the canonical spelling re-encodes differently.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
function cli(request) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(run.stdout);
}
const fingerprint = (base64) => cli({ version: 1, operation: 'fingerprint_pr_diff', data: { base64 } });

test('Issue #219 fingerprint_pr_diff takes a diff larger than the old stack threshold', () => {
  // 6 MiB of diff is 8 MiB of Base64, above the 2.8–5.6 MB range where the regular expression overflowed.
  const bytes = crypto.randomBytes(6 * 1024 * 1024);
  const result = fingerprint(bytes.toString('base64'));
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  assert.equal(result.data.fingerprint, fingerprint(Buffer.from(bytes).toString('base64')).data.fingerprint, 'the same bytes give the same fingerprint');
});

test('Issue #219 fingerprint_pr_diff still refuses every non-canonical spelling', () => {
  const canonical = Buffer.from('diff --git a/x b/x\n+on\n').toString('base64'); // 23 bytes, so it ends in padding
  assert.equal(fingerprint(canonical).ok, true);
  const urlSafe = Buffer.from([0xfb, 0xff, 0xfe]).toString('base64');
  for (const [label, value] of [
    ['missing padding', canonical.replace(/=+$/, '')],
    ['a line break', `${canonical.slice(0, 8)}\n${canonical.slice(8)}`],
    ['a space', ` ${canonical}`],
    ['a character outside the alphabet', `${canonical.slice(0, -4)}*${canonical.slice(-3)}`],
    ['the URL-safe alphabet', urlSafe.replace(/\+/g, '-').replace(/\//g, '_')],
    ['padding in the middle', `${canonical.slice(0, 4)}=${canonical.slice(5)}`],
    ['non-zero padding bits', 'QR=='],
    ['a number', 12],
  ]) {
    const result = fingerprint(value);
    assert.deepEqual([result.ok, result.error?.code], [false, 'invalid_request'], label);
  }
});
