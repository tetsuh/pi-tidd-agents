'use strict';

// Issue #337: CL-D131 stops a review-only run after Sol on a convergence FIX before the cap, while at the cap CL-D62's
// hand-off lets Sol's confirmation of the assigned findings carry the run on to Terra. The owner kept that difference
// (CONV-335-CAP-ORDER); the record's Rationale now says why in one sentence, and the CL-D131-record clause requires it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readText, readContract, sectionOf } = require('./helpers');

const SENTENCE = "That is also why the two sides of the cap differ: Sol's confirmation settles only an assigned finding, so before the cap, convergence's findings, carried as history, stay open for the author whatever Sol returns, while at the cap CL-D62 has the stage fail open toward the authority and its assigned findings no longer hold the run once Sol confirms them.";

test('Issue #337 AC1 the CL-D131 Rationale says in one sentence why the two sides of the cap differ', () => {
  const record = sectionOf(readContract(), '## CL-D131 — Review-only runs Sol after a convergence FIX BEFORE MERGE with no Blocker');
  assert.ok(record, 'CL-D131 is in the contract');
  const rationale = record.split('\n').filter((line) => line.startsWith('*Rationale:*'));
  assert.equal(rationale.length, 1, 'the record has one Rationale line');
  assert.ok(rationale[0].includes(SENTENCE), 'the Rationale carries the sentence');
  assert.equal(readText('contract/CL-D131.md').split(SENTENCE).length, 2, 'the sentence appears once');
});

test('Issue #337 AC2 the CL-D131-record clause requires the sentence', () => {
  const clause = JSON.parse(readText('contract/CL-D131.clauses.json')).clauses.find((c) => c.id === 'CL-D131-record');
  assert.deepEqual(clause.files, ['contract/CL-D131.md']);
  assert.ok(clause.requires.includes(SENTENCE), 'CL-D131-record requires the sentence');
});
