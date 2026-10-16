'use strict';

// Issue #270 (#249 B1, CL-D112): since CL-D111 no run reads `references/helper-map.md` as guidance (both drivers still hash
// it into contractInput), and the last pull request of #249 deletes it. Before that, every clause pin and every rule-stating test read moves off the file to where the rule
// lives now: the packaged CLI's operation table, the helper or driver code that enforces the rule, or the record's own
// sentence. The file itself was unchanged, so the pull request was behaviour-neutral; #249 later deleted it (CL-D119).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath, readText, readContract, manifestSources, sectionOf } = require('./helpers');

const MAP = 'skills/closed-loop-pr/references/helper-map.md';
// The rule-stating reads (AC2); the structural reads went with the map (#249, CL-D119).
const RULE_TESTS = ['issue-159-gate-launch-cwd', 'issue-161-terminal-cleanup', 'issue-169-post-push-revalidation', 'issue-179-workspace-verify-cwd', 'issue-181-commit-identity', 'issue-184-schema-in-agents', 'issue-185-guard-after-push', 'issue-188-gate-payload-file'];

test('Issue #270 no clause pin names references/helper-map.md', () => {
  for (const source of manifestSources()) {
    for (const clause of JSON.parse(readText(source)).clauses) assert.equal(clause.files.some((f) => f.endsWith('references/helper-map.md')), false, `${source} ${clause.id} still pins the map`);
  }
});

test('Issue #270 the rule-stating tests read the code or the record, not the map, and the map is gone', () => {
  for (const name of RULE_TESTS) {
    const text = readText(`test/${name}.test.js`);
    assert.equal(text.includes('references/helper-map.md'), false, `${name} still reads the map`);
    // Pre-push sweep: readAutofixProcedure() joins autofix.md and the map, so a rule-stating test may not read through it either.
    assert.equal(text.includes('readAutofixProcedure'), false, `${name} still reads the map through readAutofixProcedure()`);
    // Round 1 CONV-271-TEST-TITLES-001: a title names the surface the body now inspects, not the map.
    for (const title of text.match(/^test\('Issue #\d+ [^']*'/gm) || []) assert.doesNotMatch(title, /\b(helper )?map\b/, `${name}: ${title}`);
  }
  // #249 C2 (CL-D119) deleted the map, so no test can read it, and AUTHORITY_FILES no longer measures it.
  assert.equal(fs.existsSync(repoPath(MAP)), false, 'the map is deleted');
  assert.equal(readText('test/helpers.js').includes("'skills/closed-loop-pr/references/helper-map.md',"), false, 'AUTHORITY_FILES no longer measures the map');
});

test('Issue #270 the map is deleted and neither driver reads it into contractInput', () => {
  assert.equal(fs.existsSync(repoPath(MAP)), false);
  for (const driver of ['review', 'autofix']) assert.equal(readText(`skills/closed-loop-pr/driver/${driver}.js`).includes("'skills/closed-loop-pr/references/helper-map.md'"), false, `${driver}.js no longer reads the map`);
});

test('Issue #270 CL-D112 records the repoint and CL-D83 names it', () => {
  const record = sectionOf(readContract(), '## CL-D112 — The clause pins of the helper map move to the code and the records');
  assert.ok(record, 'CL-D112 is in the contract');
  assert.match(record, /issues\/249#issuecomment-6105250786/);
  assert.match(record, /CL-D83-map/);
  assert.match(record, /retired/);
  // Round 1 CONV-271-AC4-RECORD-001: the record distinguishes reading the map as guidance from hashing it into contractInput.
  assert.match(record, /Since CL-D111 no run reads `references\/helper-map\.md` as guidance; both drivers still hash it into `contractInput` until the last pull request of #249 deletes it\./);
  const index = readText('CONTRACT.md');
  assert.ok(index.indexOf('contract/CL-D112.md') < index.indexOf('contract/CL-D111.md'), 'the index lists CL-D112 before CL-D111');
  assert.match(sectionOf(readContract(), '## CL-D83 — The packaged helper invocation map is its own reference'), /#249 later moved every pin off the map \(CL-D112\)/);
});
