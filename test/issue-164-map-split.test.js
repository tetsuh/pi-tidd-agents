'use strict';

// Issue #164 (CL-D83). `references/autofix.md` and the addendum were both at their ceilings, and one 48-byte map row
// had become a budget question; Issue #73's own comment names that as the signal for a split. The packaged helper
// invocation map and the CL-D44 input shapes move to `references/helper-map.md`, which the exact-autofix reference
// names as part of the same reading (owner choice, issues/164). The move changes no rule: every sentence that was
// pinned to the map moves with its clause.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readContract, readManifest } = require('./helpers');

const MAP = 'skills/closed-loop-pr/references/helper-map.md';
const AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';

// #249 C2 (CL-D119) deleted both files; what remains is that no clause pins them.

test('Issue #164 no clause pins a moved sentence to either file any more', () => {
  // #249 B1 and B3 (CL-D112, CL-D114) moved every pin off both files, so the per-clause search this test ran would pass
  // over nothing; what it guarded now holds by construction, and the test says so.
  for (const clause of readManifest().clauses) {
    for (const file of [AUTOFIX, MAP]) assert.equal(clause.files.includes(file), false, `${clause.id} pins ${file}`);
  }
});

test('Issue #164 CL-D83 records the split and what it did not change', () => {
  const record = readContract();
  assert.ok(record.includes('## CL-D83 — The packaged helper invocation map is its own reference'), 'CL-D83 must exist');
});
