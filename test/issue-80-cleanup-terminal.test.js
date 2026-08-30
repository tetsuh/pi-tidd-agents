'use strict';

// Issue #80 (CL-D49) — after a successful workspace_cleanup the workspace is gone, so any
// later workspace_* call on that path can only fail. In the field the orchestrator ran a
// post-removal workspace_verify, Git returned ENOENT, and the failure was treated fail-closed:
// ~90 logged runs converted a successful cleanup into a dead run. The cleanup result already
// carries the terminal evidence; the contract simply never said it was terminal.
//
// TDD provenance: recorded with the focused command below at 0 passes and 2 failures, both
// compile/contract RED against the missing prose and record. No behavioral RED is claimed:
// the packaged operations are unchanged; this issue names which result is terminal.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');

test('Issue #80 the cleanup result is named terminal and post-removal workspace calls are forbidden', () => {
  const invariants = sectionOf(AUTOFIX, '### Isolated exact-autofix invariants (CL-D10, CL-D30)');
  assert.ok(invariants, 'the invariants section must exist');
  assert.match(invariants, /a successful `workspace_cleanup` result is the terminal workspace evidence/);
  assert.match(invariants, /no `workspace_\*` operation may target the removed path afterwards/);
  assert.match(invariants, /the terminal recheck after removal is operator-side only/);
  // The failure mode this closes must be named, so a later reader cannot rediscover it by
  // repeating it: a post-removal verification failure is the caller's error, not the target's.
  assert.match(invariants, /a post-removal verification failure is a caller error, never evidence about the target/);

  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D49 — A successful cleanup result is the terminal workspace evidence');
  assert.ok(decision, 'CONTRACT.md must record CL-D49');
  for (const field of ['*Decision ID:* CL-D49', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D49 must carry ${field}`);
  }
  // The helper-side guard the issue floated is declined for a stated reason, not silently.
  assert.match(decision, /would require declaring a new cross-operation field, which the CL-D44 freeze reserves for a new owner decision/);
});

test('Issue #80 the cleanup operation already returns the terminal evidence it is now named for', () => {
  // The prose names the cleanup result terminal; that is only true because the result actually
  // carries the post-removal facts. If cleanup ever stops returning them, the prose is a lie
  // and this fails rather than drifting.
  const source = readText('skills/closed-loop-pr/helpers/workspace.js');
  assert.match(source, /createResult\('workspace_cleanup', \{ removed: true, path: actual\.path, terminalHead: actual\.head, terminalTree: actual\.tree, id: receipt\.id \}\)/);
});
