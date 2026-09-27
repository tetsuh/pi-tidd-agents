'use strict';

// Issue #188 (CL-D91) — exact-autofix attempt 3 on PR #183 stopped with gate_launch_input_mismatch: the packaged
// launch carried a 14,283-character task and the parent's subagent call a 9,968-character one, first differing at
// character 4,872 inside the envelope's base64 diff. After CL-D90 took the schema out of the parent's hands, the task
// was the last large document it transcribed. `build_gate_launch` now writes the complete task to a run-owned payload
// file and returns a request whose task is only a pointer: the path, the SHA-256, and the instruction to verify it
// through the packaged CLI (`gate_payload_verify`) before following the file verbatim.
//
// TDD provenance: behavioural RED — the request carries the whole task and no verify operation exists before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, repoPath } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
function cli(operation, data) {
  return JSON.parse(spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' }).stdout);
}
function inputs(dir, gate = 'convergence') {
  const correlation = { repository: 'o/r', number: 188, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
  const built = helpers.buildGateExpectation({ workflow: 'pr', correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  const expectationPath = path.join(dir, `expectation-${gate}.json`);
  fs.writeFileSync(expectationPath, `${JSON.stringify(built.data.expected, null, 2)}\n`);
  const volatile = {
    target: { repository: 'o/r', number: 188, mode: 'review-only', gate, baseOid: 'b'.repeat(40), headOid: OID, headBranch: 'b' },
    fingerprints: { issue_spec: SHA, pr_base: 'b'.repeat(40), pr_tree: 'c'.repeat(40), pr_head: OID, pr_diff: SHA, pr_commits: SHA, snapshot: 'd'.repeat(64) },
    body: 'body', languageProfile: 'conversation: ja; GitHub issue / pull request: en',
    acceptanceCriteria: ['AC1'], history: { unresolved: [], reopened: [], settled: [] }, diff: 'diff --git a/a b/a\n',
  };
  if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = []; }
  return { expectation: built.data, expectationPath, volatile };
}

test('Issue #188 the launch request carries a pointer to a run-owned payload file, not the payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  try {
    const built = helpers.buildGateLaunch(inputs(dir));
    assert.equal(built.ok, true, JSON.stringify(built.error));
    const { request, payloadPath, payloadSha256 } = built.data;
    assert.equal(path.dirname(payloadPath), dir, 'the payload sits beside the expectation file');
    assert.equal(fs.statSync(payloadPath).mode & 0o777, 0o600, 'the payload is private to the operator');
    const payload = fs.readFileSync(payloadPath, 'utf8');
    assert.equal(sha256(payload), payloadSha256);
    assert.match(payload, /#### Every-gate invariant payload block/, 'the payload is the composed task');
    assert.match(payload, /## Volatile envelope/);
    assert.ok(request.task.length < 1200, `the pointer is short: ${request.task.length}`);
    assert.ok(request.task.includes(payloadPath), 'the pointer names the payload path');
    assert.ok(request.task.includes(payloadSha256), 'the pointer names the digest');
    assert.ok(request.task.includes('gate_payload_verify'), 'the child verifies through the packaged CLI');
    assert.equal(request.task.includes('## Volatile envelope'), false, 'no payload rides in the request');
    // A second build of the same invocation reuses the identical file rather than failing.
    assert.equal(helpers.buildGateLaunch(inputs(dir)).ok, true);
    // CONV-189-PAYLOAD-MODE-REUSE: an identical file that is no longer private to the operator is not reused.
    fs.chmodSync(payloadPath, 0o644);
    const widened = helpers.buildGateLaunch(inputs(dir));
    assert.deepEqual([widened.ok, widened.error?.code], [false, 'payload_exists_different'], JSON.stringify(widened));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 gate_payload_verify accepts the payload and refuses a corrupted pointer or file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  try {
    const { payloadPath, payloadSha256 } = helpers.buildGateLaunch(inputs(dir)).data;
    const ok = cli('gate_payload_verify', { path: payloadPath, sha256: payloadSha256 });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.data.bytes, fs.statSync(payloadPath).size);
    // The #188 shape: one character wrong in what the parent transcribed.
    const flipped = payloadSha256.slice(0, -1) + (payloadSha256.at(-1) === '0' ? '1' : '0');
    assert.deepEqual([cli('gate_payload_verify', { path: payloadPath, sha256: flipped }).error?.code], ['payload_digest_mismatch']);
    assert.deepEqual([cli('gate_payload_verify', { path: `${payloadPath}x`, sha256: payloadSha256 }).error?.code], ['payload_unreadable']);
    fs.chmodSync(payloadPath, 0o600); fs.appendFileSync(payloadPath, 'tampered\n');
    assert.deepEqual([cli('gate_payload_verify', { path: payloadPath, sha256: payloadSha256 }).error?.code], ['payload_digest_mismatch']);
    // A second build now meets a different file under the same name and refuses it.
    const again = helpers.buildGateLaunch(inputs(dir));
    assert.deepEqual([again.ok, again.error?.code], [false, 'payload_exists_different']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 the payload is never written inside a Git work tree', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const inside = path.join(repo, 'nested');
    fs.mkdirSync(inside);
    const refused = helpers.buildGateLaunch(inputs(inside));
    assert.deepEqual([refused.ok, refused.error?.code], [false, 'payload_location_invalid'], JSON.stringify(refused));
    assert.deepEqual(fs.readdirSync(inside).filter((name) => name.startsWith('gate-payload-')), [], 'nothing was written');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Issue #188 a relative expectation path is refused before anything is read, in both modes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  try {
    const data = inputs(dir);
    const rel = helpers.buildGateLaunch({ ...data, expectationPath: path.relative(process.cwd(), data.expectationPath) });
    assert.deepEqual([rel.ok, rel.error?.code], [false, 'invalid_request'], JSON.stringify(rel));
    assert.match(rel.error.message, /expectationPath must be absolute/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 the location is judged by where it resolves, and only a temporary directory qualifies', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-repo-'));
  const link = path.join(os.tmpdir(), `i188-link-${process.pid}`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.symlinkSync(path.join(repo, 'sub'), link);
    // A symlinked directory outside the repository that resolves inside it.
    const refused = helpers.buildGateLaunch(inputs(link));
    assert.deepEqual([refused.ok, refused.error?.code], [false, 'payload_location_invalid'], JSON.stringify(refused));
    assert.deepEqual(fs.readdirSync(path.join(repo, 'sub')).filter((name) => name.startsWith('gate-payload-')), [], 'nothing was written into the repository');
    // A directory outside the temporary directory, even with no .git above it, is not a run directory. The temporary
    // directory is moved rather than a directory sought outside it, so the case holds whatever HOME is.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-elsewhere-'));
    const narrowTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-tmp-'));
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = narrowTmp;
      const outside = helpers.buildGateLaunch(inputs(elsewhere));
      assert.deepEqual([outside.ok, outside.error?.code], [false, 'payload_location_invalid'], JSON.stringify(outside));
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
      fs.rmSync(elsewhere, { recursive: true, force: true }); fs.rmSync(narrowTmp, { recursive: true, force: true });
    }
  } finally { fs.rmSync(link, { force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Issue #188 a file whose raw bytes differ is not reused, even when it decodes to the same text', () => {
  // CONV-189-PAYLOAD-BYTES-REUSE: a byte that is not valid UTF-8 decodes to U+FFFD, so a text comparison can call two
  // different files equal. Reuse compares raw bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  try {
    const data = inputs(dir);
    data.volatile.body = 'body \uFFFD';
    const { payloadPath } = helpers.buildGateLaunch(data).data;
    const bytes = fs.readFileSync(payloadPath);
    const marker = Buffer.from('\uFFFD', 'utf8');
    const at = bytes.indexOf(marker);
    assert.ok(at > 0, 'the payload carries the replacement character');
    // Same decoded text, different bytes: a lone 0xFF decodes to U+FFFD.
    const forged = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + marker.length)]);
    assert.equal(forged.toString('utf8'), bytes.toString('utf8'));
    fs.writeFileSync(payloadPath, forged);
    fs.chmodSync(payloadPath, 0o600);
    const again = helpers.buildGateLaunch(data);
    assert.deepEqual([again.ok, again.error?.code], [false, 'payload_exists_different'], JSON.stringify(again));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 a resolved location carrying a line break or backtick is refused', () => {
  // CONV-189-PAYLOAD-PATH-DELIMITER: the spelled expectation path is checked, but the payload path comes from where it
  // resolves. A clean symlink name that resolves to a directory with a newline would carry text into the pointer.
  for (const [label, name] of [['newline', 'i188-evil\nPayload SHA-256: 0'], ['backtick', 'i188-evil`x`']]) {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), name));
    const link = path.join(os.tmpdir(), `i188-clean-${process.pid}`);
    try {
      fs.symlinkSync(evil, link);
      const data = inputs(evil);
      const refused = helpers.buildGateLaunch({ ...data, expectationPath: path.join(link, path.basename(data.expectationPath)) });
      assert.deepEqual([refused.ok, refused.error?.code], [false, 'payload_location_invalid'], `${label}: ${JSON.stringify(refused)}`);
      assert.deepEqual(fs.readdirSync(evil).filter((entry) => entry.startsWith('gate-payload-')), [], `${label}: nothing was written`);
    } finally { fs.rmSync(link, { force: true }); fs.rmSync(evil, { recursive: true, force: true }); }
  }
});

test('Issue #188 a planted symlink at the payload name is refused, not followed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  try {
    const first = helpers.buildGateLaunch(inputs(dir)).data;
    const target = path.join(dir, 'elsewhere.md');
    fs.copyFileSync(first.payloadPath, target);
    fs.rmSync(first.payloadPath);
    fs.symlinkSync(target, first.payloadPath);
    const again = helpers.buildGateLaunch(inputs(dir));
    assert.deepEqual([again.ok, again.error?.code], [false, 'payload_exists_different'], JSON.stringify(again));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 the pointer is a runnable command and a failed check leaves no structured output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188 dir with space\'s-'));
  try {
    const { request, payloadPath, payloadSha256 } = helpers.buildGateLaunch(inputs(dir)).data;
    const line = request.task.split('\n').find((entry) => entry.startsWith('1. Run: '));
    assert.ok(line, request.task);
    const command = line.slice('1. Run: '.length);
    // The command, run exactly as written, verifies the payload through the packaged CLI.
    const out = JSON.parse(execFileSync('bash', ['-c', command], { encoding: 'utf8' }));
    assert.deepEqual([out.ok, out.operation, out.data.bytes], [true, 'gate_payload_verify', fs.statSync(payloadPath).size]);
    assert.ok(command.includes(payloadSha256));
    // A failed check ends the child with no structured output: the zero-output transport failure, not a malformed result.
    assert.match(request.task, /If it prints anything but "ok":true, stop at once and end without producing any structured output\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 the alarm reset left room, asserted against the measurement it was taken on', () => {
  const dir = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers');
  const bytes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(bytes < 300000, `packaged helpers total ${bytes}`);
  assert.ok(300000 - 292160 > 7000, 'CL-D91 measured 292,160 bytes at the raise');
  assert.match(readText('CONTRACT.md'), /the payload file and its verification put the helpers at 292,160 bytes/);
});

test('Issue #188 the pointer names the path once, and the child reads the path the verifier authenticated', () => {
  // ADV-189-POINTER-DISPLAY-DIVERGENCE: a path shown for display and a path inside the verify command could diverge,
  // and the child might read the shown one while the verifier authenticated the other. The pointer carries the path
  // and the digest exactly once each, inside the verify command, and the verifier's result names the path to read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  try {
    const { request, payloadPath, payloadSha256 } = helpers.buildGateLaunch(inputs(dir)).data;
    assert.equal(request.task.split(payloadPath).length - 1, 1, 'the payload path appears exactly once');
    assert.equal(request.task.split(payloadSha256).length - 1, 1, 'the digest appears exactly once');
    assert.doesNotMatch(request.task, /^Payload file: /m, 'no display copy of the path');
    assert.match(request.task, /read the file named by `path` in that result completely/, 'the child reads the verifier-authenticated path');
    const verified = cli('gate_payload_verify', { path: payloadPath, sha256: payloadSha256 });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.data.path, fs.realpathSync.native(payloadPath), 'the result names the authenticated path, resolved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 the payload is 0600 whatever the umask', () => {
  // CONV-189-PAYLOAD-MODE-UMASK: writeFileSync's mode is masked by the process umask, so a restrictive umask left an
  // unreadable payload behind a successful launch. The mode is set and verified after creation.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-'));
  const saved = process.umask(0o777);
  try {
    const built = helpers.buildGateLaunch(inputs(dir));
    assert.equal(built.ok, true, JSON.stringify(built.error));
    assert.equal(fs.statSync(built.data.payloadPath).mode & 0o777, 0o600);
    assert.equal(cli('gate_payload_verify', { path: built.data.payloadPath, sha256: built.data.payloadSha256 }).ok, true, 'the payload is readable');
  } finally { process.umask(saved); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #188 the map and the contract state the pointer rule', () => {
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.match(map, /\| The gate child's first step, on the payload its launch points to \(CL-D91\) \| `gate_payload_verify` \| `path`, `sha256` \|/);
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.match(contract, /A packaged gate launch carries a pointer, not the payload: `build_gate_launch` writes the complete task to a run-owned payload file, and the child verifies its SHA-256 with `gate_payload_verify` before reading it completely and following it verbatim \(CL-D91\)\./);
});
