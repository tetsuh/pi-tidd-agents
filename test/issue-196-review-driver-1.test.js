'use strict';

// Part 1 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

test('Issue #196 the packaged review-only driver runs a PR round to MERGE_READY; the parent only makes printed calls', () => {
  const t = setup();
  let r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const gate of ['convergence', 'adversarial', 'safety']) {
    const request = nextRequest(r.stdout);
    assert.ok(request, `a subagent call is printed for ${gate}: ${r.stdout}`);
    assert.equal(request.agent, { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[gate]);
    assert.equal(request.outputSchema, undefined, 'the schema lives in the agent definition (CL-D90)');
    // CL-D101 (#225): the launch names the verification request and carries no hash for the child to copy.
    assert.ok(request.task.includes(path.join(t.runDir, `gate-verify-${gate}-1.json`)), request.task);
    assert.doesNotMatch(request.task.replaceAll(t.runDir, ''), /[0-9a-f]{12,}/, request.task);
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  }
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /^# Review state: MERGE_READY\n/);
  assert.ok(s.publication.comment.startsWith(t.runDir + path.sep), 'the publication artifacts live in the checked run directory');
  assert.ok(s.log.every((entry) => entry.ok), 'every packaged operation succeeded');
  assert.ok(s.log.some((entry) => entry.operation === 'validation_run'), 'validation ran from .tidd.json');
  // CONV-199-CLI-FINGERPRINT-BOUNDARY: every fingerprint is a packaged operation's answer, never an in-process call.
  for (const domain of ['issue_spec', 'pr_base', 'pr_tree', 'pr_diff', 'pr_commits', 'pr_head', 'snapshot']) {
    assert.ok(s.log.some((entry) => entry.operation === `fingerprint_${domain}` && entry.ok), `fingerprint_${domain} ran through the CLI`);
  }
});

test('Issue #196 a malformed .tidd.json at the base, or an issue without acceptance criteria, stops before any gate', () => {
  // CONV-199-MALFORMED-VALIDATION-CONFIG-TEST: a malformed file stops the run as surely as a missing one.
  // #209: a missing file no longer stops review-only (its own test below); a malformed one still does.
  for (const [options, reason] of [[{ issueBody: 'Spec without criteria.\n' }, /Acceptance criteria/],
    [{ config: 'not json' }, /not JSON/], [{ config: { validate: [] } }, /nonempty list/], [{ config: { validate: [['node', 1]] } }, /nonempty list/]]) {
    const t = setup(options);
    const r = drive(t.start, t.e);
    assert.notEqual(r.status, 0);
    const s = state(t.runDir);
    assert.equal(s.state, 'BLOCKED');
    assert.match(s.reason, reason);
    assert.equal(nextRequest(r.stdout), null, 'no gate is launched');
    assert.equal(s.log.some((entry) => entry.operation === 'build_gate_launch'), false);
  }
});

test('Issue #196 a resumed run reports its own observation time', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const before = state(t.runDir).observedFrom;
  setFixture(t, { checkStatus: 'completed' });
  drive(['resume', '--run-dir', t.runDir], t.e);
  assert.notEqual(state(t.runDir).observedFrom, before);
});

// CONV-199-POST-VALIDATION-HEAD: a validation command that moves HEAD leaves a clean checkout at the wrong commit; the
// check after validation reads HEAD as well as the working tree.
test('Issue #196 a validation command that switches the checkout stops before the first gate', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8'));
  const base = f.pull.base.sha;
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), JSON.stringify({ validate: [['git', 'checkout', '-q', base]] }));
  git(t.target.root, ['checkout', '-q', 'main']); git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'config']);
  const newBase = git(t.target.root, ['rev-parse', 'HEAD']);
  git(t.target.root, ['checkout', '-q', 'feature']); git(t.target.root, ['rebase', '-q', 'main']);
  f.pull.base.sha = newBase; f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /checkout is at/);
  assert.equal(nextRequest(r.stdout), null);
});

test('Issue #196 a reply added to an existing review thread is new evidence', () => {
  const t = setup();
  const resolvedThread = (replies) => ({ ...thread('T9', true), comments: { totalCount: replies.length, nodes: replies.map((id) => ({ id, databaseId: 1, url: 'u', body: 'b', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'h', __typename: 'User' } })), pageInfo: { endCursor: null, hasNextPage: false } } });
  setFixture(t, { threads: [resolvedThread(['c1'])] });
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { threads: [resolvedThread(['c1', 'c2'])] });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the reply reruns convergence');
});

// Round 17 of PR #199: a required check pinned to an app is satisfied only by that app's check run
// (ADV-199-REQUIRED-APP-ID), and the frozen ignored delta covers every descendant of an ignored directory by content
// (ADV-199-IGNORED-DELTA-CHILDREN).
test('Issue #196 a required check pinned to an app is satisfied only by that app\'s check run', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/run');
  const run = (appId) => ({ id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: appId } });
  const status = { id: 1, context: 'build', state: 'success', created_at: '2026-09-29T00:00:00Z' };
  const snapshot = (policies, checks, statuses = []) => ({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks, statuses, reviews: [], threads: [], policies: { rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [], ...policies } });
  const protection = (app_id) => ({ branchProtection: { required_status_checks: { contexts: ['build'], checks: [{ context: 'build', app_id }] } } });
  const ruleset = (integration_id) => ({ rulesets: [{ id: 1, enforcement: 'active', target: 'branch', bypass_actors: [], rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id }] } }] }] });
  const pending = (s) => readiness(s, 'h'.repeat(40)).pending;
  for (const policy of [protection(123)]) {
    assert.match(pending(snapshot(policy, [run(999)])).join(';'), /build/, 'another app');
    assert.match(pending(snapshot(policy, [], [status])).join(';'), /build/, 'a legacy status');
    assert.deepEqual(pending(snapshot(policy, [run(123)])), [], 'the pinned app');
  }
  assert.deepEqual(pending(snapshot(protection(null), [run(999)])), [], 'an unpinned check');
  assert.match(readiness(snapshot(ruleset(undefined), [], [status]), 'h'.repeat(40)).confirm.join(';'), /^ruleset 1 can gate the merge \(required_status_checks\)$/, 'a ruleset check is for a human to confirm');
});

test('Issue #196 the ignored inventory covers every descendant of an ignored directory by content', () => {
  const { ignoredInventory } = require('../skills/closed-loop-pr/driver/run');
  const root = temp('i196-ignored-');
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'scratch/\n');
  fs.mkdirSync(path.join(root, 'scratch', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scratch', 'x'), 'one');
  const frozen = ignoredInventory(root);
  fs.writeFileSync(path.join(root, 'scratch', 'deep', 'y'), 'new');
  assert.notDeepEqual(ignoredInventory(root), frozen, 'a new nested file');
  fs.rmSync(path.join(root, 'scratch', 'deep', 'y'));
  assert.deepEqual(ignoredInventory(root), frozen, 'back to the frozen delta');
  fs.writeFileSync(path.join(root, 'scratch', 'x'), 'two');
  assert.notDeepEqual(ignoredInventory(root), frozen, 'an edited ignored file');
});

// Round 19 of PR #199: a missing or malformed runner status record is a missing result, relaunched once like a missing
// output, and the relaunched run's result is read normally (ADV-199-STATUS-RELAUNCH).
test('Issue #196 a missing or malformed runner status record is relaunched once, and the second run is read', () => {
  for (const damage of [(p) => fs.rmSync(p), (p) => fs.writeFileSync(p, '{not json')]) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    const runId = fakeGate(t.runDir, t.runs);
    damage(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'));
    let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the same launch is printed again');
    assert.equal(state(t.runDir).invocations.convergence, 1, 'no round is spent');
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stderr + r.stdout);
  }
});

test('Issue #196 a diff that is not UTF-8 stops before any gate instead of reaching it altered', () => {
  const target = makeTarget();
  git(target.root, ['checkout', '-q', 'feature']);
  fs.writeFileSync(path.join(target.root, 'l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  git(target.root, ['add', 'l1.txt']); git(target.root, ['commit', '-q', '-m', 'latin1']);
  target.head = git(target.root, ['rev-parse', 'HEAD']); target.pull.head.sha = target.head;
  const bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  const r = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.root, '--run-dir', runDir], env(bin, runs));
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(runDir).state, 'BLOCKED');
  assert.match(state(runDir).reason, /UTF-8/);
});

test('Issue #196 the bound repository is GitHub\'s canonical name, whatever --repo spelled', () => {
  const t = setup();
  const r = drive(t.start.map((a) => (a === 'o/r' ? 'O/R' : a)), t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(state(t.runDir).target.repository, 'o/r');
});

// Round 27 of PR #199: quoted values are folded as the publisher folds them, NEL included (ADV-199-PUBLISH-NEL), and a
// convergence role the parent's role preflight found disabled is skipped and reported (CL-D62, ADV-199-DISABLED-CONVERGENCE).
test('Issue #196 a quoted value with a NEL between the marker words stays publishable', () => {
  const t = setup({ config: { validate: [['node', '-e', '0 // observed\u0085at suspicious']] } });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  const r = spawnSync('bash', [s.publication.script], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp('i196-home-') } });
  assert.doesNotMatch(r.stderr, /observation time/, r.stderr);
});

// Round 31 of PR #199: one driver command at a time holds a run; another is refused before it reads or writes
// anything, and a finished command releases the run (SAFETY-199-CONCURRENT-RESULT).
test('Issue #196 a second driver command on a held run is refused before it touches the run', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const runId = fakeGate(t.runDir, t.runs);
  const before = fs.readFileSync(path.join(t.runDir, 'state.json'), 'utf8');
  fs.mkdirSync(path.join(t.runDir, 'lock'));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /another driver command holds/);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(fs.readFileSync(path.join(t.runDir, 'state.json'), 'utf8'), before, 'the run is untouched');
  const status = drive(['status', '--run-dir', t.runDir], t.e);
  assert.notEqual(status.status, 0, 'status is refused too');
  assert.match(status.stderr, /another driver command holds/);
  assert.equal(status.stdout, '');
  fs.rmdirSync(path.join(t.runDir, 'lock'));
  assert.equal(JSON.parse(drive(['status', '--run-dir', t.runDir], t.e).stdout).state, 'GATE_LAUNCH_PENDING', 'status reads the run once it is free');
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(fs.existsSync(path.join(t.runDir, 'lock')), false, 'a finished command releases the run');
});
