'use strict';

// Issue #87 (CL-D50) — the CL-D30 addendum moves from a section of `autofix.md` into its own
// third disclosure stage: Skill, then the selected mode reference, then — only when the exact
// `autofix` token selected the mode — the addendum file the reference directs to. The mode
// invariant is untouched: exactly one mode reference is read, and the addendum is not a mode
// reference; it is selected by one.
//
// TDD provenance: recorded with the focused command below at 0 passes. Every failure is
// compile/contract RED against the unsplit layout. No behavioral RED is claimed: no prose is
// reworded — this issue relocates it and re-scopes the guards that bound it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { AUTHORITY_FILES, readText, repoPath, sectionOf } = require('./helpers');

const BASE = 'skills/closed-loop-pr/references/autofix.md';
const ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';

test('Issue #87 the addendum is its own authority file and the aggregate set has seven entries', () => {
  assert.equal(AUTHORITY_FILES.length, 7);
  assert.ok(AUTHORITY_FILES.includes(ADDENDUM), 'the addendum file must be inside the measured aggregate');
  assert.ok(AUTHORITY_FILES.includes(BASE));
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 128000, `authority files total ${total}`);
});

test('Issue #87 the addendum content moved whole and the base directs to it', () => {
  const base = readText(BASE);
  const addendum = readText(ADDENDUM);
  // The heading and its content live only in the addendum file now.
  assert.equal(base.includes('## Exact PR `autofix` addendum (CL-D30)'), false, 'the base must not keep the addendum heading');
  assert.ok(addendum.startsWith('## Exact PR `autofix` addendum (CL-D30)'), 'the addendum file must begin with the moved heading');
  for (const heading of [
    '### Exact-autofix readiness and resume boundary (CL-D30)',
    '### Findings, no-progress, and deterministic status',
    '### Source-reply markers and reconciliation (CL-D45)',
  ]) {
    assert.equal(base.includes(heading), false, `${heading} must not remain in the base`);
    assert.ok(sectionOf(addendum, heading), `${heading} must be readable in the addendum`);
  }
  // The base directs the third disclosure stage, gated on the exact token, and the mode
  // invariant's subject is untouched: the addendum is not a mode reference.
  assert.match(base, /The exact `autofix` token additionally selects the CL-D30 addendum in `references\/autofix-addendum\.md`; read it only then, after this reference \(CL-D50\)\./);
  const skill = readText('skills/closed-loop-pr/SKILL.md');
  assert.match(skill, /- exact CL-D30 `autofix` mode: read `references\/autofix\.md`\./);
});

test('Issue #87 the disclosure stages are bounded per stage', () => {
  const skill = Buffer.byteLength(readText('skills/closed-loop-pr/SKILL.md'));
  const base = Buffer.byteLength(readText(BASE));
  const addendum = Buffer.byteLength(readText(ADDENDUM));
  // The pre-split-monolith claim keeps its meaning for what every autofix run reads.
  assert.ok(skill + base < 57160, `skill+base is ${skill + base}`);
  // The addendum stage carries the guard its section already had.
  assert.ok(addendum < 28000, `addendum file is ${addendum}`);
});

test('Issue #87 CL-D50 records the third disclosure stage', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D50 — The CL-D30 addendum is a third disclosure stage');
  assert.ok(decision, 'CONTRACT.md must record CL-D50');
  for (const field of ['*Decision ID:* CL-D50', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D50 must carry ${field}`);
  }
  assert.match(decision, /the addendum is not a mode reference; it is selected by one/);
  assert.match(decision, /no prose is reworded/);
  assert.match(decision, /The aggregate set becomes seven files with its total and ceiling unchanged/);
});
