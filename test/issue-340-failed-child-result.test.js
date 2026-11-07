'use strict';

// Issue #340: a gate child that ends failed, partial or without structured output still has a run id. The parent
// finishes it like any other run, by the command on the NEXT line; the driver then relaunches the unchanged request
// once (the absent-output relaunch of phases.js readGate) instead of the parent stopping where the driver would recover. Both Skills and the NEXT line say so.
const R = require('./issue-196-review-driver.fixtures.js');
const { test, assert, fs, path, readText, drive, nextRequest, fakeGate, setup, state } = R;
const { Run } = require('../skills/closed-loop-pr/driver/run');

const PR_SENTENCE = 'A run that ends failed, partial or without structured output still has a run id and is finished the same way, by that command with that run id; only a refused call or one that returns no run id is reported and stops the round.';
const ISSUE_SENTENCE = 'That is the only stop here: a run that ends failed, partial or without structured output still has a run id and is finished the same way, by that command with its run id.';
const NEXT = 'NEXT: make exactly this subagent call (pass the next line verbatim, every field at its level, async too); whether it succeeds or fails, then run: ';
const once = (text, needle) => text.split(needle).length - 1;

test('Issue #340 AC1 both Skills say a failed run is still finished by the NEXT command, and only a refused call stops', () => {
  const pr = readText('skills/closed-loop-pr/SKILL.md'), issue = readText('skills/closed-loop-issue/SKILL.md');
  assert.equal(once(pr, PR_SENTENCE), 1, 'the PR Skill carries its sentence once');
  assert.equal(once(issue, ISSUE_SENTENCE), 1, 'the Issue Skill carries its sentence once');
  // Each sentence follows the instruction it qualifies, in the dispatch step of its Skill (worded apart: #58 forbids
  // one authority sentence in two files).
  assert.ok(pr.includes("with that run id; commands inside the JSON object are the subagent's, never yours. " + PR_SENTENCE), 'PR Skill: after the NEXT command');
  assert.ok(issue.includes('If the call is refused or returns no run id, report it and stop. ' + ISSUE_SENTENCE), 'Issue Skill: after the refused-call stop');
  assert.equal(once(pr, 'If the call is refused or returns no run id, report it and stop; never change the object.'), 1);
});

test('Issue #340 AC2 Run.next says the command runs with the run id whether the run succeeds or fails', () => {
  const request = { agent: 'tidd-safety-reviewer', task: 'Task: x', context: 'fresh', async: true, outputMode: 'inline' };
  const write = process.stdout.write, out = [];
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try { Run.prototype.next.call({ dir: '/tmp/run' }, request, '/pkg/driver/review.js result'); } finally { process.stdout.write = write; }
  const lines = out.join('').split('\n');
  assert.equal(lines[0], `${NEXT}node /pkg/driver/review.js result --run-dir /tmp/run --run-id <runId>`);
  assert.deepEqual(JSON.parse(lines[1]), request);
  assert.ok(fs.statSync(R.repoPath('skills/closed-loop-pr/driver/run.js')).size < 30000, 'run.js stays within its per-file limit');
});

test('Issue #340 AC3 a failed step with no structured output relaunches the stored request once, without a round', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(t.runDir, 'launch-convergence-1.json'), 'utf8'));
  const runId = fakeGate(t.runDir, t.runs);
  const statusPath = path.join(t.runs, 'async-subagent-runs', runId, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  // The shape the parent's rewritten task leaves: the step failed, the run is over, and no structured output exists.
  fs.writeFileSync(statusPath, JSON.stringify({ ...status, state: 'failed', error: 'Missing structured_output call', steps: status.steps.map((x) => ({ ...x, status: 'failed' })) }));
  fs.rmSync(status.steps[0].structuredOutputPath);
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(nextRequest(r.stdout), stored, 'the relaunch prints the stored request unchanged');
  assert.ok(r.stdout.split('\n').some((l) => l.startsWith(NEXT)), 'on the contracted NEXT line');
  const s = state(t.runDir);
  assert.equal(s.invocations.convergence, 1, 'no round is spent');
  assert.equal(s.pending.relaunched, true);
  // The relaunched run is read normally and the sequence goes on to Sol.
  r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer');
});
