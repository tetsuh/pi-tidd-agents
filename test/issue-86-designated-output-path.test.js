'use strict';

// Issue #86 (CL-D58) — the gate envelope is read from the run's structured output path, never
// from a completion notice. Measured on PR #99 (2026-09-02): four Sol runs the parent declared
// dead had each written a complete envelope to that path (one of them a MERGE); the pi-subagents
// completion notice for a single async run reads `(no output)`, and no prose said where the
// envelope is read, so the parent classified a courier's silence as zero designated output,
// spent the CL-D51 relaunch on a run that had succeeded, and discarded the verdicts.
//
// TDD provenance: recorded with the focused command below at 0 passes, all compile/contract
// RED against the unamended transport section and the missing record. No behavioral RED is
// claimed: the read path is orchestration prose; no packaged operation changes.
//   node --test test/issue-86-designated-output-path.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const GATE_CONTRACT = readText('skills/closed-loop-shared/references/gate-contract.md');
const RECORD = readText('CONTRACT.md');
const PR_REVIEW_ONLY = readText('skills/closed-loop-pr/references/review-only.md');
const ISSUE_WORKFLOW = readText('skills/closed-loop-issue/SKILL.md');
const PR_AUTOFIX = readText('skills/closed-loop-pr/references/autofix-addendum.md');

test('Issue #86 the transport section names the designated output and its read path', () => {
  const section = sectionOf(GATE_CONTRACT, '### Structured gate result transport (CL-D36)');
  assert.ok(section, 'the transport section must exist');
  assert.match(section, /Designated output \(CL-D58\)/);
  // The envelope is a file at a runner-reported path, read after completion.
  assert.match(section, /the gate envelope is the file at the run's structured output path, as reported by the runner's run status; the parent reads it from that path after completion/);
  // Couriers carry the envelope; they are never it, and their silence is not an observation.
  assert.match(section, /A completion notice, wait result, or preview is a courier and never the envelope/);
  assert.match(section, /`\(no output\)` in one is transport indeterminacy, not zero output, and the parent must read the path before classifying the run/);
  // CL-D51's dividing line is bound to the file, in both directions.
  assert.match(section, /Zero designated output bytes \(CL-D51\) means that file is absent or empty after completion/);
  assert.match(section, /an exit code, success flag, or runner status never substitutes for reading it/);
  assert.match(section, /a validated envelope at that path is the verdict whatever the runner's status says/);
  assert.match(section, /a validation failure at that path remains a tool failure governed by the owning workflow or selected mode's existing retry\/fail-stop rule/);
  assert.match(section, /exact autofix's first-malformed-result terminal rule and CL-D51's zero-byte relaunch remain unchanged/);
});

test('Issue #86 CL-D51 points at the read path it now depends on', () => {
  const record = sectionOf(RECORD, '## CL-D51 — A zero-output gate transport failure may relaunch once');
  assert.ok(record, 'CL-D51 must exist');
  assert.match(record, /CL-D58 later fixed where the designated output is read: the run's structured output path, never a completion notice/);
});

test('Issue #86 CL-D58 records the read path as an application of the no-information principle', () => {
  const record = sectionOf(RECORD, '## CL-D58 — The gate envelope is read from the structured output path, never from a notice');
  assert.ok(record, 'CL-D58 must exist');
  assert.match(record, /\*Owner choice:\* Option A\./);
  assert.match(record, /issues\/86#issuecomment-5509685542/);
  assert.match(record, /four Sol runs/);
  assert.match(record, /one of them a `MERGE`/);
  assert.match(record, /no helper code and no new operation/);
  assert.match(record, /A validation failure at that path remains a tool failure governed by the owning workflow or selected mode's existing retry\/fail-stop rule; this decision grants no retry change/);
  assert.match(record, /Exact autofix's first-malformed-result terminal rule and CL-D51's zero-byte relaunch remain unchanged/);
});

test('Issue #86 keeps validation-failure handling owned by each route', () => {
  // Ordinary review-only retains its existing one retry for a missing/unparsable verdict.
  assert.match(PR_REVIEW_ONLY, /A missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`/);
  // Ordinary Issue mode retains its CL-D31-scoped retry, while CL-D32 remains fail-stop.
  assert.match(ISSUE_WORKFLOW, /Only under ordinary CL-D31 rules, a missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`/);
  assert.match(ISSUE_WORKFLOW, /Under CL-D32, tool, provider, startup, capture, malformed, missing, or uncertain outcomes.*cannot use the ordinary missing-or-unparsable retry/s);
  // Exact autofix remains terminal on its first malformed result.
  assert.match(PR_AUTOFIX, /Exact autofix stops on the first malformed, unparsable, stale, missing, or mismatched result without retry/);
});
