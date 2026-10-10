'use strict';

// Issue #259: review-only had no bound on the sequence of fresh runs of one pull request, and a fresh run's gates saw no
// disposition from earlier runs (tetsuh/hekatus PR #107: fourteen rounds, each run opening at `convergence 1/3`). A run
// now reads the pull request's earlier round publications, carries their findings to every gate as settled, and stops
// WAITING_FOR_OWNER before any gate after five rounds without MERGE_READY (owner decision on #259: N = 5).
const { test, assert, fs, path, drive, setup, state, setFixture, nextRequest } = require('./issue-196-review-driver.fixtures.js');

const HEAD = (n) => String(n).repeat(40).slice(0, 40);
let id = 100;
// A published round as the workflow renders it: the review-state heading and the tidd-status block for the target.
function round(stateName, findings = [], { head = HEAD(1), target = 'o/r#7', association = 'OWNER', type = 'User' } = {}) {
  id += 1;
  const lines = findings.length ? ['findings:', ...findings.map(([f, d]) => `  ${f}: ${d}`)] : ['findings: none'];
  const body = [`# Review state: ${stateName}`, '', 'Pull request: https://github.com/o/r/pull/7', '', '```tidd-status', `target: ${target}`, 'mode: review-only', `state: ${stateName}`,
    `fingerprints: issue_spec ${'e'.repeat(64)} base ${'b'.repeat(40)} tree ${'c'.repeat(40)} diff ${'d'.repeat(64)} commits ${'f'.repeat(64)} head ${head}`, 'rounds: convergence 1/3, sol 0/3, terra 0/3', ...lines, 'review_misses: none', '```', ''].join('\n');
  return { id, html_url: `https://github.com/o/r/pull/7#issuecomment-${id}`, user: { login: 'o', type }, author_association: association, created_at: `2026-10-0${Math.min(9, 1 + (id % 9))}T00:00:00Z`, updated_at: '2026-10-09T00:00:00Z', body };
}
const comment = (body, association = 'OWNER') => ({ id: (id += 1), html_url: 'u', user: { login: 'o', type: 'User' }, author_association: association, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z', body });
function settledOf(runDir) {
  const payload = fs.readdirSync(runDir).find((f) => f.startsWith('gate-payload-convergence-1-'));
  return JSON.parse(fs.readFileSync(path.join(runDir, payload), 'utf8').split('## Volatile envelope\n\n```json\n')[1].split('\n```')[0]).history.settled;
}

test('Issue #259 the findings of earlier rounds reach every gate as settled, with the head they were raised on', () => {
  const t = setup();
  setFixture(t, { prComments: [
    round('WAITING_FOR_OWNER', [['CONV-7-001', 'fixed (proposed; correction pending)'], ['CONV-7-002', 'fixed (recorded under CL-D85)']], { head: HEAD(1) }),
    round('WAITING_FOR_OWNER', [['ADV-7-001', 'deferred (proposed; correction pending)'], ['ADV-7-002', 'needs-owner-decision (proposed; correction pending)']], { head: HEAD(2) }),
  ] });
  const r = drive(t.start, t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', r.stdout + r.stderr);
  const settled = settledOf(t.runDir);
  assert.deepEqual(settled.map(({ findingId, sourceGate, disposition, status, reviewedHead }) => [findingId, sourceGate, disposition, status, reviewedHead]), [
    ['CONV-7-001', 'convergence', 'fixed (proposed; correction pending)', 'settled', HEAD(1)],
    ['CONV-7-002', 'convergence', 'fixed (recorded under CL-D85)', 'settled', HEAD(1)],
    ['ADV-7-001', 'adversarial', 'deferred (proposed; correction pending)', 'settled', HEAD(2)],
  ], 'a needs-owner-decision line is not carried');
  assert.ok(settled.every((x) => /earlier round/.test(x.summary)), 'each carried entry says where it came from');
});

test('Issue #259 a round by an untrusted author or a bot, or for another target, is not read', () => {
  const t = setup();
  setFixture(t, { prComments: [
    round('WAITING_FOR_OWNER', [['CONV-7-009', 'fixed (proposed; correction pending)']], { association: 'NONE' }),
    round('WAITING_FOR_OWNER', [['CONV-7-010', 'fixed (proposed; correction pending)']], { type: 'Bot' }),
    round('WAITING_FOR_OWNER', [['CONV-8-001', 'fixed (proposed; correction pending)']], { target: 'o/r#8' }),
  ] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.deepEqual(settledOf(t.runDir), []);
});

test('Issue #259 five earlier rounds without MERGE_READY stop the run before any gate', () => {
  const t = setup();
  setFixture(t, { prComments: Array.from({ length: 5 }, () => round('WAITING_FOR_OWNER', [['CONV-7-001', 'fixed (proposed; correction pending)']])) });
  const r = drive(t.start, t.e);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
  assert.match(state(t.runDir).reason, /5 earlier rounds/);
  assert.deepEqual(state(t.runDir).invocations, {}, 'no gate was launched');
});

test('Issue #259 a MERGE_READY round or a trusted continue comment starts the count again', () => {
  for (const reset of [round('MERGE_READY'), comment('tidd-budget: continue')]) {
    const t = setup();
    setFixture(t, { prComments: [...Array.from({ length: 4 }, () => round('WAITING_FOR_OWNER')), reset, round('WAITING_FOR_OWNER')] });
    assert.equal(nextRequest(drive(t.start, t.e).stdout)?.agent, 'tidd-convergence-reviewer', reset.body.slice(0, 40));
  }
  // An untrusted continue comment changes nothing.
  const t = setup();
  setFixture(t, { prComments: [...Array.from({ length: 4 }, () => round('WAITING_FOR_OWNER')), comment('tidd-budget: continue', 'NONE'), round('WAITING_FOR_OWNER')] });
  assert.equal(nextRequest(drive(t.start, t.e).stdout), null);
});
