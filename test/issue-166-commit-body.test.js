'use strict';

// Issue #166 (CL-D25). A commit body is a bullet list: line 1 is the subject, line 2 is blank, and every line from
// line 3 on is a bullet, one claim per bullet; trailers stay as trailers after a blank line. The owner decided this on
// 2026-09-21; the last body that does not follow it was committed on 2026-09-26, so the history check starts the next
// day. The shape check is a pure function, tested on fixtures, then run over this repository's own non-merge commits.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { repoRoot } = require('./helpers');

// The first instant from which every non-merge commit body follows the rule (JST, as the history is dated).
const CHECKED_FROM = '2026-09-27T00:00:00+09:00';
// The trailers this repository's history carries, plus Signed-off-by; an unknown key is not a trailer, so it fails as prose.
const TRAILER = /^(?:Co-Authored-By|Claude-Session|Signed-off-by): /i;
const BULLET = /^\s*- \S/;

// null when the message follows the rule, else the first line that breaks it and why.
function bodyShape(message) {
  const lines = String(message).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (!lines[0].trim()) return { line: 1, reason: 'the subject is empty' };
  // Trailers: the final block of `Key: value` lines after a blank line. The subject (`type: summary`) is never one.
  let end = lines.length;
  while (end > 1 && TRAILER.test(lines[end - 1])) end -= 1;
  if (end < lines.length) {
    if (lines[end - 1] !== '') return { line: end + 1, reason: 'trailers must follow a blank line' };
    end -= 1;
  }
  const body = lines.slice(0, end);
  if (body.length <= 1) return null; // a subject alone has no body to shape
  if (body[1] !== '') return { line: 2, reason: 'line 2 must be blank' };
  for (let i = 2; i < body.length; i += 1) {
    if (BULLET.test(body[i])) continue;
    if (body[i] !== '') return { line: i + 1, reason: `not a bullet: ${JSON.stringify(body[i].slice(0, 60))}` };
    // A blank line inside the list, or one before a line that is neither a bullet nor a recognised trailer.
    const next = body.findIndex((l, j) => j > i && l !== '');
    if (next !== -1 && !BULLET.test(body[next])) return { line: next + 1, reason: `not a bullet or a recognised trailer: ${JSON.stringify(body[next].slice(0, 60))}` };
    return { line: i + 1, reason: 'blank line inside the list' };
  }
  return null;
}

test('Issue #166 the shape check accepts a bullet-list body and refuses prose, a wrapped bullet, and a misplaced trailer', () => {
  const trailer = 'Co-Authored-By: Someone <someone@example.com>';
  for (const ok of [
    'fix: subject only (#1)',
    'fix: subject only (#1)\n',
    `fix: one bullet (#1)\n\n- the claim\n`,
    `fix: nested bullets (#1)\n\n- the claim\n  - its detail\n- another claim\n\n${trailer}\n`,
    `fix: measurements (#1)\n\n- RED: node --test test/x.test.js fails on the base\n- GREEN: node --test test/x.test.js passes\n\n${trailer}\nSigned-off-by: Someone <someone@example.com>\n`,
  ]) assert.equal(bodyShape(ok), null, JSON.stringify(ok));
  const bad = (message, line, reason) => { const r = bodyShape(message); assert.ok(r, JSON.stringify(message)); assert.equal(r.line, line, JSON.stringify(message)); assert.match(r.reason, reason); };
  // CONV-318-EMPTY-SUBJECT: an empty or blank line 1 is no subject, which the subject-only case must not cover.
  bad('', 1, /subject is empty/);
  bad('\n\n- a claim\n', 1, /subject is empty/);
  bad('   \n\n- a claim\n', 1, /subject is empty/);
  bad('fix: prose (#1)\n\nThe third line is prose.\n', 3, /not a bullet/);
  bad('fix: no blank line (#1)\n- a bullet on line 2\n', 2, /line 2 must be blank/);
  bad('fix: wrapped (#1)\n\n- a claim that wraps\n  onto a second line\n', 4, /not a bullet/);
  bad('fix: prose after bullets (#1)\n\n- a claim\n\nA paragraph after the list.\n', 5, /not a bullet or a recognised trailer/);
  bad(`fix: blank line inside the list (#1)\n\n- a claim\n\n- another\n\n${trailer}\n`, 4, /blank line inside the list/);
  bad('fix: measurements as prose (#1)\n\nRED: node --test test/x.test.js fails\nGREEN: node --test test/x.test.js passes\n', 3, /not a bullet/);
  bad(`fix: provenance glued to a trailer (#1)\n\nTests: node --test test/x.test.js\n${trailer}\n`, 4, /trailers must follow a blank line/);
  bad('fix: unknown trailer (#1)\n\n- a claim\n\nReviewed-by-2: someone\n', 5, /not a bullet or a recognised trailer/);
  bad('fix: prose that looks like a trailer (#1)\n\nThis-is: prose\n', 3, /not a bullet/);
  bad(`fix: trailer glued to the list (#1)\n\n- a claim\n${trailer}\n`, 4, /trailers must follow a blank line/);
  bad('fix: empty bullet (#1)\n\n- \n', 3, /not a bullet/);
});

test('Issue #166 the driver\'s correction commit message takes the shape', () => {
  const { writerMessage } = require('../skills/closed-loop-pr/driver/writer');
  const message = writerMessage({ issueNumber: 7, validationCommands: [['npm', 'test']] }, [{ findingId: 'ADV-7-X', record: { correction: 'narrow the regex\nto the documented form' } }], 'fix(bench): narrow the regex');
  assert.equal(bodyShape(message), null, message);
  assert.match(message, /^fix\(bench\): narrow the regex \(#7\)\n\n- ADV-7-X: narrow the regex to the documented form\n- Validation before this commit/);
});

test('Issue #166 every non-merge commit of this repository from the checked date on has a bullet-list body', () => {
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = git('log', '--no-merges', `--since=${CHECKED_FROM}`, '--format=%H%x00%B%x01');
  const commits = log.split('\x01').map((r) => r.replace(/^\n+/, '')).filter((r) => r.includes('\x00')).map((r) => { const [oid, body] = r.split('\x00', 2); return { oid, body }; });
  const shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
  // A shallow checkout reaches only part of the history; what it reaches is still checked.
  assert.ok(commits.length > 0 || shallow, 'no commit since the checked date was reachable');
  const offenders = commits.map((c) => ({ ...c, shape: bodyShape(c.body) })).filter((c) => c.shape);
  assert.deepEqual(offenders.map((c) => `${c.oid.slice(0, 7)} line ${c.shape.line}: ${c.shape.reason}`), [], `${offenders.length} of ${commits.length} commit bodies since ${CHECKED_FROM} are not bullet lists`);
});

test('Issue #166 CL-D25 states the shape, its clauses pin the record and this check, and CI fetches the history the check reads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const record = read('contract/CL-D25.md');
  const SHAPE = 'Its body is a bullet list (#166): line 1 is the subject, line 2 is blank, and every line from line 3 on is a bullet, one claim per bullet, with the RED and GREEN measurements as their own bullets, each naming its exact command; trailers stay as trailers after a blank line.';
  const CHECK = "The driver's correction commits take that shape, and this repository's own non-merge commits are checked for it from 2026-09-27, the day after the last non-conforming body.";
  assert.ok(record.includes(`${SHAPE} ${CHECK}`), 'CL-D25 states the shape and the check');
  assert.ok(record.includes('The commit convention is not machine-checked on a consumer repository, except the exact-autofix correction subject, which CL-D116 checks.'));
  const clauses = JSON.parse(read('contract/CL-D25.clauses.json')).clauses;
  const shape = clauses.find((c) => c.id === 'CL-D25-commit-shape'), check = clauses.find((c) => c.id === 'CL-D25-commit-check');
  assert.deepEqual(shape && { files: shape.files, requires: shape.requires }, { files: ['contract/CL-D25.md'], requires: [SHAPE, CHECK] });
  assert.deepEqual(check && { files: check.files, requires: check.requires }, { files: ['test/issue-166-commit-body.test.js'], requires: [`const CHECKED_FROM = '${CHECKED_FROM}';`, `const BULLET = ${BULLET};`, `const TRAILER = ${TRAILER};`] });
  assert.match(record.split('\n')[1], /^\*\*Clauses:\*\* CL-D25, CL-D25-minimum, CL-D25-commit, CL-D25-commit-publish, CL-D25-commit-record, CL-D25-commit-shape, CL-D25-commit-check$/);
  // actions/checkout fetches one commit unless told otherwise; the test job reads the history.
  assert.match(read('.github/workflows/test.yml'), /\n  test:\n    runs-on: ubuntu-latest\n(?:.*\n)*?      - uses: actions\/checkout@v7\n        with:\n          fetch-depth: 0(?: #[^\n]*)?\n/);
});

module.exports = { bodyShape, CHECKED_FROM };
