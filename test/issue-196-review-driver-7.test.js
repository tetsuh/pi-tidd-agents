'use strict';

// Part 7 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

test('Issue #196 each resolved role names its provider, model, and thinking level', () => {
  const t = setup();
  let r = drive(t.start, t.e);
  for (let i = 0; i < 3; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.deepEqual(s.resolved, ['convergence', 'adversarial', 'safety'].map((g) => `tidd-${g}-reviewer prov/model-x:high`));
});

test('Issue #196 a gate still running is not a result, and an unreadable result is relaunched once without a round', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const runId = fakeGate(t.runDir, t.runs);
  const statusPath = path.join(t.runs, 'async-subagent-runs', runId, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: 'running', steps: status.steps.map((x) => ({ ...x, status: 'running' })) }));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.match(r.stdout, /^WAIT: /m, r.stdout + r.stderr);
  assert.equal(state(t.runDir).pending.gate, 'convergence', 'the gate stays pending');
  fs.writeFileSync(statusPath, JSON.stringify(status));
  fs.rmSync(status.steps[0].structuredOutputPath);
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the same launch is printed again');
  assert.equal(state(t.runDir).invocations.convergence, 1, 'no round is spent');
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 readiness reads commit statuses and each reviewer\'s latest decisive review, and a skipped check passes', () => {
  const failing = setup();
  setFixture(failing, { statuses: [{ id: 1, context: 'ci/circle', state: 'failure', created_at: '2026-09-29T00:00:00Z', creator: { login: 'circleci' } }] });
  assert.equal(drive(failing.start, failing.e).status, 0);
  throughGates(failing);
  assert.equal(state(failing.runDir).state, 'BLOCKED');
  const changed = setup();
  setFixture(changed, { checkConclusion: 'skipped', reviews: [
    { id: 1, user: { login: 'h', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: changed.target.head, submitted_at: '2026-09-29T00:00:00Z' },
    { id: 2, user: { login: 'h', type: 'User' }, state: 'APPROVED', commit_id: changed.target.head, submitted_at: '2026-09-29T01:00:00Z' },
    { id: 3, user: { login: 'h', type: 'User' }, state: 'COMMENTED', commit_id: changed.target.head, submitted_at: '2026-09-29T02:00:00Z' }] });
  assert.equal(drive(changed.start, changed.e).status, 0);
  throughGates(changed);
  assert.equal(state(changed.runDir).state, 'MERGE_READY', state(changed.runDir).reason);
});

test('Issue #196 a checkout switched to another commit between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  git(t.target.root, ['checkout', '-q', t.target.base]);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /checkout is at/);
});

// Round 13 of PR #199: required checks that never reported (ADV-199-MISSING-REQUIRED-CHECKS), a reply added to an
// existing thread (ADV-199-THREAD-REPLY-IDENTITY), and a pull request the driver cannot read from a local checkout
// (ADV-199-NO-CHECKOUT-PR), which the driver sends back to the prose path (CL-D104).
test('Issue #196 a required check that never reported keeps readiness waiting when protection requires it; a ruleset is for a human', () => {
  // Protection's required check is judged here and waits. A ruleset is never evaluated (the #196 cut-off), so its
  // required check is part of what a human confirms (CL-D100).
  for (const [shape, outcome, where, text] of [[{ protection: { required_status_checks: { strict: false, contexts: ['ci/build'] } } }, 'WAITING_EXTERNAL_REVIEW', 'reason', /ci\/build has not reported/],
    [{ rulesets: [{ id: 2, updated_at: '2026-09-29T00:00:00Z', enforcement: 'active', rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci/build' }] } }], bypass_actors: [] }] }, 'MERGE_READY', 'operatorActions', /ruleset 2 can gate the merge/]]) {
    const t = setup();
    setFixture(t, shape);
    assert.equal(drive(t.start, t.e).status, 0);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, outcome, `${JSON.stringify(shape)}: ${s.reason}`);
    assert.match(s[where], text);
  }
});

test('Issue #196 the drafted comment never carries a command substitution from untrusted text', () => {
  const t = setup({ config: { validate: [['sh', '-c', 'exit ${CODE:-0} $(true)']] } });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const body = fs.readFileSync(state(t.runDir).publication.comment, 'utf8');
  assert.doesNotMatch(body, /\$\(|\$\{/);
});

// Round 28 of PR #199: commit messages are framed by NUL, which Git never stores in one, so a message carrying U+0001
// fingerprints as itself (ADV-199-COMMIT-FRAME-CONTROL); and an observed change of external state that carries no event
// time of its own, such as a thread resolved, reruns the gates (ADV-199-THREAD-QUIET-UNTIMED; the quiet period it started is gone since CL-D100).
test('Issue #196 a commit message carrying U+0001 fingerprints as itself', () => {
  const { prCommitsFingerprint } = require('../skills/closed-loop-pr/helpers/fingerprints');
  const target = makeTarget();
  git(target.root, ['checkout', '-q', 'feature']);
  fs.writeFileSync(path.join(target.root, 'b.js'), 'module.exports = 3;\n');
  git(target.root, ['add', 'b.js']); git(target.root, ['commit', '-q', '--cleanup=verbatim', '-m', 'feat: allow control\u0001byte\n\nbody\n']);
  target.head = git(target.root, ['rev-parse', 'HEAD']); target.pull.head.sha = target.head;
  const bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  assert.equal(drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.root, '--run-dir', runDir], env(bin, runs)).status, 0);
  const commits = git(target.root, ['rev-list', '--reverse', `${target.base}..${target.head}`]).split('\n').map((oid) => ({ oid, message: execFileSync('git', ['cat-file', 'commit', oid], { cwd: target.root, encoding: 'utf8' }).split('\n\n').slice(1).join('\n\n') }));
  assert.ok(commits[1].message.includes('\u0001'));
  assert.equal(state(runDir).fingerprints.pr_commits, prCommitsFingerprint(commits));
});

// Round 29 of PR #199: any change of the snapshot, not only a new record, invalidates the gate sequence, which restarts
// at convergence (gate-contract.md, ADV-199-SNAPSHOT-INVALIDATION).
test('Issue #196 a check completing, a comment removed, or a review dismissed between gates reruns convergence', () => {
  const review = (state) => [{ id: 3, user: { login: 'h', type: 'User' }, state, body: 'r', submitted_at: '2026-09-29T00:00:00Z', commit_id: 'x' }];
  for (const [before, after] of [[{ checkStatus: 'in_progress' }, { checkStatus: 'completed' }], [{ prComments: [prComment(1)] }, { prComments: [] }], [{ reviews: review('CHANGES_REQUESTED') }, { reviews: review('DISMISSED') }]]) {
    const t = setup();
    setFixture(t, before);
    assert.equal(drive(t.start, t.e).status, 0);
    setFixture(t, after);
    const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `${JSON.stringify(after)}: ${state(t.runDir).state} ${state(t.runDir).reason}`);
  }
});
