'use strict';

// Issue #115 (CL-D64) — the exact-autofix writer runs the focused validation commands itself during
// the edit step and enters BEFORE_VALIDATION only when they pass; the guarded validation stays the
// single terminal check. A correction that targets a pinned literal receives that literal verbatim.
// Three PR #113 autofix runs ended BLOCKED on a one-shot assertion the writer never executed before
// the guard.
//
// TDD provenance: pre-implementation compile/contract RED (not behavioral RED: every assertion
// inspects artifact text), recorded with `node --test test/issue-115-writer-pre-guard.test.js` at 0
// passes / 2 failures before the prose, the record, and the manifest clauses existed. That local
// output is not claimed as repository-preserved evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, readContract, repoPath, sectionOf, readManifest } = require('./helpers');

test('Issue #115 the guarded validation stays the single terminal check and the writer receives pinned literals verbatim', () => {
  // #249 B3 (CL-D114): the rule is read in its record and the packaged writer task. On the driver path the writer does
  // not run the validation itself (CL-D64-forward-d96), so the prose path's iteration sentence is retired.
  const record = readText('contract/CL-D64.md');
  assert.match(record, /the guarded focused validation stays the single terminal check/);
  assert.match(record, /on the packaged driver path \(CL-D96\) the writer does not run the validation commands itself/);
  assert.match(record, /receives that literal verbatim from its source/);
  assert.match(readText('skills/closed-loop-pr/driver/writer.js'), /Copy any literal a correction pins verbatim\./);
  // The addendum is untouched: it sits inside its own byte guard and owns the guard sequence.
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.doesNotMatch(addendum, /the edit step is where the writer iterates/);
  assert.ok(Buffer.byteLength(addendum) < 32000, 'the CL-D30 addendum stays inside its recorded guard');
});

test('Issue #115 CL-D64 records the writer duty without relaxing the terminal rule', () => {
  const contract = readContract();
  const record = sectionOf(contract, '## CL-D64 — The writer iterates on focused validation before the guard');
  assert.ok(record, 'CL-D64 must exist');
  for (const field of ['*Decision ID:* CL-D64', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D64 must carry ${field}`);
  assert.match(record, /issues\/115/);
  assert.match(record, /a retry after the guarded validation fails/);
  assert.match(record, /CL-D39's post-writer terminal rule is unchanged/);
  const manifest = readManifest();
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D64').map((clause) => clause.id).sort(), ['CL-D64-forward-d96', 'CL-D64-tests', 'CL-D64-writer']);
  assert.ok(fs.existsSync(repoPath('test/issue-115-writer-pre-guard.test.js')));
});
