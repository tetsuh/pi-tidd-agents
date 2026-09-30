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
  r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const gate of ['convergence', 'adversarial', 'safety']) {
    assert.equal(nextRequest(r.stdout).agent, { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[gate]);
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.env);
  }
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.target.headOid, pushed);
  assert.deepEqual(s.counters, { gates: 2, conv: 2, pushes: 1 });
  assert.deepEqual(s.ledger.map((e) => [e.findingId, e.status, e.confirmedBy]), [['CONV-7-X1', 'settled', 'convergence']]);
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
  const r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
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
const outputPath = (t, runId) => JSON.parse(fs.readFileSync(path.join(t.runs, 'async-subagent-runs', runId, 'status.json'), 'utf8')).steps[0].structuredOutputPath;
function writerBatch(t, content) {
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), content);
  assert.match(drive(['batch', '--run-dir', t.runDir], t.env, ws).stdout, /BATCH_OK/);
  return drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
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
  const dir = path.join(t.runs, 'async-subagent-runs', 'writer-run'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: 'writer-run', state: 'running', steps: [{ agent: 'tidd-autofix-worker', status: 'running' }] }));
  const r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
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
  const r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
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
  let r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
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
  const dir = path.join(t.runs, 'async-subagent-runs', 'writer-run'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: 'writer-run', state: 'running', steps: [{ agent: 'tidd-autofix-worker', status: 'running' }] }));
  const r = drive(['writer-done', '--run-dir', t.runDir, '--run-id', 'writer-run'], t.env);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^WAIT: /m);
  assert.equal(state(t.runDir).pending.kind, 'writer', 'no gate launches in the workspace the writer still holds');
});
