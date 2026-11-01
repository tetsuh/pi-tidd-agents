'use strict';

// Issue #328 (CL-D128): any change of the external snapshot cleared every gate verdict and reran convergence, although a
// gate payload carries the snapshot only as its fingerprint. On tetsuh/sitometron PR #114, 11 of 33 kept runs reran
// convergence on an unchanged head because check runs completed and a `Bot` posted a quality-gate comment; in 6 the
// rerun on the same inputs turned a `MERGE` into `FIX BEFORE MERGE`. Owner choice A: only the fields a gate can act on
// (reviews, review threads, inline comments, conversation comments not by a `Bot`, the pull request apart from its
// mergeability, the target brackets) clear verdicts; the final policy still reads a snapshot taken at final readiness.
//
// TDD provenance: behavioural RED — a completed check between convergence and Sol reruns convergence.
const { test, assert, fs, drive, setup, state, setFixture, throughGates, nextRequest, fakeGate, prComment } = require('./issue-196-review-driver.fixtures.js');
const autofix = require('./issue-196-autofix-driver.fixtures.js');
const { readText } = require('./helpers');

const BOT = (id) => prComment(id, { user: { login: 'sonarqubecloud[bot]', type: 'Bot' }, author_association: 'NONE', body: 'Quality Gate passed' });
const result = (t, options) => drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, options)], t.e);
const pullPatch = (t, change) => { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); return { pull: { ...f.pull, ...change } }; };

test('Issue #328 AC4 a check completing and a Bot comment between convergence and Sol do not rerun convergence', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { checkStatus: 'completed', prComments: [BOT(1)] });
  const r = result(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `${state(t.runDir).state} ${state(t.runDir).reason}`);
  const s = state(t.runDir);
  assert.equal(s.verdicts.convergence, 'MERGE', 'the convergence verdict stands');
  assert.equal(s.invocations.convergence, 1);
  throughGates(t, 2);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  assert.equal(state(t.runDir).invocations.convergence, 1, 'convergence ran once');
});

test('Issue #328 AC1 a policy-only or mergeability-only change, before a later gate or at final readiness, clears nothing', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, pullPatch(t, { mergeable_state: 'unstable' }));
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  result(t);
  // Between Terra's launch and final readiness the checks complete and a Bot comments again.
  setFixture(t, { prComments: [BOT(2)], checkStatus: 'completed' });
  const r = result(t);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  assert.equal(state(t.runDir).invocations.convergence, 1);
});

test('Issue #328 AC2 a new human comment or a new review thread between gates still reruns convergence', () => {
  for (const after of [{ prComments: [prComment(3)] }, { threads: [{ id: 't9', isResolved: false, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: 'c9', databaseId: 9, url: 'u', body: 'please change this', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'h', __typename: 'User' } }], pageInfo: { endCursor: null, hasNextPage: false } } }] }]) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    setFixture(t, after);
    assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-convergence-reviewer', JSON.stringify(after));
  }
});

test('Issue #328 AC3 the final policy still reads the snapshot taken at final readiness', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t, 2);
  setFixture(t, { checkStatus: 'in_progress' });
  result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', s.reason);
  assert.equal(s.invocations.convergence, 1, 'the pending check waits; it reruns nothing');
});

test('Issue #328 AC1 and AC2 the exact autofix driver: a Bot comment clears nothing, a human comment reruns convergence', () => {
  for (const [comments, agent] of [[[BOT(4)], 'tidd-adversarial-reviewer'], [[prComment(5)], 'tidd-convergence-reviewer']]) {
    const t = autofix.setup();
    assert.equal(autofix.drive(t.start, t.env).status, 0);
    autofix.setFixture(t.bin, { prComments: comments });
    const r = autofix.result(t);
    assert.equal(autofix.nextRequest(r.stdout)?.agent, agent, `${comments[0].user.type}: ${r.stdout}${r.stderr}`);
    if (agent === 'tidd-adversarial-reviewer') assert.equal(autofix.state(t.runDir).gateLog[0].cleared, undefined, 'the convergence MERGE is not cleared');
  }
});

test('Issue #328 AC2 a run saved before the digest existed still reruns convergence on a new human comment', () => {
  // ADV sweep before the first push: an older state has no `reviewSnapshot`, so its first read compares the full
  // fingerprint once instead of reporting no change.
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  assert.equal(state(t.runDir).state, 'WAITING_EXTERNAL_REVIEW');
  const file = require('node:path').join(t.runDir, 'state.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.reviewSnapshot; fs.writeFileSync(file, JSON.stringify(saved));
  setFixture(t, { prComments: [prComment(7)] });
  const r = drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `${state(t.runDir).state} ${state(t.runDir).reason}`);
});

// CONV-331-AC1-EXCLUSION-TESTS (PR #331 round 1): each excluded field on its own, in both drivers, so a digest that
// starts hashing any one of them fails here.
const EXCLUDED = [
  ['statuses', { statuses: [{ id: 11, context: 'lint', state: 'success', target_url: null, description: 'ok', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }] }],
  ['check suites', { checkSuites: [{ id: 12, status: 'completed', conclusion: 'success', head_sha: 'x', app: { slug: 'ci' }, created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }] }],
  ['annotations', { annotations: [{ path: 'a.js', start_line: 1, end_line: 1, annotation_level: 'warning', title: 't', message: 'm', raw_details: '' }] }],
  ['policies', { rulesets: [{ id: 13, updated_at: '2026-09-29T00:00:00Z', enforcement: 'evaluate', target: 'branch', rules: [], bypass_actors: [] }] }],
];
test('Issue #328 AC1 each excluded field changing alone between convergence and Sol clears nothing in either driver', () => {
  for (const [label, patch] of EXCLUDED) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    setFixture(t, patch);
    assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer', `review-only, ${label}: ${state(t.runDir).state} ${state(t.runDir).reason}`);
    assert.equal(state(t.runDir).verdicts.convergence, 'MERGE', `review-only, ${label}`);
    const a = autofix.setup();
    assert.equal(autofix.drive(a.start, a.env).status, 0);
    autofix.setFixture(a.bin, patch);
    const r = autofix.result(a);
    assert.equal(autofix.nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `autofix, ${label}: ${r.stdout}${r.stderr}`);
    assert.equal(autofix.state(a.runDir).gateLog[0].cleared, undefined, `autofix, ${label}`);
  }
});

// CONV-331-AC1-DRIVER-EXCLUSION-COVERAGE (PR #331 round 4): a check run completing in the exact autofix driver, and
// `pull.mergeable` changing apart from `mergeable_state` in either driver, or `mergeable_state` alone in the exact autofix
// driver, clear nothing.
test('Issue #328 AC1 a check run completing in the exact autofix driver clears nothing', () => {
  const a = autofix.setup();
  autofix.setFixture(a.bin, { checkStatus: 'in_progress' });
  assert.equal(autofix.drive(a.start, a.env).status, 0);
  autofix.setFixture(a.bin, { checkStatus: 'completed' });
  const r = autofix.result(a);
  assert.equal(autofix.nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `${r.stdout}${r.stderr}`);
  assert.equal(autofix.state(a.runDir).gateLog[0].cleared, undefined, 'the convergence MERGE is not cleared');
});

test('Issue #328 AC1 pull.mergeable changing alone in either driver, or mergeable_state alone in exact autofix, clears nothing', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, pullPatch(t, { mergeable: false }));
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer', `review-only: ${state(t.runDir).state} ${state(t.runDir).reason}`);
  assert.equal(state(t.runDir).verdicts.convergence, 'MERGE', 'review-only');
  for (const patch of [{ mergeable: false }, { mergeableState: 'unstable' }]) {
    const a = autofix.setup();
    assert.equal(autofix.drive(a.start, a.env).status, 0);
    autofix.setFixture(a.bin, patch);
    const r = autofix.result(a);
    assert.equal(autofix.nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `autofix, ${JSON.stringify(patch)}: ${r.stdout}${r.stderr}`);
    assert.equal(autofix.state(a.runDir).gateLog[0].cleared, undefined, `autofix, ${JSON.stringify(patch)}`);
  }
});

test('Issue #328 AC5 the record, the index, the shared contract and CL-D62 agree', () => {
  const record = readText('contract/CL-D128.md');
  assert.match(record, /^## CL-D128 — /m);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D128.md](contract/CL-D128.md) — '), 'the index lists CL-D128');
  assert.match(record, /still records the full snapshot fingerprint/);
  // CONV-331-AC3-BLOCKED-STATE (PR #331 round 2): the final policy is unchanged, so `blocked` is still named for a human.
  assert.match(record, /a check, status, thread or `mergeable_state` the final policy fails or waits on stops the run as before, and `mergeable_state` `blocked` is still named for a human to confirm before merging \(CL-D100\)/);
  assert.doesNotMatch(record, /a non-mergeable state stops the run/);
  assert.match(readText('skills/closed-loop-shared/references/gate-contract.md'), /a snapshot change counts only in the fields a gate can act on[^\n]*\(CL-D128\)/);
  assert.match(readText('contract/CL-D62.md'), /CL-D128 later/);
  const clauses = JSON.parse(readText('contract/CL-D128.clauses.json')).clauses;
  assert.ok(clauses.some((c) => c.files.includes('skills/closed-loop-pr/driver/phases.js')), 'a clause pins the digest in phases.js');
});
