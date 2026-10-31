'use strict';

// Issue #326 (CL-D127): CL-D126 gave the review-only driver a recorded-reword line the earlier-rounds reader does not
// carry, and left the exact autofix driver's line to #50; #50 had already closed with no carried accounting. The autofix
// driver still published a recorded reword as `<disposition> (recorded under CL-D85)`, a line a later review-only run
// carries as settled although no correction comment was posted. Owner choice: the autofix driver takes the same
// non-carry form; it posts no conversation comment.
//
// TDD provenance: behavioural RED — an autofix run publishes `CONV-7-X1: fixed (recorded under CL-D85)` for a reword.
const { test, assert, fs, drive, setup, state, result, writerBatch, nextRequest } = require('./issue-196-autofix-driver.fixtures.js');
const review = require('./issue-196-review-driver.fixtures.js');
const { readText } = require('./helpers');

const REWORD_LINE = '`${x.proposedDisposition} (reword, recorded under CL-D85; judged afresh next run, CL-D126)`';
const minorReword = { severity: 'Minor', anchoring: 'reword' };

// Run to a terminal state through Sol and Terra returning MERGE; the published block is the run's publication.
function finish(t) {
  for (let i = 0; i < 2 && !state(t.runDir).publication; i += 1) result(t);
  const s = state(t.runDir);
  return { s, body: fs.readFileSync(s.publication.comment, 'utf8') };
}
function publishedLine(body, id) { return body.split('\n').find((l) => l.startsWith(`  ${id}: `)); }

test('Issue #326 AC1 the autofix driver publishes a fresh recorded reword in the CL-D126 non-carry form', () => {
  assert.ok(readText('skills/closed-loop-pr/driver/phases.js').includes(REWORD_LINE), 'the shared line carries the literal review.js publishes');
  assert.equal(readText('skills/closed-loop-pr/driver/autofix.js').split('disposition: recordedLine(x)').length - 1, 2, 'both settling sites of autofix.js publish through it');
  assert.ok(readText('skills/closed-loop-pr/driver/review.js').includes(REWORD_LINE), 'byte-identical to the review-only literal');
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  const r = result(t, { fresh: true, verdict: 'FIX BEFORE MERGE', ...minorReword, disposition: 'fixed' });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', 'a Minor reword is recorded and the run proceeds');
  const { s, body } = finish(t);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(publishedLine(body, 'CONV-7-X1'), '  CONV-7-X1: fixed (reword, recorded under CL-D85; judged afresh next run, CL-D126)', body);
});

test('Issue #326 AC1 an assigned finding a later gate returns as a recorded reword takes the same form', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true }); // CONV-7-X1, a criterion-anchored Major the writer corrects
  assert.equal(writerBatch(t, 'module.exports = 3;\n').status, 0);
  // On the new head convergence returns X1 as a body-only claim: a Minor reword, accepted as designed.
  const r = result(t, { ...minorReword, disposition: 'accepted-as-designed' });
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', r.stdout + r.stderr);
  const entry = state(t.runDir).ledger.find((e) => e.findingId === 'CONV-7-X1');
  assert.equal(entry.status, 'settled');
  assert.equal(entry.disposition, 'accepted-as-designed (reword, recorded under CL-D85; judged afresh next run, CL-D126)');
});

test('Issue #326 AC2 a later review-only run does not carry the line the autofix driver published', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true, verdict: 'FIX BEFORE MERGE', ...minorReword, disposition: 'fixed' });
  const { body } = finish(t);
  const line = publishedLine(body, 'CONV-7-X1');
  // A CL-D85 line beside it is carried, so the reader did read the round.
  const published = body.replace(line, `${line}\n  CONV-7-002: deferred (recorded under CL-D85)`);
  const t2 = review.setup();
  review.setFixture(t2, { prComments: [review.prComment(601, { body: published, author_association: 'OWNER' })] });
  assert.equal(review.nextRequest(review.drive(t2.start, t2.e).stdout)?.agent, 'tidd-convergence-reviewer');
  const payload = fs.readdirSync(t2.runDir).find((f) => f.startsWith('gate-payload-convergence-1-'));
  const settled = JSON.parse(fs.readFileSync(require('node:path').join(t2.runDir, payload), 'utf8').split('## Volatile envelope\n\n```json\n')[1].split('\n```')[0]).history.settled;
  assert.deepEqual(settled.map((x) => x.findingId), ['CONV-7-002'], 'only the CL-D85 line is carried');
});

test('Issue #326 AC3 a recorded finding that is not a reword keeps the CL-D85 line', () => {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  result(t, { fresh: true, verdict: 'MERGE', severity: 'Minor', anchoring: 'follow-up', disposition: 'deferred' });
  const { body } = finish(t);
  assert.equal(publishedLine(body, 'CONV-7-X1'), '  CONV-7-X1: deferred (recorded under CL-D85)', body);
});

test('Issue #326 AC4 the record, its clauses, the index and the re-pointed CL-D126 and CL-D110 lines agree', () => {
  const record = readText('contract/CL-D127.md');
  assert.match(record, /^## CL-D127 — /m);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D127.md](contract/CL-D127.md) — '), 'the index lists CL-D127');
  assert.match(record, /posts no conversation comment/);
  const clauses = JSON.parse(readText('contract/CL-D127.clauses.json')).clauses;
  assert.ok(clauses.some((c) => c.files.includes('skills/closed-loop-pr/driver/phases.js') && c.requires.includes(REWORD_LINE)), 'a clause pins the literal in the shared line');
  for (const file of ['contract/CL-D126.md', 'contract/CL-D110.md']) {
    const validity = readText(file).split('\n').find((l) => l.startsWith('*Validity and invalidation conditions:*'));
    assert.doesNotMatch(validity, /#50\b/, `${file} no longer defers to #50`);
    assert.match(validity, /CL-D127 later/, `${file} points forward to CL-D127`);
  }
  const d126 = JSON.parse(readText('contract/CL-D126.clauses.json')).clauses.find((c) => c.id === 'CL-D126-record');
  assert.ok(!d126.requires.some((r) => r.includes('still reads `(recorded under CL-D85)`')), 'the old autofix sentence is no longer pinned');
});
