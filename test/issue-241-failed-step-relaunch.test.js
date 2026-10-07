'use strict';

// Issue #241: a gate child that mistyped the verification command printed in its task stopped without calling
// structured_output, so its runner recorded the step as failed and wrote no designated output (PR #239 round 3). The
// driver refused at the runner status (`step_incomplete`) and ended the round BLOCKED. A runner status never substitutes
// for reading the designated output (gate-contract.md, CL-D51): an absent output after completion is relaunched once.
const { test, assert, fs, path, crypto, drive, fakeGate, setup, state, nextRequest } = require('./issue-196-review-driver.fixtures.js');
const af = require('./issue-196-autofix-driver.fixtures.js');
const { SCHEMA } = require('../skills/closed-loop-pr/helpers/gate-result');

// A completed run whose only step failed and wrote no designated output, as pi-subagents recorded the child of PR #239
// round 3 that never called structured_output: its schema written, its last output naming the failed verification.
function failedGate(runDir, runs, { timedOut = false } = {}) {
  const s = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(s.pending.expectationPath, 'utf8'));
  const agent = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[expected.correlation.gate];
  const runId = crypto.randomUUID(), dir = path.join(runs, 'async-subagent-runs', runId);
  fs.mkdirSync(path.join(dir, 'structured-output', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'structured-output', 'fake', 'schema.json'), JSON.stringify(SCHEMA));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId, state: 'failed', cwd: s.checkout, steps: [{ agent, status: 'failed', model: 'prov/model-x', thinking: 'max', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.', exitCode: 1, recentOutput: ['The required verification command did not return `"ok":true` (`MODULE_NOT_FOUND`). Stopped as instructed.'], ...(timedOut ? { timedOut: true } : {}), structuredOutputPath: path.join(dir, 'structured-output', 'fake', 'output.json'), structuredOutputSchemaPath: path.join(dir, 'structured-output', 'fake', 'schema.json') }] }));
  return runId;
}

test('Issue #241 a gate step that failed without its designated output is relaunched once, not BLOCKED', () => {
  const t = setup();
  const first = drive(t.start, t.e);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const launch = nextRequest(first.stdout);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', failedGate(t.runDir, t.runs)], t.e);
  assert.deepEqual(nextRequest(r.stdout), launch, `the same launch is printed again: ${r.stdout}`);
  assert.equal(state(t.runDir).pending.relaunched, true);
  // The relaunched run completes and the round goes on, with no round spent on the failed one.
  const next = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(next.status, 0, next.stderr + next.stdout);
  assert.equal(state(t.runDir).invocations.convergence, 1);
});

test('Issue #241 a second failed step in the same gate stops BLOCKED after one relaunch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', failedGate(t.runDir, t.runs)], t.e);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', failedGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /after one relaunch: step_incomplete/);
});

test('Issue #241 a failed step that did write its designated output is not relaunched', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const runId = failedGate(t.runDir, t.runs);
  const dir = path.join(t.runs, 'async-subagent-runs', runId, 'structured-output', 'fake');
  fs.writeFileSync(path.join(dir, 'output.json'), '{}');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /^gate_result_read refused: step_incomplete/);
});

// A step the runner ended for its time bound is not relaunched: a hung gate would otherwise cost a second hour (CL-D94).
test('Issue #241 a failed step the runner timed out is not relaunched', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', failedGate(t.runDir, t.runs, { timedOut: true })], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(nextRequest(r.stdout), null);
  assert.match(state(t.runDir).reason, /^gate_result_read refused: step_incomplete/);
});

// Exact autofix shares the reader, with its own budget: one relaunch per run, none after a push (CL-D96).
test('Issue #241 exact autofix relaunches a failed step with no output once per run', () => {
  const t = af.setup();
  assert.equal(af.drive(t.start, t.env).status, 0);
  let r = af.drive(['result', '--run-dir', t.runDir, '--run-id', failedGate(t.runDir, t.runs)], t.env);
  assert.equal(af.nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', `the one relaunch: ${r.stdout}`);
  assert.equal(af.nextRequest(af.result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  r = af.drive(['result', '--run-dir', t.runDir, '--run-id', failedGate(t.runDir, t.runs)], t.env);
  assert.equal(af.nextRequest(r.stdout), null, 'a second relaunch in the same run');
  assert.equal(af.state(t.runDir).state, 'BLOCKED');
});
