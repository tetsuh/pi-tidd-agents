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
  assert.match(section, /`OPERATOR_CHECKOUT_UNCHANGED@O` and `CLEAN@H` are freshly re-proved/);
  assert.match(section, /the budget is exactly one per operation and phase/);
  assert.match(section, /A second failure of the same operation and phase is terminal/);
  assert.match(section, /Recovery never launches a second writer, repeats a provider mutation, or re-enters a phase after Luna starts/);

  // Every post-writer phase must appear in the matrix as recoverable: none.
  const rows = section.split('\n').filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line) && !/\| Phase \|/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  assert.ok(rows.length >= 4, `the phase matrix must cover every phase, found ${rows.length} rows`);
  const postWriter = rows.find(([phase]) => /Luna guards, commit, push, reply, final policy, summary/.test(phase));
  assert.ok(postWriter, 'the matrix must name the post-writer phases');
  assert.equal(postWriter[1], 'none', 'no post-writer phase may be recoverable');
  assert.equal(postWriter[2], 'every failure');
  const gateResult = rows.find(([phase]) => /^Gate result$/.test(phase));
  assert.ok(gateResult && gateResult[1] === 'none', 'a gate result failure must stay terminal');
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
  assert.match(section, /^\*\*Clauses:\*\* CL-D39-stop, CL-D39-recovery$/m);
  assert.match(section, /^\*Decision ID:\* CL-D39$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#34/);
  assert.match(section, /Option B for exact PR `autofix`/);
  assert.match(section, /Issue and PR review-only keep their existing single malformed-verdict retry unchanged/);
  assert.match(section, /No shared prose changes, and no shared sentence gains a mode exception/);
  assert.match(section, /Removing the mode-ownership statement from the shared gate contract invalidates the no-fork basis recorded here/);
  // The corrected evidence stays recorded: the narrowing is partial, not closing.
  assert.match(section, /rejects unknown fields without preventing selection of the wrong known field/);
  assert.match(section, /all accept an `oid` so a same-typed cross-domain mix-up remains reachable/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D39').map((clause) => clause.id).sort(),
    ['CL-D39-recovery', 'CL-D39-stop'],
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
