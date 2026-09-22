'use strict';

// Issue #169 (CL-D86) — the exact-autofix run on PR #149 pushed one correction and then stopped, because the
// pre-writer `operator_revalidate` request it composed by hand omitted the post-push transition the guard
// requires. `postPushHead` and `priorPushHeads` were optional inputs a parent could simply forget. They are now
// derived by the package from the run's own snapshots, and a refused post-push revalidation is recomposed once.
//
// TDD provenance: the builder and CLI cases are behavioural — they drive the packaged builder and the packaged
// CLI and fail because the derivation does not exist; the prose, record, and alarm cases are compile/contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readAutofixProcedure, readText, sectionOf } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const { buildOperatorRevalidate } = require(path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'builders.js'));
const OID = (c) => c.repeat(40);

function snapshotAt(head) {
  return {
    before: { head }, after: { head }, pull: {}, completeness: {}, policies: {},
    annotations: [], checkSuites: [], checks: [], comments: [], inline: [], reviews: [], statuses: [], threads: [],
  };
}
// the `operator_capture` envelope, which is what a run holds; its payload has its own 22-key shape
function captured() { return { version: 1, ok: true, operation: 'operator_capture', data: { root: '/repo', head: OID('a') } }; }
function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}

test('Issue #169 the transition is derived from the run\'s own snapshots', () => {
  const one = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes: [snapshotAt(OID('c'))] });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.data.request.data.postPushHead, OID('c'));
  assert.equal(Object.hasOwn(one.data.request.data, 'priorPushHeads'), false, 'a first push names no earlier head');

  const three = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes: [snapshotAt(OID('c')), snapshotAt(OID('d')), snapshotAt(OID('e'))] });
  assert.equal(three.ok, true, JSON.stringify(three));
  assert.equal(three.data.request.data.postPushHead, OID('e'), 'the current head is the last snapshot');
  assert.deepEqual(three.data.request.data.priorPushHeads, [OID('c'), OID('d')], 'the earlier heads keep their order, oldest first');
});

test('Issue #169 a head supplied by hand beside the snapshots is refused', () => {
  for (const extra of [{ postPushHead: OID('f') }, { priorPushHeads: [OID('f')] }]) {
    const result = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes: [snapshotAt(OID('c'))], ...extra });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'invalid_request');
    assert.match(result.error.message, /pushes/);
  }
});

test('Issue #169 the snapshot list is refused when it is not the run\'s own pushes', () => {
  const cases = [
    ['empty', []],
    ['too many', [1, 2, 3, 4, 5, 6].map(() => snapshotAt(OID('c')))],
    ['not an array', { 0: snapshotAt(OID('c')) }],
    ['not a snapshot', [{ after: { head: OID('c') } }]],
    ['head is not a commit OID', [snapshotAt('not-an-oid')]],
  ];
  for (const [label, pushes] of cases) {
    const result = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes });
    assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.error.code, 'invalid_request', label);
  }
});

test('Issue #169 the packaged CLI declares and enforces the same input', () => {
  const table = readText('skills/closed-loop-pr/helpers/cli.js');
  assert.match(table, /build_operator_revalidate: \{ required: \['captured', 'cwd'\], optional: \['pushes'\] \}/,
    'the hand-supplied heads leave the builder\'s input table');
  const ok = cli('build_operator_revalidate', { captured: captured(), cwd: '/repo', pushes: [snapshotAt(OID('c'))] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.data.request.data.postPushHead, OID('c'));
  const refused = cli('build_operator_revalidate', { captured: captured(), cwd: '/repo', postPushHead: OID('c') });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error.phase, 'cli', 'an unknown field is refused by the CLI input table itself');
});

test('Issue #169 the addendum states where the transition comes from and what a refusal costs', () => {
  const procedure = readAutofixProcedure();
  assert.match(procedure, /The pre-writer `operator_revalidate` after a push is composed by `build_operator_revalidate` from the run's own snapshots, oldest first; the parent supplies no head by hand \(CL-D86\)\./);
  assert.match(procedure, /A refused post-push revalidation is recomposed once from those snapshots and retried; a second refusal stops the run \(CL-D86\)\./);
});

test('Issue #169 CL-D86 records both choices and the helper alarm reset', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D86 — The post-push revalidation is composed from the run\'s own snapshots');
  assert.ok(record, 'CL-D86 must exist');
  for (const field of ['*Decision ID:* CL-D86', '*Kind:* contract', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D86 must carry ${field}`);
  }
  assert.match(record, /issues\/169#issuecomment-5786110213/, 'the record cites the owner choices');
  assert.match(record, /The packaged-helper alarm resets from 270,000 to 280,000 bytes/);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D86').map((clause) => clause.id).sort(),
    ['CL-D86-builder', 'CL-D86-map', 'CL-D86-record', 'CL-D86-tests']);
});

test('Issue #169 the reset helper alarm is the one every suite asserts', () => {
  for (const file of fs.readdirSync(path.join(__dirname))) {
    if (!file.endsWith('.test.js') || file === 'issue-169-post-push-revalidation.test.js') continue;
    assert.equal(readText(`test/${file}`).includes('270000'), false, `${file} must not keep the superseded helper alarm`);
  }
  assert.match(readText('test/package.test.js'), /helperBytes < 280000/);
  const dir = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers');
  const bytes = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(bytes < 280000, `packaged helpers total ${bytes}`);
  assert.ok(280000 - 269652 > 8000, 'the raise left room, asserted against the measurement it was taken on');
});
