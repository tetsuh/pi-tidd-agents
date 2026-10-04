'use strict';

// Part 2 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

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

test('Issue #196 Sol and Terra stop ROUND_LIMIT_REACHED at their shared cap of 15', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { gates: 15 });
  const r = result(t);
  assert.equal(nextRequest(r.stdout), null, 'no sixteenth formal gate launches');
  assert.deepEqual([state(t.runDir).state, state(t.runDir).reason], ['ROUND_LIMIT_REACHED', 'gate_limit']);
});

test('Issue #196 a criterion-anchored Minor, fixed or deferred, is in the correctable class', () => {
  for (const disposition of ['fixed', 'deferred']) {
    const t = setup();
    assert.equal(drive(t.start, t.env).status, 0);
    const r = result(t, { fresh: true, severity: 'Minor', disposition });
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', `${disposition}: ${r.stdout}${r.stderr}`);
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
  // The autofix driver sends no pull request back here; it stops (CL-D104).
  assert.doesNotMatch(r.stdout, /^PROSE_PATH:/m);
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

test('Issue #196 a validation harness that cannot run is harness_failed, not validation_failed', () => {
  const t = setup({ config: { validate: [['/nonexistent/validator']] } });
  drive(t.start, t.env);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /^harness_failed/);
});

test('Issue #196 writer.js composes the writer task and the commit message from the run state', () => {
  const { writerTask, writerMessage } = require('../skills/closed-loop-pr/driver/writer');
  const s = { issueNumber: 5, workspace: '/w', validationCommands: [['node', '--test']], target: { repository: 'o/r', number: 7, headBranch: 'f', headOid: 'a'.repeat(40) } };
  const open = [{ findingId: 'CONV-7-X1', record: { severity: 'Major', gate: 'convergence', evidence: 'e', impact: 'i', correction: 'change  a.js' } }];
  assert.equal(writerMessage(s, open), 'fix: CONV-7-X1 (#5)\n\n- CONV-7-X1: change a.js\n\nTest provenance: node --test; git diff --check HEAD passed in the run-owned workspace before this commit.\n');
  const task = writerTask(s, open, ['a.js'], '/pkg/autofix.js', '/run');
  assert.match(task, /1\. Run: node \/pkg\/autofix\.js pre-edit --run-dir \/run/);
  assert.match(task, /\n   - a\.js\n/);
  assert.match(task, /### CONV-7-X1 \(Major, convergence\)/);
  // The batch refuses ignored-path changes it did not make, so the writer leaves validation to it.
  assert.match(task, /3\. Do not run the validation commands or the project's tests yourself/);
  assert.doesNotMatch(task, /You may run the validation commands/);
});

test('Issue #196 paths.js ends a name only at whitespace or listed punctuation, and retain keeps an earlier action', () => {
  // Round-10 pre-push sweep: connector punctuation, format characters, other dots, and ASCII symbols are not boundaries.
  const { namedPaths } = require('../skills/closed-loop-pr/driver/paths');
  const tracked = ['a.js', 'lib/b.js'];
  for (const text of ['x‿a.js', 'x＿a.js', 'a.js⁀x', 'x‍a.js', 'a.js‍x', 'foo­a.js', 'x⁠a.js', 'x​a.js', '‍./a.js', 'x·a.js', 'x·a.js', 'x・a.js', 'x\u{1F600}a.js', '@lib/b.js', 'x+a.js', 'x$a.js', 'x~a.js', 'x#a.js', 'x^a.js', 'x\\a.js', 'x=a.js']) {
    assert.deepEqual([...namedPaths(`fix ${text} now`, tracked)], [], JSON.stringify(text));
  }
  for (const [text, want] of [['(a.js)', ['a.js']], ['"lib/b.js",', ['lib/b.js']], ['a.js:12', ['a.js']], ['`a.js`.', ['a.js']], ['«a.js»', ['a.js']], ['./a.js;', ['a.js']]]) {
    assert.deepEqual([...namedPaths(text, tracked)], want, text);
  }
});

test('Issue #196 a retained root is added to an earlier operator action, never replacing it', () => {
  const t = setup();
  setFixture(t.bin, { threads: [thread('T1', false)] });
  assert.equal(drive(t.start, t.env).status, 0);
  for (let i = 0; i < 3; i += 1) result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER', s.reason);
  const before = s.operatorActions;
  assert.ok(before && !/retained workspace roots/.test(before), before);
  // The function the stop uses (writer.js): an earlier action survives, and the root is joined after it.
  const { retain } = require('../skills/closed-loop-pr/driver/writer');
  const st = { operatorActions: before }; retain(st, '/tmp/root-x');
  assert.ok(st.operatorActions.startsWith(`${before}; `), st.operatorActions);
  assert.match(st.operatorActions, /retained workspace roots \(1\): \/tmp\/root-x$/);
  const none = { operatorActions: 'none' }; retain(none, '/tmp/root-y');
  assert.match(none.operatorActions, /^inspect, then remove this run's retained workspace roots \(1\)/);
});
