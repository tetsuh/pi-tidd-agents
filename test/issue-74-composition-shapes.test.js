'use strict';

// Issue #74 — cross-operation input shapes are declared and checked at the boundary that owns
// them, so a swap fails as a shape error instead of as an unrelated downstream error.
//
// TDD provenance: recorded with the focused command below. The authority scenario is
// compile/contract RED against the missing section and record; the classification, boundary,
// composition, and tightening scenarios are behavioral RED against a boundary that accepted
// every shape it was handed. That local output is not claimed as repository-preserved or
// runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf, cliSchemas } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const CONTRACT = readText('CONTRACT.md');
const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');

const OID = 'a'.repeat(40);
function envelopeOf(operation, data) { return { version: 1, ok: true, operation, data }; }
function captureData() { return { root: '/repo', head: OID, tree: 'b'.repeat(40), identity: { repository: 'tetsuh/pi-tidd-agents' }, trackingRef: OID }; }
function receipt() { return { version: 1, id: 'run-1', root: '/run', storedPath: '/run/.cleanup-receipt.json', creationIdentity: { kind: 'linked', path: '/run/workspace' } }; }
function createData() { return { path: '/run/workspace', head: OID, tree: 'b'.repeat(40), root: '/run', kind: 'linked', receipt: receipt(), cleanupAllowed: true }; }
function snapshotData() { return { before: {}, after: {}, pull: {}, comments: [], reviews: [], inline: [], threads: [], checks: [], statuses: [] }; }
function gateOutput() {
  return {
    schemaVersion: 1,
    correlation: {
      repository: 'tetsuh/pi-tidd-agents', number: 74, baseOid: 'c'.repeat(40),
      headRepository: 'tetsuh/pi-tidd-agents', headBranch: 'feat/issue-74-composition-shapes',
      headOid: OID, lifecycle: 'open', draft: false, gate: 'sol', invocation: 1,
      contractInput: 'd'.repeat(64), snapshotFingerprint: 'e'.repeat(64),
    },
    verdict: 'MERGE', evidenceRead: [{ source: 'CONTRACT.md', kind: 'file', identity: 'f'.repeat(64), readCompletely: true }],
    findings: [], confirmations: [], decisions: [],
    adversarialResults: [{ claim: 'shape checks', searched: 'the helper boundary', outcome: 'no-counterexample', evidence: 'complete' }],
  };
}
function gateExpected() {
  return {
    correlation: gateOutput().correlation, workflow: 'pr', assignedFindings: [],
    freshFindingIdPrefix: 'SOL-74-', requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: 'f'.repeat(64) }],
  };
}

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
}
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function compositionRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-74-composition-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-74-origin-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 74 Test']);
  git(root, ['config', 'user.email', 'issue74@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'test: composition base']);
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}
function removeCompositionRepository(repository) {
  fs.rmSync(repository.root, { recursive: true, force: true });
  fs.rmSync(repository.bare, { recursive: true, force: true });
}
function compositionSnapshotTransport(head) {
  return async (_command, args) => {
    if (args[1] === 'graphql') {
      return { stdout: Buffer.from(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } })) };
    }
    const endpoint = args.at(-1);
    if (endpoint === 'repos/owner/repo/pulls/74') {
      return { stdout: Buffer.from(JSON.stringify({
        number: 74, state: 'open', draft: false, title: 'composition', body: 'body',
        user: { login: 'owner', type: 'User' }, author_association: 'OWNER',
        base: { sha: 'a'.repeat(40), ref: 'main', repo: { full_name: 'owner/repo' } },
        head: { sha: head, ref: 'main', repo: { full_name: 'owner/repo' } },
        mergeable: true, mergeable_state: 'clean',
      })) };
    }
    if (endpoint === 'repos/owner/repo') {
      return { stdout: Buffer.from(JSON.stringify({ owner: { type: 'User' }, default_branch: 'main' })) };
    }
    if (endpoint === 'repos/owner/repo/branches/main/protection') return { stdout: Buffer.from('false') };
    if (String(endpoint).includes('/check-runs')) return { stdout: Buffer.from(JSON.stringify({ check_runs: [] })) };
    if (String(endpoint).includes('/check-suites')) return { stdout: Buffer.from(JSON.stringify({ check_suites: [] })) };
    return { stdout: Buffer.from('[]') };
  };
}

test('Issue #74 authority declares the shape of every cross-operation field', () => {
  const section = sectionOf(AUTOFIX, '### Cross-operation input shapes (CL-D44)');
  assert.ok(section, 'autofix must own a CL-D44 composition section');
  assert.match(section, /`envelope`, `data`, and `receipt` are distinct input shapes/);
  assert.match(section, /the map names the shape each field expects, not only the field/);
  assert.match(section, /a supplied shape that is not the declared one stops with `input_shape_mismatch`/);
  assert.match(section, /never as a later identity, capture, or evidence failure/);
  assert.match(section, /no shape is accepted as a tolerant alternative for another/);

  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  for (const declaration of [
    '`captured` \\(envelope of `operator_capture`\\)',
    '`expected` \\(data of `workspace_create`\\)',
    '`receipt` \\(receipt inside `workspace_create` data\\)',
    '`snapshot` \\(data of `snapshot`\\)',
    '`result` \\(structured gate output\\)',
  ]) assert.match(map, new RegExp(declaration), `the map must declare ${declaration}`);

  const decision = sectionOf(CONTRACT, '## CL-D44 — Cross-operation input shapes are declared and checked');
  assert.ok(decision, 'CONTRACT.md must record CL-D44');
  for (const field of ['*Decision ID:* CL-D44', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D44 record must carry ${field}`);
  }
  assert.match(decision, /tetsuh\/sitos#165/);
});

test('Issue #74 shapes are classified by what they are, not by what they are called', () => {
  assert.equal(helpers.classifyInputShape(envelopeOf('operator_capture', captureData())), 'envelope');
  assert.equal(helpers.classifyInputShape({ version: 1, ok: false, operation: 'x', error: {} }), 'envelope');
  assert.equal(helpers.classifyInputShape(receipt()), 'receipt');
  assert.equal(helpers.classifyInputShape(createData()), 'workspace_data');
  assert.equal(helpers.classifyInputShape(captureData()), 'other');
  for (const value of [null, undefined, 'text', 7, [], []]) assert.equal(helpers.classifyInputShape(value), 'other');
});

test('Issue #74 the declared shapes are published beside the fields', () => {
  const shapes = helpers.INPUT_SHAPES;
  assert.equal(shapes.operator_revalidate.captured, 'envelope:operator_capture');
  assert.equal(shapes.workspace_verify.expected, 'data:workspace_create');
  assert.equal(shapes.workspace_cleanup.receipt, 'receipt:workspace_create');
  assert.equal(shapes.fingerprint_snapshot.snapshot, 'data:snapshot');
  assert.equal(shapes.gate_result_validate.result, 'structured:gate_result');
  // Every declared field must exist in the CLI schema it constrains, or the declaration is
  // decorative.
  const schemas = cliSchemas();
  for (const [operation, fields] of Object.entries(shapes)) {
    assert.ok(schemas[operation], `${operation} must be a known operation`);
    for (const field of Object.keys(fields)) assert.ok(schemas[operation].includes(field), `${operation}.${field} must be a declared request field`);
  }
});

test('Issue #74 the envelope-for-data swap is rejected by name at the boundary', () => {
  // The reproducer from tetsuh/sitos#165: operator_capture.data is the plausible thing to pass,
  // and it used to cross the boundary and fail later as a missing target identity.
  const swapped = cli('operator_revalidate', { captured: captureData(), cwd: '/repo' });
  assert.equal(swapped.ok, false);
  assert.equal(swapped.error.code, 'input_shape_mismatch');
  assert.equal(swapped.error.phase, 'operator_revalidate');
  assert.match(swapped.error.message, /captured/);
  assert.match(swapped.error.message, /envelope:operator_capture/);
  assert.notEqual(swapped.status, 0);
  assert.equal(/complete target identity/.test(swapped.error.message), false, 'the error must name the shape, not the downstream symptom');

  // The reverse swap, and a receipt where an envelope belongs.
  for (const value of [receipt(), createData()]) {
    const rejected = cli('operator_revalidate', { captured: value, cwd: '/repo' });
    assert.equal(rejected.error.code, 'input_shape_mismatch', JSON.stringify(rejected));
  }
  // An envelope from the wrong operation is not the declared shape either.
  const wrongOperation = cli('operator_revalidate', { captured: envelopeOf('snapshot', captureData()), cwd: '/repo' });
  assert.equal(wrongOperation.error.code, 'input_shape_mismatch');
  assert.match(wrongOperation.error.message, /snapshot/);
});

test('Issue #74 structured gate output composes successfully and rejects envelope/data/receipt swaps', () => {
  const accepted = cli('gate_result_validate', { result: gateOutput(), expected: gateExpected() });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  for (const value of [envelopeOf('gate_result_validate', gateOutput()), createData(), receipt()]) {
    const rejected = cli('gate_result_validate', { result: value, expected: gateExpected() });
    assert.equal(rejected.error.code, 'input_shape_mismatch', JSON.stringify(rejected));
    assert.equal(rejected.error.phase, 'gate_result_validate');
    assert.match(rejected.error.message, /result/);
  }
});

test('Issue #74 every other declared field rejects the shapes it does not take', () => {
  for (const [operation, field, extra, wrong] of [
    ['workspace_verify', 'expected', { cwd: '/run/workspace' }, [envelopeOf('workspace_create', createData()), receipt()]],
    ['workspace_cleanup', 'receipt', { cwd: '/repo' }, [envelopeOf('workspace_create', createData()), createData()]],
    ['fingerprint_snapshot', 'snapshot', {}, [envelopeOf('snapshot', snapshotData()), receipt()]],
  ]) {
    for (const value of wrong) {
      const rejected = cli(operation, { ...extra, [field]: value });
      assert.equal(rejected.error.code, 'input_shape_mismatch', `${operation}.${field}: ${JSON.stringify(rejected)}`);
      assert.equal(rejected.error.phase, operation);
      assert.match(rejected.error.message, new RegExp(field));
    }
  }
});

test('Issue #74 the documented composition passes exactly as written', async () => {
  // These are genuine producer-to-consumer compositions. The first three use a temporary real
  // repository so a shape-admitted request cannot remain green while its downstream operation
  // fails for an unrelated fixture or missing identity.
  const repository = compositionRepository();
  let workspace;
  try {
    const identity = {
      repository: 'owner/repo',
      prNumber: 74,
      lifecycle: 'OPEN',
      baseOid: 'a'.repeat(40),
      publicHead: repository.head,
      headRepository: 'owner/repo',
      headBranch: 'main',
      originFetch: repository.bare,
      originPush: repository.bare,
    };
    const captured = cli('operator_capture', { cwd: repository.root, identity });
    assert.equal(captured.status, 0, JSON.stringify(captured));
    assert.equal(captured.ok, true, JSON.stringify(captured));
    const revalidated = cli('operator_revalidate', { cwd: repository.root, captured });
    assert.equal(revalidated.status, 0, JSON.stringify(revalidated));
    assert.equal(revalidated.ok, true, JSON.stringify(revalidated));

    workspace = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(workspace.status, 0, JSON.stringify(workspace));
    assert.equal(workspace.ok, true, JSON.stringify(workspace));
    const verified = cli('workspace_verify', { cwd: workspace.data.path, expected: workspace.data });
    assert.equal(verified.status, 0, JSON.stringify(verified));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const cleaned = cli('workspace_cleanup', { cwd: repository.root, receipt: workspace.data.receipt });
    assert.equal(cleaned.status, 0, JSON.stringify(cleaned));
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned));
    workspace = null;
  } finally {
    // If an assertion interrupts the lifecycle, retry only the identity-guarded packaged cleanup;
    // never recursively remove a path obtained from the operation under test.
    if (workspace?.data?.receipt) {
      try { cli('workspace_cleanup', { cwd: repository.root, receipt: workspace.data.receipt }); } catch {}
    }
    removeCompositionRepository(repository);
  }

  // Feed the actual packaged snapshot producer's data to its documented fingerprint consumer.
  const snapshot = await helpers.collectSnapshot({
    owner: 'owner', repo: 'repo', number: 74,
    transport: compositionSnapshotTransport(repository.head),
  });
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const digest = cli('fingerprint_snapshot', { snapshot: snapshot.data });
  assert.equal(digest.status, 0, JSON.stringify(digest));
  assert.equal(digest.ok, true, JSON.stringify(digest));
  assert.match(digest.data.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(digest.data.record.domain, 'snapshot');
  const gate = cli('gate_result_validate', { result: gateOutput(), expected: gateExpected() });
  assert.equal(gate.ok, true, JSON.stringify(gate));
});
