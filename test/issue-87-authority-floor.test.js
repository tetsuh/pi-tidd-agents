'use strict';

// Issue #87 (CL-D48) — the headroom floor asserted a live property (`ceiling - total > 8000`)
// while meaning a raise-time one. As the graph grew into the margin it silently became the
// real ceiling: three consecutive PRs trimmed prose to fit 120,000, and PR #85 shortened a
// shared-contract sentence for nine bytes. The guard now asserts what it meant — the raise
// left real room when it was taken — and the ceiling is the only live limit.
//
// TDD provenance: recorded with the focused command below at 0 passes and 2 failures, both
// compile/contract RED against the constant-floor guard and the missing decision record. No
// behavioral RED is claimed: this issue changes a recorded limit's form, not behavior. That
// local output is not claimed as repository-preserved or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { AUTHORITY_FILES, readText, repoPath, sectionOf } = require('./helpers');

const BUDGET_TEST = readText('test/issue-73-authority-budget.test.js');

test('Issue #87 the headroom property is asserted at the raise, not against live growth', () => {
  // The live check is the ceiling alone; nothing else may bound ordinary prose work.
  assert.match(BUDGET_TEST, /assert\.ok\(total < 128000,/);
  assert.equal(/128000 - total > 8000/.test(BUDGET_TEST), false, 'the constant live floor must not survive');

  // The raise-time property is still asserted, against the measurement recorded when CL-D43
  // was taken — a static fact that cannot drift as the graph grows.
  assert.match(BUDGET_TEST, /RAISE_BASELINE_BYTES = 114563/);
  assert.match(BUDGET_TEST, /128000 - RAISE_BASELINE_BYTES > 8000/);

  // And the live measurement still has to fit.
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 128000, `six authority files total ${total}`);
  // A decision-sized addition — the observed 1,500-2,000 bytes — must fit without trimming,
  // which is the outcome this issue exists to restore.
  assert.ok(128000 - total > 2000, `a decision-sized addition must fit, only ${128000 - total} bytes free`);
});

test('Issue #87 CL-D48 records why the constant form failed', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D48 — The authority headroom property is asserted at the raise');
  assert.ok(decision, 'CONTRACT.md must record CL-D48');
  for (const field of ['*Decision ID:* CL-D48', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D48 must carry ${field}`);
  }
  assert.match(decision, /became the effective ceiling/);
  assert.match(decision, /splitting `autofix\.md` remains the recorded structural answer/);
});
