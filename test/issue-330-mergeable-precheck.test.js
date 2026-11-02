'use strict';

// Issue #330: a merge conflict, or a head behind its base, needs a new head, so both drivers stop `BLOCKED` on the
// snapshot taken before the first gate instead of spending every gate on a head that cannot become ready (CL-D130).
const { test, assert, fs, drive, setup, state, setFixture, nextRequest, fakeGate } = require('./issue-196-review-driver.fixtures.js');
const autofix = require('./issue-196-autofix-driver.fixtures.js');
const { readText, readContract, sectionOf } = require('./helpers');

const NEXT = 'the author resolves the merge conflict or updates the branch, then a fresh run';
const pullPatch = (t, change) => { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); return { pull: { ...f.pull, ...change } }; };
const DRIVERS = {
  'review-only': {
    start(mergeableState) { const t = setup(); setFixture(t, pullPatch(t, { mergeable_state: mergeableState })); return { t, r: drive(t.start, t.e), s: () => state(t.runDir) }; },
    next: (r) => nextRequest(r.stdout)?.agent,
  },
  autofix: {
    start(mergeableState) { const t = autofix.setup(); autofix.setFixture(t.bin, { mergeableState }); return { t, r: autofix.drive(t.start, t.env), s: () => autofix.state(t.runDir) }; },
    next: (r) => autofix.nextRequest(r.stdout)?.agent,
  },
};

test('Issue #330 AC1 AC3 a dirty or behind snapshot before the first gate stops BLOCKED in both drivers', () => {
  for (const [driver, d] of Object.entries(DRIVERS)) {
    for (const [mergeableState, why] of [['dirty', 'a merge conflict'], ['behind', 'its head is behind its base']]) {
      const where = `${driver} ${mergeableState}`;
      const { r, s } = d.start(mergeableState);
      assert.notEqual(r.status, 0, where);
      assert.equal(d.next(r), undefined, `${where}: no gate is launched`);
      const st = s();
      assert.equal(st.state, 'BLOCKED', where);
      assert.equal(st.reason, `the pull request's mergeable_state is ${mergeableState} before the first gate (${why})`, where);
      assert.equal(st.nextAction, NEXT, where);
      assert.deepEqual(st.invocations, {}, `${where}: no gate was invoked`);
      if (driver === 'autofix') assert.deepEqual(st.retained, [st.created.root], `${where}: the stop takes the driver's end, which keeps the workspace`);
    }
  }
});

test('Issue #330 AC2 AC3 a null, unknown, blocked, clean, unstable or has_hooks state before the first gate proceeds to convergence', () => {
  for (const [driver, d] of Object.entries(DRIVERS)) {
    for (const mergeableState of [null, 'unknown', 'blocked', 'clean', 'unstable', 'has_hooks']) {
      const { r } = d.start(mergeableState);
      assert.equal(r.status, 0, `${driver} ${mergeableState}: ${r.stderr}${r.stdout}`);
      assert.equal(d.next(r), 'tidd-convergence-reviewer', `${driver} ${mergeableState}`);
    }
  }
});

test('Issue #330 AC2 a dirty state that arrives after the first gate is left to the final policy', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  setFixture(t, pullPatch(t, { mergeable: false, mergeable_state: 'dirty' }));
  let r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stderr + r.stdout);
  const a = autofix.setup();
  assert.equal(autofix.drive(a.start, a.env).status, 0);
  autofix.setFixture(a.bin, { mergeable: false, mergeableState: 'dirty' });
  r = autofix.result(a);
  assert.equal(autofix.nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stderr + r.stdout);
});

test('Issue #330 AC4 CL-D130 records the check, and CL-D100 points forward to it', () => {
  const record = sectionOf(readContract(), '## CL-D130 — A merge conflict or a branch behind its base stops a run before its first gate');
  assert.ok(record, 'CL-D130 is in the contract');
  assert.match(record, /tetsuh\/pi-tidd-agents#330/);
  assert.match(record, /When the snapshot taken before the first gate reports `mergeable_state` `dirty` or `behind`, both drivers stop the run `BLOCKED` before any gate is launched/);
  assert.match(record, /Any other state, a null or `unknown` one while GitHub computes it and `blocked` included, proceeds, and the final policy is unchanged/);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D130.md](contract/CL-D130.md) — A merge conflict or a branch behind its base stops a run before its first gate'));
  assert.ok(readText('contract/CL-D100.md').includes('Every other `mergeable_state` that is not mergeable (`behind`, `dirty`, `unknown`, `draft`) waits as before; CL-D130 later stops a run `BLOCKED` before its first gate on `dirty` or `behind` (#330).'));
  assert.ok(readText('skills/closed-loop-pr/driver/phases.js').includes('// Before the first gate, a merge conflict or a head behind its base needs a new head: the run stops (CL-D130).'));
});
