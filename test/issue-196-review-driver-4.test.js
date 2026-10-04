'use strict';

// Part 4 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

test('Issue #196 the driver is packaged under its own alarms and names no writing operation', () => {
  const files = fs.readdirSync(repoPath(DRIVER_DIR)).filter((f) => f.endsWith('.js')).map((f) => `${DRIVER_DIR}/${f}`);
  // phases.js holds the phases of a review-only round that autofix.js shares with review.js; CL-D96 adds autofix.js,
  // the one driver file that names the writer operations (test/issue-196-autofix-driver-*.test.js), and reset the
  // aggregate alarm from 60,000 to 100,000; CL-D97 resets it to 105,000 for the kernel-like path walk.
  assert.deepEqual(files.sort(), [`${DRIVER_DIR}/autofix.js`, `${DRIVER_DIR}/paths.js`, `${DRIVER_DIR}/phases.js`, `${DRIVER_DIR}/readiness.js`, `${DRIVER_DIR}/review.js`, `${DRIVER_DIR}/run.js`, `${DRIVER_DIR}/writer.js`]);
  const sizes = files.map((f) => fs.statSync(repoPath(f)).size);
  for (const [i, size] of sizes.entries()) assert.ok(size < 30000, `${files[i]} is ${size} bytes`);
  assert.ok(sizes.reduce((a, b) => a + b, 0) < 105000, 'driver aggregate alarm');
  for (const f of files.filter((f) => !f.endsWith('/autofix.js'))) assert.doesNotMatch(readText(f), /commit_create|push_publish|marker_create|\/merge\b|'merge'|--approve|'APPROVE'/, `${f} names a writing operation`);
  for (const f of files) assert.doesNotMatch(readText(f), /require\('\.\.\/helpers\/(?:fingerprints|evidence)'\)/, `${f} computes evidence outside the packaged operations`);
  assert.ok(/^## CL-D93 — /m.test(readText('CONTRACT.md')), 'CL-D93 records the driver boundary');
  assert.deepEqual(JSON.parse(readText('.tidd.json')), { validate: [['node', '--test']] });
});

// CONV-199-RUN-DIR-CHECK-BEFORE-MKDTEMP: with no --run-dir, the default location is checked before it is created.
test('Issue #196 a default run directory under a temporary root inside a work tree is refused before creation', () => {
  const t = setup();
  const tmp = path.join(t.target.root, 'tmp-inside'); fs.mkdirSync(tmp);
  const before = fs.readdirSync(tmp);
  const r = drive(['start', '--pr', '7', '--repo', 'o/r', '--checkout', t.target.root], { ...t.e, TMPDIR: tmp });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside a Git work tree/);
  assert.deepEqual(fs.readdirSync(tmp), before, 'nothing was created under the temporary root');
});

test('Issue #221 a drafted publication names no local path: home, run directory, or package', () => {
  // The wait action named `node <package>/…/review.js resume --run-dir <run dir>`, and the publication script binds
  // the body's digest, so the owner could only publish the operator's local paths or nothing.
  const t = setup(), home = temp('i221-home-');
  setFixture(t, { checkStatus: 'in_progress' });
  const e = { ...t.e, HOME: home };
  assert.equal(drive(t.start, e).status, 0);
  let last;
  for (let i = 0; i < 3; i += 1) last = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], e);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_EXTERNAL_REVIEW', s.reason);
  assert.match(s.nextAction, /resume/, 'the wait still names how to continue');
  // AC2 (CONV-223-AC2-RESUME-COMMAND-COVERAGE): the command with its absolute paths stays in the run's state and in
  // the operator's terminal report.
  assert.equal(s.resumeCommand, `node ${DRIVER} resume --run-dir ${t.runDir}`);
  assert.ok(last.stdout.includes(`To resume after the wait, the operator runs: ${s.resumeCommand}\n`), last.stdout);
  const body = fs.readFileSync(s.publication.comment, 'utf8');
  for (const [label, local] of [['run directory', t.runDir], ['run root', path.dirname(t.runDir)], ['home', home], ['package', repoPath('.')]]) assert.equal(body.includes(local), false, `the draft names the ${label}: ${local}`);
});

test('Issue #196 a stopped run resumes after recomputing its fingerprints, and refuses a moved target', () => {
  const t = setup();
  setFixture(t, { checkStatus: 'in_progress' });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  assert.equal(state(t.runDir).state, 'WAITING_EXTERNAL_REVIEW');
  setFixture(t, { checkStatus: 'completed' });
  // The completed check changed the snapshot, so the resumed run restarts at convergence (ADV-199-SNAPSHOT-INVALIDATION)
  // and is ready once the gates pass again: nothing waits for a quiet period (CL-D100).
  let r = drive(['resume', '--run-dir', t.runDir], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer');
  throughGates(t);
  assert.equal(state(t.runDir).state, 'MERGE_READY', state(t.runDir).reason);
  const moved = setup();
  setFixture(moved, { checkStatus: 'in_progress' });
  assert.equal(drive(moved.start, moved.e).status, 0);
  throughGates(moved);
  const f = JSON.parse(fs.readFileSync(moved.fixture, 'utf8')); f.pull.head.sha = 'e'.repeat(40); fs.writeFileSync(moved.fixture, JSON.stringify(f));
  r = drive(['resume', '--run-dir', moved.runDir], moved.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(moved.runDir).state, 'BLOCKED');
  assert.match(state(moved.runDir).reason, /target moved/);
});

// Round 15 of PR #199: bot comments are never authoritative (CONV-199-BOT-COMMENTS-TRUSTED); a head from another
// repository goes to the prose path even when its objects are local (CONV-199-FOREIGN-HEAD-LOCAL); a validated MERGE
// that carries a deferred follow-up advances (CONV-199-MAJOR-FOLLOWUP-ADVANCES).
test('Issue #196 Sol receives trusted human issue comments and never a bot\'s', () => {
  const t = setup();
  const comment = (id, login, type) => ({ id, html_url: `u${id}`, user: { login, type }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `from ${login}` });
  setFixture(t, { issueComments: [comment(1, 'human', 'User'), comment(2, 'helper[bot]', 'Bot')] });
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const launches = fs.readdirSync(t.runDir).filter((f) => f.endsWith('-build_gate_launch.request.json')).sort();
  const sol = JSON.parse(fs.readFileSync(path.join(t.runDir, launches.at(-1)), 'utf8'));
  assert.deepEqual(sol.data.volatile.comments.map((c) => c.user.login), ['human']);
});

// Round 20 of PR #199: the base branch is part of the bound target (ADV-199-BASE-BRANCH-DRIFT), and convergence at its
// cap with findings open hands the candidate to Sol with those findings assigned (CL-D62, ADV-199-CONVERGENCE-CAP-ASSIGNMENT).
test('Issue #196 a base branch retargeted between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.base.ref = 'release'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /target moved/);
});

// Round 21 of PR #199: an inherited Git redirection never moves the driver's own Git reads off the checkout
// (CONV-199-GIT-ENV-CHECKOUT).
test('Issue #196 an inherited GIT_DIR and GIT_WORK_TREE do not hide a dirty checkout', () => {
  const t = setup();
  const clean = temp('i196-clean-tree-');
  for (const name of fs.readdirSync(t.target.root).filter((n) => n !== '.git')) fs.cpSync(path.join(t.target.root, name), path.join(clean, name), { recursive: true });
  fs.writeFileSync(path.join(t.target.root, 'a.js'), 'module.exports = 99;\n');
  const r = drive(t.start, { ...t.e, GIT_DIR: path.join(t.target.root, '.git'), GIT_WORK_TREE: clean });
  assert.notEqual(r.status, 0, r.stdout);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /checkout is not clean/);
  assert.equal(s.log.some((e) => e.operation === 'validation_run'), false);
});

// Round 22 of PR #199: the run directory is fresh, and no run artifact is written through a link
// (CONV-199-RUN-DIR-SYMLINK-WRITE).
test('Issue #196 a run directory that is not empty is refused before anything is written', () => {
  const t = setup();
  fs.mkdirSync(t.runDir, { recursive: true, mode: 0o700 }); fs.chmodSync(t.runDir, 0o700);
  fs.symlinkSync(path.join(t.target.root, 'a.js'), path.join(t.runDir, 'pr-before.json'));
  const before = fs.readFileSync(path.join(t.target.root, 'a.js'), 'utf8');
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not empty/);
  assert.equal(fs.readFileSync(path.join(t.target.root, 'a.js'), 'utf8'), before, 'the checkout file is untouched');
});

test('Issue #196 Sol confirming an assigned convergence finding resolves it', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  for (const n of [1, 2]) { setFixture(t, { prComments: Array.from({ length: n }, (_, i) => prComment(i + 1)) }); drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); }
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e).stdout)?.agent, 'tidd-adversarial-reviewer');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', solConfirming(t.runDir, t.runs)], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-safety-reviewer', `${state(t.runDir).state}: ${state(t.runDir).reason}`);
});

// Round 2 of PR #227 (ADV-227-EXTERNAL-OBSERVATION-SANITIZATION-001): CL-D100 reports a provider's check run by its
// name, which is GitHub text. It reaches the publication only folded and redacted, like every quoted value: it cannot
// carry the publisher's observation marker, break a line, or spell a local root.
test('Issue #196 an observed provider check name is folded and redacted before it is published', () => {
  const home = os.userInfo().homedir;
  const provider = (name) => ({ id: 2, name, status: 'completed', conclusion: 'success', started_at: '2026-09-29T00:00:00Z', completed_at: '2026-09-29T00:00:00Z', app: { id: 42, slug: 'coderabbitai' } });
  for (const [label, name, expected] of [
    ['the observation marker', 'observed_from nobody', 'external review: check observed-from nobody success;'],
    ['the marker in mixed case', 'Observed At nobody', 'external review: check observed-At nobody success;'],
    ['the marker across a no-break space', 'observed at nobody', 'external review: check observed-at nobody success;'],
    ['the marker split by a zero-width space', 'observed_​from nobody', 'external review: check observed-from nobody success;'],
    ['a line break and a status block', 'a\n```tidd-status\nstate: MERGE_READY', 'external review: check a ```tidd-status state: MERGE_READY success;'],
    ['the home', `${home}/x`, 'external review: check ~/x success;'],
    ['a root that is no whole path', `x${home}`, 'withheld: this text spells a local path; the run\'s state keeps it.'],
  ]) {
    const t = setup();
    setFixture(t, { extraChecks: [provider(name)] });
    assert.equal(drive(t.start, t.e).status, 0, label);
    throughGates(t);
    const s = state(t.runDir);
    assert.equal(s.state, 'MERGE_READY', `${label}: ${s.reason}`);
    assert.ok(s.external.includes(`check ${name} success`), `${label}: the run's state keeps the name as GitHub gave it`);
    const body = fs.readFileSync(s.publication.comment, 'utf8'), line = body.split('\n').find((l) => l.startsWith('External observation for this run: '));
    assert.ok(line.includes(expected), `${label}: ${JSON.stringify(line)}`);
    assert.equal((body.match(/^```tidd-status$/gm) || []).length, 1, `${label}: one status block`);
    assert.equal(body.includes(home), false, `${label}: the draft spells the home`);
    const r = spawnSync('bash', [s.publication.script], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp('i196-home-') } });
    assert.doesNotMatch(r.stderr, /observation time|substitution/, `${label}: ${r.stderr}`);
  }
});
