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
    assert.ok(request.task.includes(`Payload file: ${payloadPath}`));
    assert.ok(request.task.includes(`Payload SHA-256: ${payloadSha256}`));
    assert.ok(request.task.includes('gate_payload_verify'), 'the child verifies through the packaged CLI');
    assert.equal(request.task.includes('## Volatile envelope'), false, 'no payload rides in the request');
    // A second build of the same invocation reuses the identical file rather than failing.
    assert.equal(helpers.buildGateLaunch(inputs(dir)).ok, true);
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

test('Issue #188 the payload is never written inside a Git work tree or at a relative path', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'i188-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const inside = path.join(repo, 'nested');
    fs.mkdirSync(inside);
    const refused = helpers.buildGateLaunch(inputs(inside));
    assert.deepEqual([refused.ok, refused.error?.code], [false, 'payload_location_invalid'], JSON.stringify(refused));
    assert.deepEqual(fs.readdirSync(inside).filter((name) => name.startsWith('gate-payload-')), [], 'nothing was written');
    const relative = inputs(fs.mkdtempSync(path.join(os.tmpdir(), 'i188-')));
    const rel = helpers.buildGateLaunch({ ...relative, expectationPath: path.relative(process.cwd(), relative.expectationPath) });
    assert.deepEqual([rel.ok, rel.error?.code], [false, 'payload_location_invalid']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Issue #188 the map and the contract state the pointer rule', () => {
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.match(map, /\| The gate child's first step, on the payload its launch points to \(CL-D91\) \| `gate_payload_verify` \| `path`, `sha256` \|/);
  const contract = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.match(contract, /A packaged gate launch carries a pointer, not the payload: `build_gate_launch` writes the complete task to a run-owned payload file, and the child verifies its SHA-256 with `gate_payload_verify` before reading it completely and following it verbatim \(CL-D91\)\./);
});
