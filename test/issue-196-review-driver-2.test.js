'use strict';

// Part 2 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

test('Issue #196 contractInput is the package authority files, not the target checkout', () => {
  const t = setup();
  const r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const files = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/review-only.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
  const expected = crypto.createHash('sha256').update(Buffer.from(files.map((f) => `${f}\n${readText(f).replace(/\r\n?/g, '\n')}`).join('\n'), 'utf8')).digest('hex');
  assert.equal(state(t.runDir).contractInput, expected);
});

// Round 3 of PR #223 (ADV-223-PUBLICATION-REDACTION): the redaction ran before the publication's own folding, with
// ASCII word boundaries. An option attached to a path (`-I<home>`) kept the home; a zero-width character inside the
// home was folded away afterwards, which spelled the home again; and a sibling name (`<home>é`) or a root nested in a
// longer path (`/other/<tmp>`) was rewritten in part.
test('Issue #221 every quoted free-text field is redacted as folded, by whole path, with an attached option as a boundary', () => {
  const { Run } = require('../skills/closed-loop-pr/driver/run');
  const home = os.userInfo().homedir, tmp = os.tmpdir(), odd = '/sent\u00a0inel\u200b/home';
  const WITHHELD = 'withheld: this text spells a local path; the run\'s state keeps it';
  const run = new Run(temp('i221-matrix-'));
  const draft = (text, env) => {
    const s = run.state, write = process.stdout.write, before = process.env.HOME;
    Object.assign(s, { target: { repository: 'o/r', number: 7, headOid: 'a'.repeat(40), headBranch: 'b' }, state: 'BLOCKED', mode: 'review-only', startedAt: '2026-10-04T00:00:00.000Z',
      reason: text, validation: text, pendingDecisions: [text], operatorActions: text, invalidated: text, nextAction: text, gateLog: [{ gate: 'convergence', invocation: 1, head: 'a'.repeat(40), verdict: 'MERGE', findings: text }] });
    process.stdout.write = () => true; if (env) process.env.HOME = env;
    try { run.publish(); } finally { process.stdout.write = write; if (env) process.env.HOME = before; }
    const lines = fs.readFileSync(s.publication.comment, 'utf8').split('\n');
    return ['Reason: ', '- convergence 1 ', 'Validation: ', 'pending_decisions: ', 'operator_actions: ', 'invalidated_evidence: ', 'next_action: '].map((field) => lines.find((line) => line.startsWith(field)));
  };
  const zeroWidth = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff'].map((c) => [`a zero-width U+${c.codePointAt(0).toString(16)} inside the home`, `see ${home.slice(0, 3)}${c}${home.slice(3)}/x`, 'see ~/x']);
  for (const [label, text, expected, env] of [
    ['-I attached', `cc -I${home}/include`, 'cc -I~/include'], ['-L attached', `cc -L${home}/lib`, 'cc -L~/lib'], ['-isystem attached', `cc -isystem${home}/include`, 'cc -isystem~/include'],
    ['a quoted attached option', `cc "-I${home}/inc"`, 'cc "-I~/inc"'], ['a comma-joined linker option', `cc -Wl,-rpath,${home}/lib`, 'cc -Wl,-rpath,~/lib'],
    ...zeroWidth,
    ['a home the folding changes', `run ${odd}/x`, 'run ~/x', odd],
    ['a list of paths', `PATH=${home}/bin:${tmp}`, 'PATH=~/bin:{tmp}'], ['a file URL', `file://${home}/x`, 'file://~/x'], ['a path in brackets', `(${home})`, '(~)'],
    // Owner decision REDACTION-FAIL-CLOSED on PR #223: none of these is the home or the temporary root as a whole path,
    // so nothing is rewritten in part; a root's spelling is still in the text, so the field is withheld whole. That
    // includes ordinary text around a generic root such as `./tmp/x`, the accepted cost.
    ['a sibling with a non-ASCII name', `${home}é/file`, WITHHELD], ['a dotted sibling with a non-ASCII name', `${home}.é/file`, WITHHELD],
    ['a sibling with a combining mark', `${home}\u0301/file`, WITHHELD], ['a root nested after a slash', `/other/${tmp}/file`, WITHHELD],
    ['a root nested in a longer path', `/var${tmp}/x`, WITHHELD], ['a relative path', `.${tmp}/x`, WITHHELD], ['a hyphenated name before the path', `foo-bar${home}/x`, WITHHELD],
    ['a sibling with a digit', `see ${home}2/x`, WITHHELD], ['a root after a letter', `x${home}/y and ${home}/z`, WITHHELD],
    ['a path under the home that ends in the temporary root\'s spelling', `see ${home}${tmp}/x`, WITHHELD],
    // Pre-push sweep of the net: nothing applied after it spells a root again. The publication's `$ {` spacing and the
    // full stop its template adds are part of what the net reads; a home too long for the system is read from HOME.
    ['a root the publication\'s spacing completes', `see /a$${tmp} now`, WITHHELD, '/a${tmp}'], ['a root the template\'s full stop completes', 'see /x-221', WITHHELD, '/x-221.'],
    ['a home too long for the system, spelled in the text', `x /${'h'.repeat(4100)} y`, 'x ~ y', `/${'h'.repeat(4100)}`],
    // Pre-push sweep of that correction. A removed diff line and Markdown emphasis start a path; a home is a root
    // without its trailing slashes and only when it is absolute; the `$(` the publication spaces out is folded first;
    // and a home too long for the system to return does not stop the publication.
    ['a removed diff line', `-${home}/expected +${home}/actual`, '-~/expected +~/actual'], ['Markdown emphasis', `the file _${home}/x_ is missing`, 'the file _~/x_ is missing'],
    ['a home with a trailing slash', 'see /nohome-221/u/x', 'see ~/x', '/nohome-221/u/'], ['a home that is no absolute path', 'see aa/x', 'see aa/x', 'aa'],
    ['a home the publication spaces out', 'see /srv/$(y/x', 'see ~/x', '/srv/$ (y'], ['a home too long to read', `see ${home}/x`, 'see ~/x', `/${'a'.repeat(5000)}`],
    // Round 4 (CONV-223-AC1-HOME-ROOT-REDACTION), then the same owner decision: a home that is the filesystem root is
    // no root, since `/` names nothing of the operator's; the other roots are redacted as ever.
    ['a home that is the filesystem root', 'see /var/private-221/x', 'see /var/private-221/x', '/'], ['the same home spelled with two slashes', 'cc -I/var/private-221', 'cc -I/var/private-221', '//'],
    ['a file URL under that home', 'file:///var/private-221', 'file:///var/private-221', '/'], ['another root under that home', `see ${tmp}/x`, 'see {tmp}/x', '/'],
    ['a web URL under that home', 'see https://example.com/x', 'see https://example.com/x', '/'], ['relative paths under that home', 'see o/r and ./x and a / b', 'see o/r and ./x and a / b', '/'],
    // Round 5 (CONV-223-LONG-ATTACHED-OPTION-PATH-REDACTION): an attached option has no length limit. It is a run of
    // ASCII letters and hyphens that starts with its hyphens, so one run is scanned once, whatever its length.
    ['an attached option longer than 32 characters', `cc --${'x'.repeat(33)}${home}/private`, `cc --${'x'.repeat(33)}~/private`], ['an attached option of 300 characters', `cc -${'long-opt'.repeat(40)}${home}/p`, `cc -${'long-opt'.repeat(40)}~/p`],
    ['three hyphens before an attached option', `cc ---I${home}/x`, 'cc ---I~/x'], ['hyphens inside a name before the path', `foo--bar${home}/x`, WITHHELD],
  ]) {
    const lines = draft(text, env);
    lines.forEach((line, i) => assert.ok(line && line.includes(expected), `${label}, field ${i}: ${JSON.stringify(line)} lacks ${JSON.stringify(expected)}`));
    // Whatever the spelling, no field of the draft holds the home or the temporary root.
    if (!env) lines.forEach((line, i) => assert.equal(line.includes(home) || line.includes(tmp), false, `${label}, field ${i} spells a root: ${JSON.stringify(line)}`));
    // A withheld field keeps its text in the run's local state and in the local status block.
    if (expected === WITHHELD) { assert.equal(run.state.reason, text, label); assert.ok(run.state.statusBlock.includes(text), `${label}: the local block keeps the text`); }
  }
  // A failed home lookup adds no root: an empty path resolves to the current directory, which is no home.
  const cwd = process.cwd(), elsewhere = fs.realpathSync(temp('i221-cwd-'));
  process.chdir(elsewhere);
  try { for (const line of draft(`see ${elsewhere}/notes.txt`, `/${'h'.repeat(4100)}`)) assert.equal(line.includes('~/notes.txt'), false, `the current directory is published as the home: ${line}`); } finally { process.chdir(cwd); }
  // The start of a path is matched forward, never scanned backward from every position: a long run of slashes with
  // roots a quick check cannot rule out took 54 s for 200 KB. An attached option has a bounded length: a long run of
  // letters and hyphens, where every `--` starts an option, took 128 s.
  const tmpdir = process.env.TMPDIR, started = Date.now();
  process.env.TMPDIR = '/nonexistent-tmp-221';
  try { draft('/'.repeat(204800), '/-'); draft('/'.repeat(204800), '/'); draft('--a-'.repeat(51200)); } finally { if (tmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpdir; }
  assert.ok(Date.now() - started < 5000, `the long runs took ${Date.now() - started} ms`);
});

test('Issue #196 the status block is the contracted one', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  const block = state(t.runDir).statusBlock;
  assert.match(block, /^active_gate: sol$/m);
  assert.match(block, /^rounds: convergence 1\/3, sol 1\/3, terra 0\/3$/m);
  assert.match(block, /^fingerprints: issue_spec [0-9a-f]{64} base [0-9a-f]{40} tree [0-9a-f]{40} diff [0-9a-f]{64} commits [0-9a-f]{64} head [0-9a-f]{40}$/m);
  assert.match(block, /^resolved: tidd-convergence-reviewer prov\/model-x:high; tidd-adversarial-reviewer prov\/model-x:high$/m);
  assert.match(block, /^findings:\n  ADV-7-X: fixed \(proposed; correction pending\)$/m);
});

test('Issue #196 an unresolved external review thread stops readiness WAITING_FOR_OWNER, and a resolved one does not', () => {
  const t = setup();
  setFixture(t, { threads: [thread('T1', false), thread('T2', true)] });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER', s.reason);
  assert.match(s.reason, /T1/);
  assert.doesNotMatch(s.reason, /T2/);
});

test('Issue #196 an early stop still drafts publishable artifacts, with the full CL-D33 report', () => {
  const t = setup({ config: { validate: [['node', '-e', 'process.exit(1)']] } });
  const r = drive(t.start, t.e);
  const { s, body } = publishable(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER');
  assert.doesNotMatch(body, /undefined/);
  assert.match(body, /observed at \d{4}-\d\d-\d\dT/);
  assert.match(r.stdout, /bash "[^"]+\/publish-review\.sh"/);
  assert.match(r.stdout, /changed head requires fresh review/);
  assert.match(r.stdout, /sha256 [0-9a-f]{64}/);
});

test('Issue #196 an open finding is reported as proposed, not as fixed', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  assert.match(state(t.runDir).statusBlock, /^  CONV-7-X: fixed \(proposed; correction pending\)$/m);
});

test('Issue #196 a gh failure mid-run stops with an outcome token, and a harness failure never becomes a verdict', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { failEndpoint: 'repos/o/r/pulls/7' });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  const harness = setup({ config: { validate: [['definitely-not-a-program-196']] } });
  drive(harness.start, harness.e);
  assert.equal(state(harness.runDir).state, 'BLOCKED');
  assert.match(state(harness.runDir).reason, /harness_failed/);
});

// Round 7 of PR #199: new evidence before a later gate reruns convergence (CONV-199-EXTERNAL-REVIEW-RESTART), and a
// failing lookup at start happens before any run directory exists (CONV-199-START-FAILURE-ARTIFACTS).
test('Issue #196 a comment that arrives before a later gate reruns convergence first', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, { prComments: [{ id: 11, html_url: 'u', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'arrived between gates' }] });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer');
  assert.equal(state(t.runDir).invocations.convergence, 2);
  assert.equal(state(t.runDir).invocations.adversarial, undefined);
});

test('Issue #196 a pull request whose head repository is gone fails before any run directory exists', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.repo = null; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /head repository/);
});

// CONV-199-STATUS-ARTIFACT-BOUNDARY: CL-D33 drafts exactly two publication artifacts; the status block lives in the
// visible comment, the report, and the run's state, never as a third file.
test('Issue #196 a stop drafts exactly the two CL-D33 artifacts and no status-block file', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  const s = state(t.runDir);
  assert.deepEqual(fs.readdirSync(path.dirname(s.publication.comment)).sort(), ['publish-review.sh', 'review-comment.md']);
  assert.equal(fs.existsSync(path.join(t.runDir, 'status-block.md')), false);
  assert.ok(fs.readFileSync(s.publication.comment, 'utf8').includes(s.statusBlock), 'the comment carries the block');
  assert.ok(r.stdout.includes('```tidd-status'), 'the report carries the block');
});

test('Issue #196 a pull request with no local checkout of its head is left to the prose path, before any run directory', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = 'd'.repeat(40); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /review it on the prose path/);
});

// CONV-199-IGNORED-DELTA-BOUNDARY: ignored paths are frozen after validation (the validation sandbox delta) and
// compared at every later boundary, so an ignored file that appears between gates stops the next launch.
test('Issue #196 an ignored file that appears between gates stops the next launch', () => {
  const t = setup();
  fs.appendFileSync(path.join(t.target.root, '.git', 'info', 'exclude'), 'scratch/\n');
  assert.equal(drive(t.start, t.e).status, 0);
  fs.mkdirSync(path.join(t.target.root, 'scratch')); fs.writeFileSync(path.join(t.target.root, 'scratch', 'x'), 'x');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /ignored paths changed/);
});

test('Issue #196 a head from another repository goes to the prose path even when its objects are local', () => {
  const t = setup();
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.repo = { full_name: 'fork/r' }; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.match(r.stderr, /another repository.*prose path/);
});

test('Issue #196 a validated MERGE that carries a deferred follow-up advances', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'MERGE_WITH', severity: 'Major', anchoring: 'follow-up', disposition: 'deferred' })], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
});

test('Issue #196 convergence at its cap with findings open hands the candidate to Sol with them assigned', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const comment = (id) => ({ id, html_url: `u${id}`, user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `comment ${id}` });
  for (const n of [1, 2]) {
    setFixture(t, { prComments: Array.from({ length: n }, (_, i) => comment(i + 1)) });
    assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e).stdout)?.agent, 'tidd-convergence-reviewer');
  }
  assert.equal(state(t.runDir).invocations.convergence, 3);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
  const expected = JSON.parse(fs.readFileSync(state(t.runDir).pending.expectationPath, 'utf8'));
  assert.deepEqual(expected.assignedFindings.map((a) => a.findingId), ['CONV-7-X']);
  assert.match(expected.assignedFindings[0].blockerKey, /\S/);
});

// Round 24 of PR #199 (ADV-199-MISSING-EVENT-TIMESTAMP), then CL-D100: an external record without a valid event time
// is reported as such; with no quiet period to place, it holds nothing back.
test('Issue #196 an external record without a valid event time is reported, in every event class', () => {
  const { readiness, externalEvents } = require('../skills/closed-loop-pr/driver/run');
  const dated = '2026-09-29T00:00:00Z';
  const records = {
    comments: (t) => ({ comments: [{ id: 1, updated_at: t, created_at: t }] }),
    inline: (t) => ({ inline: [{ id: 1, updated_at: t, created_at: t }] }),
    reviews: (t) => ({ reviews: [{ id: 1, user: { login: 'h', type: 'User' }, state: 'COMMENTED', submitted_at: t }] }),
    threads: (t) => ({ threads: [{ id: 'T', isResolved: true, comments: { nodes: [{ id: 'c', updatedAt: t, createdAt: t }] } }] }),
    checks: (t) => ({ checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success', started_at: t, completed_at: t }] }),
    statuses: (t) => ({ statuses: [{ id: 1, context: 'ci', state: 'success', created_at: t, updated_at: t }] }),
  };
  for (const [name, make] of Object.entries(records)) {
    assert.equal(externalEvents(make(dated)), 'latest external event at 2026-09-29T00:00:00.000Z; external review is not waited for', `${name} dated`);
    for (const bad of [undefined, 'not a date']) assert.equal(externalEvents(make(bad)), 'no external event, 1 record(s) without a valid event time; external review is not waited for', `${name} ${bad}`);
  }
  assert.equal(externalEvents({}), 'no external event; external review is not waited for');
  assert.equal(typeof readiness, 'function');
});

// Round 26 of PR #199: branch protection's legacy contexts count beside its checks (ADV-199-LEGACY-CONTEXT-OMITTED),
// and a quoted value never carries the publisher's observation marker (ADV-199-DRAFT-OBSERVATION-TOKEN).
test('Issue #196 branch protection contexts count beside its checks', () => {
  const { readiness } = require('../skills/closed-loop-pr/driver/run');
  const snapshot = (rsc, checks = []) => ({ pull: { mergeable: true, mergeable_state: 'clean' }, after: { repository: 'o/r', baseBranch: 'main' }, checks, statuses: [], reviews: [], threads: [], policies: { branchProtection: { required_status_checks: rsc }, rulesets: [], organizationRulesets: [], defaultBranch: 'main', externalReview: [] } });
  const pending = (s) => readiness(s, 'h'.repeat(40)).pending;
  assert.deepEqual(pending(snapshot({ contexts: ['ci/legacy'], checks: [] })), ['required check ci/legacy has not reported']);
  assert.deepEqual(pending(snapshot({ contexts: ['ci/legacy'], checks: [{ context: 'ci/modern', app_id: 123 }] })).sort(), ['required check ci/legacy has not reported', 'required check ci/modern from app 123 has not reported']);
  assert.deepEqual(pending(snapshot({ contexts: ['build'], checks: [{ context: 'build', app_id: 123 }] }, [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: 999 } }])), ['required check build from app 123 has not reported'], 'the pin still holds');
});

test('Issue #196 a quoted branch name or validation argv never carries the publisher\'s observation marker', () => {
  const t = setup({ config: { validate: [['node', '-e', '0 // observed at 0000']] } });
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.ref = 'feat/observed_from0'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  const r = spawnSync('bash', [s.publication.script], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp('i196-home-') } });
  assert.doesNotMatch(r.stderr, /observation time/, r.stderr);
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /^Reviewed public head: /m);
});

test('Issue #196 a thread resolved at final readiness reruns the gates and starts no wait', () => {
  const t = setup();
  const old = { id: 'T1', isResolved: false, isOutdated: false, path: 'a.js', line: 1, originalLine: 1, comments: { totalCount: 1, nodes: [{ id: 'c1', databaseId: 1, url: 'u', body: 'b', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', author: { login: 'h', __typename: 'User' } }], pageInfo: { endCursor: null, hasNextPage: false } } };
  setFixture(t, { threads: [old] });
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t, 2);
  setFixture(t, { threads: [{ ...old, isResolved: true }] });
  throughGates(t, 1);
  throughGates(t, 3);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
});
