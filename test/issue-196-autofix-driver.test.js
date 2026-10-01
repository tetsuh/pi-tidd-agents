'use strict';

// Issue #196 PR-B — the packaged exact-autofix driver (CL-D96). The #191 spike took PR #195 to MERGE_READY without
// rescue (milestone #155). Here a local bare origin stands in for GitHub: the fake `gh` reads the pull request's head
// from it, so the writer's real `pre-edit` and `batch` (every packaged guard, `commit_create`, `push_publish`) move the
// public head the driver then re-reviews.
//
// TDD provenance: behavioural RED — no packaged autofix driver exists before the change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { repoPath, readText } = require('./helpers');
const { temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest } = require('./driver-fixtures');

const DRIVER = repoPath('skills/closed-loop-pr/driver/autofix.js');
function drive(args, env, cwd) { return spawnSync(process.execPath, [DRIVER, ...args], { encoding: 'utf8', env, cwd, timeout: 300000 }); }
function setup(options) {
  const target = makeTarget(options), bin = fakeGh(target), runs = temp('i196-runs-'), runDir = path.join(temp('i196-run-'), 'run');
  return { target, bin, env: driverEnv(bin, runs), runs, runDir, start: ['start', '--pr', '7', '--repo', 'o/r', '--checkout', target.checkout, '--run-dir', runDir] };
}
const state = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
const originHead = (t) => git(t.target.root, ['--git-dir', t.target.origin, 'rev-parse', 'refs/heads/feature']);

test('Issue #196 the packaged autofix driver corrects a finding through the writer batch and reaches MERGE_READY', () => {
  const t = setup();
  let r = drive(t.start, t.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout).agent, 'tidd-convergence-reviewer');
  r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { fresh: true })], t.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const writer = nextRequest(r.stdout);
  assert.equal(writer.agent, 'tidd-autofix-worker');
  const s0 = state(t.runDir);
  assert.equal(writer.cwd, s0.workspace, 'the writer runs in the run-owned workspace');
  assert.deepEqual(s0.batch.authorizedPaths, ['a.js'], 'the named path, which is also the changed file');
  // The writer: the pre-edit guard, one edit, then the guarded batch; its process commits and pushes.
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, s0.workspace).stdout, /^PRE_EDIT_OK$/m);
  fs.writeFileSync(path.join(s0.workspace, 'a.js'), 'module.exports = 3;\n');
  const b = drive(['batch', '--run-dir', t.runDir], t.env, s0.workspace);
  assert.match(b.stdout, /^BATCH_OK [0-9a-f]{40}$/m, b.stderr + b.stdout);
  const pushed = originHead(t);
  assert.notEqual(pushed, t.target.head, 'the public head moved');
  assert.equal(git(t.target.root, ['--git-dir', t.target.origin, 'log', '-1', '--format=%an <%ae>|%s', pushed]), 'Operator <operator@example.com>|fix: CONV-7-X1 (#5)');
  r = writerDone(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const gate of ['convergence', 'adversarial', 'safety']) {
    assert.equal(nextRequest(r.stdout).agent, { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[gate]);
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.env);
  }
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.target.headOid, pushed);
  assert.deepEqual(s.counters, { gates: 2, conv: 2, pushes: 1 });
  // Convergence confirms the fix; only Sol, finding no counterexample, settles it (CONV-208-SETTLE-ONLY-AFTER-SOL).
  assert.deepEqual(s.ledger.map((e) => [e.findingId, e.status, e.confirmedBy]), [['CONV-7-X1', 'settled', 'adversarial']]);
  assert.ok(s.log.every((entry) => entry.ok), `every packaged operation succeeded: ${JSON.stringify(s.log.filter((e) => !e.ok))}`);
});

test('Issue #196 an edit outside the authorized paths is refused before any commit, and the run stops BLOCKED', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { fresh: true })], t.env);
  const ws = state(t.runDir).workspace;
  drive(['pre-edit', '--run-dir', t.runDir], t.env, ws);
  fs.writeFileSync(path.join(ws, 'b.js'), 'module.exports = 0;\n');
  const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
  assert.match(b.stdout, /^FAILED overlay_freeze: guard_failed/m, b.stdout);
  assert.equal(originHead(t), t.target.head, 'nothing was pushed');
  const r = writerDone(t);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /guard_failed at overlay_freeze/);
});

test('Issue #196 a finding outside the correctable class stops WAITING_FOR_OWNER without a writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { fresh: true, severity: 'Blocker' })], t.env);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER');
  assert.match(s.reason, /outside the mechanised correction class/);
  assert.equal(s.log.some((e) => e.operation === 'build_writer_launch'), false);
});

test('Issue #196 only the autofix driver names the writer operations, and CL-D96 records them', () => {
  for (const file of ['run.js', 'review.js']) assert.doesNotMatch(readText(`skills/closed-loop-pr/driver/${file}`), /commit_create|push_publish/, file);
  const autofix = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.match(autofix, /'commit_create'/);
  assert.match(autofix, /'push_publish'/);
  assert.doesNotMatch(autofix, /\/merge\b|'merge'|--approve|marker_create|--force/);
  assert.ok(/^## CL-D96 — /m.test(readText('CONTRACT.md')), 'CL-D96 records the autofix driver');
});

// The PR #199 round-2 checks hold for the autofix driver too: run directory, target identity, role telemetry.
test('Issue #196 the autofix driver refuses a run directory inside a work tree and reports role telemetry', () => {
  const t = setup();
  const inside = path.join(t.target.checkout, 'run-inside');
  const bad = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', t.target.checkout, '--run-dir', inside], t.env);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /inside a Git work tree/);
  assert.equal(fs.existsSync(inside), false);
  let r = drive(t.start, t.env);
  for (let i = 0; i < 3; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.env);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.deepEqual(s.resolved, ['convergence', 'adversarial', 'safety'].map((g) => `tidd-${g}-reviewer fake/fake:unreported`));
});

// PR #199's review-only hardening holds for the autofix driver too: it shares the review driver's target binding,
// gate-result reading, revalidation, evidence identities, and final readiness policy (CL-D96).
const result = (t, options) => drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, options)], t.env);
function thread(id, resolved) { return { id, isResolved: resolved, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: `c${id}`, databaseId: 1, url: 'u', body: 'please change this', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'coderabbitai', __typename: 'Bot' } }], pageInfo: { endCursor: null, hasNextPage: false } } }; }

test('Issue #196 the autofix driver refuses a head from another repository before any run directory', () => {
  const t = setup();
  setFixture(t.bin, { headRepo: 'fork/r' });
  const r = drive(t.start, t.env);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /another repository/);
});

test('Issue #196 the autofix driver waits on a running gate and relaunches an unreadable result once', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const runId = fakeGate(t.runDir, t.runs);
  const statusPath = path.join(t.runs, 'async-subagent-runs', runId, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: 'running', steps: status.steps.map((x) => ({ ...x, status: 'running' })) }));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.match(r.stdout, /^WAIT: /m, r.stdout + r.stderr);
  assert.equal(state(t.runDir).pending.gate, 'convergence', 'the gate stays pending');
  fs.writeFileSync(statusPath, JSON.stringify(status));
  fs.rmSync(status.steps[0].structuredOutputPath);
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'the same launch is printed again');
  assert.equal(state(t.runDir).counters.conv, 0, 'no round is spent');
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 the autofix driver gives Sol trusted human issue comments and never a bot\'s', () => {
  const t = setup();
  const comment = (id, login, type) => ({ id, html_url: `u${id}`, user: { login, type }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `from ${login}` });
  setFixture(t.bin, { issueComments: [comment(1, 'human', 'User'), comment(2, 'helper[bot]', 'Bot')] });
  assert.equal(drive(t.start, t.env).status, 0);
  assert.equal(result(t).status, 0);
  const launches = fs.readdirSync(t.runDir).filter((f) => f.endsWith('-build_gate_launch.request.json')).sort();
  const sol = JSON.parse(fs.readFileSync(path.join(t.runDir, launches.at(-1)), 'utf8'));
  assert.deepEqual(sol.data.volatile.comments.map((c) => c.user.login), ['human']);
});

test('Issue #196 the autofix driver advances a validated MERGE that carries a deferred follow-up', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const r = result(t, { fresh: true, verdict: 'MERGE', anchoring: 'follow-up', disposition: 'deferred' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
});

test('Issue #196 the autofix driver stops readiness WAITING_FOR_OWNER on an unresolved external review thread', () => {
  const t = setup();
  setFixture(t.bin, { threads: [thread('T1', false), thread('T2', true)] });
  assert.equal(drive(t.start, t.env).status, 0);
  for (let i = 0; i < 3; i += 1) result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER', s.reason);
  assert.match(s.reason, /T1/);
  assert.doesNotMatch(s.reason, /T2/);
});

test('Issue #196 the autofix driver stops the next launch when the body or the issue spec changes between gates', () => {
  for (const [patch, reason] of [[(f) => ({ body: `${f.body}Edited.\n` }), /body changed/], [(f) => ({ issue: { ...f.issue, body: `${f.issue.body}- AC2: more.\n` } }), /issue_spec/]]) {
    const t = setup();
    assert.equal(drive(t.start, t.env).status, 0);
    setFixture(t.bin, patch(readFixture(t.bin)));
    const r = result(t);
    assert.notEqual(r.status, 0);
    assert.equal(state(t.runDir).state, 'BLOCKED');
    assert.match(state(t.runDir).reason, reason);
  }
});

test('Issue #196 the autofix driver reruns convergence when new external evidence arrives before a later gate', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setFixture(t.bin, { prComments: [{ id: 9, html_url: 'u9', user: { login: 'human', type: 'User' }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'one more thing' }] });
  const r = result(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(state(t.runDir).invocations.convergence, 2);
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

// The pre-push adversarial review of PR-B: exact autofix keeps CL-D51's relaunch key (autofix.md), the async writer is
// read before its batch is judged, and a failed terminal operator recheck is a BLOCKED stop.
// The runner's id for the writer of the current batch: a UUID, one per push, as the runner gives each run its own.
const writerId = (t) => `00000000-0000-4000-8000-${String(state(t.runDir).counters.pushes + 1).padStart(12, '0')}`;
// writer-done reads the writer's own runner record: an explicit terminal state for the autofix worker, never an absence.
function writerStatus(t, runState = 'complete') {
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'status.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ runId: writerId(t), state: runState, cwd: state(t.runDir).workspace, startedAt: Date.now(), steps: [{ agent: 'tidd-autofix-worker', status: runState }] }));
}
function writerDone(t) { writerStatus(t); return drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env); }
const outputPath = (t, runId) => JSON.parse(fs.readFileSync(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'), 'utf8')).steps[0].structuredOutputPath;
function writerBatch(t, content) {
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), content);
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  return writerDone(t);
}

test('Issue #196 exact autofix stops on malformed gate output instead of relaunching it', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const runId = fakeGate(t.runDir, t.runs);
  fs.writeFileSync(outputPath(t, runId), '{not json');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.notEqual(r.status, 0);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 exact autofix relaunches a missing output at most once per run, and never after a push', () => {
  let t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  let runId = fakeGate(t.runDir, t.runs); fs.rmSync(outputPath(t, runId));
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env).stdout)?.agent, 'tidd-convergence-reviewer', 'the one relaunch');
  assert.equal(nextRequest(result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  runId = fakeGate(t.runDir, t.runs); fs.rmSync(outputPath(t, runId));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.equal(nextRequest(r.stdout), null, 'a second relaunch in the same run');
  assert.equal(state(t.runDir).state, 'BLOCKED');
  t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  runId = fakeGate(t.runDir, t.runs); fs.rmSync(outputPath(t, runId));
  r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.equal(nextRequest(r.stdout), null, 'a relaunch after a push');
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 writer-done waits while the async writer is still running', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  drive(['pre-edit', '--run-dir', t.runDir], t.env, ws);
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: writerId(t), state: 'running', steps: [{ agent: 'tidd-autofix-worker', status: 'running' }] }));
  const r = writerDone(t);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^WAIT: /m);
  assert.equal(state(t.runDir).pending.kind, 'writer', 'the writer stays pending');
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/, 'the writer can still finish its batch');
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

test('Issue #196 the writer commit message carries test provenance (CL-D25)', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.match(state(t.runDir).batch.message, /^Test provenance: /m);
});

test('Issue #196 the writer batch refuses to push when the pull request head moved, even to an ancestor', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  // Someone rewinds the branch while the writer works: a plain push would fast-forward over the rewind.
  git(t.target.root, ['--git-dir', t.target.origin, 'update-ref', 'refs/heads/feature', t.target.base]);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
  assert.doesNotMatch(b.stdout, /BATCH_OK/, b.stdout + b.stderr);
  assert.equal(originHead(t), t.target.base, 'nothing was pushed over the rewind');
  const r = writerDone(t);
  assert.equal(nextRequest(r.stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /target_moved/);
});

test('Issue #196 a fix Sol answers with a counterexample is not settled', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  // Convergence at its cap hands the assigned finding to Sol (CL-D62); this stands in for four more convergence rounds.
  const file = path.join(t.runDir, 'state.json'), s0 = state(t.runDir);
  s0.counters.conv = 5; fs.writeFileSync(file, JSON.stringify(s0));
  let r = writerDone(t);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
  r = result(t, { counterexample: true });
  const s = state(t.runDir);
  assert.notEqual(s.state, 'MERGE_READY', s.reason);
  assert.notEqual(s.ledger.find((e) => e.findingId === 'CONV-7-X1').status, 'settled', 'a counterexample leaves the fix unresolved');
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

// Issue #196 AC2's refusals and caps, each at its boundary (CONV-208-EMPTY-EDIT-TEST, CONV-208-AUTOFIX-CAPS-TEST).
// Reaching a cap by real cycles costs a push each, so a counter is set one short of it in state.json and the next
// step is driven; the step itself is the driver's own code.
const setCounters = (t, patch) => { const file = path.join(t.runDir, 'state.json'), s = state(t.runDir); Object.assign(s.counters, patch); fs.writeFileSync(file, JSON.stringify(s)); };

test('Issue #196 the writer batch refuses an empty edit before any commit or push', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
  assert.doesNotMatch(b.stdout, /BATCH_OK/, b.stdout + b.stderr);
  assert.equal(state(t.runDir).batch.failed.step, 'overlay_freeze');
  assert.equal(originHead(t), t.target.head, 'nothing was pushed');
  assert.equal(nextRequest(writerDone(t).stdout), null);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 convergence at its cap of 5 hands a finding to Sol instead of the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 4 });
  const r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
  assert.equal(state(t.runDir).counters.conv, 5);
});

test('Issue #196 Sol and Terra stop ROUND_LIMIT_REACHED at their shared cap of 15', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { gates: 15 });
  const r = result(t);
  assert.equal(nextRequest(r.stdout), null, 'no sixteenth formal gate launches');
  assert.deepEqual([state(t.runDir).state, state(t.runDir).reason], ['ROUND_LIMIT_REACHED', 'gate_limit']);
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

test('Issue #196 the third unresolved observation of one finding stops ROUND_LIMIT_REACHED', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  const file = path.join(t.runDir, 'state.json'), s0 = state(t.runDir);
  s0.ledger.find((e) => e.findingId === 'CONV-7-X1').noProgress = 2; fs.writeFileSync(file, JSON.stringify(s0));
  const r = result(t, { unconfirmed: true });
  assert.equal(nextRequest(r.stdout), null, 'no further writer or gate');
  assert.equal(state(t.runDir).state, 'ROUND_LIMIT_REACHED');
  assert.match(state(t.runDir).reason, /^no_progress: CONV-7-X1 observed unresolved 3 times/);
});

// The mechanised judgments and the stops before any gate, as #196's body and AC4 name them.
test('Issue #196 authorizedPaths resolves a unique basename and refuses an ambiguous one', () => {
  let t = setup({ files: { 'lib/b.js': 'b\n', 'x/c.js': 'c\n', 'y/c.js': 'c\n' } });
  assert.equal(drive(t.start, t.env).status, 0);
  let r = result(t, { fresh: true, path: 'b.js' });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', r.stdout + r.stderr);
  assert.deepEqual(state(t.runDir).batch.authorizedPaths, ['a.js', 'lib/b.js'], 'the one tracked b.js, plus the changed file');
  t = setup({ files: { 'lib/b.js': 'b\n', 'x/c.js': 'c\n', 'y/c.js': 'c\n' } });
  assert.equal(drive(t.start, t.env).status, 0);
  r = result(t, { fresh: true, path: 'c.js' });
  assert.equal(nextRequest(r.stdout), null, 'two tracked c.js name no one path');
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
  assert.match(state(t.runDir).reason, /no finding names a tracked path/);
});

test('Issue #196 a criterion-anchored Minor, fixed or deferred, is in the correctable class', () => {
  for (const disposition of ['fixed', 'deferred']) {
    const t = setup();
    assert.equal(drive(t.start, t.env).status, 0);
    const r = result(t, { fresh: true, severity: 'Minor', disposition });
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', `${disposition}: ${r.stdout}${r.stderr}`);
  }
});

test('Issue #196 the autofix driver stops before any gate without .tidd.json or acceptance criteria', () => {
  for (const [label, options, pattern] of [['no .tidd.json', { config: null }, /tidd\.json/], ['no acceptance criteria', { issueBody: 'Spec only.\n' }, /[Aa]cceptance/]]) {
    const t = setup(options);
    const r = drive(t.start, t.env);
    assert.equal(nextRequest(r.stdout), null, `${label}: no gate launch`);
    assert.equal(state(t.runDir).state, 'BLOCKED', label);
    assert.match(state(t.runDir).reason, pattern, label);
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

test('Issue #196 an assigned finding that is no longer correctable goes to the owner, not the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  const r = result(t, { unconfirmed: true, disposition: 'accepted-as-designed' });
  assert.equal(nextRequest(r.stdout), null, `no writer: ${r.stdout}`);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
});

test('Issue #196 a finding from an external source is never corrected by the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const r = result(t, { fresh: true, sourceKind: 'issue-comment' });
  assert.equal(nextRequest(r.stdout), null, `no writer: ${r.stdout}${r.stderr}`);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
});

test('Issue #196 authorizedPaths never authorizes the suffix of a longer tracked path', () => {
  const t = setup({ files: { 'foo bar.js': 'x\n', 'bar.js': 'y\n' } });
  assert.equal(drive(t.start, t.env).status, 0);
  const r = result(t, { fresh: true, path: 'foo bar.js' });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', r.stdout + r.stderr);
  assert.deepEqual(state(t.runDir).batch.authorizedPaths, ['a.js', 'foo bar.js']);
});

test('Issue #196 the batch refuses to push when the pull request closed, turned draft, or changed base', () => {
  for (const [label, patch] of [['closed', { prState: 'closed' }], ['draft', { prDraft: true }], ['base', { base: 'f'.repeat(40) }]]) {
    const t = setup();
    assert.equal(drive(t.start, t.env).status, 0);
    result(t, { fresh: true });
    const ws = state(t.runDir).workspace;
    assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
    fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
    setFixture(t.bin, patch);
    const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
    assert.doesNotMatch(b.stdout, /BATCH_OK/, `${label}: ${b.stdout}`);
    assert.equal(originHead(t), t.target.head, `${label}: nothing pushed`);
  }
});

test('Issue #196 the first gate refuses an issue or body changed after the run read them', () => {
  // The validation command edits what GitHub reports, between the issue read and the first gate's recheck.
  for (const [label, edit] of [['issue', "f.issue.body += '- AC2: more.\\n'"], ['body', "f.body += 'Edited.\\n'"]]) {
    const t = setup();
    const fixture = path.join(t.bin, 'fixture.json');
    const script = `const fs=require('fs');const f=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8'));${edit};fs.writeFileSync(${JSON.stringify(fixture)},JSON.stringify(f));`;
    const cfg = { validate: [['node', '-e', script]] };
    git(t.target.checkout, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(t.target.checkout, '.tidd.json'), `${JSON.stringify(cfg)}\n`);
    git(t.target.checkout, ['commit', '-q', '-am', 'config']); git(t.target.checkout, ['push', '-q', 'origin', 'main']);
    setFixture(t.bin, { base: git(t.target.checkout, ['rev-parse', 'HEAD']) });
    git(t.target.checkout, ['checkout', '-q', 'feature']);
    const r = drive(t.start, t.env);
    assert.equal(nextRequest(r.stdout), null, `${label}: no gate launch on changed evidence: ${r.stdout}`);
    assert.equal(state(t.runDir).state, 'BLOCKED', label);
  }
});

test('Issue #196 a diff that is not valid UTF-8 never reaches a gate', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.target.checkout, 'bin.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
  git(t.target.checkout, ['add', 'bin.txt']); git(t.target.checkout, ['commit', '-q', '-m', 'bytes']); git(t.target.checkout, ['push', '-q', 'origin', 'feature']);
  const r = drive(t.start, t.env);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /UTF-8/);
});

test('Issue #196 a refused workspace cleanup never ends MERGE_READY', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t); result(t);
  // The receipt no longer matches, so workspace_cleanup_created refuses.
  const file = path.join(t.runDir, 'state.json'), s0 = state(t.runDir);
  s0.created = { ...s0.created, receipt: { ...s0.created.receipt, id: 'someone-else' } }; fs.writeFileSync(file, JSON.stringify(s0));
  result(t);
  assert.notEqual(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
});

// The round-2 pre-push sweep: an ambiguous basename still covers its span, the frozen issue comments are the ones
// fingerprinted, and the writer-side rechecks are pinned.
test('Issue #196 an ambiguous name still covers its span, so its tail authorizes nothing', () => {
  const t = setup({ files: { 'lib/foo bar.js': 'x\n', 'test/foo bar.js': 'y\n', 'bar.js': 'z\n' } });
  assert.equal(drive(t.start, t.env).status, 0);
  const r = result(t, { fresh: true, path: 'foo bar.js' });
  assert.equal(nextRequest(r.stdout)?.agent, undefined, `no writer on an ambiguous name: ${r.stdout}`);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
});

test('Issue #196 the first gate refuses issue comments added after the run read them', () => {
  const t = setup();
  const fixture = path.join(t.bin, 'fixture.json');
  const add = `const fs=require('fs');const f=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8'));f.issueComments=[{id:3,html_url:'u3',user:{login:'o',type:'User'},author_association:'OWNER',created_at:'2026-09-29T00:00:00Z',updated_at:'2026-09-29T00:00:00Z',body:'also this'}];fs.writeFileSync(${JSON.stringify(fixture)},JSON.stringify(f));`;
  git(t.target.checkout, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(t.target.checkout, '.tidd.json'), `${JSON.stringify({ validate: [['node', '-e', add]] })}\n`);
  git(t.target.checkout, ['commit', '-q', '-am', 'config']); git(t.target.checkout, ['push', '-q', 'origin', 'main']);
  setFixture(t.bin, { base: git(t.target.checkout, ['rev-parse', 'HEAD']) });
  git(t.target.checkout, ['checkout', '-q', 'feature']);
  const r = drive(t.start, t.env);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 the writer is not launched on a target that moved after the gate launched', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setFixture(t.bin, { prDraft: true });
  const r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
});

test('Issue #196 the batch refuses to push after the operator checkout changed', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  git(t.target.checkout, ['checkout', '-q', 'main']);
  const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
  assert.doesNotMatch(b.stdout, /BATCH_OK/, b.stdout + b.stderr);
  assert.equal(originHead(t), t.target.head, 'nothing pushed');
});

test('Issue #196 new external evidence while a gate runs stops the writer and restarts the sequence', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setFixture(t.bin, { prComments: [{ id: 9, html_url: 'u9', user: { login: 'human', type: 'User' }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'one more thing' }] });
  const r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `no writer on a stale snapshot: ${r.stdout}${r.stderr}`);
  assert.equal(state(t.runDir).writerLaunched, undefined);
  assert.equal(originHead(t), t.target.head);
});

test('Issue #196 paths.js names tracked paths whole and longest first, and names nothing for an ambiguous name', () => {
  // Split from autofix.js under the per-file alarm (owner, option B): the name matching is pure and tested directly.
  const { namedPaths } = require('../skills/closed-loop-pr/driver/paths');
  const tracked = ['a.js', 'lib/b.js', 'foo bar.js', 'bar.js', 'x/c.js', 'y/c.js', 'Makefile'];
  assert.deepEqual([...namedPaths('foo bar.js:3 is wrong', tracked)], ['foo bar.js']);
  assert.deepEqual([...namedPaths('change b.js and ./a.js.', tracked)].sort(), ['a.js', 'lib/b.js']);
  assert.deepEqual([...namedPaths('c.js differs', tracked)], []);
  assert.deepEqual([...namedPaths('see `Makefile`', tracked)], ['Makefile']);
  assert.deepEqual([...namedPaths('a.js.bak and xa.js', tracked)], []);
});

test('Issue #196 writer-done waits, changing nothing, when the writer run has no terminal record', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  // No record at all, then a record for another agent: neither is the writer's terminal state.
  let r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(state(t.runDir).pending.kind, 'writer', 'the writer stays pending');
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: writerId(t), state: 'complete', steps: [{ agent: 'tidd-safety-reviewer', status: 'complete' }] }));
  r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(state(t.runDir).pending.kind, 'writer');
});

test('Issue #196 a fix convergence confirms stays unresolved until Sol finds no counterexample', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  let r = result(t); // convergence confirms the fix
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
  assert.notEqual(state(t.runDir).ledger[0].status, 'settled', 'not settled by convergence alone');
  r = result(t, { counterexample: true }); // Sol links a counterexample to the confirmed fix
  const s = state(t.runDir);
  assert.notEqual(s.state, 'MERGE_READY', s.reason);
  assert.notEqual(s.ledger[0].status, 'settled');
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

test('Issue #196 writer-done takes only this batch\'s writer run: a UUID, its own record, terminal', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  const write = (record) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(record));
  // A path instead of a run id, a record naming another run, and a state the runner never calls terminal.
  let r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', '../x'], t.env);
  assert.notEqual(r.status, 0); assert.equal(state(t.runDir).pending.kind, 'writer');
  write({ runId: '00000000-0000-4000-8000-0000000000ff', state: 'complete', steps: [{ agent: 'tidd-autofix-worker', status: 'complete' }] });
  r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env);
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.equal(state(t.runDir).pending.kind, 'writer');
  write({ runId: writerId(t), state: 'unknown', steps: [{ agent: 'tidd-autofix-worker', status: 'unknown' }] });
  r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env);
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.equal(state(t.runDir).pending.kind, 'writer');
});

test('Issue #196 a run directory a shell would split is refused before anything is created', () => {
  // CONV-208-RUN-DIR-SHELL-PATH: the printed commands name the run directory and the driver for a shell to run.
  const t = setup();
  const runDir = path.join(temp('i196-run-'), 'run with spaces');
  const r = drive([...t.start.slice(0, -1), runDir], t.env);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(nextRequest(r.stdout), null);
  assert.match(r.stdout + r.stderr, /plain path/);
  assert.equal(fs.existsSync(runDir), false, 'no run directory was created');
});

test('Issue #196 writer-done takes a terminal worker record only from this launch, in this workspace', () => {
  // ADV-208-WRITER-BATCH-RUN-BINDING: an unused UUID of a finished worker elsewhere is not this batch's writer.
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  const dir = path.join(t.runs, 'async-subagent-runs', writerId(t)); fs.mkdirSync(dir, { recursive: true });
  const base = { runId: writerId(t), state: 'complete', steps: [{ agent: 'tidd-autofix-worker', status: 'complete' }] };
  for (const [label, extra] of [['another workspace', { cwd: '/tmp/other-workspace', startedAt: Date.now() }], ['started before this launch', { cwd: ws, startedAt: 1 }], ['no cwd or start', {}]]) {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ ...base, ...extra }));
    const r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', writerId(t)], t.env);
    assert.equal(r.status, 3, `${label}: ${r.stdout}${r.stderr}`);
    assert.equal(state(t.runDir).pending.kind, 'writer', `${label}: the writer stays pending`);
  }
});
