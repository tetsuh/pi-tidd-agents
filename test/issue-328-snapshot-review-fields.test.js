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

test('Issue #328 AC5 the record, the index, the shared contract and CL-D62 agree', () => {
  const record = readText('contract/CL-D128.md');
  assert.match(record, /^## CL-D128 — /m);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D128.md](contract/CL-D128.md) — '), 'the index lists CL-D128');
  assert.match(record, /still records the full snapshot fingerprint/);
  assert.match(readText('skills/closed-loop-shared/references/gate-contract.md'), /a snapshot change counts only in the fields a gate can act on[^\n]*\(CL-D128\)/);
  assert.match(readText('contract/CL-D62.md'), /CL-D128 later/);
  const clauses = JSON.parse(readText('contract/CL-D128.clauses.json')).clauses;
  assert.ok(clauses.some((c) => c.files.includes('skills/closed-loop-pr/driver/phases.js')), 'a clause pins the digest in phases.js');
});
