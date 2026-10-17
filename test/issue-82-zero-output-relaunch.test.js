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

test('Issue #82 the driver relaunches a zero-output gate once, and the record states the line where launch.js draws it', () => {
  // #249 B3 (CL-D114): the relaunch is read in the driver and its record; the base reference's mapping row and its
  // eligibility sentence are retired with the prose path.
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  assert.ok(driver.includes("codes: new Set(['designated_output_absent', 'designated_output_empty', 'result_names_no_run']), may: () => !s.relaunched && !s.writerLaunched,"), 'one relaunch per run, never after the writer');
  assert.ok(readText('skills/closed-loop-pr/driver/phases.js').includes("const as = code === 'step_incomplete' && d?.stepStatus === 'failed' && !fs.existsSync(d.structuredOutputPath || '') && !timedOut() ? 'designated_output_absent'"), 'a failed gate that left no output reads as absent output');
  const record = readText('contract/CL-D51.md');
  assert.match(record, /may be relaunched exactly once per run as `gate_transport@gate_launch`, consuming no counter/);
  assert.match(record, /Any other designated output byte, however malformed, keeps the failure terminal; after any mutation, Luna task, or reply the key is terminal exactly as before\./);
  // #275 amended the record (owner choice a): a whitespace-only output counts as zero output bytes, which is where
  // launch.js draws the line.
  assert.match(record, /A designated output with no non-whitespace content counts as zero designated output bytes/);
  assert.ok(readText('skills/closed-loop-pr/helpers/launch.js').includes("if (outputText.trim().length === 0) fail('designated_output_empty',"), 'whitespace-only output is reported as empty');
});

test('Issue #82 the stop rule names both exceptions', () => {
  // #249 B4b (CL-D117): the stop and its exceptions are read in the records and the driver. CL-D39 states the stop with the
  // one relaunch the driver keeps; CL-D51 admits only the zero-output case and keeps every other output byte terminal; the
  // driver's correlation check names a run that never ran (CL-D107).
  assert.match(readText('contract/CL-D39.md'), /a running gate waits, and every other helper refusal stops `BLOCKED`/);
  assert.match(readText('contract/CL-D51.md'), /Any other designated output byte, however malformed, keeps the failure terminal/);
  assert.ok(readText('skills/closed-loop-pr/driver/phases.js').includes(": code === 'correlation_mismatch' && noRun() ? 'result_names_no_run' : code;"), 'a correlation that names no run is the one other relaunch key');
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
