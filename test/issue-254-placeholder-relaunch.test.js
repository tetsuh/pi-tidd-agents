'use strict';

// Issue #254: in round 2 of PR #253 the parent changed one path in a gate launch's task, the gate's verification
// failed, and the gate still returned a placeholder envelope whose correlation names no run: every OID and digest the
// null value. gate_result_read refused it as a correlation mismatch and the round ended BLOCKED with no gate run. A
// placeholder that names no run is no result of the launch, so it is relaunched once, as an absent output is (CL-D107):
// review-only per gate invocation, exact autofix within its one relaunch per run; any real OID stays a refusal.
const { test, assert, fs, path, drive, fakeGate, setup, state, nextRequest } = require('./issue-196-review-driver.fixtures.js');
const af = require('./issue-196-autofix-driver.fixtures.js');

// A completed gate run whose envelope carries the correlation PR #253 round 2 observed, or `change` applied to it.
function placeholderGate(runDir, runs, change = {}) {
  const runId = fakeGate(runDir, runs);
  const file = path.join(runs, 'async-subagent-runs', runId, 'structured-output', 'fake', 'output.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8')).correlation;
  const correlation = { headBranch: 'unknown', repository: c.repository, number: c.number, baseOid: '0'.repeat(40), headRepository: c.headRepository, headOid: '0'.repeat(40), lifecycle: 'open', draft: false, gate: c.gate, invocation: c.invocation, contractInput: '0'.repeat(64), snapshotFingerprint: '0'.repeat(64), ...change(c) };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, correlation, verdict: 'NEEDS DECISION', evidenceRead: [], findings: [], confirmations: [], decisions: [], adversarialResults: [] }));
  return runId;
}
const none = () => ({});

test('Issue #254 a gate result whose correlation names no run is relaunched once, not BLOCKED', () => {
  const t = setup();
  const first = drive(t.start, t.e);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const launch = nextRequest(first.stdout);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, none)], t.e);
  assert.deepEqual(nextRequest(r.stdout), launch, `the same launch is printed again: ${r.stdout}`);
  assert.equal(state(t.runDir).pending.relaunched, true);
  const next = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(next.status, 0, next.stderr + next.stdout);
  assert.equal(state(t.runDir).invocations.convergence, 1);
});

test('Issue #254 a second result that names no run stops BLOCKED after one relaunch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, none)], t.e);
  assert.equal(state(t.runDir).pending?.relaunched, true, 'the first one was relaunched');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, none)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /after one relaunch: correlation_mismatch/);
});

// Only all four null values name no run. A correlation that names a real OID or digest anywhere, another run's included,
// is a mismatch and stays a refusal at once.
test('Issue #254 a mismatched correlation that names any real value is not relaunched', () => {
  for (const change of [(c) => ({ baseOid: c.baseOid }), (c) => ({ headOid: c.headOid }), (c) => ({ contractInput: c.contractInput }), (c) => ({ snapshotFingerprint: c.snapshotFingerprint }),
    (c) => ({ ...c, headOid: '1'.repeat(40) })]) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    const r = drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, change)], t.e);
    assert.notEqual(r.status, 0);
    assert.equal(nextRequest(r.stdout), null, String(change));
    assert.equal(state(t.runDir).state, 'BLOCKED');
    assert.match(state(t.runDir).reason, /^gate_result_read refused: correlation_mismatch/);
  }
});

// The owner widened CL-D51 for this result (#254): exact autofix relaunches it within its one relaunch per run, never
// after the writer, and a correlation that names any real value stays terminal there too.
test('Issue #254 exact autofix relaunches a result that names no run once per run', () => {
  const t = af.setup();
  const first = af.drive(t.start, t.env);
  assert.equal(first.status, 0);
  let r = af.drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, none)], t.env);
  assert.deepEqual(af.nextRequest(r.stdout), af.nextRequest(first.stdout), `the one relaunch repeats the launch: ${r.stdout}`);
  assert.equal(af.state(t.runDir).counters.conv, 0, 'no gate counter is spent');
  assert.equal(af.nextRequest(af.result(t).stdout)?.agent, 'tidd-adversarial-reviewer');
  r = af.drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, none)], t.env);
  assert.equal(af.nextRequest(r.stdout), null, 'a second relaunch in the same run');
  assert.equal(af.state(t.runDir).state, 'BLOCKED');
  assert.match(af.state(t.runDir).reason, /correlation_mismatch/);
});

test('Issue #254 exact autofix does not relaunch a mismatched correlation that names a real value', () => {
  const t = af.setup();
  assert.equal(af.drive(t.start, t.env).status, 0);
  const r = af.drive(['result', '--run-dir', t.runDir, '--run-id', placeholderGate(t.runDir, t.runs, (c) => ({ headOid: c.headOid }))], t.env);
  assert.equal(af.nextRequest(r.stdout), null, r.stdout);
  assert.equal(af.state(t.runDir).state, 'BLOCKED');
  assert.match(af.state(t.runDir).reason, /correlation_mismatch/);
});
