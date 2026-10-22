'use strict';

// Issue #320: before the first release the README puts the user-facing sections first and the contract-bound
// paragraphs last, under one reference heading, in their current order and wording. Seventeen clauses pin 61 README
// strings and other tests read three sections by heading; those checks stay where they are, so this file asserts only
// the new structure (AC1), the installation and requirement sentences (AC3, AC4), the quick start (AC5) and the
// round-output section with the driver's own BLOCKED reasons (AC6).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readText, sectionOf } = require('./helpers');

const README = () => readText('README.md');
const HEADINGS = ['Quick start', 'Requirements', 'Installation', 'Included agents', 'Commands', 'What a round produces', 'Standalone usage', 'Roles, models, and overrides', 'Design', 'License', 'Reference (contract notes)'];
const INSTALL_GIT = 'pi install git:github.com/tetsuh/pi-tidd-agents';
// [what the README quotes, what the driver source holds, the source file]: `N`, `X` and `Y` stand for template values.
const BLOCKED_REASONS = [
  ['the pull request is open (draft)', "the pull request is ${pull.state}${pull.draft ? ' (draft)' : ''}", 'skills/closed-loop-pr/driver/review.js'],
  ['the checkout is at X, not the public head Y', 'the checkout is at ${local}, not the public head ${headOid}', 'skills/closed-loop-pr/driver/run.js'],
  ['the PR body names no `Closes #N` issue and no --issue was given', 'the PR body names no `Closes #N` issue and no --issue was given', 'skills/closed-loop-pr/driver/review.js'],
  ['issue #N has no Acceptance criteria section with at least one criterion', 'issue #${s.issueNumber} has no Acceptance criteria section with at least one criterion', 'skills/closed-loop-pr/driver/review.js'],
  ['the diff is not valid UTF-8, so no gate can receive it exactly', 'the diff is not valid UTF-8, so no gate can receive it exactly', 'skills/closed-loop-pr/driver/review.js'],
];
const STATES = ['MERGE_READY', 'WAITING_FOR_OWNER', 'ROUND_LIMIT_REACHED', 'WAITING_EXTERNAL_REVIEW', 'BLOCKED'];
// Every listed string appears in `text`, each after the one before it.
function inOrder(text, items, label) {
  let at = -1;
  for (const item of items) {
    const next = text.indexOf(item, at + 1);
    assert.ok(next > at, `${label}: ${JSON.stringify(item)} is missing or out of order`);
    at = next;
  }
}

test('Issue #320 AC1 the README headings run user-facing first and the contract notes last', () => {
  const readme = README();
  const h2 = readme.split('\n').filter((line) => /^## /.test(line)).map((line) => line.slice(3).trim());
  assert.deepEqual(h2, HEADINGS);
  const roles = sectionOf(readme, '## Roles, models, and overrides');
  assert.ok(roles && roles.includes('\n### Roles and deployment (CL-D59)\n'), 'Roles and deployment sits under Roles, models, and overrides');
  const reference = sectionOf(readme, '## Reference (contract notes)');
  assert.ok(reference, 'the reference section exists');
  for (const sub of ['### How a round runs (CL-D104)', '### Autofix']) assert.ok(reference.includes(`\n${sub}\n`), `${sub} sits under the reference section`);
});

test('Issue #320 AC3 installation names this repository and explains what a tag is', () => {
  const install = sectionOf(README(), '## Installation');
  assert.ok(install.includes(INSTALL_GIT));
  assert.equal(README().includes('After the repository is published, it can also be installed from Git:'), false);
  assert.equal(README().includes('github.com/<owner>/'), false);
  assert.ok(install.includes('Without a ref, `pi install git:` installs the default branch; append `@<tag>` to pin a release tag.'));
});

test('Issue #320 AC4 requirements keep the minimum and state the versions the suite ran against', () => {
  const requirements = sectionOf(README(), '## Requirements');
  assert.ok(requirements.includes('**0.70.0 or newer**'));
  assert.ok(requirements.includes('do not assume support for older versions'));
  assert.ok(requirements.includes('the test suite was run against pi-subagents 0.70.0 and 0.78.0'));
});

test('Issue #320 AC5 the quick start walks from install to publication', () => {
  const quick = sectionOf(README(), '## Quick start');
  assert.ok(quick, 'the quick start exists');
  inOrder(quick, ['pi install npm:pi-subagents', INSTALL_GIT, '{"validate": [["node", "--test"]]}', '/tidd-pr 42', 'bash "<path>/publish-review.sh"'], 'quick start');
  for (const name of ['review-comment.md', 'publish-review.sh']) assert.ok(quick.includes(`\`${name}\``), `the quick start names ${name}`);
  assert.ok(quick.includes('The driver never runs the publication script'));
});

test('Issue #320 AC6 the round-output section quotes the driver', () => {
  const section = sectionOf(README(), '## What a round produces');
  assert.ok(section, 'the section exists');
  for (const token of ['FINISHED comment=', ...STATES]) assert.ok(section.includes(`\`${token}\``), `${token} is named`);
  for (const [quoted, printed, file] of BLOCKED_REASONS) {
    assert.ok(section.includes(`\n${quoted}\n`), `the README quotes ${JSON.stringify(quoted)}`);
    assert.ok(readText(file).includes(printed), `${file} prints ${JSON.stringify(printed)}`);
  }
  // The status string is not a BLOCKED reason of the review driver: it is reported in the block and named as such.
  assert.ok(section.includes('`no validation commands configured` in the status block'));
  assert.ok(readText('skills/closed-loop-pr/driver/review.js').includes("['no validation commands configured']"));
});
