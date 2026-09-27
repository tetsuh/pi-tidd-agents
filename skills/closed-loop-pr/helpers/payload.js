'use strict';

// Issue #188 (CL-D91): the gate task is written once, here, to a run-owned payload file, and the launch request carries
// only a pointer: the path, the SHA-256, and the instruction to verify it with gate_payload_verify before following the
// file verbatim. The parent re-typed the 14 KB task and corrupted it; a pointer is short, and a corrupted one fails the
// child's verification instead of reaching a review.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResult, createError } = require('./protocol');

const CLI_PATH = path.join(__dirname, 'cli.js');
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }

// The payload lives beside the expectation file, in the run's own directory: an absolute location outside every Git
// work tree, so neither the operator checkout nor the workspace gains a file. A same-named file is reused only when
// its bytes are the payload's, and never overwritten (CL-D91).
function writePayload(expectationPath, correlation, payload) {
  if (!path.isAbsolute(expectationPath)) fail('payload_location_invalid', 'the payload is written beside the expectation file, which must be absolute');
  // Judged where it resolves, not as spelled: a symlinked directory that lands in a repository is in that repository.
  // A run directory is a temporary directory, which also keeps the payload out of a work tree whose .git lives elsewhere.
  let dir;
  try { dir = fs.realpathSync.native(path.dirname(expectationPath)); } catch (error) { fail('payload_location_invalid', `the payload location does not resolve: ${error.message}`); }
  const tmp = fs.realpathSync.native(os.tmpdir());
  const underTmp = path.relative(tmp, dir);
  if (!underTmp || underTmp.startsWith('..') || path.isAbsolute(underTmp)) fail('payload_location_invalid', 'the payload location is not inside the temporary directory', { dir, tmp });
  for (let at = dir; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) fail('payload_location_invalid', 'the payload location is inside a Git work tree', { dir, repository: at });
    if (path.dirname(at) === at) break;
  }
  const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const payloadPath = path.join(dir, `gate-payload-${correlation.gate}-${correlation.invocation}-${payloadSha256.slice(0, 12)}.md`);
  try { fs.writeFileSync(payloadPath, payload, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') fail('payload_write_failed', `the payload file could not be written: ${error.message}`, { payloadPath });
    // A same-named entry is reused only when it is a private regular file holding these exact bytes, compared raw so no
    // decoding can make two files equal; a link or anything else is not.
    const existing = fs.lstatSync(payloadPath);
    if (!existing.isFile() || (existing.mode & 0o777) !== 0o600 || !fs.readFileSync(payloadPath).equals(Buffer.from(payload, 'utf8'))) fail('payload_exists_different', 'a different or no longer private entry already holds this payload name', { payloadPath });
  }
  return { payloadPath, payloadSha256 };
}
// A single-quoted shell word, so a path with spaces or quotes survives being run as written.
function shellWord(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function payloadPointer(payloadPath, payloadSha256) {
  const request = JSON.stringify({ version: 1, operation: 'gate_payload_verify', data: { path: payloadPath, sha256: payloadSha256 } });
  return [
    'Your complete gate payload is the file below; this message is only its pointer (CL-D91).',
    `Payload file: ${payloadPath}`,
    `Payload SHA-256: ${payloadSha256}`,
    `1. Run: printf '%s' ${shellWord(request)} | node ${shellWord(CLI_PATH)}`,
    'If it prints anything but "ok":true, stop at once and end without producing any structured output.',
    '2. Otherwise read the payload file completely, then follow it verbatim as your task.',
    '',
  ].join('\n');
}
// Operation gate_payload_verify: the child's first step, on the file its launch points to (CL-D91).
function verifyGatePayload(data) {
  const operation = 'gate_payload_verify';
  try {
    if (!plain(data) || !text(data.path) || !path.isAbsolute(data.path)) fail('invalid_request', 'path must be the absolute payload path');
    if (typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) fail('invalid_request', 'sha256 must be 64 lowercase hex digits');
    let bytes;
    try { bytes = fs.readFileSync(data.path); } catch (error) { fail('payload_unreadable', `the payload file is not readable: ${error.message}`, { path: data.path }); }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== data.sha256) fail('payload_digest_mismatch', 'the payload file does not have the digest the launch names; do not review', { path: data.path, actual });
    return createResult(operation, { bytes: bytes.length });
  } catch (error) {
    return createError(operation, error.code || 'verify_failed', error.message, operation, error.details);
  }
}

module.exports = { writePayload, payloadPointer, verifyGatePayload };
