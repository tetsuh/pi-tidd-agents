'use strict';

// Issue #316, the autofix counterpart of #314. The autofix driver's MERGE_READY reason counted every MERGE in the gate
// log on the final head, so a convergence MERGE that an external-snapshot change cleared, on an unchanged head, was
// still named after the rerun convergence returned FIX BEFORE MERGE. A cleared entry no longer counts.
const { test, assert, setFixture, setup, state, result, setCounters, drive } = require('./issue-196-autofix-driver.fixtures.js');

const comment = (id) => ({ id, html_url: `u${id}`, user: { login: 'someone', type: 'User' }, author_association: 'MEMBER', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: `comment ${id}` });

test('Issue #316 a convergence MERGE that a snapshot change cleared is not named', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 3 });
  // Convergence returns MERGE at 4/5; a new comment arrives before Sol, so the sequence restarts at convergence, which
  // returns FIX BEFORE MERGE at 5/5 with only a recorded finding; Sol and Terra then return MERGE.
  setFixture(t.bin, { prComments: [comment(1)] });
  result(t);
  assert.equal(state(t.runDir).pending.gate, 'convergence', 'the snapshot change restarts at convergence');
  result(t, { fresh: true, severity: 'Minor', anchoring: 'reword', disposition: 'accepted-as-designed' });
  result(t); result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.deepEqual(s.gateLog.map((g) => [g.gate, g.verdict]), [['convergence', 'MERGE'], ['convergence', 'FIX BEFORE MERGE'], ['adversarial', 'MERGE'], ['safety', 'MERGE']]);
  assert.match(s.reason, new RegExp(`^sol and terra returned MERGE on ${s.target.headOid.slice(0, 12)} after 0 correction push\\(es\\); the final policy passes$`));
});

test('Issue #316 a convergence MERGE at its cap that a snapshot change before Sol cleared is not named', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  setCounters(t, { conv: 4 });
  // A new comment arrives while convergence runs; it returns MERGE at 5/5, and when Sol is armed the change is seen
  // with convergence at its cap, so nothing restarts.
  setFixture(t.bin, { prComments: [comment(1)] });
  result(t); result(t); result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.deepEqual(s.gateLog.map((g) => [g.gate, g.verdict]), [['convergence', 'MERGE'], ['adversarial', 'MERGE'], ['safety', 'MERGE']]);
  assert.match(s.reason, new RegExp(`^sol and terra returned MERGE on ${s.target.headOid.slice(0, 12)} after 0 correction push\\(es\\); the final policy passes$`));
});

test('Issue #316 a convergence MERGE that stands is still named', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t); result(t); result(t);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.match(s.reason, new RegExp(`^convergence and sol and terra returned MERGE on ${s.target.headOid.slice(0, 12)} after 0 correction push\\(es\\); the final policy passes$`));
});
