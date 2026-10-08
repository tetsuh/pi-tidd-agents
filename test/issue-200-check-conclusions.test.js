'use strict';

// Issue #200: snapshot's classifyChecks counted every completed conclusion other than `success` as failed, so a job
// skipped by an `if:` condition, or one reported `neutral`, made `policies.checks` read as failing. The packaged
// driver's readiness already passes both and fails the same six conclusions (driver/readiness.js); the helper now passes
// and fails the same, and reports an unknown conclusion failed where the driver waits on it.
const test = require('node:test');
const assert = require('node:assert/strict');

const snapshot = require('../skills/closed-loop-pr/helpers/snapshot');

const classify = (status, conclusion) => {
  const [c] = snapshot.classifyChecks([{ id: 1, name: conclusion || status, status, conclusion }]);
  return { pending: c.pending, failed: c.failed, successful: c.successful };
};

test('Issue #200 skipped and neutral checks are neither failed nor pending', () => {
  for (const conclusion of ['skipped', 'neutral']) assert.deepEqual(classify('completed', conclusion), { pending: false, failed: false, successful: true }, conclusion);
  assert.deepEqual(classify('completed', 'success'), { pending: false, failed: false, successful: true });
});

test('Issue #200 each failing conclusion stays failed, and an incomplete run stays pending', () => {
  for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']) {
    assert.deepEqual(classify('completed', conclusion), { pending: false, failed: true, successful: false }, conclusion);
  }
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) assert.deepEqual(classify(status, null), { pending: true, failed: false, successful: false }, status);
  // A conclusion GitHub may add later is not known to pass, so it fails closed.
  assert.deepEqual(classify('completed', 'some_new_conclusion'), { pending: false, failed: true, successful: false });
});
