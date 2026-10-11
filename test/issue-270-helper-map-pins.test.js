'use strict';

// Issue #270 (#249 B1, CL-D112): since CL-D111 no run reads `references/helper-map.md`, and the last pull request of
// #249 deletes it. Before that, every clause pin and every rule-stating test read moves off the file to where the rule
// lives now: the packaged CLI's operation table, the helper or driver code that enforces the rule, or the record's own
// sentence. The file itself is unchanged, so the pull request is behaviour-neutral.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { repoPath, readText, readContract, manifestSources, sectionOf } = require('./helpers');

const MAP = 'skills/closed-loop-pr/references/helper-map.md';
// The rule-stating reads (AC2); the structural reads stay for the deletion pull request.
const RULE_TESTS = ['issue-159-gate-launch-cwd', 'issue-161-terminal-cleanup', 'issue-169-post-push-revalidation', 'issue-179-workspace-verify-cwd', 'issue-181-commit-identity', 'issue-184-schema-in-agents', 'issue-185-guard-after-push', 'issue-188-gate-payload-file'];
const STRUCTURAL_TESTS = ['package', 'issue-73-authority-budget', 'issue-110-derived-vocabulary', 'issue-164-map-split', 'issue-196-review-driver-2'];

test('Issue #270 no clause pin names references/helper-map.md', () => {
  for (const source of manifestSources()) {
    for (const clause of JSON.parse(readText(source)).clauses) assert.equal(clause.files.some((f) => f.endsWith('references/helper-map.md')), false, `${source} ${clause.id} still pins the map`);
  }
});

test('Issue #270 the rule-stating tests read the code or the record, not the map; the structural reads stay', () => {
  for (const name of RULE_TESTS) assert.equal(readText(`test/${name}.test.js`).includes('references/helper-map.md'), false, `${name} still reads the map`);
  for (const name of STRUCTURAL_TESTS) assert.ok(readText(`test/${name}.test.js`).includes('references/helper-map.md'), `${name} is the deletion pull request's and still reads the map`);
  assert.ok(readText('test/helpers.js').includes("'skills/closed-loop-pr/references/helper-map.md',"), 'AUTHORITY_FILES still measures the map until the deletion');
});

test('Issue #270 the map is byte-identical and the drivers still read it into contractInput', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(repoPath(MAP))).digest('hex'), 'da1528b9cfadca6e6b375f118364e8d06c3566cb1d9d4f301d13f820ea78f357');
  for (const driver of ['review', 'autofix']) assert.ok(readText(`skills/closed-loop-pr/driver/${driver}.js`).includes("'skills/closed-loop-pr/references/helper-map.md'"), `${driver}.js still reads the map into contractInput`);
});

test('Issue #270 CL-D112 records the repoint and CL-D83 names it', () => {
  const record = sectionOf(readContract(), '## CL-D112 — The clause pins of the helper map move to the code and the records');
  assert.ok(record, 'CL-D112 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6105250786/);
  assert.match(record, /CL-D83-map/);
  assert.match(record, /retired/);
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D112.md') < index.indexOf('contract/CL-D111.md'), 'the index lists CL-D112 before CL-D111');
  assert.match(sectionOf(readContract(), '## CL-D83 — The packaged helper invocation map is its own reference'), /#249 later moved every pin off the map \(CL-D112\)/);
});
