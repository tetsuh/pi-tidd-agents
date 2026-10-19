'use strict';

// Issue #308 (CL-D122), step 3 of #190. Step 2b moved the Issue review-and-draft round into the packaged driver, and
// step 1 had already put every Issue gate launch through `build_gate_launch` (CL-D120). The Issue Skill still told the
// parent to compose payloads, hash `issue_spec`, check the target kind, read results and draft the status block on
// that round; each such passage now names the driver or helper that owns it. #310 (CL-D123) later retired the candidate
// phase the passages were once scoped against, so each now names its owner alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKILL = 'skills/closed-loop-issue/SKILL.md';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const OWNED = [
  ['role-authority blocks', 'Packaged `build_gate_launch` copies exactly one of these owning-root blocks verbatim into each Issue gate payload (CL-D120):'],
  ['payload composition', 'For every Issue gate, `build_gate_launch` composes the shared Every-gate invariant payload block verbatim, for Sol the Sol-only adversarial block too, the role-authority block and the volatile envelope; Terra never receives the Sol-only block, and the packaged Issue driver calls it (CL-D122).'],
  ['target kind', 'On the review-and-draft round, the driver makes this check and refuses the target before any run (CL-D122).'],
  ['issue_spec', 'The packaged Issue driver computes `issue_spec`, recomputes it before Terra and at readiness, and stops the round at `BLOCKED` when it changes (CL-D122); a fresh run reruns both gates.'],
  ['result reading', 'The driver reads every result and owns its one relaunch (CL-D122)'],
  ['status block', 'The driver drafts the block below whenever its round stops (CL-D122).'],
];
// The parent instructions those passages replace.
const RETIRED = [
  'Copy exactly one of these owning-root blocks verbatim into each Issue gate payload',
  'the parent requires the shared Every-gate invariant payload block verbatim in every Issue Terra invocation',
  'Every Issue Sol invocation composes the shared Every-gate and Sol-only adversarial invariant payload blocks verbatim',
  'Outside the CL-D31 candidate-publication phase, recompute `issue_spec` before declaring readiness',
  'whenever the run stops without reaching readiness, the driver drafts the legacy block below',
];

test('Issue #308 each driver-owned passage of the Issue Skill names its owner', () => {
  const skill = read(SKILL);
  for (const [name, sentence] of OWNED) assert.ok(skill.includes(sentence), `${name}: ${sentence}`);
  for (const sentence of RETIRED) assert.ok(!skill.includes(sentence), `retired: ${sentence}`);
});

test('Issue #308 the Issue Skill is smaller than at the base', () => {
  // 34,948 bytes at 299d546, the merge of PR #307.
  assert.ok(fs.statSync(path.join(ROOT, SKILL)).size < 34948);
});

test('Issue #308 a CL-D122 clause carries the trim', () => {
  const clauses = JSON.parse(read('contract/CL-D122.clauses.json')).clauses;
  const trim = clauses.find((c) => c.id === 'CL-D122-trim');
  assert.ok(trim, 'CL-D122-trim');
  assert.deepEqual(trim.files, [SKILL]);
  for (const [, sentence] of OWNED) assert.ok(trim.requires.includes(sentence), sentence);
  assert.match(read('contract/CL-D122.md'), /\*\*Clauses:\*\* CL-D122-record, CL-D122-driver, CL-D122-skill, CL-D122-trim\n/);
  assert.match(read('contract/CL-D122.md'), /#308/);
});
