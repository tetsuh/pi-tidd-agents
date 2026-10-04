'use strict';

// Part 7 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

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

test('Issue #196 convergence at its cap of 5 hands a finding to Sol instead of the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 4 });
  const r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
  assert.equal(state(t.runDir).counters.conv, 5);
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

test('Issue #196 the writer is not launched on a target that moved after the gate launched', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setFixture(t.bin, { prDraft: true });
  const r = result(t, { fresh: true });
  assert.equal(nextRequest(r.stdout), null, r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
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

test('Issue #196 writer.js judges a writer record: this run id, this workspace, after this launch, terminal, the worker', () => {
  // Split from autofix.js under the per-file alarm (owner, option b): the judgment is pure and tested directly.
  const { writerFinished } = require('../skills/closed-loop-pr/driver/writer');
  const id = '00000000-0000-4000-8000-000000000001', root = temp('i196-writer-');
  const s = { workspace: '/w', resolved: [], batch: { launchedAt: 1000 } };
  const record = (r) => { fs.mkdirSync(path.join(root, id), { recursive: true }); fs.writeFileSync(path.join(root, id, 'status.json'), JSON.stringify(r)); };
  const good = { runId: id, cwd: '/w', startedAt: 2000, state: 'complete', steps: [{ agent: 'tidd-autofix-worker' }] };
  assert.equal(writerFinished(root, id, s), false, 'no record');
  record(good); assert.equal(writerFinished(root, id, s), true);
  for (const bad of [{ runId: 'x' }, { cwd: '/other' }, { startedAt: 999 }, { startedAt: undefined }, { startedAt: '2000' }, { state: 'running' }, { state: 'unknown' }, { steps: [{ agent: 'tidd-safety-reviewer' }] }]) {
    record({ ...good, ...bad }); assert.equal(writerFinished(root, id, s), false, JSON.stringify(bad));
  }
  record(good); assert.equal(writerFinished(root, id, { ...s, resolved: [`tidd-autofix-worker run ${id}`] }), false, 'an earlier batch\'s run');
  assert.throws(() => writerFinished(root, '../x', s), /UUID/);
});

test('Issue #196 a convergence role preflight found disabled is skipped at start and at every restart (CL-D62)', () => {
  // CONV-208-DISABLED-ROLE: review.js already honours --convergence disabled; the autofix driver does the same.
  assert.notEqual(drive([...setup().start, '--convergence', 'off'], setup().env).status, 0, 'only the value disabled is accepted');
  const t = setup();
  let r = drive([...t.start, '--convergence', 'disabled'], t.env);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
  assert.ok(state(t.runDir).resolved.includes('convergence: disabled'));
  r = result(t, { fresh: true }); // Sol raises a correctable finding
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', r.stdout + r.stderr);
  r = writerBatch(t, 'module.exports = 3;\n');
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', `the post-push restart skips convergence: ${r.stdout}${r.stderr}`);
  assert.equal(state(t.runDir).counters.conv, 0);
  assert.match(state(t.runDir).rounds, /convergence disabled/);
});

test('Issue #196 ignored paths validation creates in the batch are adopted, not refused', () => {
  const mk = "require('fs').mkdirSync('build',{recursive:true});require('fs').writeFileSync('build/cache','c')";
  const t = setup({ files: { '.gitignore': 'build/\n' }, config: { validate: [['node', '-e', mk]] } });
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  assert.notEqual(state(t.runDir).state, 'BLOCKED', state(t.runDir).reason);
});
