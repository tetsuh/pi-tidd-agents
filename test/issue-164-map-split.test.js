'use strict';

// Issue #164 (CL-D83). `references/autofix.md` and the addendum were both at their ceilings, and one 48-byte map row
// had become a budget question; Issue #73's own comment names that as the signal for a split. The packaged helper
// invocation map and the CL-D44 input shapes move to `references/helper-map.md`, which the exact-autofix reference
// names as part of the same reading (owner choice, issues/164). The move changes no rule: every sentence that was
// pinned to the map moves with its clause.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, readJson, repoPath } = require('./helpers');

const MAP = 'skills/closed-loop-pr/references/helper-map.md';
const AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';

test('Issue #164 the map and the declared shapes live in one file of their own', () => {
  const map = readText(MAP);
  assert.match(map, /^# Packaged helper invocation map/m);
  assert.ok(map.includes('### Packaged helper invocation map (CL-D30, Issue #47)'), 'the map section moved');
  assert.ok(map.includes('### Cross-operation input shapes (CL-D44)'), 'the declared shapes moved with it');
  assert.ok(map.includes('| Phase | Operation | Required data |'), 'the table itself is here');
});

test('Issue #164 the autofix reference points at it once and carries the table no longer', () => {
  const autofix = readText(AUTOFIX);
  assert.ok(autofix.includes('The packaged helper invocation map and the CL-D44 input shapes are in `references/helper-map.md`; read it with this reference (CL-D83).'), 'one pointer');
  assert.equal(autofix.includes('| Phase | Operation | Required data |'), false, 'the table is not in two places');
  assert.equal(autofix.includes('### Cross-operation input shapes (CL-D44)'), false, 'nor is the shapes section');
});

test('Issue #164 the move frees the budget it was taken for', () => {
  const size = (file) => fs.statSync(repoPath(file)).size;
  const addendum = size('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.ok(size(AUTOFIX) < addendum - 5000, `autofix.md ${size(AUTOFIX)} must sit well under the addendum ${addendum} again`);
  assert.ok(size(MAP) < addendum, 'the new file is not the largest either');
});

test('Issue #164 every clause pinned to a moved sentence names the file it moved to', () => {
  const manifest = readJson('test/contract-clauses.json');
  const map = readText(MAP);
  const autofix = readText(AUTOFIX);
  for (const clause of manifest.clauses) {
    for (const file of clause.files) {
      if (file !== AUTOFIX && file !== MAP) continue;
      const text = file === MAP ? map : autofix;
      for (const required of clause.requires) {
        assert.ok(text.includes(required), `${clause.id} requires text that is not in ${file}: ${JSON.stringify(required.slice(0, 60))}`);
      }
    }
  }
});

test('Issue #164 CL-D83 records the split and what it did not change', () => {
  const record = readText('CONTRACT.md');
  assert.ok(record.includes('## CL-D83 — The packaged helper invocation map is its own reference'), 'CL-D83 must exist');
});
