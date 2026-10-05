'use strict';

// Part 5 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

test('Issue #196 the autofix driver refuses a head from another repository before any run directory', () => {
  const t = setup();
  setFixture(t.bin, { headRepo: 'fork/r' });
  const r = drive(t.start, t.env);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stdout.trim().split('\n').pop(), /^PROSE_PATH: .*another repository/);
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

test('Issue #196 MERGE_READY names Sol and Terra, only the gates that returned MERGE on the final head', () => {
  // Convergence at its cap returns FIX BEFORE MERGE and hands the finding to Sol; it never returned MERGE on this head.
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 4 });
  result(t, { fresh: true }); result(t); result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.doesNotMatch(s.reason, /convergence/, s.reason);
  assert.match(s.reason, /sol and terra returned MERGE/);
  assert.equal(s.invalidated, null, 'a ready run carries no invalidated evidence');
});
