'use strict';

// Part 6 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

test('Issue #196 a run directory inside a Git work tree is refused before anything is written', () => {
  const t = setup();
  const inside = path.join(t.target.root, 'run-inside');
  const r = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', t.target.root, '--run-dir', inside], t.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside a Git work tree/);
  assert.equal(fs.existsSync(inside), false, 'the directory was not created');
});

// CL-D100 (#226): what only a human or GitHub settles never holds readiness back; the operator's actions name it.
test('Issue #196 a protection the driver cannot read is settled by mergeability: clean names nothing, blocked is named', () => {
  let t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  let s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.operatorActions, 'none; a human may merge');
  t = setup();
  { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.mergeable_state = 'blocked'; fs.writeFileSync(t.fixture, JSON.stringify(f)); }
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.operatorActions, 'before merging, a human confirms: GitHub reports the pull request mergeable_state blocked');
});

test('Issue #196 a missing required approval does not hold MERGE_READY back, and the operator\'s actions name it', () => {
  const t = setup();
  setFixture(t, { protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.operatorActions, 'before merging, a human confirms: branch protection requires required_pull_request_reviews');
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /^operator_actions: before merging, a human confirms: branch protection requires required_pull_request_reviews$/m);
});

test('Issue #196 a pull request that cannot be read at start fails before any run directory exists', () => {
  const t = setup();
  setFixture(t, { failEndpoint: 'repos/o/r/pulls/7' });
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false, 'no run directory, so no half-run');
  assert.match(r.stderr, /cannot read pull request/);
});

// CONV-199-UNKNOWN-CHECK-CONCLUSION: only success, skipped, and neutral pass; a conclusion or status state the driver
// does not know is unknown, which is not complete.
test('Issue #196 an unknown check conclusion or status state waits instead of passing', () => {
  for (const patch of [{ checkConclusion: 'future-conclusion' }, { statuses: [{ id: 1, context: 'ci/x', state: 'future-state', created_at: '2026-09-29T00:00:00Z', creator: { login: 'x' } }] }]) {
    const t = setup();
    setFixture(t, patch);
    assert.equal(drive(t.start, t.e).status, 0);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', `${JSON.stringify(patch)}: ${s.reason}`);
    assert.match(s.reason, /unknown/);
  }
});

test('Issue #196 a run artifact is never written through a link', () => {
  const { Run } = require('../skills/closed-loop-pr/driver/run');
  const dir = temp('i196-run-links-'), victim = path.join(temp('i196-victim-'), 'v.txt');
  fs.writeFileSync(victim, 'keep');
  const run = new Run(dir);
  fs.symlinkSync(victim, path.join(dir, 'x.json'));
  assert.throws(() => run.file('x.json', { a: 1 }));
  fs.symlinkSync(victim, path.join(dir, 'state.json'));
  assert.throws(() => run.save());
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

// Round 23 of PR #199: the target and body are revalidated after validation, before the first gate
// (CONV-199-FIRST-BODY-REVALIDATION).
test('Issue #196 a body edited during validation stops before the first gate', () => {
  const t = setup();
  const edit = `const fs=require('fs');const f=JSON.parse(fs.readFileSync(${JSON.stringify(t.fixture)},'utf8'));f.pull.body+='Edited during validation.\\n';fs.writeFileSync(${JSON.stringify(t.fixture)},JSON.stringify(f));`;
  git(t.target.root, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), JSON.stringify({ validate: [['node', '-e', edit]] }));
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'config']);
  const newBase = git(t.target.root, ['rev-parse', 'HEAD']);
  git(t.target.root, ['checkout', '-q', 'feature']); git(t.target.root, ['rebase', '-q', 'main']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  f.pull.base.sha = newBase; f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /body changed/);
});

test('Issue #196 a relaunch revalidates the target first', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.body = 'edited'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const runId = fakeGate(t.runDir, t.runs);
  fs.rmSync(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /body changed/);
});

test('Issue #196 the status block names only a permitted next action, and MERGE_READY carries no stale invalidation', () => {
  let t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = 'e'.repeat(40); fs.writeFileSync(t.fixture, JSON.stringify(f));
  drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.doesNotMatch(state(t.runDir).statusBlock, /next_action: .*resume/);
  t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { prComments: [prComment(1)] });
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  throughGates(t);
  // The comment's arrival reran the gates; nothing waits for a quiet period after it (CL-D100).
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  assert.match(state(t.runDir).statusBlock, /^invalidated_evidence: none$/m);
  assert.equal((state(t.runDir).statusBlock.match(/tidd-convergence-reviewer/g) || []).length, 1, 'resolved lists each role once');
});

// CL-D100 (#226): external review is best effort. A recent external event starts no wait; the run reports the latest
// event and that it did not wait.
test('Issue #196 a recent external event does not hold MERGE_READY back, and the publication reports it as observed', () => {
  const t = setup();
  const now = new Date().toISOString();
  setFixture(t, { prComments: [prComment(1, { created_at: now, updated_at: now })] });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.ok(s.external.endsWith(`external review: none observed; latest external event at ${new Date(now).toISOString()}; external review is not waited for`), s.external);
  assert.doesNotMatch(s.external, /quiet|window/);
  assert.ok(fs.readFileSync(s.publication.comment, 'utf8').includes('external review is not waited for'), 'the comment says so');
});

// CL-D100 (#226): an external review provider's state is observed, never waited for and never a failure; a check run
// the provider posts counts with it unless protection requires that check.
test('Issue #196 an external review provider\'s state and its own check run are observed, never waited for', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/readiness');
  const ci = { id: 1, name: 'ci', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } };
  const run = ({ externalReview = [], checks = [ci], contexts = [], pins = [], statuses = [] }) => readiness({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks, statuses, threads: [], reviews: [],
    policies: { branchProtection: contexts.length || pins.length ? { required_status_checks: { strict: false, contexts, checks: pins } } : false, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview } }, 'h'.repeat(40));
  for (const state of ['queued', 'in_progress', 'pending', 'unknown', 'failed', 'completed']) {
    const r = run({ externalReview: [{ provider: 'coderabbit', source: 'status', state }] });
    assert.deepEqual([r.pending, r.failed, r.confirm, r.observed], [[], [], [], [`coderabbit ${state}`]], state);
  }
  const theirs = (status, conclusion = null, name = 'CodeRabbit') => ({ id: 2, name, status, conclusion, app: { slug: 'coderabbitai' } });
  for (const [check, text] of [[theirs('in_progress'), 'check CodeRabbit in_progress'], [theirs('queued'), 'check CodeRabbit queued'], [theirs('completed', 'failure'), 'check CodeRabbit failure'], [theirs('completed', 'action_required'), 'check CodeRabbit action_required']]) {
    const r = run({ checks: [ci, check] });
    assert.deepEqual([r.pending, r.failed, r.observed], [[], [], [text]], text);
  }
  assert.deepEqual(run({ checks: [ci, theirs('completed', 'success')] }).observed, ['check CodeRabbit success'], 'a passed provider check is reported too');
  // Protection requires it: the check keeps the rule of every required check.
  assert.deepEqual(run({ checks: [ci, theirs('in_progress')], contexts: ['CodeRabbit'] }).pending, ['check CodeRabbit']);
  assert.deepEqual(run({ checks: [ci, theirs('completed', 'failure')], contexts: ['CodeRabbit'] }).failed, ['check CodeRabbit failure']);
  // The provider's commit status follows the same rule (pre-push sweep): skipped unless protection requires the context.
  const status = (state) => [{ id: 1, context: 'CodeRabbit', state, created_at: '2026-09-29T00:00:00Z', creator: { login: 'coderabbitai[bot]' } }];
  for (const state of ['pending', 'failure', 'error']) { const r = run({ statuses: status(state) }); assert.deepEqual([r.pending, r.failed], [[], []], `an unrequired status ${state}`); }
  assert.deepEqual(run({ statuses: status('pending'), contexts: ['CodeRabbit'] }).pending, ['status CodeRabbit']);
  assert.deepEqual(run({ statuses: status('failure'), contexts: ['CodeRabbit'] }).failed, ['status CodeRabbit failure']);
  assert.deepEqual(run({ statuses: status('error'), contexts: ['CodeRabbit'] }).failed, ['status CodeRabbit error']);
  const met = run({ statuses: status('success'), contexts: ['CodeRabbit'] }); assert.deepEqual([met.pending, met.failed], [[], []], 'a required status that passed');
  // Round 1 of PR #227 (CONV-227-PINNED-REVIEW-CHECK-001): a requirement pinned to another app is not the provider's
  // check or status. The provider's is observed; the pinned requirement is still missing, and that is what waits.
  const missing = ['required check CodeRabbit from app 7 has not reported'], other = [{ context: 'CodeRabbit', app_id: 7 }], from = (check, id) => ({ ...check, app: { slug: 'coderabbitai', id } });
  for (const [check, text] of [[theirs('in_progress'), 'check CodeRabbit in_progress'], [theirs('completed', 'failure'), 'check CodeRabbit failure']]) {
    const r = run({ checks: [ci, from(check, 42)], pins: other });
    assert.deepEqual([r.pending, r.failed, r.observed], [missing, [], [text]], `${text} beside a pin on another app`);
  }
  for (const state of ['pending', 'failure']) { const r = run({ statuses: status(state), pins: other }); assert.deepEqual([r.pending, r.failed], [missing, []], `a status ${state} beside a pin`); }
  // The requirement pinned to the provider's own app, or accepting any source, is the provider's check.
  assert.deepEqual(run({ checks: [ci, from(theirs('completed', 'failure'), 42)], pins: [{ context: 'CodeRabbit', app_id: 42 }] }).failed, ['check CodeRabbit failure']);
  assert.deepEqual(run({ checks: [ci, from(theirs('in_progress'), 42)], pins: [{ context: 'CodeRabbit', app_id: -1 }] }).pending, ['check CodeRabbit']);
  assert.deepEqual(run({ statuses: status('failure'), pins: [{ context: 'CodeRabbit', app_id: -1 }] }).failed, ['status CodeRabbit failure']);
  // Round 3 of PR #227 (SAFETY-227-STATUS-SOURCE-001): only the provider's own status is exempt. A status of the same
  // context from another creator is an ordinary status and keeps its rule, required or not.
  const foreign = (state) => [{ ...status(state)[0], creator: { login: 'ci-bot[bot]' } }];
  assert.deepEqual(run({ statuses: foreign('pending') }).pending, ['status CodeRabbit']);
  for (const state of ['failure', 'error']) assert.deepEqual(run({ statuses: foreign(state) }).failed, [`status CodeRabbit ${state}`]);
  assert.deepEqual(run({ statuses: [{ ...status('failure')[0], creator: undefined }] }).failed, ['status CodeRabbit failure'], 'a status without a creator');
  const passed = run({ statuses: foreign('success') }); assert.deepEqual([passed.pending, passed.failed], [[], []]);
  // Pre-push sweep: the exempt context is exactly the one CL-D92's classification reads, and the order of the statuses
  // is consistent whatever an undated record does, so an older provider status cannot stand in for a newer status of
  // another creator.
  assert.deepEqual(run({ statuses: [{ ...status('failure')[0], context: 'coderabbit' }] }).failed, ['status coderabbit failure'], 'the provider\'s context in another letter case');
  const mixed = [{ id: 2, context: 'ci', state: 'success', created_at: '2026-10-01T00:00:02Z', creator: { login: 'ci-bot[bot]' } }, { id: 5, context: 'CodeRabbit', state: 'success', created_at: '2026-10-01T00:00:00Z', creator: { login: 'coderabbitai[bot]' } },
    { id: 4, context: 'ci', state: 'success', created_at: null, creator: { login: 'ci-bot[bot]' } }, { id: 1, context: 'CodeRabbit', state: 'failure', created_at: '2026-10-01T00:00:05Z', creator: { login: 'ci-bot[bot]' } }];
  assert.deepEqual(run({ statuses: mixed }).failed, ['status CodeRabbit failure'], 'the newest status of the context decides, whatever an undated record does to the order');
  // An undated status cannot be placed in time: it is judged beside the newest dated one, never instead of it.
  assert.deepEqual(run({ statuses: [{ id: 9, context: 'ci', state: 'failure', created_at: null }, { id: 1, context: 'ci', state: 'success', created_at: '2026-10-01T00:00:00Z' }] }).failed, ['status ci failure'], 'an undated failure still counts');
  assert.deepEqual(run({ statuses: [{ id: 9, context: 'ci', state: 'success', created_at: 'not a date' }, { id: 1, context: 'ci', state: 'failure', created_at: '2026-10-01T00:00:00Z' }] }).failed, ['status ci failure'], 'an undated success hides nothing');
  // Another app's check with the provider's name is no provider check, and a pending CI check still waits.
  assert.deepEqual(run({ checks: [ci, { ...theirs('in_progress'), app: { slug: 'github-actions' } }] }).pending, ['check CodeRabbit']);
  assert.deepEqual(run({ checks: [{ ...ci, status: 'in_progress', conclusion: null }] }).pending, ['check ci']);
});
