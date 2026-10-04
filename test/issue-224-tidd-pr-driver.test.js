'use strict';

// Issue #224 (CL-D104): `/tidd-pr` loaded the Skill and the parent followed its prose step by step, hand-composing the
// requests the packaged drivers already build. The Skill's dispatch section now sends a pull request the driver accepts
// to the driver: the parent makes exactly the printed `subagent` call and runs the command the driver names next.
const { test, assert, fs, path, spawnSync, repoPath, readText, setup, fakeGate, publishable } = require('./issue-196-review-driver.fixtures.js');
const { sectionOf, readContract } = require('./helpers');

const SKILL = 'skills/closed-loop-pr/SKILL.md';
const HEADING = '## Driver dispatch (CL-D104)';
const START = /^1\. From the checkout, run `([^`]+)`/m;
const section = () => sectionOf(readText(SKILL), HEADING);
const once = (text, needle) => text.split(needle).length - 1;

test('Issue #224 the Skill sends the round to the packaged driver before any mode reference is read', () => {
  const skill = readText(SKILL), s = section();
  assert.ok(s, 'the dispatch section exists');
  assert.ok(skill.indexOf(HEADING) < skill.indexOf('## Mode dispatch (CL-D19)'), 'it comes before Mode dispatch');
  assert.ok(skill.indexOf('## Workflow target-kind boundary (CL-D7, CL-D8)') < skill.indexOf(HEADING), 'it comes after the checks it follows');
  assert.equal(once(s, 'The other sections of this Skill and the mode references are the specification the driver and the gates implement'), 1);
  assert.equal(once(s, 'on this path you read no mode reference, compose no helper request, and judge no finding.'), 1);
  // AC2: exactly the printed call, the command it names next, and never a hand on a running gate.
  assert.equal(once(s, 'call `subagent` with exactly that object and note the run id. Never interrupt, pause, steer, or cancel the run; only its own completion ends the wait.'), 1);
  assert.equal(once(s, 'Then run the command the driver names, with that run id, and do the same for every command it names after.'), 1);
  assert.equal(once(s, 'Never run the publication script.'), 1);
  assert.equal(once(s, 'When the driver ends without `FINISHED`, report its last 30 lines and stop; never retry or continue by hand.'), 1);
  assert.equal(once(s, 'Only when it says the pull request stays on the prose path, continue with Mode dispatch below.'), 1);
  // Both drivers it names exist, and the start command always names the target's repository.
  assert.equal(START.exec(s)[1], 'node <skill-dir>/driver/<driver>.js start --pr <number> --repo <owner/name>');
  assert.match(s, /`<driver>` is `review` in review-only mode and `autofix` in autofix mode/);
  for (const driver of ['review', 'autofix']) assert.ok(fs.existsSync(repoPath('skills/closed-loop-pr/driver', `${driver}.js`)), driver);
  // The prompt stays a thin dispatcher (DEC-I22-PROMPT-AUTHORITY-001).
  assert.doesNotMatch(readText('prompts/tidd-pr.md'), /driver/);
});

test('Issue #224 the dispatch section\'s command sequence runs one review-only round to a terminal outcome', () => {
  const t = setup();
  const argv = START.exec(section())[1].replace('<skill-dir>', repoPath('skills/closed-loop-pr')).replace('<driver>', 'review')
    .replace('<number>', '7').replace('<owner/name>', 'o/r').split(' ');
  assert.equal(argv.shift(), 'node');
  let r = spawnSync(process.execPath, argv, { cwd: t.target.root, encoding: 'utf8', env: t.e, timeout: 120000 });
  const calls = [];
  for (let i = 0; i < 6 && !r.stdout.includes('FINISHED'); i += 1) {
    const lines = r.stdout.split('\n'), at = lines.findIndex((l) => l.startsWith('NEXT:'));
    assert.ok(at >= 0, r.stderr + r.stdout);
    calls.push(JSON.parse(lines[at + 1]));
    // The follow-up is read from the NEXT line itself, as the section tells the parent to run it.
    const follow = /then run: node (.+)$/.exec(lines[at])[1].split(' ');
    const runDir = follow[follow.indexOf('--run-dir') + 1];
    const runId = fakeGate(runDir, t.runs);
    r = spawnSync(process.execPath, follow.map((a) => (a === '<runId>' ? runId : a)), { cwd: t.target.root, encoding: 'utf8', env: t.e, timeout: 120000 });
  }
  assert.equal(calls.length, 3, 'one printed call per gate');
  assert.match(r.stdout, /^FINISHED comment=/m);
  const last = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(last.state, 'MERGE_READY', last.reason);
  const { s, body } = publishable(last.runDir);
  assert.ok(fs.existsSync(s.publication.script), 'the publication script is drafted');
  assert.match(body, /^# Review state: MERGE_READY\n/);
  assert.ok(path.isAbsolute(s.publication.comment));
});

test('Issue #224 the contract records the dispatch and README names the one way to run a round', () => {
  const record = sectionOf(readContract(), '## CL-D104 — /tidd-pr runs through the packaged driver');
  assert.ok(record, 'CL-D104 is in the contract');
  assert.match(record, /never by its exit status/);
  assert.match(record, /so no guard is raised/);
  const readme = sectionOf(readText('README.md'), '### How a round runs (CL-D104)');
  assert.ok(readme, 'README has the section');
  assert.match(readme, /`\.tidd\.json` at the base commit/);
  assert.match(readme, /`--validate`/);
  assert.match(readme, /`\$XDG_CONFIG_HOME\/tidd\/<owner>\/<repo>\.json`/);
  assert.match(readme, /no validation commands configured/);
});
