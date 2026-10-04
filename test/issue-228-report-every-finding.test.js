'use strict';

// Issue #228 (CL-D102): a gate returned one finding per run, and each correction moved the head, so every finding cost
// a full round (PR #227: five rounds, one finding each; tetsuh/hekatus#90: four runs, one Minor each, never past
// convergence). Nothing told a gate to stop at its first finding, and nothing told it to report all it can establish.
// The rule is stated once for every gate in the shared Every-gate block, which the launch builder copies into the
// payload, and in the three PR gate roles' definitions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf } = require('./helpers');

const BLOCK_RULE = 'The child reports every finding it can establish in the invocation, not only the first, and after a finding checks the rest of the target for the same class (CL-D102).';
const ROLE_RULE = '- Report every finding you can establish in this invocation, not only the first: after a finding, check the rest of the change for the same class before you return.';
const OID = 'a'.repeat(40), SHA = 'e'.repeat(64);

test('Issue #228 the shared Every-gate block tells every gate to report all it can establish', () => {
  const block = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Every-gate invariant payload block (CL-D2)');
  assert.ok(block, 'the Every-gate block exists');
  assert.equal(block.split(BLOCK_RULE).length - 1, 1, 'the rule is in the block once');
  // It changes no verdict rule: the vocabulary sentence stands as it was.
  assert.match(block, /The required verdict vocabulary is exactly `MERGE \| FIX BEFORE MERGE \| NEEDS DECISION`, and that verdict must be the final line\./);
});

test('Issue #228 each PR gate role\'s definition carries the rule among its working rules', () => {
  for (const role of ['tidd-convergence-reviewer', 'tidd-adversarial-reviewer', 'tidd-safety-reviewer']) {
    const rules = sectionOf(readText(`agents/${role}.md`), '## Working rules');
    assert.ok(rules, `${role} has working rules`);
    assert.equal(rules.split(ROLE_RULE).length - 1, 1, `${role} carries the rule once`);
  }
});

// Round 1 of PR #230 (CONV-230-ISSUE-GATE-PAYLOAD-TEST-COVERAGE): the rule is contracted for every gate of both roots,
// so the payload is checked for every launch the builder composes: the PR gates in review-only and in exact autofix,
// and the Issue root's convergence, adversarial and decision-drift gates.
const CREATED = Object.freeze({ kind: 'linked', path: '/tmp/pi-autofix-helper-test/workspace', root: '/tmp/pi-autofix-helper-test', head: OID, tree: 'b'.repeat(40), cleanupAllowed: true,
  receipt: { version: 1, id: 'id', root: '/tmp/pi-autofix-helper-test', storedPath: '/tmp/pi-autofix-helper-test/.cleanup-receipt.json' } });
const LAUNCHES = [
  ...['convergence', 'adversarial', 'safety'].flatMap((gate) => [['pr', gate, 'review-only'], ['pr', gate, 'autofix']]),
  ...['convergence', 'adversarial', 'decision-drift'].map((gate) => ['issue', gate, 'review-only']),
];

test('Issue #228 the payload the launch builder writes carries the rule, for every gate of both roots', () => {
  for (const [workflow, gate, mode] of LAUNCHES) {
    const label = `${workflow}/${gate}/${mode}`, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i228-'));
    try {
      const correlation = { repository: 'o/r', number: 228, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
      const expectation = helpers.buildGateExpectation({ workflow, correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
      assert.equal(expectation.ok, true, `${label}: ${JSON.stringify(expectation.error)}`);
      const expectationPath = path.join(dir, `expectation-${gate}.json`);
      fs.writeFileSync(expectationPath, `${JSON.stringify(expectation.data.expected, null, 2)}\n`);
      const volatile = {
        target: { repository: 'o/r', number: 228, mode, gate, baseOid: 'b'.repeat(40), headOid: OID, headBranch: 'b' },
        fingerprints: workflow === 'pr' ? { issue_spec: SHA, pr_base: 'b'.repeat(40), pr_tree: 'c'.repeat(40), pr_head: OID, pr_diff: SHA, pr_commits: SHA, snapshot: 'd'.repeat(64) } : { issue_spec: SHA, snapshot: 'd'.repeat(64) },
        body: 'body', languageProfile: 'conversation: ja; GitHub issue / pull request: en',
        acceptanceCriteria: ['AC1'], history: { unresolved: [], reopened: [], settled: [] },
      };
      if (workflow === 'pr') volatile.diff = 'diff --git a/a b/a\n';
      if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = []; }
      const built = helpers.buildGateLaunch({ expectation: expectation.data, expectationPath, volatile, ...(mode === 'autofix' ? { created: CREATED } : {}) });
      assert.equal(built.ok, true, `${label}: ${JSON.stringify(built.error)}`);
      const payload = fs.readFileSync(built.data.payloadPath, 'utf8');
      assert.equal(payload.split(BLOCK_RULE).length - 1, 1, `${label}: the payload carries the rule once`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
