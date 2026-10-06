'use strict';

// Issue #241: a gate child that mistyped the verification command printed in its task stopped without calling
// structured_output, so its runner recorded the step as failed and wrote no designated output (PR #239 round 3). The
// driver refused at the runner status (`step_incomplete`) and ended the round BLOCKED. A runner status never substitutes
// for reading the designated output (gate-contract.md, CL-D51): an absent output after completion is relaunched once.
const { test, assert, fs, path, crypto, drive, fakeGate, setup, state, nextRequest } = require('./issue-196-review-driver.fixtures.js');

// A completed run whose only step failed and wrote no designated output, as pi-subagents records a child that never
// called structured_output.
function failedGate(runDir, runs) {
  const s = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(s.pending.expectationPath, 'utf8'));
  const agent = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' }[expected.correlation.gate];
  const runId = crypto.randomUUID(), dir = path.join(runs, 'async-subagent-runs', runId);
  fs.mkdirSync(path.join(dir, 'structured-output', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId, state: 'failed', cwd: s.checkout, steps: [{ agent, status: 'failed', model: 'prov/model-x', thinking: 'max', error: 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.', exitCode: 1, structuredOutputPath: path.join(dir, 'structured-output', 'fake', 'output.json'), structuredOutputSchemaPath: path.join(dir, 'structured-output', 'fake', 'schema.json') }] }));
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
