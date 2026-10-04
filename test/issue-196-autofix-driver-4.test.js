'use strict';

// Part 4 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

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

test('Issue #196 the writer commit message carries test provenance (CL-D25)', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.match(state(t.runDir).batch.message, /^Test provenance: /m);
});

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

test('Issue #196 the autofix driver passes --language-profile to the gates', () => {
  const t = setup();
  assert.equal(drive([...t.start, '--language-profile', 'ja-JP'], t.env).status, 0);
  const payload = fs.readdirSync(t.runDir).find((f) => f.startsWith('gate-payload-'));
  assert.match(fs.readFileSync(path.join(t.runDir, payload), 'utf8'), /"languageProfile": "ja-JP"/);
});

test('Issue #196 a refused workspace_create reports the root it kept', () => {
  // CONV-208-RETAINED-CREATE-COVERAGE: git cannot add a worktree under a read-only .git/worktrees, after the run root exists.
  const t = setup();
  const worktrees = path.join(t.target.checkout, '.git', 'worktrees');
  fs.mkdirSync(worktrees, { recursive: true }); fs.chmodSync(worktrees, 0o555);
  try {
    drive(t.start, t.env);
    const s = state(t.runDir);
    assert.equal(s.state, 'BLOCKED', s.reason);
    assert.match(s.reason, /^workspace_create refused/);
    assert.equal(s.retained?.length, 1, JSON.stringify(s.retained));
    assert.ok(fs.existsSync(s.retained[0]), 'the reported root is the one the failed create kept');
    assert.ok(s.operatorActions.includes(`retained workspace roots (1): ${s.retained[0]}`), s.operatorActions);
    // #221: with the temporary root as a placeholder, never the local path itself.
    const comment = fs.readFileSync(s.publication.comment, 'utf8');
    assert.ok(comment.includes(`{tmp}${s.retained[0].slice(require('node:os').tmpdir().length)}`), 'the drafted comment names it');
    assert.equal(comment.includes(s.retained[0]), false, 'without its local path');
  } finally { fs.chmodSync(worktrees, 0o755); }
});

test('Issue #196 the batch refuses an ignored path the writer changed before validation', () => {
  // CONV-208-IGNORED-WRITER-DRIFT: the writer's own ignored-path changes are drift; only validation's additions are adopted.
  const t = setup({ files: { '.gitignore': 'build/\n' } });
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  const ws = state(t.runDir).workspace;
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  fs.mkdirSync(path.join(ws, 'build'), { recursive: true }); fs.writeFileSync(path.join(ws, 'build', 'planted'), 'x');
  const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
  assert.doesNotMatch(b.stdout, /BATCH_OK/, b.stdout + b.stderr);
  assert.match(b.stdout, /ignored/);
  assert.equal(originHead(t), t.target.head, 'nothing pushed');
});

test('Issue #209 the autofix driver ignores a .tidd.json added only at the head', () => {
  const t = setup({ config: null });
  const marker = path.join(temp('i209-head-marker-'), 'ran');
  fs.writeFileSync(path.join(t.target.checkout, '.tidd.json'), `${JSON.stringify({ validate: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]] })}\n`);
  git(t.target.checkout, ['add', '.tidd.json']); git(t.target.checkout, ['commit', '-q', '-m', 'config at head']); git(t.target.checkout, ['push', '-q', 'origin', 'feature']);
  const r = drive(t.start, t.env);
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /\.tidd\.json at the base or ~\/\.config\/tidd\/o\/r\.json/);
  assert.equal(fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json')), false);
  assert.equal(fs.existsSync(marker), false, "the head file's command never ran");
});
