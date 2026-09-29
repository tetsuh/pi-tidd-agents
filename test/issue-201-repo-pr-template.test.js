'use strict';

// Issue #201 (CL-D95) — CL-D67 fixed a three-part pull-request body and said nothing about a repository that
// mandates its own template. On tetsuh/sitos the two could not both hold, and Sol stopped sitos#187 on the layout
// alone while sitos#185, with the same template, reached MERGE_READY. A repository's own template now governs the
// sections; CL-D67's per-head rule still applies inside it, and layout alone is never a finding.
//
// TDD provenance: pre-implementation contract RED (not behavioural RED: every assertion inspects artifact text),
// `node --test test/issue-201-repo-pr-template.test.js` at 0 passes / 3 failures before the sentences and the record.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, sectionOf } = require('./helpers');

const PRECEDENCE = 'Where the target repository has a pull-request template of its own — a template file GitHub applies, such as `.github/pull_request_template.md`, or a template its `CONTRIBUTING.md` or `AGENTS.md` requires — that template governs the body\'s sections instead of the three parts above; the rules below still apply wherever the template leaves the wording to the author, and a body\'s section layout alone is never a finding (CL-D95).';
const GATE = 'A pull-request body\'s section layout alone is never a finding; its claims are judged for accuracy against the head (CL-D95).';

test('Issue #201 a repository\'s own pull-request template governs the body\'s sections', () => {
  const template = sectionOf(readText('skills/closed-loop-pr/SKILL.md'), '### PR body template (CL-D67)');
  assert.ok(template, 'the PR body template subsection must exist');
  assert.ok(template.includes(PRECEDENCE), 'the template states the repository template\'s precedence');
  // The three-part shape and the per-head rule stay, word for word: CL-D95 narrows where the shape applies.
  assert.ok(template.includes('A pull-request body under this workflow carries three parts and nothing else'));
  assert.ok(template.includes('Per-head measurements — run counts, guard bytes, authority headroom — live in commit messages'));
  assert.ok(template.indexOf(PRECEDENCE) > template.indexOf('followed at most by one tooling attribution footer.'), 'the precedence follows the shape it narrows');
});

test('Issue #201 every gate reads that a body\'s layout alone is never a finding', () => {
  // SKILL.md's template section reaches no gate payload; the every-gate block reaches all of them (CL-D2).
  const block = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Every-gate invariant payload block (CL-D2)');
  assert.ok(block, 'the every-gate block must exist');
  assert.ok(block.includes(GATE), 'the every-gate block states the rule');
});

test('Issue #201 CL-D95 records the precedence and what it leaves unchanged', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D95 — A repository\'s own pull-request template governs the body\'s sections');
  assert.ok(record, 'CL-D95 must exist');
  for (const field of ['*Decision ID:* CL-D95', '*Kind:* contract', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) assert.ok(record.includes(field), `CL-D95 must carry ${field}`);
  assert.ok(record.includes('issues/201#issuecomment-5900278630'), 'the owner choice is cited');
  assert.ok(record.includes('Recording per repository which body contract applies is deferred'), 'proposal 3 is recorded as deferred');
  // The records CL-D95 narrows say so where a reader of either finds the three parts.
  const contract = readText('CONTRACT.md');
  assert.ok(sectionOf(contract, '## CL-D67 — Pull-request bodies carry no per-head facts').includes('CL-D95 later let a repository\'s own pull-request template govern the sections'));
  assert.ok(sectionOf(contract, '## CL-D85 — Wording-only Minors do not stop a run').includes('CL-D95 later let a repository\'s own pull-request template govern the body\'s sections'));
});
