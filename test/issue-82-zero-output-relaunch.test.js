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
// the relaunch was orchestration prose then; the packaged driver applies it now (#249 B3, CL-D114).

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readContract, sectionOf } = require('./helpers');

const ADDENDUM = readText('skills/closed-loop-pr/references/autofix-addendum.md');

test('Issue #82 the driver relaunches a zero-output gate once, and the record states the line and its divergence', () => {
  // #249 B3 (CL-D114): the relaunch is read in the driver and its record; the base reference's mapping row and its
  // eligibility sentence are retired with the prose path.
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.ok(driver.includes("codes: new Set(['designated_output_absent', 'designated_output_empty', 'result_names_no_run']), may: () => !s.relaunched && !s.writerLaunched,"), 'one relaunch per run, never after the writer');
  assert.ok(readText('skills/closed-loop-pr/driver/phases.js').includes("const as = code === 'step_incomplete' && d?.stepStatus === 'failed' && !fs.existsSync(d.structuredOutputPath || '') && !timedOut() ? 'designated_output_absent'"), 'a failed gate that left no output reads as absent output');
  const record = readText('contract/CL-D51.md');
  assert.match(record, /may be relaunched exactly once per run as `gate_transport@gate_launch`, consuming no counter/);
  assert.match(record, /Any designated output byte, however malformed, keeps the failure terminal; after any mutation, Luna task, or reply the key is terminal exactly as before\./);
  // The driver is wider than that line for an output of whitespace alone. The record says so, and one or both of the
  // last two assertions fail when #275 is settled either way, so the record follows the code.
  assert.match(record, /so a whitespace-only output is relaunched although it has bytes: wider than this record, recorded and not closed \(#249, CL-D114\); #275 asks which side changes\./);
  assert.ok(readText('skills/closed-loop-pr/helpers/launch.js').includes("if (outputText.trim().length === 0) fail('designated_output_empty',"), 'whitespace-only output is reported as empty');
});

test('Issue #82 the stop rule names both exceptions', () => {
  const text = ADDENDUM;
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop, except for the CL-D39 recovery defined above, the CL-D51 zero-output relaunch, and the CL-D86 recomposition after a push\./);
  // Review-driven (PR #94 round 3): the addendum's own absolute stop sentences must carry the
  // same carve-out, or they contradict the relaunch they sit beside. Only the zero-byte case
  // is admitted; every output byte and every other correlation defect stops exactly as before.
  assert.match(ADDENDUM, /except that a missing result whose designated output holds zero bytes may first take the single CL-D51 relaunch; any output byte, however malformed, stops as before/);
  assert.match(ADDENDUM, /except that correlation entirely absent because the CL-D51 pure zero-output gate transport failure produced no bytes permits that single relaunch first/);
});

test('Issue #82 CL-D51 records the widening under CL-D39\'s own conditions', () => {
  const decision = sectionOf(readContract(), '## CL-D51 — A zero-output gate transport failure may relaunch once');
  assert.ok(decision, 'CONTRACT.md must record CL-D51');
  for (const field of ['*Decision ID:* CL-D51', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D51 must carry ${field}`);
  }
  assert.match(decision, /Option A/);
  assert.match(decision, /CL-D39 names widening the recoverable set as requiring a new owner decision; this is that decision/);
  assert.match(decision, /zero designated output bytes/);
});
