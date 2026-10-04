'use strict';

// Part 6 of 7 of issue-196-autofix-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-autofix-driver.fixtures.js. These tests drive the packaged
// exact-autofix driver (CL-D96, #196).
const { test, assert, fs, path, spawnSync, repoPath, readText, temp, git, makeTarget, fakeGh, setFixture, readFixture, fakeGate, driverEnv, nextRequest, DRIVER, drive, setup, state, originHead, result, thread, writerId, writerStatus, writerDone, outputPath, writerBatch, setCounters } = require("./issue-196-autofix-driver.fixtures.js");

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

test('Issue #196 the autofix driver reruns convergence when new external evidence arrives before a later gate', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setFixture(t.bin, { prComments: [{ id: 9, html_url: 'u9', user: { login: 'human', type: 'User' }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'one more thing' }] });
  const r = result(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(state(t.runDir).invocations.convergence, 2);
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

test('Issue #196 an assigned finding that is no longer correctable goes to the owner, not the writer', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true });
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  const r = result(t, { unconfirmed: true, disposition: 'accepted-as-designed' });
  assert.equal(nextRequest(r.stdout), null, `no writer: ${r.stdout}`);
  assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER');
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

test('Issue #209 the autofix driver refuses an operator configuration inside the checkout, even from a subdirectory', () => {
  // The sweep after CONV-211-XDG-IN-REPO: the check compares with the repository root, not the --checkout given.
  const t = setup({ config: null, files: { 'sub/keep': 'k\n' } });
  const cfg = path.join(t.target.checkout, 'cfg');
  fs.mkdirSync(path.join(cfg, 'tidd', 'o'), { recursive: true });
  const marker = path.join(temp('i209-marker-'), 'ran');
  fs.writeFileSync(path.join(cfg, 'tidd', 'o', 'r.json'), JSON.stringify({ validate: [['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]] }));
  git(t.target.checkout, ['add', 'cfg']); git(t.target.checkout, ['commit', '-q', '-m', 'config at head']); git(t.target.checkout, ['push', '-q', 'origin', 'feature']);
  const start = [...t.start]; start[start.indexOf('--checkout') + 1] = path.join(t.target.checkout, 'sub');
  drive(start, { ...t.env, XDG_CONFIG_HOME: cfg });
  assert.equal(state(t.runDir).state, 'BLOCKED', state(t.runDir).reason);
  assert.match(state(t.runDir).reason, /inside the target checkout/);
  assert.equal(fs.existsSync(marker), false, "the head file's command never ran");
});

// #209 AC1 and AC4 in autofix (pre-push sweep): --validate and the operator configuration are sources when the base has
// no file, each recorded; a .tidd.json added only at the head is never one.
test('Issue #209 the autofix driver takes --validate or the operator configuration, and records which', () => {
  const config = temp('i209-autofix-config-');
  fs.mkdirSync(path.join(config, 'tidd', 'o'), { recursive: true });
  fs.writeFileSync(path.join(config, 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "process.exit(0)", "operator-config"]]}\n');
  for (const [label, args, env, source] of [['--validate', ['--validate', '[["node", "-e", "process.exit(0)", "flag"]]'], {}, '--validate'], ['operator configuration', [], { XDG_CONFIG_HOME: config }, 'operator configuration']]) {
    const t = setup({ config: null });
    const r = drive([...t.start, ...args], { ...t.env, ...env });
    assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `${label}: ${r.stdout}${r.stderr}`);
    const s = state(t.runDir);
    assert.equal(s.validationSource, source, label);
    const marker = label === '--validate' ? 'flag' : 'operator-config';
    assert.ok(s.validation.startsWith(`source: ${source}; node -e process.exit(0) ${marker}: passed; `), `${label}: ${s.validation}`);
  }
});
