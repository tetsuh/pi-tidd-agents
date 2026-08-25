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
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
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

test('Issue #74 the documented composition passes exactly as written', () => {
  // Positive fixtures: the declared shape reaches the operation, which then fails or succeeds on
  // its own terms rather than on the shape. None of these may be an input_shape_mismatch.
  for (const [operation, data] of [
    ['operator_revalidate', { captured: envelopeOf('operator_capture', captureData()), cwd: '/repo' }],
    ['workspace_verify', { cwd: '/run/workspace', expected: createData() }],
    ['workspace_cleanup', { receipt: receipt(), cwd: '/repo' }],
    ['fingerprint_snapshot', { snapshot: snapshotData() }],
  ]) {
    const result = cli(operation, data);
    assert.notEqual(result.error?.code, 'input_shape_mismatch', `${operation} must accept its declared shape: ${JSON.stringify(result)}`);
  }
  // fingerprint_snapshot is total over objects, so its positive fixture must also produce a
  // digest rather than merely avoiding the shape error.
  const digest = cli('fingerprint_snapshot', { snapshot: snapshotData() });
  assert.equal(digest.ok, true, JSON.stringify(digest));
  assert.match(digest.data.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(digest.data.record.domain, 'snapshot');
});

test('Issue #74 workspace cleanup no longer accepts three shapes for one field', () => {
  // Before this issue the library read `input?.data?.receipt || input?.receipt || input`, so it
  // silently accepted an envelope, the creation data, or the receipt. No caller used the
  // tolerance and it defeats the boundary check, so only the receipt is accepted now.
  const source = readText('skills/closed-loop-pr/helpers/workspace.js');
  assert.equal(source.includes('input?.data?.receipt || input?.receipt || input'), false, 'the tolerant fallback must be gone');
  assert.match(source, /function cleanupWorkspace\(receipt, cwd\)/);
});

// Review-driven regression: one document must not carry two producer names. The library stamped
// the capture result `operator_checkout` while the CLI restamped the same document
// `operator_capture`, so an envelope's own `operation` could not identify its producer and a
// library-built capture routed through the CLI looked like the wrong shape.
test('Issue #74 one producer stamps one operation name on both paths', () => {
  const source = readText('skills/closed-loop-pr/helpers/operator.js');
  assert.equal(source.includes("'operator_checkout'"), false, 'the subject-named stamp must be gone');
  assert.match(source, /createResult\('operator_capture', \{/);
  assert.match(source, /createError\('operator_revalidate', 'operator_changed'/);
  // Every packaged module must name its own operation, so the CLI's restamp is confirmation
  // rather than correction.
  for (const module of ['operator.js', 'workspace.js', 'evidence.js', 'snapshot.js', 'writability.js', 'gate-result.js', 'composition.js']) {
    const text = readText(`skills/closed-loop-pr/helpers/${module}`);
    for (const match of text.matchAll(/create(?:Result|Error)\('([a-z_]+)'/g)) {
      assert.ok(cliSchemas()[match[1]] || match[1] === 'workspace', `${module} stamps unknown operation ${match[1]}`);
    }
  }
});
