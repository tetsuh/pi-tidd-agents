'use strict';

// Issue #275 (CL-D51), owner choice (a): a designated output with no non-whitespace content counts as zero designated
// output bytes, so the one relaunch covers it; any other byte keeps the failure terminal. The record states the line
// where helpers/launch.js draws it, and the packaged autofix driver relaunches on that side of it only.
const { test, assert, fs, readText, drive, setup, state, fakeGate, nextRequest, outputPath } = require('./issue-196-autofix-driver.fixtures.js');

test('Issue #275 CL-D51 counts a whitespace-only designated output as zero output, where launch.js draws the line', () => {
  const record = readText('contract/CL-D51.md');
  assert.match(record, /A designated output with no non-whitespace content counts as zero designated output bytes \(#275, https:\/\/github\.com\/tetsuh\/pi-tidd-agents\/issues\/275#issuecomment-6226889811\)\. Any other designated output byte, however malformed, keeps the failure terminal;/);
  assert.equal(record.includes('#275 asks which side changes'), false, 'the divergence is closed, not still asked');
  assert.match(record, /either exists with bytes or it does not, and since #275 whitespace alone counts as no bytes\./);
  assert.match(record, /#275 closed it by amending this record \(option a\)/);
  const launch = readText('skills/closed-loop-pr/helpers/launch.js');
  assert.ok(launch.includes("if (outputText.trim().length === 0) fail('designated_output_empty',"), 'launch.js reports an output of whitespace alone as empty');
  assert.match(readText('contract/CL-D114.md'), /#275 later closed the divergence by amending CL-D51 \(option a\)\./);
});

test('Issue #275 the driver relaunches a whitespace-only output once, and stops on one non-whitespace byte', () => {
  let t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  let runId = fakeGate(t.runDir, t.runs); fs.writeFileSync(outputPath(t, runId), ' \n\t\r\n');
  assert.equal(nextRequest(drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env).stdout)?.agent, 'tidd-convergence-reviewer', 'the one relaunch');
  assert.equal(state(t.runDir).relaunched, true);
  t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  runId = fakeGate(t.runDir, t.runs); fs.writeFileSync(outputPath(t, runId), ' x\n');
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', runId], t.env);
  assert.equal(nextRequest(r.stdout), null, 'no relaunch for an output with content');
  assert.equal(state(t.runDir).state, 'BLOCKED');
});
