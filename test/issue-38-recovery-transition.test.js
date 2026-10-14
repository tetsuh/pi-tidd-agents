'use strict';

// Issue #38 remainder after CL-D39 (Issue #34): the recovery's place in the deterministic
// action order. #249 B3 (CL-D114) retired the executable model of vectors 2-7: it parsed the
// base reference's CL-D39 table, a decision the packaged driver does not make (it recovers only
// CL-D51's key, which test/issue-196-autofix-driver-5, -6 and -7 and test/issue-254-placeholder-relaunch.test.js
// test by behaviour, the last of them with the operator checkout and workspace recheck the vectors stated).

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText } = require('./helpers');

// #249 B4b (CL-D117): the base reference's action order placed a recovery the driver does not take (CL-D114); what
// stays is the order the driver keeps in `result`: the run's guard, then the gate-result read with its one relaunch, then
// the counter, and the gate and push limits before any launch.
test('Issue #38 the driver guards the run before it reads a gate result, and counts the result only after the read', () => {
  const driver = readText('skills/closed-loop-pr/driver/autofix.js');
  const result = driver.slice(driver.indexOf('function result(opts) {'));
  const guard = result.indexOf('  guard(run);'), read = result.indexOf("const read = readGate(run, opts['run-id'], SELF,"), count = result.indexOf("if (gate === 'convergence') s.counters.conv += 1; else s.counters.gates += 1;");
  assert.ok(guard > 0 && guard < read && read < count, 'guard, read, then count');
  assert.ok(result.indexOf('  if (!read) return undefined;') > read && result.indexOf('  if (!read) return undefined;') < count, 'a relaunched read returns before the counter, consuming none');
  assert.ok(driver.includes("if (gate !== 'convergence' && s.counters.gates >= CAP.gates) end(run, 'ROUND_LIMIT_REACHED', 'gate_limit');"), 'a reached gate limit stops before any launch');
});
