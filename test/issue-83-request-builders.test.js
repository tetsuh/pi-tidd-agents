'use strict';

// Issue #83 (CL-D56) — package-owned request builders make correct documents constructible,
// not just checkable. Each documented composition has a builder that constructs the consuming
// request from its producing operation's result and validates the construction with the
// boundary's own predicates before returning it, so a builder output the boundary would
// reject is unrepresentable. `build_gate_expectation` additionally returns the canonical
// CL-D36 structured-output schema — CL-D47's derived-namespace rule applied to schemas.
//
// TDD provenance: recorded with the focused command below at 0 passes. The prose, CLI-table,
// and record fixtures are compile/contract RED; the round-trip and rejection fixtures are
// behavioral RED — they execute operations the packaged CLI does not yet expose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { readText, sectionOf, cliSchemas } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const BUILDERS = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'builders.js');

const OID = 'a'.repeat(40);
function envelopeOf(operation, data) { return { version: 1, ok: true, operation, data }; }
function captureData() { return { root: '/repo', head: OID, tree: 'b'.repeat(40), identity: { repository: 'tetsuh/pi-tidd-agents' }, trackingRef: OID }; }
function receipt() { return { version: 1, id: 'run-1', root: '/run', storedPath: '/run/.cleanup-receipt.json', creationIdentity: { kind: 'linked', path: '/run/workspace' } }; }
function createData() { return { path: '/run/workspace', head: OID, tree: 'b'.repeat(40), root: '/run', kind: 'linked', receipt: receipt(), cleanupAllowed: true }; }
function cloneData() {
  const { receipt: dropped, ...rest } = createData();
  return { ...rest, kind: 'clone', cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable' };
}
function producerSnapshotData() {
  return {
    before: {}, after: {}, pull: {}, completeness: {}, policies: {},
    annotations: [], checkSuites: [], checks: [], comments: [], inline: [], reviews: [], statuses: [], threads: [],
  };
}
function correlation() {
  return {
    repository: 'tetsuh/pi-tidd-agents', number: 83, baseOid: 'c'.repeat(40),
    headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'feat/issue-83-request-builders',
    headOid: OID, lifecycle: 'open', draft: false, gate: 'sol', invocation: 1,
    contractInput: 'd'.repeat(64), snapshotFingerprint: 'e'.repeat(64),
  };
}
function expectationInput() {
  return {
    workflow: 'pr', correlation: correlation(), assignedFindings: [],
    requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: 'f'.repeat(64) }],
  };
}
function gateOutput() {
  return {
    schemaVersion: 1, correlation: correlation(), verdict: 'MERGE',
    evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: 'f'.repeat(64), readCompletely: true }],
    findings: [], confirmations: [], decisions: [],
    adversarialResults: [{ claim: 'builders', searched: 'the helper boundary', outcome: 'no-counterexample', evidence: 'complete' }],
  };
}

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8',
  });
  return JSON.parse(run.stdout);
}
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function builderRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-83-builders-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-83-origin-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 83 Test']);
  git(root, ['config', 'user.email', 'issue83@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'test: builder base']);
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

test('Issue #83 the invocation map offers every builder and the builder paragraph', () => {
  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map, 'the invocation map must exist');
  for (const declaration of [
    '| `build_operator_revalidate` | `captured` (envelope of `operator_capture`), `cwd` |',
    '| `build_workspace_verify` | `created` (data of `workspace_create`), `cwd` |',
    '| `build_workspace_cleanup` | `created` (data of `workspace_create`), `cwd` |',
    '| `build_fingerprint_snapshot` | `snapshot` (data of `snapshot`) |',
    '| `build_gate_expectation` | `workflow`, `correlation`, `assignedFindings`, `requiredEvidence` |',
  ]) assert.ok(map.includes(declaration), `map must declare ${declaration}`);
  assert.match(map, /validates the construction with the boundary's own predicates before returning it, so a builder output the boundary would reject is unrepresentable/);
  assert.match(map, /Builders are read-only, reach no network, filesystem, or Git, and grant no authority/);
  assert.match(map, /rejects invalid inputs with the boundary's vocabulary at phase `build`/);
  assert.match(map, /returns the canonical CL-D36 structured-output schema, so the parent copies a derivation instead of re-authoring one/);
  assert.match(map, /Prefer a builder over hand-assembly wherever one exists/);
});

test('Issue #83 the CLI exposes exactly the five builder operations with frozen inputs', () => {
  const schemas = cliSchemas();
  assert.deepEqual(schemas.build_operator_revalidate, { required: ['captured', 'cwd'], optional: ['postPushHead'] });
  assert.deepEqual(schemas.build_workspace_verify, { required: ['created', 'cwd'], optional: ['transition'] });
  assert.deepEqual(schemas.build_workspace_cleanup, { required: ['created', 'cwd'], optional: [] });
  assert.deepEqual(schemas.build_fingerprint_snapshot, { required: ['snapshot'], optional: [] });
  assert.deepEqual(schemas.build_gate_expectation, { required: ['workflow', 'correlation', 'assignedFindings', 'requiredEvidence'], optional: [] });
  assert.equal(Object.keys(schemas).filter((operation) => operation.startsWith('build_')).length, 5, 'the builder family is exactly the five owner-approved compositions');
});

test('Issue #83 builders are pure: no filesystem, process, network, or Git reach', () => {
  const source = readText('skills/closed-loop-pr/helpers/builders.js');
  for (const forbidden of ['node:fs', 'node:child_process', 'node:http', 'node:https', 'node:net', 'execFile', 'spawn']) {
    assert.equal(source.includes(forbidden), false, `builders.js must not reach ${forbidden}`);
  }
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(requires, ['./composition', './gate-result', './protocol'], 'builders.js consumes only the boundary predicate modules');
});

test('Issue #83 the workspace chain round-trips: create, built verify, built cleanup', async () => {
  const repository = builderRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));

    const builtVerify = cli('build_workspace_verify', { created: created.data, cwd: created.data.path });
    assert.equal(builtVerify.ok, true, JSON.stringify(builtVerify.error));
    assert.equal(builtVerify.data.request.operation, 'workspace_verify');
    const verified = cli('workspace_verify', builtVerify.data.request.data);
    assert.equal(verified.ok, true, JSON.stringify(verified.error));

    const builtCleanup = cli('build_workspace_cleanup', { created: created.data, cwd: repository.root });
    assert.equal(builtCleanup.ok, true, JSON.stringify(builtCleanup.error));
    assert.equal(builtCleanup.data.request.operation, 'workspace_cleanup');
    const cleaned = cli('workspace_cleanup', builtCleanup.data.request.data);
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned.error));
    assert.equal(cleaned.data.removed, true);
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
  }
});

test('Issue #83 built operator and snapshot requests satisfy the boundary by construction', () => {
  const helpers = require('../skills/closed-loop-pr/helpers');
  const builtRevalidate = cli('build_operator_revalidate', { captured: envelopeOf('operator_capture', captureData()), cwd: '/repo', postPushHead: OID });
  assert.equal(builtRevalidate.ok, true, JSON.stringify(builtRevalidate.error));
  assert.equal(builtRevalidate.data.request.operation, 'operator_revalidate');
  assert.equal(helpers.inputShapeProblem('operator_revalidate', builtRevalidate.data.request.data), null);

  const builtSnapshot = cli('build_fingerprint_snapshot', { snapshot: producerSnapshotData() });
  assert.equal(builtSnapshot.ok, true, JSON.stringify(builtSnapshot.error));
  assert.equal(helpers.inputShapeProblem('fingerprint_snapshot', builtSnapshot.data.request.data), null);
  const fingerprinted = cli('fingerprint_snapshot', builtSnapshot.data.request.data);
  assert.equal(fingerprinted.ok, true, JSON.stringify(fingerprinted.error));
});

test('Issue #83 the built gate expectation validates a real gate result and carries the schema', () => {
  const built = cli('build_gate_expectation', expectationInput());
  assert.equal(built.ok, true, JSON.stringify(built.error));
  assert.equal(built.data.outputSchema.properties.schemaVersion.const, 1, 'the canonical CL-D36 schema rides along');
  const validated = cli('gate_result_validate', { result: gateOutput(), expected: built.data.expected });
  assert.equal(validated.ok, true, JSON.stringify(validated.error));
  assert.equal(validated.data.verdict, 'MERGE');
});

test('Issue #83 builders reject with the boundary vocabulary, not new codes', () => {
  // The field-level swap the boundary rejects is rejected at build time with the same shape name.
  const swapped = cli('build_operator_revalidate', { captured: captureData(), cwd: '/repo' });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'input_shape_mismatch');
  assert.match(swapped.error.message, /envelope:operator_capture/);
  assert.equal(swapped.error.phase, 'build');

  const wrongCreate = cli('build_workspace_verify', { created: { path: '/w' }, cwd: '/w' });
  assert.equal(wrongCreate.ok, false);
  assert.equal(wrongCreate.error.code, 'input_shape_mismatch');
  assert.match(wrongCreate.error.message, /data:workspace_create/);

  // A retained clone has no receipt: cleanup is unbuildable, stated at build time.
  const clone = cli('build_workspace_cleanup', { created: cloneData(), cwd: '/repo' });
  assert.equal(clone.ok, false);
  assert.equal(clone.error.code, 'invalid_request');
  assert.match(clone.error.message, /clone fallback workspace is retained/);

  // CL-D47: the derived namespace stays underivable by hand even through the builder.
  const derived = cli('build_gate_expectation', { ...expectationInput(), freshFindingIdPrefix: 'SOL-83-' });
  assert.equal(derived.ok, false);
  assert.equal(derived.error.code, 'invalid_request');

  const duplicate = cli('build_gate_expectation', {
    ...expectationInput(),
    assignedFindings: [{ findingId: 'SOL-83-001', blockerKey: 'k' }, { findingId: 'SOL-83-001', blockerKey: 'k' }],
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error.message, /duplicate assignment/);
});

test('Issue #83 CL-D56 records the builder family and its correctness mechanism', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D56 — Package-owned builders construct the documents the boundary checks');
  assert.ok(decision, 'CONTRACT.md must record CL-D56');
  for (const field of ['*Decision ID:* CL-D56', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D56 must carry ${field}`);
  }
  assert.match(decision, /one CLI operation per builder/);
  assert.match(decision, /validation-not-classification/);
  assert.match(decision, /a builder output the boundary would reject is unrepresentable/);
  assert.match(decision, /issues\/83#issuecomment-5467176488/);
  assert.match(decision, /the CL-D44 five-field freeze is untouched/);
});
