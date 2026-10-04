'use strict';

// Issue #224 (CL-D104): `/tidd-pr` loaded the Skill and the parent followed its prose step by step, hand-composing the
// requests the packaged drivers already build. The Skill's dispatch section now sends a pull request the driver accepts
// to the driver: the parent makes exactly the printed `subagent` call and runs the command the driver names next.
const { test, assert, fs, path, spawnSync, repoPath, readText, git, setup, setFixture, drive, fakeGate, publishable } = require('./issue-196-review-driver.fixtures.js');
const { sectionOf, readContract } = require('./helpers');

const SKILL = 'skills/closed-loop-pr/SKILL.md';
const HEADING = '## Driver dispatch (CL-D104)';
const START = /^1\. From the checkout's top-level directory, run `([^`]+)`/m;
const section = () => sectionOf(readText(SKILL), HEADING);
const once = (text, needle) => text.split(needle).length - 1;

test('Issue #224 the Skill sends the round to the packaged driver before any mode reference is read', () => {
  const skill = readText(SKILL), s = section();
  assert.ok(s, 'the dispatch section exists');
  assert.ok(skill.indexOf(HEADING) < skill.indexOf('## Mode dispatch (CL-D19)'), 'it comes before Mode dispatch');
  assert.ok(skill.indexOf('## Workflow target-kind boundary (CL-D7, CL-D8)') < skill.indexOf(HEADING), 'it comes after the checks it follows');
  assert.equal(once(s, 'a pull request of the repository of the current checkout runs through the packaged driver, which sequences the round, not you; any other target continues with Mode dispatch below.'), 1);
  assert.equal(once(s, 'The other sections of this Skill, the shared references and the mode references are the specification the driver and the gates implement'), 1);
  assert.equal(once(s, 'on this path you read no mode reference, compose no helper request, and judge no finding.'), 1);
  assert.equal(once(s, "From the checkout's top-level directory, run"), 1);
  assert.equal(once(s, 'Set no timeout of your own on a driver command; one that is killed anyway is reported, and you stop.'), 1);
  // AC2: exactly the printed call, the wait for the runner's own completion, and the command on the NEXT line itself.
  assert.equal(once(s, 'When a line begins `NEXT:`, call `subagent` with exactly the JSON object on the following line.'), 1);
  assert.equal(once(s, 'If the call is refused or returns no run id, report it and stop; never change the object.'), 1);
  assert.equal(once(s, "Otherwise wait for the runner's own completion of that run; never interrupt, pause, steer, or cancel it."), 1);
  assert.equal(once(s, "Then run the command on the `NEXT:` line itself (`result` or `writer-done`) with that run id; commands inside the JSON object are the subagent's, never yours."), 1);
  // A WAIT line is the driver's own report that the run is still going (phases.js readGate, autofix.js writer-done).
  assert.equal(once(s, 'When a line begins `WAIT:`, the run has not completed: wait for its completion, then run the command that line names with the same run id. This is not a retry.'), 1);
  // The prose path is read first, so a stop that drafts artifacts and sends the pull request back (a review-only diff that
  // is not UTF-8) still reaches it; it is the driver's own last line, which no quoted text can print.
  const prose = s.indexOf("4. When the last line the driver prints begins `PROSE_PATH:` (a note your shell tool adds after it, such as the exit code, is not the driver's), continue with Mode dispatch below in the parsed mode, whatever reference that line names.");
  const finished = s.indexOf('5. Otherwise, when a line begins `FINISHED comment=`, report everything from that line to the end verbatim, and stop.');
  assert.ok(prose > 0 && finished > prose, 'the prose-path step comes before the FINISHED step');
  assert.equal(once(s, 'Never run the publication script.'), 1);
  assert.equal(once(s, '6. Otherwise, when a driver command prints none of these lines, report the last 30 lines of its combined output and stop; never retry or continue by hand.'), 1);
  assert.equal(once(s, 'with the profile CL-D16 resolved for this run (`<sites>` is `{}` when it names none)'), 1);
  assert.equal(once(s, "(a note your shell tool adds after it, such as the exit code, is not the driver's)"), 1);
  // Each send-back site prints the token, and no other text in the driver says to review on the prose path.
  const driver = (file) => readText(`skills/closed-loop-pr/driver/${file}`);
  assert.equal(once(driver('phases.js'), 'function sendBack(message) { process.stdout.write(`PROSE_PATH: ${message}\\n`); process.exit(2); }'), 1);
  assert.equal(once(driver('phases.js'), 'sendBack(`'), 2);
  assert.equal(once(driver('review.js'), "run.stop('BLOCKED', why, `PROSE_PATH: ${why}\\n`);"), 1);
  for (const [file, n] of [['phases.js', 2], ['review.js', 1], ['autofix.js', 0], ['run.js', 0], ['readiness.js', 0], ['paths.js', 0], ['writer.js', 0]]) assert.equal(once(driver(file), 'on the prose path'), n, file);
  // A WAIT line is the driver's own report that a run is still going, for a gate and for the writer.
  assert.match(driver('phases.js'), /WAIT: the \$\{gateLabel\(p\.gate\)\} run is still in progress; when it completes, run: node \$\{self\} result --run-dir \$\{run\.dir\} --run-id <runId>/);
  assert.match(driver('autofix.js'), /WAIT: the writer run has no terminal record yet; when it completes, run: node \$\{SELF\} writer-done --run-dir \$\{run\.dir\} --run-id \$\{opts\['run-id'\]\}/);
  // Both drivers it names exist, and the start command always names the target's repository.
  assert.equal(START.exec(s)[1], 'node <skill-dir>/driver/<driver>.js start --pr <number> --repo <owner/name>');
  assert.match(s, /`<driver>` is `review` in review-only mode and `autofix` in autofix mode, and `<owner\/name>` is the checkout's repository\./);
  for (const driver of ['review', 'autofix']) assert.ok(fs.existsSync(repoPath('skills/closed-loop-pr/driver', `${driver}.js`)), driver);
  // The prompt stays a thin dispatcher (DEC-I22-PROMPT-AUTHORITY-001).
  assert.doesNotMatch(readText('prompts/tidd-pr.md'), /driver/);
});

test('Issue #224 the dispatch section\'s command sequence runs one review-only round to a terminal outcome', () => {
  const t = setup();
  const argv = START.exec(section())[1].replace('<skill-dir>', repoPath('skills/closed-loop-pr')).replace('<driver>', 'review')
    .replace('<number>', '7').replace('<owner/name>', 'o/r').split(' ');
  assert.equal(argv.shift(), 'node');
  // The profile the section composes reaches the run, so the gates never receive the driver's default.
  const [, flag, value] = /Add `(--language-profile) "([^"]+)"`/.exec(section());
  argv.push(flag, value.replaceAll('<language>', 'English').replace('<sites>', '{}'));
  let r = spawnSync(process.execPath, argv, { cwd: t.target.root, encoding: 'utf8', env: t.e, timeout: 120000 });
  const calls = [];
  for (let i = 0; i < 6 && !/^FINISHED comment=/m.test(r.stdout); i += 1) {
    const lines = r.stdout.split('\n'), at = lines.findIndex((l) => l.startsWith('NEXT:'));
    assert.ok(at >= 0, r.stderr + r.stdout);
    calls.push(JSON.parse(lines[at + 1]));
    // The follow-up is read from the NEXT line itself, as the section tells the parent to run it.
    const follow = /then run: node (.+)$/.exec(lines[at])[1].split(' ');
    const runDir = follow[follow.indexOf('--run-dir') + 1];
    const runId = fakeGate(runDir, t.runs);
    r = spawnSync(process.execPath, follow.map((a) => (a === '<runId>' ? runId : a)), { cwd: t.target.root, encoding: 'utf8', env: t.e, timeout: 120000 });
  }
  assert.deepEqual(calls.map((c) => c.agent), ['tidd-convergence-reviewer', 'tidd-adversarial-reviewer', 'tidd-safety-reviewer'], 'one printed call per gate, in order');
  assert.match(r.stdout, /^FINISHED comment=/m);
  const last = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(last.state, 'MERGE_READY', last.reason);
  assert.equal(JSON.parse(fs.readFileSync(path.join(last.runDir, 'state.json'), 'utf8')).languageProfile, 'conversation=English; github.issue=English; github.pull_request=English; external_sites={}');
  const { s, body } = publishable(last.runDir);
  assert.ok(fs.existsSync(s.publication.script), 'the publication script is drafted');
  assert.match(body, /^# Review state: MERGE_READY\n/);
  assert.ok(path.isAbsolute(s.publication.comment));
});

// A review-only diff that is not UTF-8 drafts its artifacts and still sends the pull request back on the last line; the
// autofix driver stops BLOCKED there without a send-back.
test('Issue #224 a review-only diff that is not UTF-8 ends on a PROSE_PATH line after FINISHED', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.target.root, 'bin.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]));
  git(t.target.root, ['add', 'bin.txt']); git(t.target.root, ['commit', '-q', '-m', 'bytes']);
  setFixture(t, { pull: { ...t.target.pull, head: { ...t.target.pull.head, sha: git(t.target.root, ['rev-parse', 'HEAD']) } } });
  const r = drive(t.start, t.e);
  assert.match(r.stdout, /^FINISHED comment=/m, r.stderr + r.stdout);
  assert.match(r.stdout.trim().split('\n').pop(), /^PROSE_PATH: the diff is not valid UTF-8, so no gate can receive it exactly; review it on the prose path of review-only\.md$/);
});

// A pull request the driver cannot read locally is sent back before any run directory, on its only line of output.
test('Issue #224 a head that is not local is sent back on a PROSE_PATH line', () => {
  const t = setup();
  setFixture(t, { pull: { ...t.target.pull, head: { ...t.target.pull.head, sha: 'd'.repeat(40) } } });
  const r = drive(t.start, t.e);
  assert.equal(r.stdout, `PROSE_PATH: the checkout ${t.target.root} does not hold ${'d'.repeat(40)}; the driver needs the head and base locally, so review it on the prose path of review-only.md\n`);
  // Git's own refusal stays off the output, so nothing can follow the PROSE_PATH line.
  assert.equal(r.stderr, '');
  assert.equal(fs.existsSync(t.runDir), false);
});

test('Issue #224 the contract records the dispatch and README names the one way to run a round', () => {
  const record = sectionOf(readContract(), '## CL-D104 — /tidd-pr runs through the packaged driver');
  assert.ok(record, 'CL-D104 is in the contract');
  assert.match(record, /never by its exit status/);
  assert.match(record, /This narrows CL-D19 and Mode dispatch/);
  assert.match(sectionOf(readContract(), '## CL-D19 — Division of responsibility between prompts, Skills, and mode references'), /CL-D104 later narrowed the PR mode continuation to the prose path/);
  const readme = sectionOf(readText('README.md'), '### How a round runs (CL-D104)');
  assert.ok(readme, 'README has the section');
  assert.match(readme, /`\.tidd\.json` at the base commit/);
  assert.match(readme, /`--validate`/);
  assert.match(readme, /`\$XDG_CONFIG_HOME\/tidd\/<owner>\/<repo>\.json`/);
  assert.match(readme, /no validation commands configured/);
  assert.match(readme, /only when you start the driver directly \(`\/tidd-pr` never passes it\)/);
});

// The raise, with its property asserted at the raise (CL-D43, CL-D48): the section took the eight authority files past
// 156,000, and the ceiling rises once, to 162,000, against the measurement on this change.
test('Issue #224 CL-D104 raises the authority ceiling once, with the headroom asserted at the raise', () => {
  const CL_D104_BASELINE_BYTES = 156472;
  assert.match(readContract(), /they measured 156,472 bytes on this change, so the ceiling rises to 162,000 bytes on the CL-D43 terms, leaving 5,528 bytes/);
  assert.ok(CL_D104_BASELINE_BYTES > 156000 && 162000 - CL_D104_BASELINE_BYTES > 5000, `the raise left ${162000 - CL_D104_BASELINE_BYTES} bytes`);
  for (const file of ['test/package.test.js', 'test/issue-73-authority-budget.test.js', 'test/issue-87-authority-floor.test.js', 'test/issue-87-addendum-split.test.js', 'test/issue-100-gate-ids-v2.test.js', 'test/issue-126-sol-component-sweep.test.js', 'test/issue-153-wording-only-minors.test.js']) {
    const text = readText(file);
    assert.match(text, /total < 162000/, `${file} asserts the raised ceiling`);
    assert.equal(text.includes('total < 156000'), false, `${file}: the CL-D85 ceiling must not survive the raise`);
  }
});
