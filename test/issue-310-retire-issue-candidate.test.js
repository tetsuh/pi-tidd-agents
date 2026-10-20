'use strict';

// Issue #310 (CL-D123), step 4 of #190. The verification of step 3 found that no packaged launch could carry a CL-D31
// candidate bundle, and the owner retired the route instead of extending the builder
// (issues/190#issuecomment-6252295881): a gate finding stops the round, the owner revises the Issue, and a fresh run
// reviews it. The Issue root publishes nothing, and CL-D31 and CL-D32 are history. #312 (CL-D124) later removed
// `candidateIdentity` from the version-2 Issue schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKILL = 'skills/closed-loop-issue/SKILL.md';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const clausesOf = (id) => JSON.parse(read(`contract/${id}.clauses.json`)).clauses;

test('Issue #310 the Issue Skill has no candidate route and publishes nothing', () => {
  const skill = read(SKILL);
  for (const gone of ['## Owner-gated Issue candidate publication', '### Combined scope-freeze decision transaction', '### Candidate phase and immutable bundle', 'CL-D31', 'CL-D32', 'snapshot-C', 'Snapshot-C', 'candidate phase', 'candidate-publication']) {
    assert.equal(skill.includes(gone), false, `the Skill still names ${gone}`);
  }
  assert.ok(skill.includes('`/tidd-issue` is review-and-draft only: it never edits the Issue or posts to GitHub (CL-D123).'));
  assert.ok(skill.includes('When a round stops, the owner revises the Issue, and a fresh run reviews the revised text.'));
  assert.ok(skill.includes('Its `publication_grant` field is always `not-applicable`: the Issue root grants no publication (CL-D123).'));
  // 34,904 bytes at ecec912, the merge of PR #309.
  assert.ok(fs.statSync(path.join(ROOT, SKILL)).size <= 34904 - 18000);
});

test('Issue #310 CL-D31 and CL-D32 are historical and pin only their own records', () => {
  for (const id of ['CL-D31', 'CL-D32']) {
    const record = read(`contract/${id}.md`);
    assert.match(record.split('\n')[0], /^## .+ \(historical; retired by CL-D123\)$/);
    assert.match(record, /Retired by CL-D123 \(#310, step 4 of #190\)/);
    for (const clause of clausesOf(id)) assert.deepEqual(clause.files, [`contract/${id}.md`], clause.id);
    assert.match(read('CONTRACT.md'), new RegExp(`\\[contract/${id}\\.md\\]\\(contract/${id}\\.md\\) — .+ \\(historical; retired by CL-D123\\)\\n`));
  }
  // The records that stated the route as current say it is retired.
  for (const file of ['AC-REVIEW-ONLY', 'AC-GRANT', 'AC-AUTOFIX', 'CL-D28', 'CL-D16', 'CL-D13', 'CL-D121', 'CL-D62']) {
    assert.match(read(`contract/${file}.md`), /\n#310 later retired the Issue candidate route \(CL-D123\): the Issue root publishes nothing\.\n$/, file);
  }
  assert.match(read('contract/DEC-I15-ROUND-BUDGET-001.md').split('\n')[0], / \(historical; retired by CL-D123\)$/);
  for (const file of ['test/issue-candidate-publication.test.js', 'test/issue-scope-freeze-candidate.test.js']) assert.equal(fs.existsSync(path.join(ROOT, file)), false, file);
});

test('Issue #310 the shared references, the README and the driver describe no Issue candidate route', () => {
  const contract = read('skills/closed-loop-shared/references/gate-contract.md');
  assert.equal(/Issue candidate|CL-D32/.test(contract), false);
  assert.equal(read('skills/closed-loop-shared/references/records.md').includes('CL-D31/CL-D32'), false);
  const readme = read('README.md');
  assert.equal(/CL-D31|CL-D32|Owner-gated Issue candidate publication|Combined scope-freeze/.test(readme), false);
  assert.ok(readme.includes('`/tidd-issue <issue-ref>` and `/skill:closed-loop-issue <issue-ref>` are review-and-draft only: they never edit the Issue or post to GitHub (CL-D123).'));
  // The pull-request Skill describes no Issue publication either (the scan issue-candidate-publication held).
  assert.doesNotMatch(read('skills/closed-loop-pr/SKILL.md'), /Issue PATCH.*POST.*CL-D30/s);
  const driver = read('skills/closed-loop-pr/driver/issue.js');
  assert.equal(driver.includes('CL-D31'), false);
  assert.ok(driver.includes('the Issue root posts nothing (CL-D123).'));
});

test('Issue #310 CL-D123 records the decision', () => {
  const record = read('contract/CL-D123.md');
  assert.match(record, /^## CL-D123 — The Issue root has no candidate publication route\n\*\*Clauses:\*\* CL-D123-record, CL-D123-skill\n/);
  assert.match(record, /issues\/190#issuecomment-6252295881/);
  assert.deepEqual(clausesOf('CL-D123').map((c) => c.id), ['CL-D123-record', 'CL-D123-skill']);
  assert.match(read('CONTRACT.md'), /- \[contract\/CL-D123\.md\]\(contract\/CL-D123\.md\) — The Issue root has no candidate publication route\n/);
});
