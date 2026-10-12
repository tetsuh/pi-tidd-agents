'use strict';

// Issue #38 remainder after CL-D39 (Issue #34): the recovery's place in the deterministic
// action order. #249 B3 (CL-D114) retired the executable model of vectors 2-7: it parsed the
// base reference's CL-D39 table, a decision the packaged driver does not make (it recovers only
// CL-D51's key, which test/issue-196-autofix-driver-5, -6 and -7 and test/issue-254-placeholder-relaunch.test.js
// test by behaviour, the last of them with the operator checkout and workspace recheck the vectors stated).

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText } = require('./helpers');

const PR_AUTOFIX_ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';

test('Issue #38 the action order states where recovery sits and that safety precedes it', () => {
  const text = readText(PR_AUTOFIX_ADDENDUM);
  const order = text.match(/Apply this deterministic action order[^\n]*/);
  assert.ok(order, 'the deterministic action order clause must exist');
  assert.match(order[0], /The CL-D39 recovery is evaluated only after target movement, lifecycle, identity, and fingerprint checks and gate correlation and result validation have passed/);
  assert.match(order[0], /and before any owner decision, final policy, or reply step/);
  // Already-reached limits come first: recovering into a run that must stop is pointless.
  assert.match(order[0], /an already-reached gate, push, or no-progress limit and any safety or identity failure take precedence over recovery eligibility/);
  assert.match(order[0], /a recovery consumes no counter/);
});
