'use strict';

// Issue #74 — cross-operation input shapes are declared and checked at the boundary that owns
// them, so a swap fails as a shape error instead of as an unrelated downstream error.
//
// TDD provenance: recorded with the focused command below. The authority scenario is
// compile/contract RED against the missing section and record; the boundary, composition, and
// tightening scenarios are behavioral RED against a boundary that accepted every shape it was
// handed. That local output is not claimed as repository-preserved or runtime-compliance
// evidence. The predicate scenario replaced the original classification scenario after review:
// successive rounds each constructed an object falling between two classes of the total
// classifier, so the API was reformulated as one predicate per declared field and the
// classifier was removed; the producer-edge fixtures are review-driven regressions.

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
function producerSnapshotData() {
  return {
    before: {}, after: {}, pull: {}, completeness: {}, policies: {},
    annotations: [], checkSuites: [], checks: [], comments: [], inline: [], reviews: [], statuses: [], threads: [],
  };
}
function cloneData() {
  const { receipt: dropped, ...rest } = createData();
  return { ...rest, kind: 'clone', cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable' };
}
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

function cli(operation, data, env = {}) {
  const run = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
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
  git(root, ['push', 'origin', 'main']);
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
  // The separator-not-validator boundary, its depth calibration, its residual, and the freeze
  // are contract text, so retreating from any of them fails here.
  assert.match(section, /it is not a validator of producer output/);
  assert.match(section, /rejected because it fails that one predicate, never because of what it was recognized to be/);
  assert.match(section, /calibrated to what fails downstream/);
  assert.match(section, /the closed CL-D36 schema remains the sole validator of gate results/);
  assert.match(section, /constructed by hand to satisfy a declared predicate passes/);
  assert.match(section, /The five declared fields are the complete CL-D44 set/);

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

test('Issue #74 each declared field carries one predicate and rejection needs no classification', () => {
  // The declared shape passes; everything else fails the same one predicate. There is no
  // total classifier in the API: the boundary never needs to recognize what a wrong value is,
  // only that it is not the declared shape, so the rejection side is closed by construction.
  assert.equal(helpers.classifyInputShape, undefined, 'the total classifier must not be part of the API');
  assert.equal(helpers.inputShapeProblem('operator_revalidate', { captured: envelopeOf('operator_capture', captureData()), cwd: '/repo' }), null);
  for (const wrong of [
    captureData(), receipt(), createData(), snapshotData(), gateOutput(),
    envelopeOf('snapshot', captureData()),
    { version: 1, ok: false, operation: 'operator_capture', error: { code: 'x', message: 'x', phase: 'x' } },
    null, undefined, 'text', 7, [],
  ]) {
    const problem = helpers.inputShapeProblem('operator_revalidate', { captured: wrong, cwd: '/repo' });
    assert.match(problem ?? '', /`captured` must be envelope:operator_capture/, JSON.stringify(wrong) ?? 'undefined');
  }
  // An operation with no declared cross-operation fields never reports a shape problem.
  assert.equal(helpers.inputShapeProblem('operator_capture', { cwd: '/repo', identity: {} }), null);

  // Producer-shape edges pinned directly against the predicates. A clone never carries a
  // receipt, a successful envelope never carries an error key, and snapshot data is exactly
  // the producer's key set — an extra key means it is not producer output.
  assert.equal(helpers.inputShapeProblem('workspace_verify', { cwd: '/w', expected: cloneData() }), null);
  assert.match(helpers.inputShapeProblem('workspace_verify', { cwd: '/w', expected: { ...cloneData(), receipt: receipt() } }) ?? '', /`expected` must be data:workspace_create/);
  assert.match(helpers.inputShapeProblem('operator_revalidate', { cwd: '/repo', captured: { ...envelopeOf('operator_capture', captureData()), error: { code: 'x', message: 'x', phase: 'x' } } }) ?? '', /`captured` must be envelope:operator_capture/);
  assert.equal(helpers.inputShapeProblem('fingerprint_snapshot', { snapshot: producerSnapshotData() }), null);
  assert.match(helpers.inputShapeProblem('fingerprint_snapshot', { snapshot: { ...producerSnapshotData(), extra: 1 } }) ?? '', /`snapshot` must be data:snapshot/);
});

test('Issue #74 the declared shapes are published beside the fields', () => {
  const shapes = helpers.INPUT_SHAPES;
  // The freeze is an absolute claim — "the five declared fields are the complete CL-D44 set" —
  // so the set is pinned exactly: a sixth declaration, a second field on an operation, or a
  // renamed spec fails here before it can widen the boundary silently.
  assert.deepEqual(
    Object.entries(shapes).map(([operation, fields]) => [operation, ...Object.entries(fields).flat()]).sort(),
    [
      ['fingerprint_snapshot', 'snapshot', 'data:snapshot'],
      ['gate_result_validate', 'result', 'structured:gate_result'],
      ['operator_revalidate', 'captured', 'envelope:operator_capture'],
      ['workspace_cleanup', 'receipt', 'receipt:workspace_create'],
      ['workspace_verify', 'expected', 'data:workspace_create'],
    ],
  );
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
  // Envelopes from the direct helper's legacy producer name and another operation are not the
  // packaged field's declared envelope shape. Both must fail before downstream identity checks.
  for (const operation of ['operator_checkout', 'snapshot']) {
    const wrongOperation = cli('operator_revalidate', { captured: envelopeOf(operation, captureData()), cwd: '/repo' });
    assert.equal(wrongOperation.error.code, 'input_shape_mismatch', JSON.stringify(wrongOperation));
    assert.match(wrongOperation.error.message, new RegExp(operation));
    assert.equal(/complete target identity/.test(wrongOperation.error.message), false);
  }

  // A producer failure is an error envelope, not the successful producer output required by
  // this field. It must stop at the composition boundary rather than surface as capture_failed.
  const failedProducer = cli('operator_revalidate', {
    captured: { version: 1, ok: false, operation: 'operator_capture', error: { code: 'capture_failed', message: 'failed', phase: 'operator_capture' } },
    cwd: '/repo',
  });
  assert.equal(failedProducer.error.code, 'input_shape_mismatch', JSON.stringify(failedProducer));
  assert.equal(failedProducer.error.phase, 'operator_revalidate');
  assert.equal(/complete target identity/.test(failedProducer.error.message), false);
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
    ['fingerprint_snapshot', 'snapshot', {}, [envelopeOf('snapshot', snapshotData()), receipt(), { foo: 'bar' }, { head: OID }, captureData()]],
  ]) {
    for (const value of wrong) {
      const rejected = cli(operation, { ...extra, [field]: value });
      assert.equal(rejected.error.code, 'input_shape_mismatch', `${operation}.${field}: ${JSON.stringify(rejected)}`);
      assert.equal(rejected.error.phase, operation);
      assert.match(rejected.error.message, new RegExp(field));
    }
  }
});

test('Issue #74 clone workspace producer composes into packaged verification', () => {
  const repository = compositionRepository();
  const publisher = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-74-publisher-'));
  const runParent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-74-clone-run-'));
  const runRoot = path.join(runParent, 'run');
  let created;
  try {
    git(publisher, ['init', '-b', 'main']);
    git(publisher, ['config', 'user.name', 'Issue 74 Test']);
    git(publisher, ['config', 'user.email', 'issue74@example.invalid']);
    git(publisher, ['remote', 'add', 'origin', repository.bare]);
    git(publisher, ['fetch', 'origin', 'main']);
    git(publisher, ['checkout', '-B', 'main', 'FETCH_HEAD']);
    fs.appendFileSync(path.join(publisher, 'tracked.txt'), 'remote-only\n');
    git(publisher, ['add', 'tracked.txt']);
    git(publisher, ['commit', '-m', 'test: remote-only clone fallback']);
    git(publisher, ['push', 'origin', 'HEAD:main']);
    const remoteHead = git(publisher, ['rev-parse', 'HEAD']);
    const remoteTree = git(publisher, ['rev-parse', 'HEAD^{tree}']);

    // The source repository deliberately has not fetched this commit. A linked worktree cannot
    // resolve it and fails without residue, while cloning the verified origin can resolve it.
    const localLookup = spawnSync('git', ['cat-file', '-e', `${remoteHead}^{commit}`], {
      cwd: repository.root, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    assert.notEqual(localLookup.status, 0);
    created = cli('workspace_create', {
      cwd: repository.root, head: remoteHead, tree: remoteTree, runRoot,
    });
    assert.equal(created.status, 0, JSON.stringify(created));
    assert.equal(created.ok, true, JSON.stringify(created));
    const verified = cli('workspace_verify', { cwd: created.data.path, expected: created.data });
    assert.equal(verified.status, 0, JSON.stringify(verified));
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(created.data.kind, 'clone');
    assert.equal(created.data.receipt, undefined);
  } finally {
    fs.rmSync(runParent, { recursive: true, force: true });
    fs.rmSync(publisher, { recursive: true, force: true });
    removeCompositionRepository(repository);
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
