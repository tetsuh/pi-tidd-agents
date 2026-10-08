'use strict';

// Issue #242 (CL-D108): a gate kept a pull request waiting on a body sentence that a trusted timeline comment had
// already corrected (PR #239 round 5, CONV-239-PR-BODY-RED-CLASSIFICATION; PR #255 round 1, CONV-255-AC5-PRBODY), while
// Sol accepted the same kind of correction on PR #236. Corrections go in the timeline, never the body (owner rule), so
// the shared Every-gate block, which every gate payload carries, says a corrected body claim is judged as corrected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf } = require('./helpers');

const BLOCK_RULE = 'A pull-request body claim that a later conversation comment by a trusted author (owner, member or collaborator, not a bot) corrects is judged as corrected: the gate cites that comment and raises no finding against the body sentence, unless the correction itself is inaccurate against the head (CL-D108).';
const OID = 'a'.repeat(40), SHA = 'e'.repeat(64);

test('Issue #242 the shared Every-gate block says a trusted timeline correction settles a body claim', () => {
  const block = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '#### Every-gate invariant payload block (CL-D2)');
  assert.ok(block, 'the Every-gate block exists');
  assert.equal(block.split(BLOCK_RULE).length - 1, 1, 'the rule is in the block once');
  // It follows the CL-D95 sentence, which it narrows for corrected claims; that sentence stands as it was.
  assert.ok(block.indexOf('its claims are judged for accuracy against the head (CL-D95).') < block.indexOf(BLOCK_RULE), 'the rule follows CL-D95');
});

const CREATED = Object.freeze({ kind: 'linked', path: '/tmp/pi-autofix-helper-test/workspace', root: '/tmp/pi-autofix-helper-test', head: OID, tree: 'b'.repeat(40), cleanupAllowed: true,
  receipt: { version: 1, id: 'id', root: '/tmp/pi-autofix-helper-test', storedPath: '/tmp/pi-autofix-helper-test/.cleanup-receipt.json' } });
const LAUNCHES = [
  ...['convergence', 'adversarial', 'safety'].flatMap((gate) => [['pr', gate, 'review-only'], ['pr', gate, 'autofix']]),
  ...['convergence', 'adversarial', 'decision-drift'].map((gate) => ['issue', gate, 'review-only']),
];

test('Issue #242 the payload the launch builder writes carries the rule, for every gate of both roots', () => {
  for (const [workflow, gate, mode] of LAUNCHES) {
    const label = `${workflow}/${gate}/${mode}`, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i242-'));
    try {
      const correlation = { repository: 'o/r', number: 242, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
      const expectation = helpers.buildGateExpectation({ workflow, correlation, assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
      assert.equal(expectation.ok, true, `${label}: ${JSON.stringify(expectation.error)}`);
      const expectationPath = path.join(dir, `expectation-${gate}.json`);
      fs.writeFileSync(expectationPath, `${JSON.stringify(expectation.data.expected, null, 2)}\n`);
      const volatile = {
        target: { repository: 'o/r', number: 242, mode, gate, baseOid: 'b'.repeat(40), headOid: OID, headBranch: 'b' },
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
