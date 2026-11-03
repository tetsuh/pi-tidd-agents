'use strict';

// Issue #329: in the review-only driver a convergence FIX BEFORE MERGE with no Blocker still has Sol review the same
// head in the same run, convergence's open findings carried as unresolved history, not assigned; the run then stops
// WAITING_FOR_OWNER with both gates' findings and Terra is not launched (CL-D131). The autofix driver is unchanged.
const { test, assert, fs, path, drive, setup, state, setFixture, nextRequest, fakeGate } = require('./issue-196-review-driver.fixtures.js');
const { readText, readContract, sectionOf } = require('./helpers');

const result = (t, options) => drive(['result', '--run-dir', t.runDir, '--run-id', typeof options === 'string' ? options : fakeGate(t.runDir, t.runs, options)], t.e);
function started() { const t = setup(); assert.equal(drive(t.start, t.e).status, 0); return t; }
function convergenceFix(t, severity = 'Major') {
  const r = result(t, { verdict: 'FIX', severity });
  return r;
}
const payload = (t, gate, invocation) => fs.readFileSync(JSON.parse(fs.readFileSync(path.join(t.runDir, `gate-verify-${gate}-${invocation}.json`), 'utf8')).data.path, 'utf8');
const NEXT = 'the author applies the smallest correction, then a fresh run';

test('Issue #329 AC1 a convergence FIX with no Blocker launches Sol on the same head with the findings as unresolved history', () => {
  for (const severity of ['Major', 'Minor']) {
    const t = started();
    const r = convergenceFix(t, severity);
    assert.equal(r.status, 0, `${severity}: ${r.stderr}${r.stdout}`);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', severity);
    const s = state(t.runDir);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.pending.expectationPath, 'utf8')).assignedFindings, [], `${severity}: nothing is assigned`);
    assert.match(payload(t, 'adversarial', 1), /"unresolved": \[\s*\{\s*"findingId": "CONV-7-X"/, `${severity}: the finding is unresolved history`);
    const head = (gate) => JSON.parse(fs.readFileSync(path.join(t.runDir, `expectation-${gate}-1.json`), 'utf8')).correlation.headOid;
    assert.equal(head('adversarial'), head('convergence'), `${severity}: the same head`);
  }
});

test('Issue #329 AC2 the run then stops WAITING_FOR_OWNER with both gates\' findings in one round, and Terra is not launched', () => {
  for (const [sol, reason, findings] of [
    ['MERGE', 'convergence returned FIX BEFORE MERGE with open finding(s): CONV-7-X; sol returned MERGE', ['CONV-7-X']],
    ['FIX', 'convergence returned FIX BEFORE MERGE with open finding(s): CONV-7-X; sol returned FIX BEFORE MERGE with open finding(s): ADV-7-X', ['CONV-7-X', 'ADV-7-X']],
  ]) {
    const t = started();
    convergenceFix(t);
    const r = result(t, { verdict: sol });
    assert.notEqual(r.status, 0, sol);
    assert.equal(nextRequest(r.stdout), null, `${sol}: nothing is launched`);
    const s = state(t.runDir);
    assert.equal(s.state, 'WAITING_FOR_OWNER', sol);
    assert.equal(s.reason, reason, sol);
    assert.equal(s.nextAction, NEXT, sol);
    assert.equal(s.invocations.safety, undefined, `${sol}: Terra is not launched`);
    const comment = fs.readFileSync(s.publication.comment, 'utf8');
    for (const id of findings) assert.match(comment, new RegExp(`^  ${id}: fixed \\(proposed; correction pending\\)$`, 'm'), `${sol}: ${id} is in the published round`);
    // AC4: one round, with Sol's invocation counted against its own cap.
    assert.equal(s.rounds, 'convergence 1/3, sol 1/3, terra 0/3', sol);
    assert.match(comment, /^rounds: convergence 1\/3, sol 1\/3, terra 0\/3$/m, sol);
    assert.equal((comment.match(/^# Review state: /gm) || []).length, 1, `${sol}: one published round`);
  }
});

function needsDecision(t) {
  const runId = fakeGate(t.runDir, t.runs, { verdict: 'FIX', disposition: 'needs-owner-decision' });
  const gate = JSON.parse(fs.readFileSync(path.join(t.runDir, 'state.json'), 'utf8')).pending.gate, prefix = gate === 'adversarial' ? 'ADV' : 'CONV';
  const dir = path.join(t.runs, 'async-subagent-runs', runId, 'structured-output', 'fake');
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'output.json'), 'utf8'));
  out.verdict = 'NEEDS DECISION';
  out.decisions = [{ decisionId: `${prefix}-7-D`, kind: 'scope', targetAndRevision: 'o/r#7', question: 'q', options: 'o', recommendation: 'r', rationale: 'ra', validity: 'v', status: 'pending' }];
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(out));
  return runId;
}

test('Issue #329 AC3 a convergence Blocker, NEEDS DECISION or owner-decision finding still stops before Sol', () => {
  let t = started();
  let r = convergenceFix(t, 'Blocker');
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
  assert.equal(state(t.runDir).reason, 'convergence returned FIX BEFORE MERGE with open finding(s): CONV-7-X');
  assert.equal(state(t.runDir).invocations.adversarial, undefined, 'a Blocker stops before Sol');
  t = started();
  r = result(t, needsDecision(t));
  assert.notEqual(r.status, 0, r.stderr + r.stdout);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
  assert.equal(state(t.runDir).reason, 'convergence returned NEEDS DECISION');
  assert.equal(state(t.runDir).invocations.adversarial, undefined, 'a decision stops before Sol');
});

test('Issue #329 AC2 a Sol NEEDS DECISION on that path stops for the owner with both gates\' findings published', () => {
  const t = started();
  convergenceFix(t);
  const r = result(t, needsDecision(t));
  assert.notEqual(r.status, 0, r.stderr + r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER');
  assert.equal(s.reason, 'sol returned NEEDS DECISION');
  assert.equal(s.invocations.safety, undefined, 'Terra is not launched');
  const comment = fs.readFileSync(s.publication.comment, 'utf8');
  assert.match(comment, /^  CONV-7-X: fixed \(proposed; correction pending\)$/m, 'the convergence finding is published');
  assert.match(comment, /^  ADV-7-X: needs-owner-decision /m, 'the Sol finding is published');
});

test('Issue #329 a snapshot change on the way to Sol reruns convergence, and a later MERGE goes on to Terra', () => {
  const t = started();
  setFixture(t, { prComments: [{ id: 9, html_url: 'u', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'a new comment' }] });
  let r = convergenceFix(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', r.stderr + r.stdout);
  r = result(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.doesNotMatch(payload(t, 'adversarial', 1), /"findingId": "CONV-7-X"/, 'the earlier finding is not carried');
  r = result(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-safety-reviewer', 'Sol MERGE goes on to Terra');
});

// Round 1 of PR #335 (ADV-335-STALE-CONVERGENCE-PUBLICATION): a convergence rerun after a snapshot change replaces
// the superseded convergence finding in the published ledger, whether the rerun returns MERGE or a different FIX.
const comment9 = { id: 9, html_url: 'u', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'a new comment' };
function renamed(t, findingId) {
  const runId = fakeGate(t.runDir, t.runs, { verdict: 'FIX' });
  const file = path.join(t.runs, 'async-subagent-runs', runId, 'structured-output', 'fake', 'output.json');
  const out = JSON.parse(fs.readFileSync(file, 'utf8')); out.findings[0].findingId = findingId; fs.writeFileSync(file, JSON.stringify(out));
  return runId;
}

test('Issue #329 a rerun MERGE after a snapshot change drops the superseded convergence finding from MERGE_READY', () => {
  const t = started();
  setFixture(t, { prComments: [comment9] });
  assert.equal(nextRequest(convergenceFix(t).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-safety-reviewer');
  const r = result(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.findings.some((f) => f.findingId === 'CONV-7-X'), false, 'the ledger drops it');
  assert.doesNotMatch(fs.readFileSync(s.publication.comment, 'utf8'), /CONV-7-X: /, 'the publication drops it');
});

test('Issue #329 a rerun FIX with a different finding after a snapshot change publishes only the new one', () => {
  const t = started();
  setFixture(t, { prComments: [comment9] });
  assert.equal(nextRequest(convergenceFix(t).stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(nextRequest(result(t, renamed(t, 'CONV-7-Y')).stdout)?.agent, 'tidd-adversarial-reviewer');
  const r = result(t);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.reason, 'convergence returned FIX BEFORE MERGE with open finding(s): CONV-7-Y; sol returned MERGE');
  const comment = fs.readFileSync(s.publication.comment, 'utf8');
  assert.match(comment, /^  CONV-7-Y: fixed \(proposed; correction pending\)$/m, 'the current finding');
  assert.doesNotMatch(comment, /CONV-7-X: /, 'not the superseded one');
});

test('Issue #329 recorded findings keep their published lines through a convergence rerun', () => {
  const t = started();
  const recorded = { verdict: 'MERGE_WITH', severity: 'Minor', anchoring: 'follow-up', disposition: 'deferred' };
  assert.equal(nextRequest(result(t, recorded).stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(nextRequest(result(t, recorded).stdout)?.agent, 'tidd-safety-reviewer');
  setFixture(t, { prComments: [comment9] });
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-convergence-reviewer', 'final readiness reruns convergence');
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-safety-reviewer');
  const r = result(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  const comment = fs.readFileSync(s.publication.comment, 'utf8');
  for (const id of ['CONV-7-X', 'ADV-7-X']) assert.match(comment, new RegExp(`^  ${id}: deferred \\(recorded under CL-D85\\)$`, 'm'), id);
});

test('Issue #329 AC5 CL-D131 records the review-only order, CL-D62 points forward, and the autofix driver is unchanged', () => {
  const record = sectionOf(readContract(), '## CL-D131 — Review-only runs Sol after a convergence FIX BEFORE MERGE with no Blocker');
  assert.ok(record, 'CL-D131 is in the contract');
  assert.match(record, /tetsuh\/pi-tidd-agents#329/);
  assert.match(record, /Sol is launched on the same head in the same run, with convergence's open findings as unresolved history, not as assigned findings/);
  assert.match(record, /The exact autofix driver's order is unchanged/);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D131.md](contract/CL-D131.md) — Review-only runs Sol after a convergence FIX BEFORE MERGE with no Blocker'));
  assert.ok(readText('contract/CL-D62.md').includes('CL-D131 later has review-only run Sol after a convergence `FIX BEFORE MERGE` with no `Blocker` (#329).'));
  assert.ok(readText('skills/closed-loop-shared/references/gate-contract.md').includes('On PR review-only before the cap, a convergence `FIX BEFORE MERGE` whose open findings include no `Blocker` still hands the candidate to the adversarial gate, those findings carried as unresolved history rather than assigned, and the run then stops `WAITING_FOR_OWNER` with both gates\' findings before the safety gate (CL-D131).'));
  assert.equal(readText('skills/closed-loop-pr/driver/autofix.js').includes('solAfterFix'), false, 'the autofix driver is unchanged');
});
