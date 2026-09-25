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
const { readAutofixProcedure, readText, repoPath, sectionOf, cliSchemas } = require('./helpers');

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

    // Version parity: the read validates with the envelope's own version, as the two-step path does, so a v1
    // envelope and its v1 expectation are accepted by both or by neither (CL-D60 keeps v1 verbatim for a release).
    const v1Correlation = correlation('sol');
    const v1Envelope = {
      schemaVersion: 1, verdict: 'MERGE', correlation: v1Correlation,
      evidenceRead: evidence().map(({ source, kind }) => ({ source, kind, readCompletely: true })),
      findings: [], confirmations: [], decisions: [],
      adversarialResults: [{ claim: 'c', searched: 's', outcome: 'no-counterexample', evidence: 'e' }],
    };
    const v1Expected = { workflow: 'pr', correlation: v1Correlation, assignedFindings: [], requiredEvidence: evidence() };
    const v1Paths = runRecord(v1Envelope);
    const v1Path = path.join(v1Paths.root, 'v1-expectation.json');
    fs.writeFileSync(v1Path, JSON.stringify(v1Expected));
    try {
      const twoStep = helpers.validateGateResult(v1Envelope, v1Expected);
      const oneStep = helpers.readGateResult({ runId: RUN, runsRoot: v1Paths.root, expectationPath: v1Path });
      assert.deepEqual([oneStep.ok, twoStep.ok], [true, true], JSON.stringify(oneStep.error ?? twoStep.error));
    } finally { fs.rmSync(v1Paths.root, { recursive: true, force: true }); }

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

  // Only an assigned finding carries a key, and it always carries one: a key on a fresh finding is invented, and an
  // assigned finding without one has lost the key the parent gave it. Both were emitted as tuples before.
  const invented = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-A', blockerKey: 'MADE-UP' }], settledKeys: [] });
  assert.deepEqual([invented.ok, invented.error.code], [false, 'invalid_request'], JSON.stringify(invented.data ?? invented.error));
  const assignedWithoutKey = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-A', origin: 'assigned' }], settledKeys: [] });
  assert.deepEqual([assignedWithoutKey.ok, assignedWithoutKey.error.code], [false, 'invalid_request'], JSON.stringify(assignedWithoutKey.data ?? assignedWithoutKey.error));
  // An assigned finding's key is not in the settled ledger while its blocker is still open, so it is accepted.
  const openAssigned = cli('build_gate_assignments', { findings: [{ findingId: 'ADV-125-A', origin: 'assigned', blockerKey: 'ADV-124-OPEN' }], settledKeys: [] });
  assert.deepEqual(openAssigned.data.assignedFindings, [{ findingId: 'ADV-125-A', blockerKey: 'ADV-124-OPEN' }], JSON.stringify(openAssigned.error));
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
  let runRoot;
  assert.deepEqual(cliSchemas().workspace_cleanup, ['cwd'], 'only the cwd stays required');
  assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /workspace_cleanup: \{ required: \['cwd'\], optional: \['receipt', 'workspace'\] \}/, 'the receipt and the workspace path are the two ways in');
  // The fields a stored identity must state, exactly: a field it may omit is one the comparison never holds it to.
  assert.match(readText('skills/closed-loop-pr/helpers/workspace.js'), /const STATED_IDENTITY = 'kind path detached gitDir commonGitDir originFetch originPush head tree registered'\.split\(' '\);/, 'the stated-identity list is pinned exactly');

  // Run 3's stop: the cleanup request built from creation data the run had lost.
  const lost = cli('build_workspace_cleanup', { created: null });
  assert.deepEqual([lost.ok, lost.error.code], [false, 'input_shape_mismatch'], JSON.stringify(lost.error));

  const repository = fixtureRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;
    runRoot = created.data.root;
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
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
    if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true });
  }
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
  assert.match(record, /resets from 240,000 to 260,000 bytes/);
  assert.match(record, /the parent keeps every judgment it has today and loses only the transcription/);

  // CL-D37 carries the fifth reset beside the four before it.
  const boundary = sectionOf(readText('CONTRACT.md'), '## CL-D37 — Bounded helper surface is structural');
  assert.match(boundary, /CL-D73 reset it a fifth time to 260,000 bytes for the packaged gate-step compositions, on the same terms\./);

  // Every guard that carries the alarm literal carries the new one.
  assert.match(readText('test/issue-59-helper-surface.test.js'), /const AGGREGATE_SMOKE_ALARM = 290000; \/\/ CL-D89 reviewed reset from 280,000 \(CL-D86\)/);
  assert.match(readText('test/package.test.js'), /helperBytes < 290000/);
  assert.equal(readText('test/package.test.js').includes('helperBytes < 240000'), false, 'the superseded alarm must not survive');

  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D73').map((clause) => clause.id).sort(), ['CL-D73-addendum', 'CL-D73-operations', 'CL-D73-record', 'CL-D73-tests', 'CL-D73-transport']);
  const byId = Object.fromEntries(manifest.clauses.map((clause) => [clause.id, clause]));
  assert.equal(byId['CL-D73-transport'].section, '### Structured gate result transport (CL-D36)', 'the transport clause names the section its sentences live in');
  assert.equal(byId['CL-D73-addendum'].section, '### Exact identity and Luna publication phases', 'the addendum clause names the section its sentence lives in');
  assert.ok(fs.existsSync(repoPath('test/issue-125-gate-step-builders.test.js')));
});

test('Issue #125 the invocation map offers the packaged compositions', () => {
  const map = sectionOf(readAutofixProcedure(), '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map.includes('| `gate_result_read` | `runId`, `expectationPath` (optional; the file `build_gate_launch` verified, which returns the validated envelope in the same result) |'), 'the map offers the read with its optional expectation path');
  assert.ok(map.includes('| `build_gate_assignments` | `findings` (of the validated result), `settledKeys` (the ledger), `reopens` (optional; fresh finding id to the settled key it reopens) |'), 'the map offers the assignments builder');
  assert.ok(map.includes('| `workspace_cleanup` | `cwd`, and either `receipt` (receipt inside `workspace_create` data) or `workspace` (the run workspace path) |'), 'the map offers cleanup from the workspace path');
});

test('Issue #125 workspace_cleanup removes only the workspace the request names', async () => {
  const repository = fixtureRepository();
  let runRoot;
  let probeRoot;
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

    // A cwd the request carries but does not state is not a cwd: an empty or null value took the repository from
    // the receipt the request had just located.
    for (const empty of ['', null]) {
      const emptyCwd = cli('workspace_cleanup', { cwd: empty, workspace });
      assert.deepEqual([emptyCwd.ok, emptyCwd.error.code], [false, 'cleanup_cwd_relative'], JSON.stringify(emptyCwd.data ?? emptyCwd.error));
    }

    // The stored receipt must carry what a run writes: a nonempty id and a creation identity. A file with neither
    // authorized a removal, and a file without a creation identity crashed the comparison meant to guard it.
    const genuine = fs.readFileSync(storedPath, 'utf8');
    for (const forged of [
      { version: 1, id: null, creationIdentity: { kind: 'linked', path: workspace } },
      { version: 1, id: 'x' },
      // An identity that states nothing matches everything: inspectWorkspace compares only the fields it is given.
      { version: 1, id: 'x', creationIdentity: { kind: 'linked', path: workspace } },
      { version: 1, id: 'x', creationIdentity: { kind: 'linked' } },
    ]) {
      fs.writeFileSync(storedPath, JSON.stringify(forged));
      const out = cli('workspace_cleanup', { cwd: repository.root, workspace });
      assert.deepEqual([out.ok, out.error.code], [false, 'cleanup_not_authorized'], JSON.stringify(out.data ?? out.error));
      assert.ok(fs.existsSync(workspace), 'no forged receipt removed anything');
    }
    // A complete identity that states a path of the wrong type reached Node's own error before any check ran.
    const genuineStored = JSON.parse(genuine);
    fs.writeFileSync(storedPath, JSON.stringify({ ...genuineStored, creationIdentity: { ...genuineStored.creationIdentity, path: null } }));
    const badPath = cli('workspace_cleanup', { cwd: repository.root, workspace });
    assert.deepEqual([badPath.ok, badPath.error.code], [false, 'cleanup_not_authorized'], JSON.stringify(badPath.data ?? badPath.error));

    // Bytes that are not a receipt at all are the same refusal as a receipt that says the wrong thing: a parse
    // failure is the stored file failing, not the operation, and it carries the operation's own code.
    const malformed = ['{"version":1,', String.fromCharCode(0, 1) + 'garbage', ''];
    for (const bytes of malformed) {
      fs.writeFileSync(storedPath, bytes);
      const viaWorkspace = cli('workspace_cleanup', { cwd: repository.root, workspace });
      assert.deepEqual([viaWorkspace.ok, viaWorkspace.error.code], [false, 'cleanup_not_authorized'], JSON.stringify(viaWorkspace.data ?? viaWorkspace.error));
      const viaReceiptForm = cli('workspace_cleanup', { cwd: repository.root, receipt: { ...JSON.parse(genuine), root: runRoot, storedPath } });
      assert.deepEqual([viaReceiptForm.ok, viaReceiptForm.error.code], [false, 'cleanup_not_authorized'], JSON.stringify(viaReceiptForm.data ?? viaReceiptForm.error));
      assert.ok(fs.existsSync(workspace), 'no unreadable receipt removed anything');
    }
    fs.writeFileSync(storedPath, genuine);

    // Both ways in are held to the same stored identity: a forger who wrote the file supplies an equal copy, so a
    // receipt the request carries proves nothing the stored file does not.
    const incomplete = { version: 1, id: 'x', creationIdentity: { kind: 'linked', path: workspace } };
    fs.writeFileSync(storedPath, JSON.stringify(incomplete));
    const viaReceipt = cli('workspace_cleanup', { cwd: repository.root, receipt: { ...incomplete, root: runRoot, storedPath } });
    assert.deepEqual([viaReceipt.ok, viaReceipt.error.code], [false, 'cleanup_not_authorized'], JSON.stringify(viaReceipt.data ?? viaReceipt.error));
    assert.ok(fs.existsSync(workspace), 'the receipt form refuses what the workspace form refuses');
    fs.writeFileSync(storedPath, genuine);

    // A lower layer's failure is not this operation's vocabulary: an errno never becomes the code, and a receipt
    // that is present but unreadable is a read that failed, not a receipt that does not match. Both are probed on a
    // second workspace, because each leaves the run it touches unusable.
    const probe = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(probe.ok, true, JSON.stringify(probe.error));
    probeRoot = probe.data.root;
    // Only where the mode actually withholds a read: root bypasses it, and Windows applies it to writes alone.
    if (process.platform !== 'win32' && (process.getuid === undefined || process.getuid() !== 0)) {
      fs.chmodSync(path.join(probeRoot, '.cleanup-receipt.json'), 0);
      const unreadable = cli('workspace_cleanup', { cwd: repository.root, workspace: probe.data.path });
      fs.chmodSync(path.join(probeRoot, '.cleanup-receipt.json'), 0o600);
      assert.match(unreadable.error.code, /^[a-z_]+$/, 'the code is this operation\'s own vocabulary, never an errno');
      assert.notEqual(unreadable.error.code, 'cleanup_not_authorized', 'a receipt that cannot be read is not a receipt that does not match');
      assert.ok(fs.existsSync(probe.data.path), 'no unreadable receipt removed anything');
    }

    // The same, for a workspace directory removed by hand while its receipt and registration stay in place.
    fs.rmSync(probe.data.path, { recursive: true, force: true });
    const vanished = cli('workspace_cleanup', { cwd: repository.root, workspace: probe.data.path });
    assert.match(vanished.error.code, /^[a-z_]+$/, 'a missing directory is reported in this operation\'s vocabulary');

    // A receipt sits beside the workspace it was written for, not beside whatever path a request names: a copy of it
    // in an unrelated directory, next to a symlink, removed the workspace and left the real receipt orphaned.
    const elsewhere = temp('issue-125-elsewhere-');
    fs.writeFileSync(path.join(elsewhere, '.cleanup-receipt.json'), genuine);
    fs.symlinkSync(workspace, path.join(elsewhere, 'link'));
    const copied = cli('workspace_cleanup', { cwd: repository.root, workspace: path.join(elsewhere, 'link') });
    assert.deepEqual([copied.ok, copied.error.code], [false, 'workspace_mismatch'], JSON.stringify(copied.data ?? copied.error));
    assert.ok(fs.existsSync(workspace), 'a copied receipt removed nothing');
    fs.rmSync(elsewhere, { recursive: true, force: true });

    // The cwd a request states is the cwd, whether or not a caller repeats it as the second argument.
    const inProcess = await helpers.cleanupWorkspace({ cwd: repository.root, workspace });
    assert.equal(inProcess.ok, true, JSON.stringify(inProcess.error));
    assert.deepEqual([inProcess.data.removed, inProcess.data.path], [true, workspace], 'the workspace it names is the one removed');
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
    if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true });
    if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

const TRANSPORT_READ = "That read also accepts the expectation file `build_gate_launch` has already verified and returns the envelope validated by `gate_result_validate`'s own code, with that code's own refusals except that its `invalid_request`, always the expectation's, is reported as the file's fault, in the same result, so the parent carries no document from one operation into the next (CL-D73).";
const TRANSPORT_TUPLES = "built by packaged `build_gate_assignments` from the validated result's findings, the settled ledger's keys, and the reopens the parent states, so the parent states which blocker a finding reopens and transcribes no tuple (CL-D73)";
const ADDENDUM = "It governs the gate step's requests too: packaged `gate_result_read`, given its expectation file, validates the result, packaged `build_gate_assignments` builds the assigned tuples, and packaged `workspace_cleanup` takes the workspace path (CL-D73).";

test('Issue #125 the transport section and the addendum name the packaged compositions', () => {
  const transport = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '### Structured gate result transport (CL-D36)');
  assert.ok(transport, 'the transport section exists');
  assert.ok(transport.includes(TRANSPORT_READ), 'the transport section states what the packaged read returns');
  assert.ok(transport.includes(TRANSPORT_TUPLES), 'the transport section states who builds the tuples');
  // The addendum states it beside the rule it extends, not in a section of its own.
  const phases = sectionOf(readText('skills/closed-loop-pr/references/autofix-addendum.md'), '### Exact identity and Luna publication phases');
  assert.ok(phases.includes(ADDENDUM), 'the addendum names all three operations and their package-owned usage');
});
