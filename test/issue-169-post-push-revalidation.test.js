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
  assert.match(procedure, /A refused post-push revalidation is recomposed once from a freshly taken post-push snapshot and retried; a second refusal stops the run, and neither attempt consumes a gate or push counter \(CL-D86\)\./);
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
    ['CL-D86-builder', 'CL-D86-cli', 'CL-D86-map', 'CL-D86-record', 'CL-D86-tests']);
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

// The pre-push pass on 27f70ab found three blocking defects and one surviving mutant. Each case below pins one.
test('Issue #169 the derived head is the one the push produced, not the one it started from', () => {
  const moved = { ...snapshotAt(OID('c')), before: { head: OID('b') }, after: { head: OID('c') } };
  const refused = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes: [moved] });
  assert.equal(refused.ok, false, 'a snapshot whose brackets disagree is evidence the run must discard');
  assert.equal(refused.error.code, 'invalid_request');
  const kept = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes: [{ ...snapshotAt(OID('c')), before: { head: OID('c'), extra: 1 } }] });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(kept.data.request.data.postPushHead, OID('c'), 'the after bracket names the public head the push produced');
});

test('Issue #169 the cap counts what the builder will emit, not what the input claims', () => {
  // Array.from takes the iterator; an array's own `length` need not describe what that iterator yields.
  const forged = [snapshotAt(OID('c')), snapshotAt(OID('d'))];
  forged[Symbol.iterator] = function* iterate() { for (let i = 0; i < 8; i += 1) yield snapshotAt(OID('c')); };
  const built = buildOperatorRevalidate({ captured: captured(), cwd: '/repo', pushes: forged });
  assert.equal(built.ok, false, 'a builder must not emit a chain the guard would refuse');
  assert.equal(built.error.code, 'invalid_request');
});

test('Issue #169 the retry is stated where the no-retry rule is stated', () => {
  const procedure = readAutofixProcedure();
  assert.match(procedure, /no retry beyond the CL-D39 recovery defined above and the CL-D86 recomposition after a push/);
  assert.match(procedure, /A refused post-push revalidation is recomposed once from a freshly taken post-push snapshot and retried; a second refusal stops the run, and neither attempt consumes a gate or push counter \(CL-D86\)\./);
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.match(addendum, /the CL-D39 recovery defined above, the CL-D51 zero-output relaunch, and the CL-D86 recomposition after a push/);
});

test('Issue #169 nothing still says the parent supplies the heads', () => {
  for (const file of ['CONTRACT.md', 'README.md', 'skills/closed-loop-pr/references/helper-map.md']) {
    assert.equal(readText(file).includes('an obligation no check enforces'), false, `${file} still calls the transition an unchecked obligation`);
  }
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D79 — The post-push guard accepts a sole-child chain of pushes');
  assert.ok(record, 'CL-D79 must exist');
  assert.match(record, /CL-D86 later took that decision: the heads are derived by `build_operator_revalidate` from the run's own post-push snapshots, so the parent supplies none by hand\./);
});

// CONV-173-AUTOFIX-INVARIANT-DOC-001: the normative invariant still said the parent names the heads, which is
// the claim CL-D86 removed everywhere else. One sentence, pinned in two files and in the manifest.
test('Issue #169 the post-push invariant names the derivation, wherever it is stated', () => {
  const DERIVED = 'through the heads `build_operator_revalidate` derives from the run\'s own post-push snapshots (CL-D79, CL-D86)';
  for (const file of ['skills/closed-loop-pr/references/autofix.md', 'CONTRACT.md']) {
    const text = readText(file);
    assert.ok(text.includes(DERIVED), `${file} states the derived chain`);
    assert.equal(text.includes('through the heads the parent names as its own pushes'), false, `${file} keeps no superseded statement of it`);
  }
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  const pinned = manifest.clauses.find((clause) => clause.id === 'CL-D79-definition');
  assert.ok(pinned.requires.every((sentence) => sentence.includes(DERIVED) || !sentence.includes('WORKSPACE_POST_PUSH')),
    'the definition clause pins the amended sentence');
});

// ADV-173-OMISSION-REGRESSION: acceptance criterion 2 asks for a regression that fails when the composed request
// omits the transition, on both surfaces. The refusal cases above cover malformed input; this covers the omission
// the run actually made on PR #149 — a push happened and the request says nothing about it.
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const helpers = require('../skills/closed-loop-pr/helpers');

const commitEnv = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
function git(cwd, args, env) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function withPushedOperator(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-169-repo-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-169-origin-'));
  try {
    git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 169 Test']); git(root, ['config', 'user.email', 'issue169@example.invalid']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), `base${String.fromCharCode(10)}`);
    git(root, ['add', 'tracked.txt']); git(root, ['commit', '-m', 'test: base']);
    git(bare, ['init', '--bare']); git(root, ['remote', 'add', 'origin', bare]); git(root, ['push', '-u', 'origin', 'main']);
    const head = git(root, ['rev-parse', 'HEAD']);
    const identity = { repository: 'owner/repo', prNumber: 169, lifecycle: 'OPEN', baseOid: OID('a'), publicHead: head, headRepository: 'owner/repo', headBranch: 'main', originFetch: bare, originPush: bare };
    const capture = helpers.captureOperatorCheckout({ cwd: root, identity });
    assert.equal(capture.ok, true, JSON.stringify(capture));
    const captureCli = cli('operator_capture', { cwd: root, identity });
    assert.equal(captureCli.ok, true, JSON.stringify(captureCli));
    // The push itself: one child commit, and the remote-tracking ref moved onto it.
    const pushed = git(root, ['commit-tree', 'HEAD^{tree}', '-p', head, '-m', 'fix: correction'], commitEnv);
    git(root, ['update-ref', 'refs/remotes/origin/main', pushed]);
    run({ root, capture, captureCli, pushed });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bare, { recursive: true, force: true }); }
}

test('Issue #169 a revalidation composed without the push is refused, on both surfaces', () => {
  withPushedOperator(({ root, capture, captureCli, pushed }) => {
    // Direct helper API: build with no pushes after a push, run what it returns.
    const omitted = buildOperatorRevalidate({ captured: capture.data, cwd: root });
    assert.equal(omitted.ok, true, 'the pre-push form is still composable; it is the guard that refuses it');
    // And it is exactly the pre-push form: a builder that invented a transition here would hide the omission
    // behind a request the guard refuses for a different reason.
    assert.deepEqual(Object.keys(omitted.data.request.data).sort(), ['captured', 'cwd']);
    const ranOmitted = helpers.revalidateOperatorCheckout(capture, { cwd: root });
    assert.equal(ranOmitted.ok, false, 'a request that says nothing about the push cannot pass the post-push guard');
    assert.equal(ranOmitted.error.code, 'operator_changed');
    // Packaged CLI, the same two steps.
    const builtCli = cli('build_operator_revalidate', { captured: captureCli, cwd: root });
    assert.equal(builtCli.ok, true, JSON.stringify(builtCli));
    const ranCli = cli(builtCli.data.request.operation, builtCli.data.request.data);
    assert.deepEqual([ranCli.ok, ranCli.error?.code], [false, 'operator_changed'], JSON.stringify(ranCli));
    // And the snapshot the run holds composes a request that passes, on both surfaces.
    const snapshot = { ...snapshotAt(pushed) };
    const derived = buildOperatorRevalidate({ captured: capture.data, cwd: root, pushes: [snapshot] });
    assert.equal(derived.data.request.data.postPushHead, pushed);
    const ranDerived = helpers.revalidateOperatorCheckout(capture, { cwd: root, postPushHead: derived.data.request.data.postPushHead });
    assert.equal(ranDerived.ok, true, JSON.stringify(ranDerived.error));
    const derivedCli = cli('build_operator_revalidate', { captured: captureCli, cwd: root, pushes: [snapshot] });
    const ranDerivedCli = cli(derivedCli.data.request.operation, derivedCli.data.request.data);
    assert.equal(ranDerivedCli.ok, true, JSON.stringify(ranDerivedCli.error));
  });
});

test('Issue #169 the record names the source the retry recomposes from', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D86 — The post-push revalidation is composed from the run\'s own snapshots');
  assert.match(record, /A refused post-push revalidation is recomposed once from a freshly taken post-push snapshot and retried; a second refusal stops the run, and neither attempt consumes a gate or push counter\./);
  assert.equal(record.includes('recomposed once from those snapshots'), false, 'the record may not name a source the operational rule does not');
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  const pins = manifest.clauses.filter((clause) => clause.marker === 'CL-D86').flatMap((clause) => clause.requires);
  assert.ok(pins.some((sentence) => sentence.includes('recomposed once from a freshly taken post-push snapshot')), 'the manifest pins the source');
});
