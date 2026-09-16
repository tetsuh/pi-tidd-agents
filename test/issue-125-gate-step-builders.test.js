'use strict';

// Issue #125 (CL-D73) — the three compositions exact autofix still assembled by hand at the gate step
// are packaged. Four autofix runs of PR #124 stopped on them: a `gate_result_validate` request carrying
// the builder's inputs instead of `expected`; an assigned-finding tuple sent without a `blockerKey`;
// and a cleanup request built with `created: null` after the run lost the creation data it had held
// since launch. Each failing shape is reproduced here first, then made unrepresentable or refused with
// a message naming the correct shape.
//
// TDD provenance: pre-implementation compile/contract and behavioral RED, recorded with
// `node --test test/issue-125-gate-step-builders.test.js` before the operations, the record, the alarm
// reset, and the manifest clauses existed. That local output is not claimed as repository-preserved
// evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, repoPath, sectionOf, cliSchemas } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const OID = 'a'.repeat(40);
const RUN = '7305b50a-2708-4e55-8364-d72f11197fbe';
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}
function correlation(gate = 'adversarial') {
  return { repository: 'o/r', number: 125, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
}
const evidence = () => [{ source: 'git:pr_head', kind: 'git', identity: OID }];

// A runner run directory whose status record names the designated output, as gate_result_read reads it.
function runRecord(envelope) {
  const root = temp('issue-125-runs-');
  const runDir = path.join(root, RUN);
  fs.mkdirSync(runDir, { recursive: true });
  const structuredOutputPath = path.join(runDir, 'output.json');
  fs.writeFileSync(structuredOutputPath, JSON.stringify(envelope));
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    runId: RUN, state: 'succeeded', steps: [{ status: 'complete', structuredOutputPath }],
  }));
  return { root, runDir, structuredOutputPath };
}

test('Issue #125 gate_result_read validates the envelope against the expectation file in one result', () => {
  assert.deepEqual(cliSchemas().gate_result_read, ['runId'], 'the run id stays the only required field');
  assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /gate_result_read: \{ required: \['runId'\], optional: \['expectationPath'\] \}/, 'the expectation path is the one optional field');

  const built = cli('build_gate_expectation', { workflow: 'pr', correlation: correlation(), assignedFindings: [], requiredEvidence: evidence() });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  const expected = built.data.expected;
  const envelope = {
    schemaVersion: 2, verdict: 'MERGE', correlation: correlation(),
    evidenceRead: evidence().map(({ source, kind }) => ({ source, kind, readCompletely: true })),
    findings: [], confirmations: [], decisions: [],
    adversarialResults: [{ claim: 'the read returns a file the parent chose', searched: 'the runner status record', outcome: 'no-counterexample', evidence: 'the path is resolved from the run id' }],
  };
  const paths = runRecord(envelope);
  const expectationPath = path.join(paths.root, 'expectation.json');
  fs.writeFileSync(expectationPath, JSON.stringify(expected));
  try {
    // The composition the parent performed by hand: read, then validate, in one packaged operation.
    const read = helpers.readGateResult({ runId: RUN, runsRoot: paths.root, expectationPath });
    assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.equal(read.data.verdict, 'MERGE', 'the validated verdict is returned');
    assert.deepEqual(read.data.correlation, correlation(), 'the validated correlation is returned');
    assert.equal(read.data.envelope === undefined, false, 'the envelope the validation ran against is still reported');

    // The expectation file keeps the launch builder's own fail-closed codes.
    const missing = helpers.readGateResult({ runId: RUN, runsRoot: paths.root, expectationPath: path.join(paths.root, 'absent.json') });
    assert.deepEqual([missing.ok, missing.error.code], [false, 'expectation_file_absent'], JSON.stringify(missing.error));
    // An expectation built for another head is the validator's own refusal, in the validator's own code.
    const otherPath = path.join(paths.root, 'other.json');
    fs.writeFileSync(otherPath, JSON.stringify({ ...expected, correlation: { ...correlation(), headOid: 'c'.repeat(40) } }));
    const mismatch = helpers.readGateResult({ runId: RUN, runsRoot: paths.root, expectationPath: otherPath });
    assert.deepEqual([mismatch.ok, mismatch.error.code], [false, 'correlation_mismatch'], JSON.stringify(mismatch.error));

    // Without the path the read is unchanged: the envelope, unvalidated.
    const plain = helpers.readGateResult({ runId: RUN, runsRoot: paths.root });
    assert.deepEqual([plain.ok, plain.data.verdict, plain.data.envelope.verdict], [true, undefined, 'MERGE'], 'the old shape still returns the envelope alone');

    // A file that is not an expectation at all is the file's fault, not the request's, and the refusal names it.
    const notExpectation = path.join(paths.root, 'not-expectation.json');
    fs.writeFileSync(notExpectation, JSON.stringify({ hello: 'world' }));
    const badFile = helpers.readGateResult({ runId: RUN, runsRoot: paths.root, expectationPath: notExpectation });
    assert.deepEqual([badFile.ok, badFile.error.code], [false, 'expectation_file_mismatch'], JSON.stringify(badFile.error));
    assert.equal(badFile.error.details?.expectationPath, notExpectation, 'the refusal names the file it read');

    // The shape run 4 sent by hand stays refused by the CLI.
    const handComposed = cli('gate_result_validate', { expectation: expected, workflow: 'pr', result: envelope });
    assert.deepEqual([handComposed.ok, handComposed.error.code], [false, 'invalid_request'], JSON.stringify(handComposed.error));
    assert.match(handComposed.error.message, /unknown request field: expectation/);
  } finally { fs.rmSync(paths.root, { recursive: true, force: true }); }
});

test('Issue #125 build_gate_assignments turns findings and settled keys into the tuples the expectation needs', () => {
  assert.deepEqual(cliSchemas().build_gate_assignments, ['findings', 'settledKeys'], 'the builder takes the findings and the ledger');
  // Run 2's stop: a tuple assembled by hand without a blocker key.
  const byHand = cli('build_gate_expectation', { workflow: 'pr', correlation: correlation(), assignedFindings: [{ findingId: 'ADV-125-A' }], requiredEvidence: evidence() });
  assert.deepEqual([byHand.ok, byHand.error.message], [false, 'bad assignments'], JSON.stringify(byHand.error));

  // A fresh finding carries its own id as its key; an explicit reopen carries the settled key.
  const builtAssignments = cli('build_gate_assignments', {
    findings: [{ findingId: 'ADV-125-A' }, { findingId: 'ADV-125-B' }],
    settledKeys: ['ADV-124-OLD'],
    reopens: { 'ADV-125-B': 'ADV-124-OLD' },
  });
  assert.equal(builtAssignments.ok, true, JSON.stringify(builtAssignments.error));
  assert.deepEqual(builtAssignments.data.assignedFindings, [
    { findingId: 'ADV-125-A', blockerKey: 'ADV-125-A' },
    { findingId: 'ADV-125-B', blockerKey: 'ADV-124-OLD' },
  ], 'the fresh finding keys itself and the reopen carries the settled key');

  // The built tuples are exactly what the expectation accepts.
  const expectation = cli('build_gate_expectation', { workflow: 'pr', correlation: correlation(), assignedFindings: builtAssignments.data.assignedFindings, requiredEvidence: evidence() });
  assert.equal(expectation.ok, true, JSON.stringify(expectation.error));

  // A reopen the ledger does not hold is refused, and so is a repeated finding.
  const unknownKey = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-A' }], settledKeys: [], reopens: { 'ADV-125-A': 'ADV-124-OLD' } });
  assert.deepEqual([unknownKey.ok, unknownKey.error.code], [false, 'invalid_request'], JSON.stringify(unknownKey.error));
  assert.match(unknownKey.error.message, /ADV-124-OLD/, 'the refusal names the key the ledger does not hold');
  const repeated = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-A' }, { findingId: 'ADV-125-A' }], settledKeys: [] });
  assert.deepEqual([repeated.ok, repeated.error.code], [false, 'invalid_request'], JSON.stringify(repeated.error));
  const reopenWithoutFinding = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-A' }], settledKeys: ['ADV-124-OLD'], reopens: { 'ADV-125-Z': 'ADV-124-OLD' } });
  assert.deepEqual([reopenWithoutFinding.ok, reopenWithoutFinding.error.code], [false, 'invalid_request'], JSON.stringify(reopenWithoutFinding.error));

  // An assigned finding already carries the key the parent gave it, and that key is immutable: re-keying it to the
  // finding id restarts the no-progress count for the blocker under a new key, which is the transcription error
  // this builder exists to remove.
  const carried = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-B', origin: 'assigned', blockerKey: 'ADV-124-OLD' }], settledKeys: ['ADV-124-OLD'] });
  assert.equal(carried.ok, true, JSON.stringify(carried.error));
  assert.deepEqual(carried.data.assignedFindings, [{ findingId: 'ADV-125-B', blockerKey: 'ADV-124-OLD' }], 'the assigned key is carried through, never replaced by the finding id');
  const disagreeing = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-B', origin: 'assigned', blockerKey: 'ADV-124-OLD' }], settledKeys: ['ADV-124-OLD', 'ADV-124-OTHER'], reopens: { 'ADV-125-B': 'ADV-124-OTHER' } });
  assert.deepEqual([disagreeing.ok, disagreeing.error.code], [false, 'invalid_request'], JSON.stringify(disagreeing.error));
  assert.match(disagreeing.error.message, /ADV-124-OLD/, 'the refusal names the key the finding already carries');
  // A fresh finding whose id is a settled key is a reopen; the parent states it, the builder never assumes it.
  const silentReopen = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-124-OLD' }], settledKeys: ['ADV-124-OLD'] });
  assert.deepEqual([silentReopen.ok, silentReopen.error.code], [false, 'invalid_request'], JSON.stringify(silentReopen.error));
  const statedReopen = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-124-OLD' }], settledKeys: ['ADV-124-OLD'], reopens: { 'ADV-124-OLD': 'ADV-124-OLD' } });
  assert.equal(statedReopen.ok, true, JSON.stringify(statedReopen.error));
});

// A repository with an origin, as workspace_create needs one.
function fixtureRepository() {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
  const root = temp('issue-125-repo-'); const bare = temp('issue-125-origin-');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 125 Test']); git(root, ['config', 'user.email', 'issue125@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base' + String.fromCharCode(10)); git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
  git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

test('Issue #125 workspace_cleanup removes the workspace from its own path, without the receipt the run held', async () => {
  assert.deepEqual(cliSchemas().workspace_cleanup, ['cwd'], 'only the cwd stays required');
  assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /workspace_cleanup: \{ required: \['cwd'\], optional: \['receipt', 'workspace'\] \}/, 'the receipt and the workspace path are the two ways in');

  // Run 3's stop: the cleanup request built from creation data the run had lost.
  const lost = cli('build_workspace_cleanup', { created: null, cwd: '/tmp' });
  assert.deepEqual([lost.ok, lost.error.code], [false, 'input_shape_mismatch'], JSON.stringify(lost.error));

  const repository = fixtureRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;
    assert.ok(fs.existsSync(workspace), 'the workspace exists before cleanup');

    // Neither input given, and both given, are refused before anything is removed.
    const neither = cli('workspace_cleanup', { cwd: repository.root });
    assert.deepEqual([neither.ok, neither.error.code], [false, 'invalid_request'], JSON.stringify(neither.error));
    const both = cli('workspace_cleanup', { cwd: repository.root, workspace, receipt: created.data.receipt });
    assert.deepEqual([both.ok, both.error.code], [false, 'invalid_request'], JSON.stringify(both.error));
    // A path that is not a run-owned workspace is refused by the same identity checks.
    const foreign = cli('workspace_cleanup', { cwd: repository.root, workspace: repository.root });
    assert.equal(foreign.ok, false, JSON.stringify(foreign.data));
    assert.ok(fs.existsSync(workspace), 'nothing was removed by a refused request');

    const removed = cli('workspace_cleanup', { cwd: repository.root, workspace });
    assert.equal(removed.ok, true, JSON.stringify(removed.error));
    assert.deepEqual([removed.data.removed, removed.data.path], [true, workspace], 'the workspace it names is the one removed');
    assert.equal(fs.existsSync(workspace), false, 'the linked worktree is gone');
  } finally { fs.rmSync(repository.root, { recursive: true, force: true }); fs.rmSync(repository.bare, { recursive: true, force: true }); }
});

test('Issue #125 CL-D73 records the three compositions and the reviewed alarm reset', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D73 — The gate step composes no request by hand');
  assert.ok(record, 'CL-D73 must exist');
  for (const field of ['*Decision ID:* CL-D73', '*Kind:* contract', '*Options and trade-offs:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D73 must carry ${field}`);
  }
  assert.match(record, /issues\/125#issuecomment-5665281873/, 'the record cites the owner choice on the three compositions');
  assert.match(record, /issues\/125#issuecomment-5692473758/, 'the record cites the owner choice on the alarm');
  assert.match(record, /Option A on all three/);
  assert.match(record, /resets from 240,000 to 250,000 bytes/);
  assert.match(record, /the parent keeps every judgment it has today and loses only the transcription/);

  // CL-D37 carries the fifth reset beside the four before it.
  const boundary = sectionOf(readText('CONTRACT.md'), '## CL-D37 — Bounded helper surface is structural');
  assert.match(boundary, /CL-D73 reset it a fifth time to 250,000 bytes for the packaged gate-step compositions, on the same terms\./);

  // Every guard that carries the alarm literal carries the new one.
  assert.match(readText('test/issue-59-helper-surface.test.js'), /const AGGREGATE_SMOKE_ALARM = 250000; \/\/ CL-D73 reviewed reset from 240,000 \(CL-D72\)/);
  assert.match(readText('test/package.test.js'), /helperBytes < 250000/);
  assert.equal(readText('test/package.test.js').includes('helperBytes < 240000'), false, 'the superseded alarm must not survive');

  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D73').map((clause) => clause.id).sort(), ['CL-D73-operations', 'CL-D73-record', 'CL-D73-tests']);
  assert.ok(fs.existsSync(repoPath('test/issue-125-gate-step-builders.test.js')));
});

test('Issue #125 the invocation map offers the packaged compositions', () => {
  const map = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map.includes('| `gate_result_read` | `runId`, `expectationPath` (optional; the file `build_gate_launch` verified, which returns the validated envelope in the same result) |'), 'the map offers the read with its optional expectation path');
  assert.ok(map.includes('| `build_gate_assignments` | `findings` (of the validated result), `settledKeys` (the ledger), `reopens` (optional; fresh finding id to the settled key it reopens) |'), 'the map offers the assignments builder');
  assert.ok(map.includes('| `workspace_cleanup` | `cwd`, and either `receipt` (receipt inside `workspace_create` data) or `workspace` (the run workspace path) |'), 'the map offers cleanup from the workspace path');
});

test('Issue #125 workspace_cleanup removes only the workspace the request names', () => {
  const repository = fixtureRepository();
  let runRoot;
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;
    runRoot = created.data.root;

    // The named path located the receipt and was then never compared with what the receipt points at, so a run
    // could name its own workspace and another run's would be removed instead.
    const sibling = cli('workspace_cleanup', { cwd: repository.root, workspace: path.join(runRoot, 'not-the-workspace') });
    assert.deepEqual([sibling.ok, sibling.error.code], [false, 'workspace_mismatch'], JSON.stringify(sibling.data ?? sibling.error));
    assert.ok(fs.existsSync(workspace), 'the workspace nobody named is still there');

    // A relative path in either field has no identity this operation can judge, and no builder stands in front of it.
    const relativeWorkspace = cli('workspace_cleanup', { cwd: repository.root, workspace: 'workspace' });
    assert.deepEqual([relativeWorkspace.ok, relativeWorkspace.error.code], [false, 'cleanup_workspace_relative'], JSON.stringify(relativeWorkspace.data ?? relativeWorkspace.error));
    const relativeCwd = cli('workspace_cleanup', { cwd: 'relative', workspace });
    assert.deepEqual([relativeCwd.ok, relativeCwd.error.code], [false, 'cleanup_cwd_relative'], JSON.stringify(relativeCwd.data ?? relativeCwd.error));

    // The stored receipt authorizes the removal, so it is held to the declared receipt shape, not merely compared
    // with a copy of itself.
    const storedPath = path.join(runRoot, '.cleanup-receipt.json');
    const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
    fs.writeFileSync(storedPath, JSON.stringify({ ...stored, id: undefined }));
    const unshaped = cli('workspace_cleanup', { cwd: repository.root, workspace });
    assert.deepEqual([unshaped.ok, unshaped.error.code], [false, 'cleanup_not_authorized'], JSON.stringify(unshaped.data ?? unshaped.error));
    fs.writeFileSync(storedPath, JSON.stringify(stored));
    assert.ok(fs.existsSync(workspace), 'no refusal removed anything');

    const removed = cli('workspace_cleanup', { cwd: repository.root, workspace });
    assert.equal(removed.ok, true, JSON.stringify(removed.error));
    assert.deepEqual([removed.data.removed, removed.data.path], [true, workspace], 'the workspace it names is the one removed');
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
    if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
