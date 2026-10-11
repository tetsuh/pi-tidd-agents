'use strict';

// Issue #249 (CL-D111): since CL-D104 the driver sent three cases back to the prose path on a `PROSE_PATH:` line (a head in
// another repository, commits the checkout does not hold, a review-only diff that is not UTF-8), and the parent then
// hand-composed the round from the mode references. None of the three occurred on a consumer run. The owner refused the
// prose path (option a): the driver refuses or stops, the parent reports it, and nothing is reviewed by hand.
const review = require('./issue-196-review-driver.fixtures.js');
const autofix = require('./issue-196-autofix-driver.fixtures.js');
const { test, assert, fs, path, readText, git } = review;
const { sectionOf, readContract } = require('./helpers');

const SKILL = 'skills/closed-loop-pr/SKILL.md';
const DRIVER_FILES = ['phases.js', 'review.js', 'autofix.js', 'run.js', 'readiness.js', 'paths.js', 'writer.js'];
const driver = (file) => readText(`skills/closed-loop-pr/driver/${file}`);

// A head in another repository is refused before any run directory, on the driver's error output, with no token line.
test('Issue #249 the review-only driver refuses a head from another repository before any run directory', () => {
  const t = review.setup();
  review.setFixture(t, { pull: { ...t.target.pull, head: { ...t.target.pull.head, repo: { full_name: 'fork/r' } } } });
  const r = review.drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^tidd-driver: pull request [^\n]*#\d+ has its head in another repository \(fork\/r\); the driver reviews only a pull request whose head is in [^\n]+\n$/);
  assert.doesNotMatch(r.stderr, /prose path|PROSE_PATH/);
});

test('Issue #249 the review-only driver refuses a head the checkout does not hold before any run directory', () => {
  const t = review.setup();
  review.setFixture(t, { pull: { ...t.target.pull, head: { ...t.target.pull.head, sha: 'd'.repeat(40) } } });
  const r = review.drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `tidd-driver: the checkout ${t.target.root} does not hold ${'d'.repeat(40)}; the driver needs the head and base locally\n`);
});

test('Issue #249 the autofix driver refuses a head from another repository the same way', () => {
  const t = autofix.setup();
  autofix.setFixture(t.bin, { headRepo: 'fork/r' });
  const r = autofix.drive(t.start, t.env);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(t.runDir), false);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^tidd-driver: pull request [^\n]*#\d+ has its head in another repository \(fork\/r\)/);
  assert.doesNotMatch(r.stderr, /prose path|PROSE_PATH/);
});

// Round 1 CONV-269-AC1-LOCAL-COMMIT-COVERAGE: AC1 names the base as well as the head, in both modes. Each missing commit
// is refused the same way through each driver, before any run directory.
const MISSING = 'd'.repeat(40);
for (const [mode, which] of [['review-only', 'base'], ['autofix', 'base'], ['autofix', 'head']]) {
  test(`Issue #249 the ${mode} driver refuses a ${which} commit the checkout does not hold before any run directory`, () => {
    let r, runDir, root;
    if (mode === 'review-only') {
      const t = review.setup(); runDir = t.runDir; root = t.target.root;
      review.setFixture(t, { pull: { ...t.target.pull, [which]: { ...t.target.pull[which], sha: MISSING } } });
      r = review.drive(t.start, t.e);
    } else {
      const t = autofix.setup(); runDir = t.runDir; root = t.target.checkout;
      autofix.setFixture(t.bin, which === 'base' ? { base: MISSING } : { headSha: MISSING });
      r = autofix.drive(t.start, t.env);
    }
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(runDir), false);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `tidd-driver: the checkout ${root} does not hold ${MISSING}; the driver needs the head and base locally\n`);
  });
}

// A review-only diff that is not UTF-8 stops BLOCKED with its artifacts drafted, as the autofix driver already did; the
// FINISHED line is the last line, and no line sends the pull request anywhere.
test('Issue #249 a review-only diff that is not UTF-8 stops BLOCKED and ends on the driver status line', () => {
  const t = review.setup();
  fs.writeFileSync(path.join(t.target.root, 'bin.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
  git(t.target.root, ['add', 'bin.txt']); git(t.target.root, ['commit', '-q', '-m', 'bytes']);
  review.setFixture(t, { pull: { ...t.target.pull, head: { ...t.target.pull.head, sha: git(t.target.root, ['rev-parse', 'HEAD']) } } });
  const r = review.drive(t.start, t.e);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^FINISHED comment=/m, r.stdout);
  assert.doesNotMatch(r.stdout, /PROSE_PATH|prose path/);
  const s = review.state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.equal(s.reason, 'the diff is not valid UTF-8, so no gate can receive it exactly');
  // The driver's own status line is the last line; nothing sends the pull request anywhere after it.
  const last = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual([last.state, last.reason], ['BLOCKED', s.reason]);
});

// The driver carries no send-back, and no text in it names a prose path.
test('Issue #249 no driver file sends a pull request back or names the prose path', () => {
  for (const file of DRIVER_FILES) {
    const text = driver(file);
    assert.doesNotMatch(text, /PROSE_PATH|prose path|sendBack/, file);
  }
});

// The Skill routes every pull request to the driver; a refusal is reported, and the parent stops.
test('Issue #249 the dispatch section routes every pull request to the driver and names the refusal', () => {
  const skill = readText(SKILL);
  const s = sectionOf(skill, '## Driver dispatch (CL-D104)');
  assert.ok(s, 'the dispatch section exists');
  assert.doesNotMatch(s, /PROSE_PATH|prose path|Mode dispatch below|any other target/);
  assert.match(s, /^After the checks above, the pull request runs through the packaged driver, which sequences the round, not you\. /m);
  assert.match(s, /you read no mode reference, compose no helper request, and judge no finding\./);
  assert.match(s, /A pull request the driver refuses before any run \(a head in another repository, or a base or head commit the checkout does not hold\) is reported on its error output; report it and stop, and review nothing by hand \(CL-D111\)\./);
  assert.match(s, /^4\. Otherwise, when a line begins `FINISHED comment=`, report everything from that line to the end verbatim, and stop\. Never run the publication script\.$/m);
  assert.match(s, /^5\. Otherwise, when a driver command prints none of these lines, report the last 30 lines of its combined output and stop; never retry or continue by hand\.$/m);
  assert.equal(s.includes('6. '), false, 'the numbered steps end at 5');
  const boundary = sectionOf(skill, '## Workflow target-kind boundary (CL-D7, CL-D8)');
  assert.match(boundary, /A pull request whose head is in \*\*another repository\*\* is refused by the driver before any run, as is one whose base or head commit the checkout does not hold; nothing is reviewed from the GitHub API alone \(CL-D111\)\./);
  assert.doesNotMatch(boundary, /may be reviewed in review-only mode|no local Git object or checkout is required/);
  assert.match(boundary, /Autofix and every publication action refuse such a target/);
  // Pre-push sweep A1: a pull request of another repository (a URL the shared grammar accepts) would otherwise be read
  // as the checkout repository's pull request of that number, since step 1 fixes --repo to the checkout's repository.
  assert.match(boundary, /A pull request of another repository than the current checkout's is refused before the driver: report it and stop, and review nothing \(CL-D111\)\./);
  // The evidence section's foreign path is specification until #249 deletes it, and says so.
  assert.match(sectionOf(skill, '## Evidence fingerprints (CL-D9)'), /Since CL-D111 no run takes the following path; it stays as specification until #249 deletes it\./);
});

// Round 1 CONV-269-AC3-MODE-DISPATCH: AC3 covers the whole Skill, not only the dispatch section. No line of it instructs
// the parent to read a mode reference; the Mode dispatch block is a non-operative note until #249 deletes it.
test('Issue #249 no instruction anywhere in the Skill routes a pull request to a mode reference', () => {
  const skill = readText(SKILL);
  assert.doesNotMatch(skill, /^- [^\n]*mode: read `references\//m);
  assert.doesNotMatch(skill, /load the authoritative continuation|Read exactly one mode reference|Follow the selected reference/);
  const dispatch = sectionOf(skill, '## Mode dispatch (CL-D19)');
  assert.ok(dispatch, 'the Mode dispatch block is still the final block until #249 deletes it');
  assert.match(dispatch, /^Since CL-D111 no pull request takes this path: every run goes through the driver \(Driver dispatch above\), and you read no mode reference\. The block stays as specification until #249 deletes it with the mode references\./m);
  assert.match(dispatch, /The former continuation, for the record only: review-only mode read `references\/review-only\.md`; exact CL-D30 `autofix` mode read `references\/autofix\.md`\. Exactly one was read after mode parsing, never both\./);
});

test('Issue #249 README names the refusal in place of the send-back', () => {
  const readme = sectionOf(readText('README.md'), '### How a round runs (CL-D104)');
  assert.doesNotMatch(readme, /PROSE_PATH|prose path/);
  assert.match(readme, /A pull request whose head is in another repository, or whose commits the checkout does not hold, is refused before any run and reported; a review-only diff that is not UTF-8 stops `BLOCKED` \(CL-D111\)\./);
});

test('Issue #249 CL-D111 records the refusal and the superseded records name it', () => {
  const record = sectionOf(readContract(), '## CL-D111 — Every pull request runs through the driver; the prose path is refused');
  assert.ok(record, 'CL-D111 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6105220135/);
  assert.match(record, /Option \(a\)/);
  assert.match(record, /the mode references are deleted in later pull requests of #249/);
  assert.match(record, /Reinstating a hand-composed round, or reviewing a pull request from the GitHub API alone, requires a new owner decision\./);
  assert.match(record, /A pull request of another repository than the current checkout's is refused by the parent before the driver/);
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D111.md') < index.indexOf('contract/CL-D110.md'), 'the index lists CL-D111 before CL-D110, in its descending block');
  for (const [id, heading] of [
    ['CL-D104', '## CL-D104 — /tidd-pr runs through the packaged driver'],
    ['CL-D19', '## CL-D19 — Division of responsibility between prompts, Skills, and mode references'],
    ['CL-D93', '## CL-D93 — A packaged driver sequences the review; the parent only makes the calls it prints'],
    ['CL-D8', '## CL-D8 — Targets outside the current repository'],
  ]) assert.match(sectionOf(readContract(), heading), /#249 later/, id);
  assert.match(sectionOf(readContract(), '## CL-D8 — Targets outside the current repository'), /#249 later refused a foreign pull request in both PR modes; the Issue workflow's rule is unchanged/);
});
