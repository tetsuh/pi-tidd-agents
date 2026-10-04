'use strict';

// Part 1 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

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
    const launch = nextRequest(r.stdout);
    assert.equal(launch.agent, { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[gate]);
    // CL-D101 (#225): the launch names a verification request and carries no hash for the child to copy.
    assert.match(launch.task, /gate-verify-[a-z]+-\d+\.json/, launch.task);
    assert.doesNotMatch(launch.task.replaceAll(t.runDir, ''), /[0-9a-f]{12,}/, launch.task);
    r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.env);
  }
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.target.headOid, pushed);
  // #209 AC1: the source is recorded in the state and named first in the validation line.
  assert.equal(s.validationSource, 'base .tidd.json');
  assert.match(s.validation, /^source: base \.tidd\.json; /);
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

// The round-9 parity sweep against review.js (CL-D96 holds every CL-D93 obligation).
test('Issue #196 ignored paths that change after validation stop the next gate', () => {
  const t = setup({ files: { '.gitignore': 'build/\n' } });
  assert.equal(drive(t.start, t.env).status, 0);
  const ws = state(t.runDir).workspace;
  fs.mkdirSync(path.join(ws, 'build'), { recursive: true }); fs.writeFileSync(path.join(ws, 'build', 'x'), 'x');
  const r = result(t);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /ignored paths changed/);
});

test('Issue #196 paths.js reads whole code points and combining marks at every name boundary', () => {
  // ADV-208-PATH-UNICODE: a supplementary letter or number, or a combining mark, beside a name continues it.
  const { namedPaths } = require('../skills/closed-loop-pr/driver/paths');
  const tracked = ['a.js', 'lib/b.js', 'README.md'];
  for (const text of ['\u{10400}a.js', 'a.js\u{10400}', '\u{1D7D8}a.js', 'a.js\u{1D7D8}', '\u{10400}./a.js', 'a.js.\u{10400}bak', 'a.jś', '́a.js', '\u{10400}lib/b.js', 'b.js\u{10400}', '\u{10400}README.md']) {
    assert.deepEqual([...namedPaths(`fix ${text} now`, tracked)], [], JSON.stringify(text));
  }
  assert.deepEqual([...namedPaths('fix a.js, then b.js.', tracked)].sort(), ['a.js', 'lib/b.js'], 'plain punctuation still bounds a name');
});

test('Issue #196 a stop reports this run\'s retained workspace roots and their count', () => {
  // ADV-208-RETAINED-ROOT-REPORT (owner: implemented here): a BLOCKED stop keeps the workspace; the report names its root.
  let t = setup({ config: { validate: [['node', '-e', 'process.exit(1)']] } });
  drive(t.start, t.env);
  let s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED', s.reason);
  assert.match(s.operatorActions, new RegExp(`retained workspace roots \\(1\\): ${s.created.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // #221: the drafted comment names it with the temporary root as a placeholder, never the local path itself.
  const comment = fs.readFileSync(s.publication.comment, 'utf8');
  assert.ok(comment.includes(`{tmp}${s.created.root.slice(require('node:os').tmpdir().length)}`), 'the drafted comment names the root');
  assert.equal(comment.includes(s.created.root), false, 'without its local path');
  // A refused cleanup keeps it too.
  t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t); result(t);
  const file = path.join(t.runDir, 'state.json'), s0 = state(t.runDir);
  s0.created = { ...s0.created, receipt: { ...s0.created.receipt, id: 'someone-else' } }; fs.writeFileSync(file, JSON.stringify(s0));
  result(t);
  s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.operatorActions, /retained workspace roots \(1\)/);
});
