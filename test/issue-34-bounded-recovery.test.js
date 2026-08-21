'use strict';

// Issue #34 / CL-D39: exact PR autofix gains one bounded recovery for a deterministic local
// tooling failure before any Luna task exists. Two properties matter and are pinned here:
// the recovery is confined to the pre-writer region, and it is expressed only in the mode
// reference that already owns retry behaviour, so no shared prose forks and no shared
// sentence gains a mode exception.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson } = require('./helpers');

const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const RECORDS = 'skills/closed-loop-shared/references/records.md';
const REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const ISSUE_SKILL = 'skills/closed-loop-issue/SKILL.md';
const CLI = 'skills/closed-loop-pr/helpers/cli.js';
const CONTRACT = 'CONTRACT.md';
const RECOVERY_HEADING = '### Bounded pre-writer recovery (CL-D39)';

function sectionOf(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const depth = heading.match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const match = lines[end].match(/^(#+)\s/);
    if (match && match[1].length <= depth) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('Issue #34 the recovery is bounded to the pre-writer region', () => {
  const section = sectionOf(readText(PR_AUTOFIX), RECOVERY_HEADING);
  assert.ok(section, `${PR_AUTOFIX} must own the bounded recovery rule`);
  assert.match(section, /One recovery is permitted for a deterministic local tooling failure/);
  assert.match(section, /no Luna task, commit, push, or reply exists/);
  assert.match(section, /`OPERATOR_CHECKOUT_UNCHANGED@O` and `AUTOFIX_WORKSPACE@H` are freshly re-proved/);
  // CLEAN@H was retired by Issue #42 and is not a live invariant; it must not return.
  assert.doesNotMatch(section, /CLEAN@H/, 'the recovery must bind to live invariants only');
  assert.match(section, /the budget is exactly one per operation and phase/);
  assert.match(section, /A second failure of the same operation and phase is terminal/);
  assert.match(section, /Recovery never launches a second writer, repeats a provider mutation, or re-enters a phase after Luna starts/);

  // The mapping must be closed over every Issue #34 failure, each with a canonical key, a
  // prevalidated replacement, an outcome, and explicit evidence handling.
  assert.match(section, /one canonical `operation@phase` key/);
  assert.match(section, /The replacement retains that key, so a replacement failure is the second failure of the same key and is terminal/);
  assert.match(section, /preserves evidence already proved unchanged and invalidates only the failed operation's own output/);

  const rows = section.split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/\| Failure \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.equal(rows.length, 5, `the mapping must cover all five Issue #34 failures, found ${rows.length}`);
  for (const row of rows) assert.equal(row.length, 5, `each row needs failure, key, replacement, outcome, evidence: ${row.join(' | ')}`);
  const byKey = new Map(rows.map((row) => [row[1], row]));
  assert.deepEqual([...byKey.keys()].sort(), [
    '`envelope_read@normalize`', '`fingerprint@normalize`', '`manifest_compare@after_staging`',
    '`report_verify@normalize`', '`validation_harness@preflight`',
  ], 'every failure needs its own canonical key');
  // The post-writer failure is the one that must stay terminal, with no replacement.
  const manifest = byKey.get('`manifest_compare@after_staging`');
  assert.equal(manifest[2], 'none', 'a post-writer failure has no prevalidated replacement');
  assert.equal(manifest[3], 'terminal');
  for (const [key, row] of byKey) {
    if (key === '`manifest_compare@after_staging`') continue;
    assert.equal(row[3], 'recoverable', `${key} should be recoverable`);
    assert.notEqual(row[2], 'none', `${key} needs a concrete prevalidated replacement`);
    assert.ok(row[4].length > 0, `${key} must state its evidence handling`);
  }
  // Every phase not in the mapping stays terminal, named explicitly.
  assert.match(section, /Every other phase is terminal for every failure/);
  for (const phase of ['preflight and gate launch', 'a gate result', 'normalization', 'Luna guards, commit, push, reply, final policy, and summary']) {
    assert.ok(section.includes(phase), `the terminal sweep must name ${phase}`);
  }
});

test('Issue #34 the stop rule keeps its wording and names the single exception', () => {
  const text = readText(PR_AUTOFIX);
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop, except for the one CL-D39 recovery below\./);
});

test('Issue #34 no shared prose forks and no shared sentence gains a mode exception', () => {
  // The shared layer already delegates retry behaviour, so the mode reference can own the
  // recovery outright. These pins fail if a future change instead conditionalises shared text.
  const shared = readText(GATE_CONTRACT);
  assert.match(shared, /Ordinary workflow-specific retry and fail-stop behavior belongs to the selected owning workflow or mode reference; shared policy does not grant a retry, publication, or mutation\./,
    'the shared delegation is what makes the mode-local rule possible');
  assert.match(shared, /Workflow-specific candidate, retry, extension, and resume boundaries remain authoritative in their owning files\./);
  assert.match(shared, /Tool, provider, startup, stale-target, and unparsable-verdict failures \*\*do not consume a round\*\*\./,
    'shared round accounting must stay compatible with a counter-free recovery');

  for (const file of [GATE_CONTRACT, RECORDS]) {
    const text = readText(file);
    assert.doesNotMatch(text, /CL-D39/, `${file} must not carry the mode-specific recovery decision`);
    assert.doesNotMatch(text, /exact autofix[^.]*recover/i, `${file} must not gain an autofix exception`);
  }
  // The other two modes keep their own rule, untouched and unqualified.
  for (const file of [REVIEW_ONLY, ISSUE_SKILL]) {
    assert.match(readText(file), /retry the invocation once, and if it fails again report `BLOCKED`/, `${file} must keep its existing single retry`);
    assert.doesNotMatch(readText(file), /CL-D39/, `${file} must not be conditionalised by the autofix decision`);
  }
});

test('Issue #34 CL-D39 records the recovery and the no-fork basis', () => {
  const section = sectionOf(readText(CONTRACT), '## CL-D39 — Exact autofix gains one bounded pre-writer recovery');
  assert.ok(section, 'CL-D39 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D39-stop, CL-D39-recovery, CL-D39-baseline$/m);
  assert.match(section, /^\*Decision ID:\* CL-D39$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#34/);
  assert.match(section, /Option B for exact PR `autofix`/);
  assert.match(section, /Issue and PR review-only keep their existing single malformed-verdict retry unchanged/);
  assert.match(section, /No shared prose changes, and no shared sentence gains a mode exception/);
  assert.match(section, /Removing the mode-ownership statement from the shared gate contract invalidates the no-fork basis recorded here/);
  // The corrected evidence stays recorded: the narrowing is partial, not closing.
  assert.match(section, /rejects unknown fields without preventing selection of the wrong known field/);
  assert.match(section, /all accept an `oid` so a same-typed cross-domain mix-up remains reachable/);
  // The retired invariant and the funded baseline are both recorded.
  assert.match(section, /`CLEAN@H` is not used because Issue #42 retired it/);
  assert.match(section, /raises the six-file authority baseline from 112,000 to 116,000 bytes/);
  assert.match(section, /no trim could fund it/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D39').map((clause) => clause.id).sort(),
    ['CL-D39-baseline', 'CL-D39-recovery', 'CL-D39-stop'],
  );
});

test('Issue #34 the partial-narrowing evidence in the record still matches the code', () => {
  // CL-D39 cites these as reasons the case is not closed; if the code changes, the record
  // must be revisited rather than silently drifting.
  const table = readText(CLI).match(/const SCHEMAS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(table, 'could not locate the CLI schema table');
  const domains = new Map();
  for (const [, operation, required] of table[1].matchAll(/^\s*(fingerprint_[a-z0-9_]+):\s*\{\s*required:\s*\[([^\]]*)\]/gm)) {
    domains.set(operation, (required.match(/'([^']+)'/g) || []).map((field) => field.slice(1, -1)));
  }
  const sharingOid = [...domains.entries()].filter(([, fields]) => fields.length === 1 && fields[0] === 'oid').map(([name]) => name).sort();
  assert.deepEqual(sharingOid, ['fingerprint_pr_base', 'fingerprint_pr_head', 'fingerprint_pr_tree'],
    'the record cites these three as sharing an oid input; a change here invalidates that rationale');
  assert.match(readText(PR_AUTOFIX), /Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL/);
});
