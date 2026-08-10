'use strict';

// Issue #15 changes a prose Skill/prompt workflow. Artifact assertions below are
// compile/contract coverage. The `fixture:` tests are non-authoritative reference
// transitions: they pin intended semantics but cannot prove LLM orchestration,
// provider locking, or that a model follows the Skill.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readText } = require('./helpers');

function sectionOf(text, heading) {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
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

const CONDITIONAL_OWNER_CHOICE =
  'Option B: adopt the exact recommended scope without guessing an owner value. Conditionally selected by the exact affirmative response bound to this displayed candidate; no owner choice exists unless that response is observed.';
const DEC_FIELDS = [
  'Decision ID', 'Kind', 'Target and revision', 'Question',
  'Options and trade-offs', 'Recommendation', 'Owner choice', 'Rationale',
  'Validity and invalidation conditions',
];
const AFFIRMATIVE = 'approve';
const TARGET_REPOSITORY = 'tetsuh/sitos';
const TARGET_ISSUE = 56;

// Artifact assertions are section-scoped compile/contract checks, not behavior proof.
test('Issue #15 contract owns the combined scope-freeze transaction', () => {
  const contract = readText('CONTRACT.md');
  const section = sectionOf(contract, '## CL-D32 — Scope-freeze approval stays inside the candidate transaction');
  assert.ok(section, 'CONTRACT.md has no CL-D32 Issue #15 decision');
  for (const required of [
    'target-specific readiness-blocking scope-freeze AC-DECISION record', 'distinct from the repository contract decision `DEC-I15-ROUND-BUDGET-001`',
    'independent current-repository Issue, checkout, and resolver antecedent',
    'exactly five decision conditions', 'complete byte-identical candidate',
    'dormant at-most-one counted Sol round', 'unchanged Sol and Terra `MERGE`',
    'Snapshot C', 'never publishes a standalone scope-freeze decision',
    'gate finding requiring correction, non-`MERGE`, correlation mismatch, or gate uncertainty',
    'optional current-Issue body PATCH and one exact ledger POST',
    'no additional or unlisted GitHub/provider authority',
    'no implementation-start authority', 'Foreign Issues remain review-and-draft-only',
    'PR/CL-D30',
  ]) assert.ok(section.includes(required), `CL-D32 contract is missing ${required}`);

  const decision = sectionOf(contract, '## DEC-I15-ROUND-BUDGET-001 — Bounded post-decision Sol round');
  assert.ok(decision, 'canonical Issue #15 decision record is missing');
  assert.deepEqual(
    [...decision.matchAll(/^\*(.+?):\*\s+/gm)].map((match) => match[1]),
    DEC_FIELDS,
    'DEC-I15 must contain the canonical nine fields in order',
  );
  assert.match(decision, /Option B approved by the exact live same-session response/);
  assert.match(section, /published Issue #15 body SHA-256 `7d04df705a9e503464178148d70ad2755da720441ce61d0a8eaffee4d35c0b23`/);
  assert.match(section, /final published `issue_spec` `b850ae9fe339a3881f739ee8a7295e700047319e7f781dff16cc7d032d98734c`/);
  assert.doesNotMatch(section, /complete nine-field `DEC-I15-ROUND-BUDGET-001` decision/);
});

test('Issue Skill defines the complete combined scope-freeze transaction', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  const section = sectionOf(skill, '### Combined scope-freeze decision transaction (CL-D32)');
  assert.ok(section, 'Issue Skill has no CL-D32 combined scope-freeze section');
  for (const required of [
    'independent pre-question antecedent', 'if and only if', 'five necessary-and-sufficient decision conditions',
    'complete nine-field target-specific readiness-blocking scope-freeze AC-DECISION record',
    'distinct from the repository contract decision `DEC-I15-ROUND-BUDGET-001`', 'Owner choice` field is exactly',
    CONDITIONAL_OWNER_CHOICE, 'exact affirmative response byte sequence',
    'dormant grant for at most one additional counted Sol round', 'last already-authorized counted Sol round',
    'Sol must re-review', 'Terra starts only after Sol returns `MERGE`',
    'Snapshot A, optional body PATCH, Snapshot B, one ledger POST, and Snapshot C',
    'Never publish the scope-freeze decision as a standalone comment', 'candidate/body/diff/ledger byte change',
    'no retry, transfer, Terra launch', 'implementation-start authority',
  ]) assert.ok(section.includes(required), `CL-D32 Skill is missing ${required}`);
  assert.doesNotMatch(section, /provider lock|executable controller/i, 'Skill must preserve prose-only architecture');
});

test('CL-D31 ordinary-route prose is explicitly qualified for the CL-D32 exception', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  const candidate = sectionOf(skill, '### Candidate phase and immutable bundle');
  const correlation = sectionOf(skill, '### Gate correlation and sequential review');
  const preview = sectionOf(skill, '### Exact same-session owner preview and approval');
  const outcome = sectionOf(skill, '## Outcome and status block (CL-D13, CL-D14)');
  assert.ok(candidate && correlation && preview && outcome);
  assert.match(candidate, /ordinarily begins/);
  assert.match(candidate, /Sol result that raises combined-route eligibility is legacy\/pre-candidate review/);
  assert.match(candidate, /earlier result is not a review of the new candidate/);
  assert.match(correlation, /pre-candidate Sol result/);
  assert.match(correlation, /legacy `issue_spec` gate payload/);
  assert.match(correlation, /cannot satisfy the mandatory post-decision rereview/);
  assert.match(correlation, /ordinary CL-D31/);
  assert.match(correlation, /sole exception/);
  assert.match(correlation, /grants no mutation/);
  assert.match(correlation, /mandatory unchanged Sol then Terra/);
  assert.match(preview, /ordinary CL-D31 route/);
  assert.match(preview, /sole pre-rereview exception and replaces this later prompt/);
  assert.match(preview, /never ask for a second approval, command, or fresh run/);
  assert.match(preview, /downstream mismatch or failure still follows the fresh-run invalidation rules/);
  assert.match(preview, /A\/B\/C/);
  assert.match(outcome, /ordinary CL-D31/);
  assert.match(outcome, /under CL-D32/);
  assert.match(outcome, /without duplicate gates/);
});

test('Issue prompt delegates CL-D32 to the authoritative Skill without duplicating it', () => {
  const prompt = readText('prompts/tidd-issue.md');
  assert.match(prompt, /closed-loop-issue/);
  assert.match(prompt, /authoritative contract/);
  assert.match(prompt, /Raw arguments \(preserve this complete vector for the Skill to parse\): \$@/);
  assert.doesNotMatch(prompt, /CL-D32 combined scope-freeze approval|one exact owner response/);
});

test('README documents one-response scope-freeze approval and preserved boundaries', () => {
  const readme = readText('README.md');
  const section = sectionOf(readme, '#### Combined scope-freeze approval');
  assert.ok(section, 'README has no combined scope-freeze approval subsection');
  for (const required of [
    'one exact combined scope-freeze preview', 'one exact owner response',
    'mandatory Sol rereview and Terra review', 'dormant at-most-one counted Sol round',
    'never a standalone comment', 'Snapshot A', 'Snapshot C',
    'does not authorize starting implementation', 'Foreign Issues', 'PR/CL-D30',
  ]) assert.ok(section.includes(required), `README is missing ${required}`);
});

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}
function candidateStream(fields) {
  return `tidd-issue-candidate-v1\n${fields.map(([name, value]) => {
    const bytes = Buffer.from(String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n'), 'utf8');
    return `${name} ${bytes.length}\n${bytes.toString('utf8')}\n`;
  }).join('')}`;
}
const SCOPE_FREEZE_ID = 'DEC-56-SCOPE-FREEZE-001';
function decisionRecord({ repository = TARGET_REPOSITORY, issue = TARGET_ISSUE,
  baseSpec = '7'.repeat(64), ownerChoice = CONDITIONAL_OWNER_CHOICE } = {}) {
  return {
    'Decision ID': `DEC-${issue}-SCOPE-FREEZE-001`,
    Kind: 'Readiness-blocking scope-freeze decision',
    'Target and revision': `${repository}#${issue} at base issue_spec ${baseSpec}`,
    Question: 'Which exact scope should be frozen for the readiness candidate?',
    'Options and trade-offs': 'Option A keeps the current scope; Option B adopts the recommended bounded scope.',
    Recommendation: 'Option B: adopt the exact recommended scope without guessing an owner value.',
    'Owner choice': ownerChoice,
    Rationale: 'Freezes the displayed target-specific scope while preserving all Sol, Terra, and publication guards.',
    'Validity and invalidation conditions': 'Bound to this candidate/session; any target, byte, decision, or gate change requires new authority.',
  };
}
function serializeDecision(record) {
  assert.deepEqual(Object.keys(record), DEC_FIELDS);
  return DEC_FIELDS.map((field) => `*${field}:* ${record[field]}`).join('\n');
}
function frozenBundle(overrides = {}) {
  const repository = overrides.repository || TARGET_REPOSITORY;
  const issue = overrides.issue || TARGET_ISSUE;
  const baseSpec = overrides.baseSpec || '7'.repeat(64);
  const baseBody = overrides.baseBody || 'base issue body';
  const proposedBody = overrides.body || 'proposed issue body';
  const decision = overrides.decision || decisionRecord({ repository, issue, baseSpec });
  const ledger = overrides.ledger || `## ${decision['Decision ID']}\n${serializeDecision(decision)}`;
  const fields = [
    ['repository', repository],
    ['issue.number', String(issue)],
    ['issue.url', `https://github.com/${repository}/issues/${issue}`],
    ['base.issue_spec.sha256', baseSpec],
    ['base.body', baseBody],
    ['base.comments.count', '1'],
    ['base.comments.0.id', '1'],
    ['base.comments.0.updated_at', '2026-01-01T00:00:00Z'],
    ['base.comments.0.body', 'authoritative decision context'],
    ['proposed.body', proposedBody],
    ['ledger.comment', ledger],
  ];
  const candidateBytes = candidateStream(fields);
  const diffBytes = overrides.diff !== undefined ? overrides.diff :
    (baseBody === proposedBody ? '' : `--- a/body\n+++ b/body\n@@ -1 +1 @@\n-${baseBody}\n+${proposedBody}`);
  const baseAuthoritativeComments = [{ id: '1', updatedAt: '2026-01-01T00:00:00Z',
    body: 'authoritative decision context', association: 'OWNER', userType: 'User' }];
  const baseSnapshotComments = [...baseAuthoritativeComments,
    { id: '2', updatedAt: '2026-01-01T00:01:00Z', body: 'advisory context', association: 'CONTRIBUTOR', userType: 'User' }];
  return {
    repository, issue, issueUrl: `https://github.com/${repository}/issues/${issue}`,
    baseSpec, runNonce: overrides.runNonce || 'a'.repeat(32), session: overrides.session || 'session-15',
    candidateBytes, candidateIdentity: digest(candidateBytes), baseBodyBytes: baseBody, bodyBytes: proposedBody,
    diffBytes, ledgerBytes: ledger, decision, fields, baseAuthoritativeComments, baseSnapshotComments,
  };
}
function bindingOf(bundle) {
  return {
    repository: bundle.repository, issue: bundle.issue, baseSpec: bundle.baseSpec,
    runNonce: bundle.runNonce, session: bundle.session, candidateIdentity: bundle.candidateIdentity,
    candidateBytes: bundle.candidateBytes, bodyBytes: bundle.bodyBytes,
    diffBytes: bundle.diffBytes, ledgerBytes: bundle.ledgerBytes,
  };
}
function exactResponse(state, response = AFFIRMATIVE) {
  if (!state.preview || !Buffer.from(response).equals(Buffer.from(state.exactAffirmative))) {
    return { approved: false, ownerChoiceObserved: false, grant: null, candidate: null };
  }
  const activates = state.decisionRaisedOnLastAuthorizedRound && state.authorizedRemaining === 0;
  return {
    approved: true, ownerChoiceObserved: true, candidate: state.bundle,
    grant: {
      dormant: !activates, activated: activates, consumed: false, expired: false,
      maxCountedRounds: 1, purpose: 'post-decision-sol-rereview', ...bindingOf(state.bundle),
      frozenBundleDigest: digest(state.bundle.candidateBytes + state.bundle.diffBytes),
    },
  };
}
function eligibility({ target, guards, decisions, recommendation, preview }) {
  const antecedent = target.kind === 'issue' && target.currentRepository && guards.targetIdentity && guards.checkout && guards.resolver;
  const five = decisions.length === 1 && decisions[0].kind === 'readiness-blocking-scope-freeze' &&
    !decisions[0].otherOwnerChoicePending && recommendation.complete && recommendation.tradeoffsComplete &&
    !recommendation.guessesOwnerValue && preview.complete && preview.onlyRecommendedCandidate;
  if (!antecedent) return target.kind === 'issue' && !target.currentRepository ? 'foreign-review-draft-only' : 'existing-fail-closed';
  return five ? 'combined-preview' : 'legacy-owner-decision';
}
function baseEligibility() {
  return {
    target: { kind: 'issue', currentRepository: true },
    guards: { targetIdentity: true, checkout: true, resolver: true },
    decisions: [{ kind: 'readiness-blocking-scope-freeze', otherOwnerChoicePending: false }],
    recommendation: { complete: true, tradeoffsComplete: true, guessesOwnerValue: false },
    preview: { complete: true, onlyRecommendedCandidate: true },
  };
}

// fixture: the five conditions are sufficient only within the independent antecedent.
test('fixture: combined eligibility has exact five-condition iff and preserves boundaries', () => {
  assert.equal(eligibility(baseEligibility()), 'combined-preview');
  // Downstream gates and snapshots are deliberately absent: they are not eligibility prerequisites.
  assert.equal(eligibility({ ...baseEligibility(), downstream: { sol: false, terra: false, snapshots: false } }), 'combined-preview');
  for (const [name, change] of [
    ['zero-decisions', { decisions: [] }],
    ['multiple-decisions', { decisions: [{ kind: 'readiness-blocking-scope-freeze' }, { kind: 'readiness-blocking-scope-freeze' }] }],
    ['wrong-architecture', { decisions: [{ kind: 'architecture' }] }],
    ['wrong-api', { decisions: [{ kind: 'api' }] }],
    ['wrong-compatibility', { decisions: [{ kind: 'compatibility' }] }],
    ['wrong-security', { decisions: [{ kind: 'security/risk' }] }],
    ['wrong-waiver', { decisions: [{ kind: 'waiver' }] }],
    ['other-choice', { decisions: [{ kind: 'readiness-blocking-scope-freeze', otherOwnerChoicePending: true }] }],
    ['incomplete-option', { recommendation: { ...baseEligibility().recommendation, complete: false } }],
    ['incomplete-tradeoffs', { recommendation: { ...baseEligibility().recommendation, tradeoffsComplete: false } }],
    ['guessed-owner-value', { recommendation: { ...baseEligibility().recommendation, guessesOwnerValue: true } }],
    ['incomplete-candidate', { preview: { ...baseEligibility().preview, complete: false } }],
    ['alternative-shown', { preview: { ...baseEligibility().preview, onlyRecommendedCandidate: false } }],
  ]) {
    assert.equal(eligibility({ ...baseEligibility(), ...change }), 'legacy-owner-decision', name);
  }
  for (const [name, change] of [
    ['target-identity', { guards: { ...baseEligibility().guards, targetIdentity: false } }],
    ['checkout', { guards: { ...baseEligibility().guards, checkout: false } }],
    ['resolver', { guards: { ...baseEligibility().guards, resolver: false } }],
    ['foreign', { target: { kind: 'issue', currentRepository: false } }],
    ['pr', { target: { kind: 'pr', currentRepository: true } },],
  ]) {
    const result = eligibility({ ...baseEligibility(), ...change });
    assert.notEqual(result, 'combined-preview', name);
    if (name === 'foreign') assert.equal(result, 'foreign-review-draft-only');
    if (name !== 'foreign') assert.equal(result, name === 'pr' ? 'existing-fail-closed' : 'existing-fail-closed');
  }
});

test('fixture: frozen nine-field conditional decision and exact response preserve every byte', () => {
  const bundle = frozenBundle();
  assert.deepEqual(Object.keys(bundle.decision), DEC_FIELDS);
  assert.equal(bundle.decision['Decision ID'], SCOPE_FREEZE_ID);
  assert.notEqual(bundle.decision['Decision ID'], 'DEC-I15-ROUND-BUDGET-001');
  assert.equal(bundle.decision['Owner choice'], CONDITIONAL_OWNER_CHOICE);
  assert.match(bundle.ledgerBytes, new RegExp(`^## ${SCOPE_FREEZE_ID}\\n`));
  assert.doesNotMatch(bundle.ledgerBytes, /^## DEC-I15-ROUND-BUDGET-001/m);
  const state = { preview: true, exactAffirmative: AFFIRMATIVE, bundle, authorizedRemaining: 0, decisionRaisedOnLastAuthorizedRound: true };
  const before = [bundle.candidateBytes, bundle.bodyBytes, bundle.diffBytes, bundle.ledgerBytes, digest(bundle.candidateBytes)];
  const approval = exactResponse(state);
  assert.equal(approval.approved, true);
  assert.equal(approval.ownerChoiceObserved, true);
  assert.deepEqual([bundle.candidateBytes, bundle.bodyBytes, bundle.diffBytes, bundle.ledgerBytes, digest(bundle.candidateBytes)], before);
  assert.deepEqual(exactResponse(state, 'APPROVE').approved, false);
  assert.deepEqual(exactResponse(state, ' approve').approved, false);
  assert.deepEqual(exactResponse(state, 'yes').approved, false);
  assert.deepEqual(exactResponse(state, '承認').approved, false);
  for (const response of ['decline', 'cancel', 'different option']) {
    const declined = exactResponse({ ...state, preview: true }, response);
    assert.equal(declined.approved, false, response);
    assert.equal(declined.candidate, null);
    assert.equal(declined.grant, null);
  }
  const different = frozenBundle({ decision: decisionRecord({ ownerChoice: 'Option A selected by a new response.' }) });
  assert.notEqual(different.candidateIdentity, bundle.candidateIdentity);
  assert.notEqual(different.ledgerBytes, bundle.ledgerBytes);
});

function sameBinding(expected, actual) {
  return Object.keys(bindingOf(expected)).every((key) => bindingOf(expected)[key] === actual[key]);
}
function consumeSolGrant(grant, bundle, { gate = 'sol', result = 'MERGE' } = {}) {
  const valid = grant && grant.activated && !grant.consumed && !grant.expired &&
    grant.purpose === 'post-decision-sol-rereview' && gate === 'sol' && sameBinding(bundle, grant);
  if (!valid) return { ok: false, grant: grant ? { ...grant, expired: true } : grant };
  const consumed = { ...grant, consumed: true, expired: result !== 'MERGE' };
  return { ok: result === 'MERGE', grant: consumed };
}

// fixture: this model carries only the one explicitly bounded Sol authority.
test('fixture: dormant grant activates only at the last-round boundary, binds every byte, and is consumed once', () => {
  const bundle = frozenBundle();
  const early = exactResponse({ preview: true, exactAffirmative: AFFIRMATIVE, bundle, authorizedRemaining: 1, decisionRaisedOnLastAuthorizedRound: false });
  assert.equal(early.grant.dormant, true); assert.equal(early.grant.activated, false);
  const notLast = exactResponse({ preview: true, exactAffirmative: AFFIRMATIVE, bundle, authorizedRemaining: 0, decisionRaisedOnLastAuthorizedRound: false });
  assert.equal(notLast.grant.activated, false, 'zero remaining alone cannot activate the grant');
  const last = exactResponse({ preview: true, exactAffirmative: AFFIRMATIVE, bundle, authorizedRemaining: 0, decisionRaisedOnLastAuthorizedRound: true });
  assert.equal(last.grant.dormant, false); assert.equal(last.grant.activated, true);
  assert.equal(last.grant.maxCountedRounds, 1);
  const used = consumeSolGrant(last.grant, bundle);
  assert.equal(used.ok, true); assert.equal(used.grant.consumed, true);
  assert.equal(consumeSolGrant(used.grant, bundle).ok, false, 'the grant cannot be reused');
  assert.equal(consumeSolGrant(last.grant, bundle, { result: 'FIX BEFORE MERGE' }).grant.expired, true);
  assert.equal(consumeSolGrant(last.grant, bundle, { result: 'NEEDS DECISION' }).grant.expired, true);
  assert.equal(consumeSolGrant(last.grant, bundle, { gate: 'terra' }).ok, false);
  for (const changed of [
    { ...bundle, repository: 'other/repo' }, { ...bundle, issue: 57 }, { ...bundle, baseSpec: '0'.repeat(64) },
    { ...bundle, runNonce: 'b'.repeat(32) }, { ...bundle, session: 'other' },
    { ...bundle, candidateBytes: bundle.candidateBytes + 'x' }, { ...bundle, candidateIdentity: '0'.repeat(64) },
    { ...bundle, bodyBytes: bundle.bodyBytes + 'x' }, { ...bundle, diffBytes: bundle.diffBytes + 'x' },
    { ...bundle, ledgerBytes: bundle.ledgerBytes + 'x' },
  ]) {
    assert.equal(consumeSolGrant(last.grant, changed).grant.expired, true);
  }
});

function liveApproval(bundle) {
  return { ...bindingOf(bundle), approved: true, grantLive: true, authoritativeInput: 'unchanged', resolver: true,
    checkout: true, identity: true, ownerDecision: 'same', gate: 'pending', failure: null,
    terminal: null, laterCommand: false, retry: false, transfer: false, furtherExtension: false };
}
function approvalRemainsLive(original, current) {
  const bindingsMatch = Object.keys(bindingOf(original)).every((key) => original[key] === current[key]);
  return bindingsMatch && current.approved && current.grantLive && current.authoritativeInput === 'unchanged' &&
    current.resolver && current.checkout && current.identity && current.ownerDecision === 'same' &&
    ['pending', 'MERGE'].includes(current.gate) && current.failure === null && current.terminal === null &&
    !current.laterCommand && !current.retry && !current.transfer && !current.furtherExtension;
}
test('fixture: concrete AC6 state changes independently expire approval and grant before mutation', () => {
  const original = liveApproval(frozenBundle());
  const mutations = [
    ['candidate regeneration', { candidateIdentity: '0'.repeat(64) }],
    ['candidate bytes', { candidateBytes: original.candidateBytes + 'x' }], ['body bytes', { bodyBytes: original.bodyBytes + 'x' }],
    ['diff bytes', { diffBytes: original.diffBytes + 'x' }], ['ledger bytes', { ledgerBytes: original.ledgerBytes + 'x' }],
    ['new owner decision', { ownerDecision: 'different' }], ['authoritative input', { authoritativeInput: 'changed' }],
    ['target movement', { issue: original.issue + 1 }], ['repository movement', { repository: 'other/repo' }],
    ['resolver movement', { resolver: false }], ['checkout movement', { checkout: false }], ['identity movement', { identity: false }],
    ['base issue_spec', { baseSpec: '0'.repeat(64) }], ['run replay', { runNonce: 'b'.repeat(32) }],
    ['session end/replay', { session: 'other' }], ['later command', { laterCommand: true }],
    ['tool/provider/capture failure', { failure: 'provider' }], ['malformed result', { failure: 'malformed' }],
    ['uncertainty', { failure: 'uncertain' }], ['candidate-changing Sol', { gate: 'FIX BEFORE MERGE' }],
    ['candidate-changing Terra', { gate: 'NEEDS DECISION' }], ['terminal outcome', { terminal: 'ABORTED' }],
    ['ready terminal', { terminal: 'IMPLEMENTATION_READY' }], ['round limit', { terminal: 'ROUND_LIMIT_REACHED' }],
    ['retry', { retry: true }], ['transfer', { transfer: true }], ['further extension', { furtherExtension: true }],
  ];
  for (const [name, change] of mutations) {
    assert.equal(approvalRemainsLive(original, { ...original, ...change }), false, name);
  }
  assert.equal(approvalRemainsLive(original, { ...original, gate: 'MERGE' }), true, 'a matching MERGE is not an invalidator');
  assert.equal(approvalRemainsLive(original, { ...original }), true);
});

function canonicalIssueSpec(body, comments) {
  const authoritative = comments.filter((comment) =>
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.association) && comment.userType !== 'Bot')
    .slice().sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  const records = [body.replaceAll('\r\n', '\n').replaceAll('\r', '\n'), ...authoritative.map((comment) =>
    `${comment.id}:${comment.updatedAt}:${comment.body.replaceAll('\r\n', '\n').replaceAll('\r', '\n')}`)];
  return digest(records.join('\n'));
}
function bracketFor(body, comments) {
  const copy = () => comments.map((comment) => ({ ...comment }));
  return [
    { read: 'R0', body }, { read: 'C1', comments: copy() },
    { read: 'R1', body }, { read: 'C2', comments: copy() },
    { read: 'R2', body }, { read: 'C3', comments: copy() },
  ];
}
function snapshot(body, comments) {
  return { stable: true, terminalPagination: true, bracket: bracketFor(body, comments), body,
    comments: comments.map((comment) => ({ ...comment })) };
}
function orderedComments(comments) {
  return comments.slice().sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}
function captureMatches(capture, expectedBody, expectedComments) {
  return capture.stable && capture.terminalPagination &&
    JSON.stringify(capture.bracket) === JSON.stringify(bracketFor(expectedBody, expectedComments)) && capture.body === expectedBody &&
    JSON.stringify(orderedComments(capture.comments)) === JSON.stringify(orderedComments(expectedComments));
}
function bundleInternallyConsistent(bundle) {
  const fields = new Map(bundle.fields);
  const expectedDiff = bundle.baseBodyBytes === bundle.bodyBytes ? '' :
    `--- a/body\n+++ b/body\n@@ -1 +1 @@\n-${bundle.baseBodyBytes}\n+${bundle.bodyBytes}`;
  return candidateStream(bundle.fields) === bundle.candidateBytes && digest(bundle.candidateBytes) === bundle.candidateIdentity &&
    fields.get('repository') === bundle.repository && fields.get('issue.number') === String(bundle.issue) &&
    fields.get('issue.url') === bundle.issueUrl && bundle.issueUrl === `https://github.com/${bundle.repository}/issues/${bundle.issue}` &&
    fields.get('base.issue_spec.sha256') === bundle.baseSpec && fields.get('base.body') === bundle.baseBodyBytes &&
    fields.get('proposed.body') === bundle.bodyBytes && fields.get('ledger.comment') === bundle.ledgerBytes &&
    bundle.decision['Target and revision'] === `${bundle.repository}#${bundle.issue} at base issue_spec ${bundle.baseSpec}` &&
    bundle.decision['Owner choice'] === CONDITIONAL_OWNER_CHOICE && bundle.diffBytes === expectedDiff;
}
function completeBundleMatches(displayed, reviewed) {
  return Boolean(reviewed) && bundleInternallyConsistent(displayed) && bundleInternallyConsistent(reviewed) &&
    sameBinding(displayed, bindingOf(reviewed));
}
function defaultPublicationEvidence(bundle) {
  const commentId = '99';
  const transportUrl = `https://github.com/${bundle.repository}/issues/${bundle.issue}#issuecomment-${commentId}`;
  const postedComment = { id: commentId, updatedAt: '2026-08-03T00:00:00Z', body: bundle.ledgerBytes,
    association: 'OWNER', userType: 'User' };
  const finalComments = [...bundle.baseSnapshotComments, postedComment];
  return {
    resolverPatch: true, resolverPost: true, patchResult: 'ok', postResult: 'ok',
    postTransport: { id: commentId, url: transportUrl, updatedAt: postedComment.updatedAt },
    A: { ...snapshot(bundle.baseBodyBytes, bundle.baseSnapshotComments), repository: bundle.repository,
      issue: bundle.issue, issueUrl: bundle.issueUrl, baseSpec: bundle.baseSpec },
    B: snapshot(bundle.bodyBytes, bundle.baseSnapshotComments),
    C: { ...snapshot(bundle.bodyBytes, finalComments), commentId, transportUrl, newCommentCount: 1,
      issueSpec: canonicalIssueSpec(bundle.bodyBytes, finalComments) },
  };
}
function combinedTransaction(bundle, options = {}) {
  const actions = [];
  const events = ['scope-decision', 'freeze-candidate', 'combined-preview'];
  const bodyChanged = bundle.baseBodyBytes !== bundle.bodyBytes;
  const response = exactResponse({ preview: true, exactAffirmative: AFFIRMATIVE, bundle, authorizedRemaining: 0,
    decisionRaisedOnLastAuthorizedRound: true }, options.response || AFFIRMATIVE);
  const result = (state, extra = {}) => ({ state, actions: actions.map((action) => action.type), actionPayloads: actions,
    events: [...events, state], prompts: 1, commands: 1, freshRuns: 0, response,
    retry: false, compensation: false, mutationsBeforeGates: [], ...extra });
  if (!response.approved) return result('ABORTED');
  events.push('affirmative');

  const grantUse = consumeSolGrant(response.grant, bundle, { result: options.solResult || 'MERGE' });
  const solBundle = options.solBundle || bundle;
  events.push(`sol-rereview-${options.solResult || 'MERGE'}`);
  if (!grantUse.ok || !completeBundleMatches(bundle, solBundle)) return result('WAITING_FOR_OWNER', { grant: grantUse.grant });
  const terraBundle = options.terraBundle || bundle;
  events.push('terra-start');
  if ((options.terraResult || 'MERGE') !== 'MERGE' || !completeBundleMatches(bundle, terraBundle)) {
    return result('WAITING_FOR_OWNER', { grant: grantUse.grant });
  }
  events.push('terra-MERGE');

  const defaults = defaultPublicationEvidence(bundle);
  const evidence = { ...defaults, ...(options.evidence || {}) };
  evidence.A = { ...defaults.A, ...(options.evidence && options.evidence.A) };
  evidence.B = { ...defaults.B, ...(options.evidence && options.evidence.B) };
  evidence.C = { ...defaults.C, ...(options.evidence && options.evidence.C) };
  evidence.postTransport = { ...defaults.postTransport, ...(options.evidence && options.evidence.postTransport) };
  events.push('snapshot-A');
  const aMatches = evidence.A.repository === bundle.repository && evidence.A.issue === bundle.issue &&
    evidence.A.issueUrl === bundle.issueUrl && evidence.A.baseSpec === bundle.baseSpec &&
    captureMatches(evidence.A, bundle.baseBodyBytes, bundle.baseSnapshotComments);
  if (!aMatches) return result(evidence.A.failure ? 'BLOCKED' : 'WAITING_FOR_OWNER', { evidence, grant: grantUse.grant });
  if (bodyChanged) {
    if (!evidence.resolverPatch) return result('BLOCKED', { evidence, grant: grantUse.grant });
    actions.push({ type: 'PATCH_BODY', bodyBytes: bundle.bodyBytes });
    if (evidence.patchResult !== 'ok') return result('WAITING_FOR_OWNER', { evidence, grant: grantUse.grant });
  }
  events.push('snapshot-B');
  const bMatches = captureMatches(evidence.B, bundle.bodyBytes, bundle.baseSnapshotComments);
  if (!bMatches) return result(actions.length ? 'WAITING_FOR_OWNER' : (evidence.B.failure ? 'BLOCKED' : 'WAITING_FOR_OWNER'), { evidence, grant: grantUse.grant });
  if (!evidence.resolverPost) return result(actions.length ? 'WAITING_FOR_OWNER' : 'BLOCKED', { evidence, grant: grantUse.grant });
  const expectedTransportUrl = `https://github.com/${bundle.repository}/issues/${bundle.issue}#issuecomment-${evidence.postTransport.id}`;
  if (evidence.postTransport.url !== expectedTransportUrl || !/^\d+$/.test(evidence.postTransport.id) || !evidence.postTransport.updatedAt) {
    return result(actions.length ? 'WAITING_FOR_OWNER' : 'BLOCKED', { evidence, grant: grantUse.grant });
  }
  const transport = { type: 'POST_LEDGER', bytes: bundle.ledgerBytes, ...evidence.postTransport };
  actions.push(transport);
  if (evidence.postResult !== 'ok') return result('WAITING_FOR_OWNER', { evidence, grant: grantUse.grant });
  events.push('snapshot-C');
  const baseIds = new Set(bundle.baseSnapshotComments.map((comment) => comment.id));
  const newComments = evidence.C.comments.filter((comment) => !baseIds.has(comment.id));
  const postedComment = newComments.length === 1 ? newComments[0] : null;
  const qualifies = postedComment && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(postedComment.association) && postedComment.userType !== 'Bot';
  const expectedComments = postedComment ? [...bundle.baseSnapshotComments, postedComment] : bundle.baseSnapshotComments;
  const cMatches = Boolean(qualifies) && captureMatches(evidence.C, bundle.bodyBytes, expectedComments) &&
    postedComment.id === transport.id && postedComment.updatedAt === transport.updatedAt && postedComment.body === bundle.ledgerBytes &&
    evidence.C.commentId === transport.id && evidence.C.transportUrl === transport.url &&
    evidence.C.newCommentCount === 1 && evidence.C.issueSpec === canonicalIssueSpec(bundle.bodyBytes, expectedComments);
  if (!cMatches) return result('WAITING_FOR_OWNER', { evidence, grant: grantUse.grant });
  return result('IMPLEMENTATION_READY', {
    evidence, grant: grantUse.grant, standaloneDecisionPosts: actions.filter((action) => action.type === 'POST_DECISION').length,
    terraStartedAfterSol: events.indexOf('terra-start') > events.indexOf('sol-rereview-MERGE'),
    identicalGateBundle: true, authority: ['PATCH_BODY', 'POST_LEDGER'],
  });
}

test('fixture: one exact response reaches readiness through bound Sol/Terra and complete A/B/C proof', () => {
  const bundle = frozenBundle();
  const repositoryField = bundle.fields.find(([name]) => name === 'repository')[1];
  const urlField = bundle.fields.find(([name]) => name === 'issue.url')[1];
  assert.equal(repositoryField, bundle.repository);
  assert.equal(urlField, bundle.issueUrl);
  assert.equal(bundle.diffBytes, '--- a/body\n+++ b/body\n@@ -1 +1 @@\n-base issue body\n+proposed issue body');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-15-diff-'));
  try {
    fs.writeFileSync(path.join(directory, 'body'), `${bundle.baseBodyBytes}\n`);
    assert.doesNotThrow(() => execFileSync('git', ['apply', '--check', '--no-index', '-'], {
      cwd: directory, input: `${bundle.diffBytes}\n`, stdio: ['pipe', 'ignore', 'pipe'],
    }));
    assert.throws(() => execFileSync('git', ['apply', '--check', '--no-index', '-'], {
      cwd: directory, input: '--- a/body\n+++ b/body\n@@\n-old\n+new\n', stdio: ['pipe', 'ignore', 'pipe'],
    }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const flow = combinedTransaction(bundle);
  assert.equal(flow.state, 'IMPLEMENTATION_READY');
  assert.equal(flow.prompts, 1); assert.equal(flow.commands, 1); assert.equal(flow.freshRuns, 0);
  assert.deepEqual(flow.mutationsBeforeGates, []);
  assert.equal(flow.terraStartedAfterSol, true); assert.equal(flow.identicalGateBundle, true);
  assert.deepEqual(flow.actions, ['PATCH_BODY', 'POST_LEDGER']);
  assert.equal(flow.grant.consumed, true);
  assert.equal(flow.response.approved, true);
  const postedComment = flow.evidence.C.comments.find((comment) => comment.id === flow.evidence.C.commentId);
  assert.equal(postedComment.body, bundle.ledgerBytes);
  assert.match(flow.evidence.C.transportUrl, /issuecomment-99$/);
  assert.equal(flow.evidence.C.issueSpec, canonicalIssueSpec(bundle.bodyBytes, flow.evidence.C.comments));
  assert.notEqual(flow.evidence.C.issueSpec, canonicalIssueSpec(bundle.bodyBytes, [postedComment]), 'the existing authoritative comment must affect issue_spec');
  const postedLedger = flow.actionPayloads.find((action) => action.type === 'POST_LEDGER').bytes;
  assert.equal((postedLedger.match(/\*Decision ID:\*/g) || []).length, 1);
  assert.equal(postedLedger.includes(SCOPE_FREEZE_ID), true);
  assert.equal(postedLedger.includes('DEC-I15-ROUND-BUDGET-001'), false);
  assert.equal(flow.standaloneDecisionPosts, 0);
  const noBodyBundle = frozenBundle({ body: 'base issue body' });
  assert.equal(noBodyBundle.diffBytes, '');
  assert.equal(noBodyBundle.baseBodyBytes, noBodyBundle.bodyBytes);
  const noBody = combinedTransaction(noBodyBundle);
  assert.equal(noBody.state, 'IMPLEMENTATION_READY');
  assert.deepEqual(noBody.actions, ['POST_LEDGER']);
  assert.ok(noBody.events.includes('snapshot-B'));
});

test('fixture: Sol and Terra must each review every displayed frozen binding', () => {
  const bundle = frozenBundle();
  for (const field of ['candidateBytes', 'candidateIdentity', 'bodyBytes', 'diffBytes', 'ledgerBytes']) {
    const changed = { ...bundle, [field]: `${bundle[field]}changed` };
    assert.equal(combinedTransaction(bundle, { solBundle: changed }).state, 'WAITING_FOR_OWNER', `Sol ${field}`);
    assert.equal(combinedTransaction(bundle, { terraBundle: changed }).state, 'WAITING_FOR_OWNER', `Terra ${field}`);
  }
  const forged = { ...bundle, bodyBytes: 'changed', diffBytes: 'changed', ledgerBytes: 'changed' };
  assert.equal(combinedTransaction(bundle, { solBundle: forged, terraBundle: forged }).state, 'WAITING_FOR_OWNER');
  const moved = frozenBundle({ repository: 'other/repo', issue: 57, baseSpec: '8'.repeat(64) });
  assert.equal(moved.decision['Decision ID'], 'DEC-57-SCOPE-FREEZE-001');
  assert.equal(moved.decision['Target and revision'], `other/repo#57 at base issue_spec ${'8'.repeat(64)}`);
  assert.equal(bundleInternallyConsistent(moved), true);
  const inconsistentTarget = { ...bundle, repository: 'other/repo' };
  assert.equal(completeBundleMatches(inconsistentTarget, inconsistentTarget), false);
  const staleDecision = frozenBundle({ repository: 'other/repo', issue: 57, decision: decisionRecord() });
  assert.equal(bundleInternallyConsistent(staleDecision), false);
  const untruthfulDiff = { ...bundle, diffBytes: '--- a/body\n+++ b/body\n@@ -1 +1 @@\n-same\n+same' };
  assert.equal(completeBundleMatches(untruthfulDiff, untruthfulDiff), false);
});

test('fixture: each target, pagination, publication, transport, and Snapshot-C predicate independently blocks readiness', () => {
  const bundle = frozenBundle();
  const cases = [
    ['A repository', (e) => { e.A.repository = 'other/repo'; }], ['A issue', (e) => { e.A.issue = 57; }],
    ['A URL', (e) => { e.A.issueUrl = 'https://github.com/other/repo/issues/56'; }],
    ['A base spec', (e) => { e.A.baseSpec = '0'.repeat(64); }], ['A body', (e) => { e.A.body = 'other'; }],
    ['A comments', (e) => { e.A.comments = []; }], ['A unstable', (e) => { e.A.stable = false; }],
    ['A pagination', (e) => { e.A.terminalPagination = false; }], ['A bracket', (e) => { e.A.bracket[3] = 'wrong'; }],
    ['B body', (e) => { e.B.body = 'other'; }], ['B comments', (e) => { e.B.comments = []; }],
    ['B unstable', (e) => { e.B.stable = false; }], ['B pagination', (e) => { e.B.terminalPagination = false; }],
    ['B bracket', (e) => { e.B.bracket.pop(); }], ['C unstable', (e) => { e.C.stable = false; }],
    ['C pagination', (e) => { e.C.terminalPagination = false; }], ['C bracket', (e) => { e.C.bracket[0] = 'wrong'; }],
    ['C body', (e) => { e.C.body = 'other'; }], ['C base comment missing', (e) => { e.C.comments.shift(); }],
    ['C ledger', (e) => { e.C.comments.at(-1).body = 'other'; }],
    ['C timestamp', (e) => { e.C.comments.at(-1).updatedAt = '2026-08-03T00:00:01Z'; }],
    ['C transport id', (e) => { e.C.commentId = '100'; }], ['C transport URL', (e) => { e.C.transportUrl = 'other'; }],
    ['C count', (e) => { e.C.newCommentCount = 2; }],
    ['C association', (e) => { e.C.comments.at(-1).association = 'CONTRIBUTOR'; }],
    ['C bot', (e) => { e.C.comments.at(-1).userType = 'Bot'; }],
    ['C issue_spec', (e) => { e.C.issueSpec = '0'.repeat(64); }],
    ['POST target URL', (e) => {
      e.postTransport.url = 'https://github.com/other/repo/issues/56#issuecomment-99';
      e.C.transportUrl = e.postTransport.url;
    }],
  ];
  for (const [name, mutate] of cases) {
    const evidence = defaultPublicationEvidence(bundle);
    mutate(evidence);
    const outcome = combinedTransaction(bundle, { evidence });
    assert.notEqual(outcome.state, 'IMPLEMENTATION_READY', name);
    assert.equal(outcome.retry, false, name); assert.equal(outcome.compensation, false, name);
  }
  const patchFailure = combinedTransaction(bundle, { evidence: { patchResult: 'unknown' } });
  assert.deepEqual(patchFailure.actions, ['PATCH_BODY']); assert.equal(patchFailure.state, 'WAITING_FOR_OWNER');
  const postFailure = combinedTransaction(bundle, { evidence: { postResult: 'failure' } });
  assert.deepEqual(postFailure.actions, ['PATCH_BODY', 'POST_LEDGER']); assert.equal(postFailure.state, 'WAITING_FOR_OWNER');
  assert.equal(combinedTransaction(bundle, { evidence: { resolverPatch: false } }).state, 'BLOCKED');
  const movedAfterPatch = combinedTransaction(bundle, { evidence: { resolverPost: false } });
  assert.deepEqual(movedAfterPatch.actions, ['PATCH_BODY']); assert.equal(movedAfterPatch.state, 'WAITING_FOR_OWNER');
});

function actionAuthorized(action, stage) {
  return stage === 'publication-after-matching-proof' && ['PATCH_BODY', 'POST_LEDGER'].includes(action);
}
test('fixture: approval authority permits only the two bounded publication actions', () => {
  assert.equal(actionAuthorized('PATCH_BODY', 'publication-after-matching-proof'), true);
  assert.equal(actionAuthorized('POST_LEDGER', 'publication-after-matching-proof'), true);
  for (const action of ['IMPLEMENT', 'EDIT_REPOSITORY', 'COMMIT', 'PUSH', 'CREATE_PR', 'MERGE_REPOSITORY',
    'PROVIDER_MUTATION', 'RETRY', 'COMPENSATE', 'POST_DECISION', 'TERRA_GRANT']) {
    assert.equal(actionAuthorized(action, 'publication-after-matching-proof'), false, action);
  }
  assert.equal(actionAuthorized('PATCH_BODY', 'before-gates'), false);
});

function routeEntrypoint(command) {
  if (/^\/tidd-issue [^ ]+$/.test(command) || /^\/skill:closed-loop-issue [^ ]+$/.test(command)) return 'issue-workflow';
  if (/^\/tidd-pr /.test(command)) return 'pr-workflow';
  return 'unsupported';
}
test('fixture: exact equivalent entrypoints preserve legacy, foreign, and PR boundaries', () => {
  assert.equal(routeEntrypoint('/tidd-issue 15'), 'issue-workflow');
  assert.equal(routeEntrypoint('/skill:closed-loop-issue 15'), 'issue-workflow');
  assert.equal(routeEntrypoint('/tidd-pr 15'), 'pr-workflow');
  assert.equal(routeEntrypoint('/other 15'), 'unsupported');
  assert.equal(eligibility({ ...baseEligibility(), target: { kind: 'issue', currentRepository: false } }), 'foreign-review-draft-only');
  assert.equal(eligibility({ ...baseEligibility(), target: { kind: 'pr', currentRepository: true } }), 'existing-fail-closed');
  assert.equal(eligibility({ ...baseEligibility(), decisions: [{ kind: 'architecture' }] }), 'legacy-owner-decision');
});
