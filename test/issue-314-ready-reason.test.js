'use strict';

// Issue #314, part of #203. The review-only driver's MERGE_READY reason was a fixed sentence naming convergence, Sol and
// Terra, so a run where convergence handed its open findings to Sol at its cap, after an external-snapshot change had
// cleared its earlier MERGE, still reported that convergence returned MERGE. The reason now names the gates whose
// verdict stands as MERGE at readiness.
const { test, assert, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, solConfirming, prComment } = require('./issue-196-review-driver.fixtures.js');

test('Issue #314 MERGE_READY names convergence, Sol and Terra when all three stand', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.reason, /^convergence, Sol and Terra returned MERGE on the unchanged head; the final policy passes$/);
});

test('Issue #314 a convergence that handed its findings to Sol at its cap is not named', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  // Two convergence MERGEs, each cleared by a new comment before Sol, then a third convergence at its cap with a
  // finding open, which hands it to Sol; Sol confirms it and Terra returns MERGE.
  for (const n of [1, 2]) { setFixture(t, { prComments: Array.from({ length: n }, (_, i) => prComment(i + 1)) }); drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); }
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e).stdout)?.agent, 'tidd-adversarial-reviewer');
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', solConfirming(t.runDir, t.runs)], t.e).stdout)?.agent, 'tidd-safety-reviewer');
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.ok(s.gateLog.some((g) => g.gate === 'convergence' && g.verdict === 'MERGE'), 'the fixture logs a convergence MERGE that was later cleared');
  assert.match(s.reason, /^Sol and Terra returned MERGE on the unchanged head; the final policy passes$/);
});

test('Issue #314 with convergence disabled the reason keeps its prefix', () => {
  const t = setup();
  assert.equal(drive([...t.start, '--convergence', 'disabled'], t.e).status, 0);
  throughGates(t, 2);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.reason, /^convergence was disabled; Sol and Terra returned MERGE on the unchanged head; the final policy passes$/);
});

test('Issue #314 a convergence MERGE that a snapshot change cleared is not named', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  // Three convergence MERGEs, each cleared by a new comment before Sol; at its cap convergence is not rerun.
  for (const n of [1, 2, 3]) { setFixture(t, { prComments: Array.from({ length: n }, (_, i) => prComment(i + 1)) }); drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e); }
  throughGates(t, 2);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.reason, /^Sol and Terra returned MERGE on the unchanged head; the final policy passes$/);
});

test('Issue #314 a gate whose findings are all recorded is not named', () => {
  const reword = { verdict: 'FIX', severity: 'Minor', anchoring: 'reword', disposition: 'fixed' };
  for (const [disabled, expected] of [[false, /^convergence and Terra returned MERGE on the unchanged head; the final policy passes$/], [true, /^convergence was disabled; Terra returned MERGE on the unchanged head; the final policy passes$/]]) {
    const t = setup();
    assert.equal(drive(disabled ? [...t.start, '--convergence', 'disabled'] : t.start, t.e).status, 0);
    if (!disabled) drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
    assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, reword)], t.e).stdout)?.agent, 'tidd-safety-reviewer');
    drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
    const s = state(t.runDir);
    assert.equal(s.state, 'MERGE_READY', s.reason);
    assert.match(s.reason, expected);
  }
  // Every gate's findings recorded and none returning MERGE.
  const t = setup();
  assert.equal(drive([...t.start, '--convergence', 'disabled'], t.e).status, 0);
  for (let i = 0; i < 2; i += 1) drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, reword)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.reason, /^convergence was disabled; every gate's findings are recorded on the unchanged head; the final policy passes$/);
});
