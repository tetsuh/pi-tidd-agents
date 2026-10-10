'use strict';

// Issue #259 (CL-D110): review-only had no bound on the sequence of fresh runs of one pull request, and a fresh run's gates saw no
// disposition from earlier runs (tetsuh/hekatus PR #107: fourteen rounds, each run opening at `convergence 1/3`). A run
// now reads the pull request's earlier round publications, carries their findings to every gate as settled, and stops
// WAITING_FOR_OWNER before any gate after five rounds without MERGE_READY (owner decision on #259: N = 5).
const { test, assert, fs, path, drive, setup, state, setFixture, nextRequest, fakeGate } = require('./issue-196-review-driver.fixtures.js');

const HEAD = (n) => String(n).repeat(40).slice(0, 40);
let id = 100;
// A published round as the workflow renders it: the review-state heading and the tidd-status block for the target.
function round(stateName, findings = [], { head = HEAD(1), target = 'o/r#7', association = 'OWNER', type = 'User', crlf = false } = {}) {
  id += 1;
  const lines = findings.length ? ['findings:', ...findings.map(([f, d]) => `  ${f}: ${d}`)] : ['findings: none'];
  const body = [`# Review state: ${stateName}`, '', 'Pull request: https://github.com/o/r/pull/7', '', '```tidd-status', `target: ${target}`, 'mode: review-only', `state: ${stateName}`,
    `fingerprints: issue_spec ${'e'.repeat(64)} base ${'b'.repeat(40)} tree ${'c'.repeat(40)} diff ${'d'.repeat(64)} commits ${'f'.repeat(64)}${head ? ` head ${head}` : ''}`, 'rounds: convergence 1/3, sol 0/3, terra 0/3', ...lines, 'review_misses: none', '```', ''].join(crlf ? '\r\n' : '\n');
  return { id, html_url: `https://github.com/o/r/pull/7#issuecomment-${id}`, user: { login: 'o', type }, author_association: association, created_at: `2026-10-0${Math.min(9, 1 + (id % 9))}T00:00:00Z`, updated_at: '2026-10-09T00:00:00Z', body };
}
const comment = (body, association = 'OWNER') => ({ id: (id += 1), html_url: 'u', user: { login: 'o', type: 'User' }, author_association: association, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', body });
// ADV-267-AC4-001 (PR #267 round 3): every scenario's listing also holds a settled round by an untrusted author, which
// must never be counted or carried (AC4).
const untrusted = () => round('WAITING_FOR_OWNER', [['CONV-7-099', 'fixed (recorded under CL-D85)']], { association: 'NONE' });
function settledOf(runDir, gate = 'convergence') {
  const payload = fs.readdirSync(runDir).find((f) => f.startsWith(`gate-payload-${gate}-1-`));
  const settled = JSON.parse(fs.readFileSync(path.join(runDir, payload), 'utf8').split('## Volatile envelope\n\n```json\n')[1].split('\n```')[0]).history.settled;
  assert.ok(!settled.some((x) => x.findingId === 'CONV-7-099'), 'the untrusted round carries nothing');
  return settled;
}

test('Issue #259 the settled findings of earlier rounds reach every gate, with the head they were raised on', () => {
  const t = setup();
  setFixture(t, { prComments: [untrusted(),
    round('WAITING_FOR_OWNER', [['CONV-7-001', 'fixed (proposed; correction pending)'], ['CONV-7-002', 'fixed (recorded under CL-D85)']], { head: HEAD(1) }),
    round('WAITING_FOR_OWNER', [['CONV-7-005', 'fixed (recorded under CL-D85)']], { head: HEAD(4), association: 'NONE' }),
    round('WAITING_FOR_OWNER', [['ADV-7-001', 'deferred (proposed; correction pending)'], ['ADV-7-002', 'needs-owner-decision (recorded under CL-D85)'], ['ADV-7-003', 'fixed (confirmed by sol)'], ['ADV-7-004', 'deferred (recorded under CL-D85)'], ['SAFETY-7-001', 'not-applicable (proposed; correction pending)'], ['SAFETY-7-002', 'accepted-as-designed (confirmed by terra)']], { head: HEAD(2) }),
  ] });
  const r = drive(t.start, t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', r.stdout + r.stderr);
  const settled = settledOf(t.runDir);
  // Owner decision A on #259, as refined: only a line marked recorded or confirmed is settled; any `(proposed …)` line,
  // a deferral included, is still open, and a needs-owner-decision line is never carried.
  assert.deepEqual(settled.map(({ findingId, sourceGate, disposition, status, raisedAgainst }) => [findingId, sourceGate, disposition, status, raisedAgainst]), [
    ['CONV-7-002', 'convergence', 'fixed (recorded under CL-D85)', 'settled', HEAD(1)],
    ['ADV-7-003', 'adversarial', 'fixed (confirmed by sol)', 'settled', HEAD(2)],
    ['ADV-7-004', 'adversarial', 'deferred (recorded under CL-D85)', 'settled', HEAD(2)],
    ['SAFETY-7-002', 'safety', 'accepted-as-designed (confirmed by terra)', 'settled', HEAD(2)],
  ]);
  assert.ok(settled.every((x) => /earlier round/.test(x.summary)), 'each carried entry says where it came from');
});

// A round posted by hand may name no head; its settled findings still reach the gates (this change's pre-push sweep).
test('Issue #259 a round that names no head carries its findings without one', () => {
  const t = setup();
  setFixture(t, { prComments: [untrusted(), round('WAITING_FOR_OWNER', [['CONV-7-002', 'fixed (recorded under CL-D85)']], { head: null })] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.deepEqual(settledOf(t.runDir).map((x) => [x.findingId, Object.hasOwn(x, 'raisedAgainst')]), [['CONV-7-002', false]]);
});

test('Issue #259 a round by an untrusted author or a bot, or for another target, is not read', () => {
  const t = setup();
  setFixture(t, { prComments: [untrusted(),
    round('WAITING_FOR_OWNER', [['CONV-7-009', 'fixed (proposed; correction pending)']], { association: 'NONE' }),
    round('WAITING_FOR_OWNER', [['CONV-7-010', 'fixed (proposed; correction pending)']], { type: 'Bot' }),
    round('WAITING_FOR_OWNER', [['CONV-8-001', 'fixed (proposed; correction pending)']], { target: 'o/r#8' }),
  ] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.deepEqual(settledOf(t.runDir), []);
});

test('Issue #259 five earlier rounds without MERGE_READY stop the run before any gate', () => {
  const t = setup();
  setFixture(t, { prComments: [untrusted(), ...Array.from({ length: 5 }, (_, i) => round('WAITING_FOR_OWNER', [['CONV-7-001', 'fixed (proposed; correction pending)']], { crlf: i % 2 === 1 }))] });
  const r = drive(t.start, t.e);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
  assert.match(state(t.runDir).reason, /5 earlier rounds/);
  assert.deepEqual(state(t.runDir).invocations, {}, 'no gate was launched');
});

// Only a trusted, non-bot round that ran counts: an untrusted, bot or BLOCKED publication does not (CL-D11).
test('Issue #259 untrusted, bot and BLOCKED publications do not count toward the stop', () => {
  const t = setup();
  setFixture(t, { prComments: [untrusted(), ...Array.from({ length: 4 }, () => round('WAITING_FOR_OWNER')), round('WAITING_FOR_OWNER', [], { association: 'NONE' }), round('WAITING_FOR_OWNER', [], { type: 'Bot' }), round('BLOCKED')] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer');
});

test('Issue #259 a MERGE_READY round or a trusted continue comment starts the count again', () => {
  for (const reset of [round('MERGE_READY', [['CONV-7-009', 'fixed (recorded under CL-D85)']]), comment('tidd-budget: continue')]) {
    const t = setup();
    setFixture(t, { prComments: [untrusted(), ...Array.from({ length: 4 }, () => round('WAITING_FOR_OWNER', [['ADV-7-004', 'deferred (recorded under CL-D85)']])), reset, round('WAITING_FOR_OWNER')] });
    assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer', reset.body.slice(0, 40));
    // A reset starts the count again but drops nothing already carried.
    assert.ok(settledOf(t.runDir).some((x) => x.findingId === 'ADV-7-004'), 'the deferral before the reset is still carried');
  }
  // A MERGE_READY round's own settled findings are carried too.
  assert.ok(settledOf((() => { const t = setup(); setFixture(t, { prComments: [untrusted(), round('MERGE_READY', [['CONV-7-009', 'fixed (recorded under CL-D85)']])] }); drive(t.start, t.e); return t.runDir; })()).some((x) => x.findingId === 'CONV-7-009'));
  // An untrusted continue comment changes nothing.
  const t = setup();
  setFixture(t, { prComments: [untrusted(), ...Array.from({ length: 4 }, () => round('WAITING_FOR_OWNER')), comment('tidd-budget: continue', 'NONE'), round('WAITING_FOR_OWNER')] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout), null);
});

// CONV-267-COVERAGE-001 (PR #267 round 1): AC1 says every gate. After a convergence and a Sol MERGE, Sol's and Terra's
// payloads carry the same settled entries as convergence's.
test('Issue #259 the carried findings reach Sol and Terra as well as convergence', () => {
  const t = setup();
  setFixture(t, { prComments: [untrusted(), round('WAITING_FOR_OWNER', [['CONV-7-002', 'fixed (recorded under CL-D85)'], ['ADV-7-004', 'deferred (recorded under CL-D85)']], { head: HEAD(1) })] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e).stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e).stdout)?.agent, 'tidd-safety-reviewer');
  const ids = (gate) => settledOf(t.runDir, gate).map((x) => x.findingId);
  for (const gate of ['convergence', 'adversarial', 'safety']) assert.deepEqual(ids(gate), ['CONV-7-002', 'ADV-7-004'], gate);
});

// CONV-267-001 (PR #267 round 2): trust fails closed. A comment whose author type is missing or anything but `User`
// is not trusted, for the earlier rounds and for Sol's comments alike (they shared the `!== 'Bot'` test).
test('Issue #259 a comment with no author type, or a type other than User, is not trusted', () => {
  const t = setup();
  const odd = [round('WAITING_FOR_OWNER', [['CONV-7-002', 'fixed (recorded under CL-D85)']]), round('WAITING_FOR_OWNER', [['CONV-7-003', 'fixed (recorded under CL-D85)']])];
  delete odd[0].user; odd[1].user.type = 'Organization';
  setFixture(t, { prComments: [untrusted(), ...odd, ...Array.from({ length: 4 }, () => round('WAITING_FOR_OWNER'))] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer', 'the two untyped rounds do not count toward five');
  assert.deepEqual(settledOf(t.runDir), [], 'and carry nothing');
  // Sol's comments: an Issue comment with no author type stays out of the adversarial payload.
  const { trustedComments } = require('../skills/closed-loop-pr/driver/phases');
  fs.writeFileSync(path.join(t.runDir, 'issue-comments.json'), JSON.stringify([{ id: 1, author_association: 'OWNER', body: 'a decision' }, { id: 2, author_association: 'OWNER', user: { login: 'o', type: 'User' }, body: 'b' }]));
  assert.deepEqual(trustedComments({ dir: t.runDir }).map((c) => c.id), [2]);
});
