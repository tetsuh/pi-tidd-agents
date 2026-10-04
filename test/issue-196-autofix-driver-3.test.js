'use strict';

// Part 3 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

test('Issue #196 only the autofix driver names the writer operations, and CL-D96 records them', () => {
  for (const file of ['run.js', 'review.js']) assert.doesNotMatch(readText(`skills/closed-loop-pr/driver/${file}`), /commit_create|push_publish/, file);
  const autofix = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.match(autofix, /'commit_create'/);
  assert.match(autofix, /'push_publish'/);
  assert.doesNotMatch(autofix, /\/merge\b|'merge'|--approve|marker_create|--force/);
  assert.ok(/^## CL-D96 — /m.test(require('./helpers').readContract()), 'CL-D96 records the autofix driver');
});

test('Issue #196 the autofix driver advances a validated MERGE that carries a deferred follow-up', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const r = result(t, { fresh: true, verdict: 'MERGE', anchoring: 'follow-up', disposition: 'deferred' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
});

test('Issue #196 an autofix driver failure after the run directory exists still ends with a token', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setFixture(t.bin, { failEndpoint: 'issues/5' });
  const r = result(t);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /the driver failed/);
});

test('Issue #196 a failed terminal operator recheck turns the stop BLOCKED and keeps the workspace', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  fs.writeFileSync(path.join(t.target.checkout, 'a.js'), 'dirty\n');
  result(t, { fresh: true, severity: 'Blocker' });
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED', s.reason);
  assert.match(s.reason, /operator/);
  assert.equal(fs.existsSync(s.workspace), true);
});

test('Issue #196 writer-done waits while the writer run is still going, even after its batch finished', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: writerId(t), state: 'running', steps: [{ agent: 'tidd-autofix-worker', status: 'running' }] }));
  const r = writerDone(t);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^WAIT: /m);
  assert.equal(state(t.runDir).pending.kind, 'writer', 'no gate launches in the workspace the writer still holds');
});

test('Issue #196 a sixth push is never prepared: the push cap of 5 stops before the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { pushes: 5 });
  const r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout), null, 'no writer launch');
  assert.deepEqual([state(t.runDir).state, state(t.runDir).reason], ['ROUND_LIMIT_REACHED', 'push_limit']);
  assert.equal(originHead(t), t.target.head);
});

test('Issue #196 the autofix driver stops before any gate without .tidd.json or acceptance criteria', () => {
  // #209: exact autofix with no validation commands stops, naming both places they can come from.
  for (const [label, options, pattern] of [['no .tidd.json', { config: null }, /\.tidd\.json at the base or ~\/\.config\/tidd\/o\/r\.json/], ['no acceptance criteria', { issueBody: 'Spec only.\n' }, /[Aa]cceptance/]]) {
    const t = setup(options);
    const r = drive(t.start, t.env);
    assert.equal(nextRequest(r.stdout), null, `${label}: no gate launch`);
    assert.equal(state(t.runDir).state, 'BLOCKED', label);
    assert.match(state(t.runDir).reason, pattern, label);
    // Before the operator capture and any workspace (#209 AC3).
    assert.equal(fs.readdirSync(t.runDir).some((f) => /-(operator_capture|workspace_create)\.request\.json$/.test(f)), false, label);
  }
});

// PR #208 round 2, the findings where the driver could proceed wrongly (owner cut-off, pull/208#issuecomment-5913850841).
test('Issue #196 new external evidence at the convergence cap reruns Sol before Terra and before readiness', () => {
  const comment = { prComments: [{ id: 9, html_url: 'u9', user: { login: 'human', type: 'User' }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'one more thing' }] };
  // Before Terra: Sol returns MERGE, then the snapshot changes.
  let t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 4 });
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  setFixture(t.bin, comment);
  let r = result(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `Sol reruns on the changed snapshot: ${r.stdout}${r.stderr}`);
  // At readiness: Terra returns MERGE, then the snapshot changes.
  t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 4 });
  result(t); result(t);
  setFixture(t.bin, comment);
  r = result(t);
  assert.notEqual(state(t.runDir).state, 'MERGE_READY', 'no readiness on a snapshot no formal gate saw');
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
});

test('Issue #196 a confirmed fix that a later gate reports unresolved goes back to the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true }); // CONV-7-X1
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  // Convergence confirms X1 and raises X2 on the new head; the writer corrects X2.
  let r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', r.stdout + r.stderr);
  assert.equal(writerBatch(t, 'module.exports = 4;\n').status, 0);
  // On that head X2 is confirmed but X1 is reported unresolved again: X1 needs the writer, not Sol.
  r = result(t, { reject: ['CONV-7-X1'] });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', `the regressed fix returns to the writer: ${r.stdout}${r.stderr}`);
  assert.equal(state(t.runDir).ledger.find((e) => e.findingId === 'CONV-7-X1').status, 'open');
});

// Issue #224: the driver's Git reads capture Git's error output, so a failure keeps Git's own reason in the stop rather
// than echoing it to a terminal the operator may never see.
test('Issue #224 a Git failure after the run directory exists keeps Git\'s reason in the stop', () => {
  const t = setup();
  git(t.target.checkout, ['remote', 'remove', 'origin']);
  const r = drive(t.start, t.env);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /^the driver failed: Command failed: git .*remote get-url origin \(error: No such remote 'origin'\)$/);
  assert.equal(r.stderr, '');
});
