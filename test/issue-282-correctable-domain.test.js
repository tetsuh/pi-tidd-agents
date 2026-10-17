'use strict';

// Issue #282 (CL-D96), owner choice (a): the correctable class does not depend on a finding's domain. A security or risk
// finding a gate proposes `fixed` is corrected like any other, and the gates decide when a finding needs the owner; the
// exact-autofix rule that a security or risk finding always waits for the owner is retired as superseded by CL-D96.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readText } = require('./helpers');

test("Issue #282 CL-D96 states that the correctable class does not depend on the finding's domain", () => {
  const d96 = readText('contract/CL-D96.md');
  assert.match(d96, /it is criterion-anchored, Major or Minor, not out of scope, and proposed `fixed` or `deferred`, whatever its domain \(#282\), and every unresolved finding/);
  assert.ok(Buffer.byteLength(d96) < 8000, `CL-D96 stays under the record limit (${Buffer.byteLength(d96)})`);
  // The class the record states is the one the driver applies: no condition on a domain.
  assert.ok(readText('skills/closed-loop-pr/driver/autofix.js').includes("function correctable(x) { return x.workflowRecord?.sourceKind === 'gate' && x.anchoring === 'criterion-anchored' && ['Major', 'Minor'].includes(x.severity) && ['fixed', 'deferred'].includes(x.proposedDisposition) && x.outOfScope !== true; }\n"), 'correctable() is the class CL-D96 states');
});

test('Issue #282 CL-D30 records the departure closed and the rule retired, and CL-D115 notes the closure', () => {
  assert.match(readText('contract/CL-D30.md'), /#282 later closed the second departure \(owner choice, https:\/\/github\.com\/tetsuh\/pi-tidd-agents\/issues\/282#issuecomment-6226890003\): CL-D96's class does not depend on a finding's domain, so the exact-autofix rule that a security or risk finding always waits for the owner is retired as superseded by CL-D96\./);
  assert.match(readText('contract/CL-D115.md'), /#282 later closed the domain departure \(CL-D30, CL-D96\)\./);
});
