'use strict';

// Issue #336: two operator traps seen on 2026-11-03. A driver started with a TMPDIR that does not contain its run
// directory has every gate payload refused, and a parent that adapts the printed request, moving `async` into
// `options` or rewriting the task line, has the launch refused or the child abort. The README says where TMPDIR belongs,
// and the NEXT line says the request is passed verbatim with every field at its own level.
const R = require('./issue-196-review-driver.fixtures.js');
const { test, assert, readText } = R;
const { Run } = require('../skills/closed-loop-pr/driver/run');
const { sectionOf } = require('./helpers');

const NEXT = 'NEXT: make exactly this subagent call (pass the next line verbatim, every field at its level, async too); whether it succeeds or fails, then run: '; // reworded by #340

function printed(request, command, dir) {
  const write = process.stdout.write, out = [];
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try { Run.prototype.next.call({ dir }, request, command); } finally { process.stdout.write = write; }
  return out.join('');
}

test('Issue #336 AC2 Run.next prints that the request is passed verbatim, async at the top level', () => {
  const request = { agent: 'tidd-convergence-reviewer', task: 'Task: x', context: 'fresh', async: true, outputMode: 'inline' };
  const lines = printed(request, '/pkg/driver/review.js result', '/tmp/run').split('\n');
  assert.equal(lines[0], `${NEXT}node /pkg/driver/review.js result --run-dir /tmp/run --run-id <runId>`);
  assert.deepEqual(JSON.parse(lines[1]), request);
  assert.equal(lines.length, 3, 'the line, the request, and the final newline');
});

test('Issue #336 AC2 the packaged review driver prints that line before its first gate, async top-level in the request', () => {
  const t = R.setup();
  const r = R.drive(t.start, t.e);
  const lines = r.stdout.split('\n'), at = lines.findIndex((l) => l.startsWith('NEXT:'));
  assert.ok(at >= 0, r.stderr + r.stdout);
  assert.ok(lines[at].startsWith(NEXT), lines[at]);
  // The follow-up command is still read from the end of the line, as the parent runs it.
  assert.match(lines[at], /then run: node \S+review\.js result --run-dir \S+ --run-id <runId>$/);
  const request = JSON.parse(lines[at + 1]);
  assert.equal(request.async, true);
  assert.equal(request.options?.async, undefined);
});

test('Issue #336 AC1 the README says the driver runs with a TMPDIR that contains its run directory', () => {
  const section = sectionOf(readText('README.md'), '### How a round runs (CL-D104)');
  assert.ok(section, 'README has the section');
  for (const sentence of [
    'The driver writes each gate\'s payload in its run directory and refuses to launch a gate when that directory is not inside the temporary directory Node reports (`os.tmpdir()`, read from `TMPDIR`, `TMP` or `TEMP`), with `payload_location_invalid`.',
    'So the driver must run with a `TMPDIR` (and `TEMP`/`TMP`) that contains its run directory; without `--run-dir` it makes its run directory there.',
    'A scratch temporary directory for the project\'s tests belongs in the validation command\'s own environment, for example `["env", "TMPDIR=/path/to/scratch", "node", "--test"]`, not in the driver process\'s.',
  ]) assert.ok(section.includes(sentence), sentence);
});
