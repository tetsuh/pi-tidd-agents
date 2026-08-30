'use strict';

// Issue #82 (CL-D51) — a gate child that dies of a pure transport failure with zero designated
// output bytes may be relaunched exactly once in the same run. Zero output is the dividing
// line: with no bytes there is no partial verdict to misread or double-count, so a relaunch
// contradicts nothing; a child that produced any output at all stays terminal exactly as
// before. Observed cost of the terminal rule: roughly 150 whole-run losses on tetsuh/sitometron
// with no repository or GitHub mutation pending in any of them.
//
// TDD provenance: recorded with the focused command below at 0 passes, all compile/contract
// RED against the un-widened mapping and the missing record. No behavioral RED is claimed:
// the relaunch is orchestration prose; no packaged operation changes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const BASE = readText('skills/closed-loop-pr/references/autofix.md');
const ADDENDUM = readText('skills/closed-loop-pr/references/autofix-addendum.md');

test('Issue #82 the recovery mapping gains the zero-output relaunch row and its carve-out', () => {
  const section = sectionOf(BASE, '### Bounded pre-writer recovery (CL-D39)');
  assert.ok(section, 'the recovery section must exist');
  assert.match(section, /\| gate transport failure with zero designated output bytes \| `gate_transport@gate_launch` \| one relaunch of the same prevalidated invocation \| recoverable \| no output existed; nothing is preserved or invalidated \|/);
  // The terminal sweep still holds for everything else at gate_launch, with the one carve-out
  // named where the sweep is stated.
  assert.match(section, /child startup at `preflight` and `gate_launch` except the CL-D51 zero-output transport key/);
  // The dividing line and the budget are stated as absolutes the gate can falsify.
  assert.match(section, /any designated output byte, however malformed, keeps the failure terminal/);
  assert.match(section, /at most one relaunch per run, consuming no counter/);
  assert.match(section, /after any mutation, Luna task, or reply the key is terminal exactly as before/);
});

test('Issue #82 the stop rule names both exceptions', () => {
  const text = `${BASE}\n${ADDENDUM}`;
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop, except for the CL-D39 recovery defined above and the CL-D51 zero-output relaunch\./);
});

test('Issue #82 CL-D51 records the widening under CL-D39\'s own conditions', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D51 — A zero-output gate transport failure may relaunch once');
  assert.ok(decision, 'CONTRACT.md must record CL-D51');
  for (const field of ['*Decision ID:* CL-D51', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D51 must carry ${field}`);
  }
  assert.match(decision, /Option A/);
  assert.match(decision, /CL-D39 names widening the recoverable set as requiring a new owner decision; this is that decision/);
  assert.match(decision, /zero designated output bytes/);
});
