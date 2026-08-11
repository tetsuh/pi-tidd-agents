'use strict';

// This file holds two different kinds of check, and the distinction matters.
//
// 1. Artifact assertions read the shipped prompt files and assert something about
//    them. They can fail when the artifacts regress.
// 2. Reference fixtures are executable specifications of a grammar or byte
//    serialization that the skills describe in prose. The runtime implementation
//    is that prose, interpreted by a model, so a fixture cannot verify runtime
//    behaviour. It pins the intended semantics and gives an implementer exact
//    vectors to check against. Fixture tests are named with a `fixture:` prefix
//    so nobody reads them as proof that the workflow behaves this way.
//
// Prose obligations belong in test/contract-clauses.json, not here.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readText } = require('./helpers');

const SINGLE_TOKEN_REF = /^(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+|#?\d+|PR\d+)$/;

function expandPrompt(file, args) {
  // Pi's documented `$@` substitution joins all arguments with a space.
  return readText(file).replaceAll('$@', args.join(' '));
}

/** Reference implementation of the target and mode grammar documented in CL-D6/CL-D7. */
function parseReferenceArgs(args, kind) {
  if (args.length === 0) return { usage: true };
  const wantsAutofix = kind === 'pr' && args.at(-1) === 'autofix';
  const targetArgs = wantsAutofix ? args.slice(0, -1) : args;
  const mode = wantsAutofix ? 'autofix' : 'review-only';
  if (targetArgs.length === 2 && /^(Issue|PR)$/.test(targetArgs[0]) && /^#\d+$/.test(targetArgs[1])) {
    return { target: targetArgs.join(' '), mode };
  }
  if (targetArgs.length === 1 && SINGLE_TOKEN_REF.test(targetArgs[0])) {
    return { target: targetArgs[0], mode };
  }
  return { usage: true };
}

const TARGETS = [
  'https://github.com/acme/widgets/pull/123',
  '#123',
  '123',
  'Issue #123',
  'PR #123',
  'PR123',
];

test('prompts pass the raw argument vector and no longer split it positionally', () => {
  for (const file of ['prompts/tidd-issue.md', 'prompts/tidd-pr.md']) {
    const text = readText(file);
    assert.match(text, /Raw arguments.*\$@/);
    // Positional binding broke two-token references such as `PR #123`, which #3
    // lists as an accepted form: `$2` captured `#123` and the mode parser
    // rejected it. Guard against a regression to that syntax.
    assert.doesNotMatch(text, /\$\{1:-MISSING\}/);
    assert.doesNotMatch(text, /\$\{2:-NONE\}/);
  }
});

test('every accepted target reference survives prompt expansion intact', () => {
  for (const target of TARGETS) {
    const file = target.startsWith('Issue') ? 'prompts/tidd-issue.md' : 'prompts/tidd-pr.md';
    const expanded = expandPrompt(file, target.split(' '));
    assert.ok(
      expanded.includes(`Raw arguments (preserve this complete vector for the Skill to parse): ${target}`),
      `${file} loses the target reference ${JSON.stringify(target)} on expansion`,
    );
  }
});

test('fixture: the documented grammar accepts every reference form', () => {
  for (const target of TARGETS) {
    const kind = target.startsWith('Issue') ? 'issue' : 'pr';
    assert.equal(parseReferenceArgs(target.split(' '), kind).target, target);
  }
});

test('fixture: the composed shared/root target grammar delegates mode handling correctly', () => {
  const shared = readText('skills/closed-loop-shared/references/gate-contract.md');
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  const pr = readText(PR_SKILL);
  assert.match(shared, /consume only that target reference/);
  assert.match(issue, /Reject any remaining argument/);
  assert.match(pr, /CL-D6 then consumes only a final exact `autofix` token/);
  assert.deepEqual(parseReferenceArgs(['Issue', '#123', 'autofix'], 'issue'), { usage: true });
  assert.equal(parseReferenceArgs(['PR', '#123', 'autofix'], 'pr').mode, 'autofix');
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'Autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'autofix', 'extra'], 'pr'), { usage: true });
});

test('fixture: the documented grammar keeps the autofix boundary exact', () => {
  assert.equal(parseReferenceArgs(['PR', '#123'], 'pr').mode, 'review-only');
  assert.equal(parseReferenceArgs(['PR', '#123', 'autofix'], 'pr').mode, 'autofix');
  assert.equal(parseReferenceArgs(['123', 'autofix'], 'pr').mode, 'autofix');
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'Autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', '--autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'autofix', 'extra'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['autofix', '#123'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs([], 'pr'), { usage: true });
  // The issue workflow has no autofix mode, so the token is just an extra argument.
  assert.deepEqual(parseReferenceArgs(['#123', 'autofix'], 'issue'), { usage: true });
});

function canonicalText(records) {
  return records.map((record) => String(record).replaceAll('\r\n', '\n').replaceAll('\r', '\n')).join('\n');
}

test('fixture: text fingerprint serialization is newline-stable and delimiter-stable', () => {
  const lf = canonicalText(['body\nline', '42:2026-01-01T00:00:00Z:comment']);
  const crlf = canonicalText(['body\r\nline', '42:2026-01-01T00:00:00Z:comment']);
  assert.equal(lf, crlf, 'CRLF input must hash identically to LF input');
  assert.equal(lf.endsWith('\n'), false, 'no trailing separator');
  assert.equal(
    crypto.createHash('sha256').update(Buffer.from(lf, 'utf8')).digest('hex'),
    crypto.createHash('sha256').update(Buffer.from(crlf, 'utf8')).digest('hex'),
  );
});

// CL-D28 is mode-scoped: Issue/review-only still deny publication, while the
// exact PR autofix token approves only CL-D30's bounded actions. Prose obligations
// live in the clause manifest, but unqualified stale rules require negative
// assertions because a manifest cannot express their absence.
const PR_SKILL = 'skills/closed-loop-pr/SKILL.md';
const PR_REVIEW_ONLY = 'skills/closed-loop-pr/references/review-only.md';
const PR_AUTOFIX = 'skills/closed-loop-pr/references/autofix.md';
const PR_PUBLICATION_TEMPLATE = 'skills/closed-loop-pr/references/publish-review.sh';
const PR_ARTIFACTS = [PR_SKILL, PR_REVIEW_ONLY, PR_AUTOFIX];
const readPrMode = (reference) => [PR_SKILL, reference].map(readText).join('\n');
const ENTRY_ARTIFACTS = [
  'skills/closed-loop-issue/SKILL.md',
  ...PR_ARTIFACTS,
  'prompts/tidd-issue.md',
  'prompts/tidd-pr.md',
];

// Superseded rules must not survive beside their replacements. Three times a
// contradiction reached review because the clause literal was satisfied by the
// stale half of the document: the mode grammar stated twice, publication offered
// after its removal, and external resume restored after it was withdrawn. A
// clause proves a rule is present; nothing proves an obsolete rule is gone
// unless it is named. Retired phrasings go here.

function artifactSection(text, heading) {
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

const SUPERSEDED = [
  { files: ENTRY_ARTIFACTS, pattern: /after explicit approval/i,
    reason: 'only exact PR autofix token grants bounded CL-D30 publication' },
  { files: ENTRY_ARTIFACTS, pattern: /without explicit approval/i,
    reason: 'only exact PR autofix token grants bounded CL-D30 publication' },
  { files: ENTRY_ARTIFACTS, pattern: /when publication is (granted|authorized)/i,
    reason: 'only exact PR autofix token grants bounded CL-D30 publication' },
  { files: ENTRY_ARTIFACTS, pattern: /require the separate run-scoped publication grant/i,
    reason: 'only exact PR autofix token grants bounded CL-D30 publication' },
  { files: PR_ARTIFACTS, pattern: /observation origin is part of resumable state/i,
    reason: 'external evidence is no longer carried across runs' },
  { files: PR_ARTIFACTS, pattern: /a resume against the same head restores/i,
    reason: 'external evidence is no longer carried across runs' },
  { files: ENTRY_ARTIFACTS, pattern: /whose only inputs are repository files/i,
    reason: 'the RED classes are separated by what a test does, not by where its inputs come from' },
  { files: [
      'skills/closed-loop-issue/SKILL.md',
      ...PR_ARTIFACTS,
      'CONTRACT.md',
    ], pattern: /produce (?:a )?counterexample from ground-truth files for each/i,
    reason: 'CL-D29 requires falsification attempts and actual cited counterexamples, not one invented counterexample per claim' },
  { files: [
      'skills/closed-loop-issue/SKILL.md',
      ...PR_ARTIFACTS,
      'CONTRACT.md',
    ], pattern: /survives (?:the check )?as (?:a )?finding/i,
    reason: 'CL-D29 makes no counterexample neither a finding nor proof' },
];

test('Issue #41 publication authority remains review-only-owned and aggregate-only', () => {
  const reviewOnly = readText(PR_REVIEW_ONLY);
  const autofix = readText(PR_AUTOFIX);
  const shared = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.match(reviewOnly, /Guarded owner publication artifacts \(CL-D33, Issue #41\)/);
  assert.match(reviewOnly, /CL-D33 aggregate-summary publication is optional/);
  assert.match(reviewOnly, /not a locally drafted correction candidate/);
  assert.match(reviewOnly, /never blocks `MERGE_READY`/);
  assert.match(reviewOnly, /does not create `WAITING_FOR_OWNER`/);
  assert.match(reviewOnly, /only an outstanding readiness-relevant unpublished correction candidate has that effect/);
  assert.match(reviewOnly, /Review-only never executes the script/);
  assert.match(readText(PR_PUBLICATION_TEMPLATE), /aggregate-summary publication only|Issue #40 source-reply authority/);
  assert.match(readText(PR_PUBLICATION_TEMPLATE), /gh pr comment <full-pr-url> --body-file <review-comment\.md>/);
  assert.doesNotMatch(autofix, /publish-review\.sh|review-publication:v1/);
  assert.doesNotMatch(shared, /publish-review\.sh|review-publication:v1/);
});

test('Issue #41 optional aggregate publication does not block readiness', () => {
  const reviewOnly = readText(PR_REVIEW_ONLY);
  assert.match(reviewOnly, /CL-D33 aggregate-summary publication is optional[\s\S]*never blocks `MERGE_READY`[\s\S]*does not create `WAITING_FOR_OWNER`/);
  assert.match(reviewOnly, /only an outstanding readiness-relevant unpublished correction candidate has that effect/);
  assert.doesNotMatch(reviewOnly, /any outstanding operator publication action ends at `WAITING_FOR_OWNER`/);
});

test('entry artifacts preserve the scoped CL-D30 boundary', () => {
  const skill = readText(PR_AUTOFIX);
  assert.match(skill, /This addendum is selected only when.*exactly `autofix`/s);
  assert.doesNotMatch(skill, /Review-only retains the preceding/);
  assert.match(skill, /one bounded normal commit/);
  assert.match(skill, /one non-force push/);
  assert.match(skill, /five successful correction pushes/);
  assert.match(skill, /one bounded batch for the currently reviewed public head\/gate result/);
  assert.match(skill, /parent is the only GitHub comment actor/);
  assert.doesNotMatch(skill, /valid pasted resume status|dirty candidate tree/);
  assert.doesNotMatch(skill, /This MVP never posts|This MVP does not commit|Draft it; never post it/);
  assert.doesNotMatch(skill, /any drafted operator action is still outstanding.*MERGE_READY/s);
  assert.doesNotMatch(skill, /autofix.*does not by itself authorize/s);
  const contract = readText('CONTRACT.md');
  assert.match(contract, /## CL-D28 — Mode-scoped publication boundary/);
  assert.match(contract, /exact PR `autofix` token itself supplies the run-scoped grant only for CL-D30/);
  assert.match(contract, /## AC-AUTOFIX — Autofix token grants only bounded CL-D30 actions/);
  assert.match(contract, /## AC-GRANT — Run-scoped bounded publication grant/);
  assert.match(contract, /PR review-only still never commits, pushes, posts/);
  assert.match(contract, /During CL-D31 only, exact same-session approval authorizes at most one optional current-repository Issue body PATCH followed by one exact ledger POST/);
  assert.match(contract, /Exact PR `autofix` may post only `REPLY_EXCEPTION`/);
  assert.doesNotMatch(contract, /this MVP never posts/i);
  assert.doesNotMatch(contract, /## CL-D28 — The MVP does not publish/);
  assert.doesNotMatch(contract, /## AC-AUTOFIX — Autofix is file-mutation permission only/);
  assert.doesNotMatch(contract, /This MVP does not exercise it \(CL-D28\)/);
  const readme = readText('README.md');
  assert.match(readme, /PR review-only retains the legacy resumable `tidd-status`/);
  assert.match(readme, /Exact PR `autofix` ends/);
});

test('fixture: PR mode references own downstream obligations exclusively', () => {
  const reviewOnly = readText(PR_REVIEW_ONLY);
  const autofix = readText(PR_AUTOFIX);
  const reviewOwned = [
    'Review-only never edits any repository file or creates a working-tree candidate.',
    'Review-only has no publication phase and no local commit/push window.',
    'Review-only never commits, pushes, posts, replies, or mutates external state.',
    'A missing or unparsable verdict is a tool-level failure: retry the invocation once',
  ];
  const autofixOwned = [
    'Exact PR `autofix` submits only the published public-head OID',
    'Only the exact PR `autofix` mode token supplies a run-scoped publication grant',
    'Exact PR `autofix` never resumes: a later command is a fresh run.',
    'Exact autofix malformed or unparsable verdict stops on first failure.',
  ];
  for (const text of reviewOwned) assert.ok(reviewOnly.includes(text), `review-only must retain ${text}`);
  for (const text of autofixOwned) assert.ok(autofix.includes(text), `autofix must retain ${text}`);
  assert.doesNotMatch(autofix, /Review-only never edits any repository file/);
  assert.doesNotMatch(autofix, /Review-only has no publication phase/);
  assert.doesNotMatch(autofix, /Review-only never commits, pushes, posts, replies/);
  assert.doesNotMatch(reviewOnly, /Exact PR `autofix` submits only the published public-head OID/);
  assert.doesNotMatch(reviewOnly, /Only the exact PR `autofix` mode token supplies a run-scoped publication grant/);
  assert.doesNotMatch(reviewOnly, /Exact autofix malformed or unparsable verdict stops on first failure/);
});

test('contract scopes the exact provider-mutation exceptions', () => {
  const contract = readText('CONTRACT.md');
  const autofix = artifactSection(contract, '## AC-AUTOFIX — Autofix token grants only bounded CL-D30 actions');
  const grant = artifactSection(contract, '## AC-GRANT — Run-scoped bounded publication grant');
  const exceptions = 'provider mutation other than `REPLY_EXCEPTION` and CL-D31 optional body PATCH/ledger POST';
  for (const [name, section] of [['AC-AUTOFIX', autofix], ['AC-GRANT', grant]]) {
    assert.ok(section, `${name} section must exist for provider-mutation protection`);
    assert.ok(section.includes(exceptions), `${name} must preserve only the exact scoped provider-mutation exceptions`);
    assert.doesNotMatch(section, /does not authorize[^.]*provider mutation\./s, `${name} must not restore an unqualified provider-mutation prohibition`);
  }
});

test('provider mutation exceptions remain scoped in PR Skills', () => {
  const shared = readText('skills/closed-loop-shared/references/gate-contract.md');
  const skill = readPrMode(PR_AUTOFIX);
  const language = artifactSection(shared, '## Language Profile (CL-D16)');
  const autofix = artifactSection(skill, '## Autofix (AC-AUTOFIX, CL-D3, CL-D4, CL-D10)');
  const publication = artifactSection(skill, '## Publication (AC-GRANT, CL-D28, CL-D30)');
  const replies = artifactSection(skill, '### Source-finding replies and final readiness');
  assert.ok(language, 'shared Language Profile section must exist for provider-mutation protection');
  assert.doesNotMatch(language, /`REPLY_EXCEPTION`/, 'shared Language Profile must not acquire PR-mode mutation authority');
  for (const [name, section] of [['Autofix', autofix], ['Publication', publication]]) {
    assert.ok(section, `${name} section must exist for provider-mutation protection`);
    assert.match(section, /`REPLY_EXCEPTION`/);
    assert.doesNotMatch(section, /(?:neither mode|does not authorize|never authorizes)[^.]*provider(?:-specific| mutation|[- ]side)[^.]*\./s, `${name} restores an unqualified provider-mutation prohibition`);
  }
  assert.equal((skill.match(/^- `REPLY_EXCEPTION` :=/gm) || []).length, 1);
  assert.ok(replies, 'Source-finding replies section must exist for provider-mutation protection');
  assert.match(replies, /Replies never approve, request rereview, resolve threads, or invoke bot commands; provider mutation is exactly `REPLY_EXCEPTION`\./);
  assert.doesNotMatch(replies, /Replies never approve, request rereview, resolve threads, invoke bot commands, or mutate provider state\./);
  const prompt = readText('prompts/tidd-pr.md');
  assert.doesNotMatch(prompt, /REPLY_EXCEPTION|Issue mutation|provider mutation/);
});

// Co-developed compile/contract coverage for Issue #22; this inspects artifact placement,
// not runtime model compliance, and is not behavioral RED evidence.
test('Issue #22 prompts contain no retired workflow restatements', () => {
  const issuePrompt = readText('prompts/tidd-issue.md');
  const prPrompt = readText('prompts/tidd-pr.md');
  for (const [name, prompt, forbidden] of [
    ['Issue', issuePrompt, /CL-D31|CL-D32|equivalent entrypoints|owner-gated candidate publication|no-retry|foreign-repository|scope-freeze/i],
    ['PR', prPrompt, /CL-D6|AC-REVIEW-ONLY|case-sensitive|final exact token|do not edit|successful correction pushes|REPLY_EXCEPTION|Issue mutation|force-push|history rewriting/i],
  ]) {
    assert.doesNotMatch(prompt, forbidden, `${name} prompt contains workflow-owned prose`);
    assert.match(prompt, /Raw arguments \(preserve this complete vector for the Skill to parse\): \$@/);
    assert.match(prompt, /authoritative contract/);
  }
});

test('no superseded rule survives beside its replacement', () => {
  for (const { files, pattern, reason } of SUPERSEDED) {
    for (const file of files) {
      assert.doesNotMatch(readText(file), pattern, `${file} still carries a retired rule: ${reason}`);
    }
  }
});

test('exact-autofix Luna ownership is protected within its authored sections', () => {
  const skill = readText(PR_AUTOFIX);
  const writer = artifactSection(skill, '### The writer (CL-D3)');
  const addendum = artifactSection(skill, '## Exact PR `autofix` addendum (CL-D30)');
  const exactOwner = artifactSection(skill, '### Exact owner and safety boundary (CL-D30)');
  const contract = artifactSection(readText('CONTRACT.md'), '## CL-D3 — Writer selection');
  const readmeAutofix = artifactSection(readText('README.md'), '### Autofix');
  for (const [name, section] of [['Skill writer', writer], ['Skill addendum', addendum], ['Skill exact owner boundary', exactOwner], ['CONTRACT CL-D3', contract], ['README Autofix', readmeAutofix]]) {
    assert.ok(section, `${name} section must exist for scoped protection`);
  }
  assert.match(writer, /For exact `\/tidd-pr \.\.\. autofix`, `luna-worker` is mandatory/);
  assert.match(writer, /sole correction writer and publisher/);
  assert.match(exactOwner, /exact-autofix writer is not replaceable/);
  assert.match(exactOwner, /always `luna-worker`/);
  assert.match(exactOwner, /ends there and has no resume/);
  assert.match(contract, /For exact PR `autofix`, `luna-worker` is the mandatory and sole correction writer\/publisher/);
  assert.match(readmeAutofix, /`luna-worker` is always the mandatory sole writer\/publisher/);
  for (const [name, section] of [['Skill writer', writer], ['Skill exact owner boundary', exactOwner], ['CONTRACT CL-D3', contract], ['README Autofix', readmeAutofix]]) {
    assert.doesNotMatch(section, /default writer|default autofix writer|`luna-worker` by default|Choosing a different worker requires an explicit owner instruction|Selecting an alternate worker requires an explicit owner instruction/i, `${name} restores replaceable exact-autofix wording`);
  }
});

// The following is a deterministic, non-authoritative reference model. It
// executes intended artifact semantics only; it cannot prove LLM runtime behavior.
function gateSuccess(gate, head, verdict = 'MERGE') {
  return { gate, head, verdict, next: verdict === 'MERGE' ? (gate === 'sol' ? 'terra' : 'final') : verdict === 'FIX BEFORE MERGE' ? 'luna' : 'stop' };
}
function publishedCorrection(parent = 'P', child = 'C') {
  return { parent, head: child, solApproval: false, terraApproval: false, restart: 'sol' };
}
function pushResult({ accepted = true, ambiguous = false } = {}) {
  if (ambiguous) return { localCommit: true, remoteHead: 'unknown', retry: false, retryAttempts: 0, cleanupMutations: 0, laterGateMutations: 0, laterReplyMutations: 0, status: 'push_outcome_unknown' };
  return accepted ? { localCommit: true, remoteHead: 'C', retry: false } : { localCommit: true, remoteHead: 'P', retry: false, retryAttempts: 0, cleanupMutations: 0, status: 'local_commit_unpushed' };
}
function correctionBatch(findings) {
  return { tasks: findings.length ? 1 : 0, commits: findings.length ? 1 : 0, pushes: findings.length ? 1 : 0 };
}
const GATE_ENUM = new Set(['sol', 'terra']);
const DISPOSITION_ENUM = new Set(['fixed', 'accepted-as-designed', 'deferred', 'duplicate', 'not-applicable', 'needs-owner-decision']);
const CONFIRMATION_ENUM = new Set(['confirmed', 'rejected', 'unverifiable']);
function expectedConfirmationGates(finding) {
  return finding.confirmationGate === 'both' ? ['sol', 'terra'] : [finding.confirmationGate];
}
function confirmationTuple(record) {
  return `${record.findingId}:${record.blockerKey}:${record.headOid}:${record.proposedDisposition}:${record.gate}`;
}
function confirmationRecordsValid(records, assignedFindings = []) {
  if (!Array.isArray(records) || !Array.isArray(assignedFindings)) return false;
  const assignedIds = new Set();
  const expected = new Set();
  for (const finding of assignedFindings) {
    if (!finding || !finding.findingId || assignedIds.has(finding.findingId) || !finding.blockerKey || !finding.headOid || !DISPOSITION_ENUM.has(finding.proposedDisposition) || (finding.confirmationGate !== 'both' && !GATE_ENUM.has(finding.confirmationGate))) return false;
    assignedIds.add(finding.findingId);
    for (const gate of expectedConfirmationGates(finding)) expected.add(`${finding.findingId}:${finding.blockerKey}:${finding.headOid}:${finding.proposedDisposition}:${gate}`);
  }
  if (assignedFindings.length && records.length !== expected.size) return false;
  const seen = new Set();
  for (const record of records) {
    if (!record || !record.findingId || !record.blockerKey || !GATE_ENUM.has(record.gate) || !record.headOid || !DISPOSITION_ENUM.has(record.proposedDisposition) || !CONFIRMATION_ENUM.has(record.confirmation) || !record.evidence) return false;
    if (assignedFindings.length && !assignedIds.has(record.findingId)) return false;
    const tuple = confirmationTuple(record);
    if (seen.has(tuple) || (assignedFindings.length && !expected.has(tuple))) return false;
    seen.add(tuple);
  }
  return !assignedFindings.length || seen.size === expected.size;
}
function confirmation(finding, records, assignedFindings = [finding]) {
  if (!finding.findingId || !confirmationRecordsValid(records, assignedFindings)) return false;
  const matching = records.filter((record) => record.findingId === finding.findingId && record.blockerKey === finding.blockerKey && record.headOid === finding.headOid && record.proposedDisposition === finding.proposedDisposition);
  const expectedGates = expectedConfirmationGates(finding);
  if (matching.length !== expectedGates.length || !expectedGates.every((gate) => matching.some((record) => record.gate === gate))) return false;
  const gates = new Set(matching.filter((record) => record.confirmation === 'confirmed').map((record) => record.gate));
  return expectedGates.every((gate) => gates.has(gate));
}
function noProgressObservation(records) {
  return new Set(records.map((record) => record.blockerKey)).size;
}
function noProgressHistory(observations) {
  const count = new Map();
  const seen = new Set();
  for (const observation of observations) {
    const owner = observation.breakerOwner || 'shared';
    if (owner === 'sol' && observation.gate !== 'sol') continue;
    if (owner === 'terra' && observation.gate !== 'terra') continue;
    const key = `${observation.blockerKey}:${owner}`;
    const resultKey = `${observation.resultId || `${observation.gate || 'gate'}:${observation.blockerKey}`}:${key}`;
    if (!seen.has(resultKey)) {
      seen.add(resultKey);
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  return count;
}
function breaker(stage, { gates = 0, pushes = 0, observations = 0, safety = false, owner = false, policy = 'success' } = {}) {
  if (stage === 'gate' && gates >= 15) return 'ROUND_LIMIT_REACHED:gate_limit';
  if (stage === 'correction' && pushes >= 5) return 'ROUND_LIMIT_REACHED:push_limit';
  if (safety) return 'BLOCKED:safety';
  if (observations >= 3) return 'ROUND_LIMIT_REACHED:no_progress';
  if (owner) return 'WAITING_FOR_OWNER:owner_decision_required';
  if (policy === 'pending') return 'WAITING_EXTERNAL_REVIEW:required_checks_pending';
  if (policy === 'failed' || policy === 'ambiguous') return 'BLOCKED:policy';
  return 'continue';
}
function validationResult({ changed = true, unauthorized = false, unexpectedValidationMutation = false } = {}) {
  if (!changed || unauthorized || unexpectedValidationMutation) return { status: 'validation_failed', mutations: { commit: 0, push: 0, cleanup: 0, retry: 0 } };
  return { status: 'validated', mutations: { commit: 0, push: 0, cleanup: 0, retry: 0 } };
}
function publicationPhase({ phase, parent = 'P', localHead = 'P', remote = 'P', repository = 'R', expectedRepository = 'R', pr = 10, expectedPr = 10, base = 'B', expectedBase = 'B', lifecycle = 'open-nondraft', expectedLifecycle = 'open-nondraft', headRepo = 'R', expectedHeadRepo = 'R', headBranch = 'feature', expectedHeadBranch = 'feature', localBranch = 'feature', checkoutHead = 'P', expectedCheckoutHead = 'P', indexMatchesManifest = true, unstagedEmpty = true, untrackedEmpty = true, fullyClean = true, manifestParent = 'P', stagedTree = 'manifest', manifestTree = 'manifest', indexTree = 'manifest', manifestInventory = 'paths', indexInventory = 'paths', commitInventory = 'paths', commitParent = 'P', commitTree = 'manifest', tree = 'manifest', candidate = 'C' } = {}) {
  const identity = repository === expectedRepository && pr === expectedPr && base === expectedBase && lifecycle === expectedLifecycle && headRepo === expectedHeadRepo && headBranch === expectedHeadBranch;
  const requiredCheckoutHead = phase === 'push' ? candidate : expectedCheckoutHead;
  const checkout = localBranch === expectedHeadBranch && checkoutHead === requiredCheckoutHead;
  const clean = fullyClean && unstagedEmpty && untrackedEmpty;
  if (phase === 'edit' || phase === 'gate' || phase === 'reply' || phase === 'final' || phase === 'summary') {
    return identity && checkout && localHead === parent && remote === parent && clean ? phase : `BLOCKED:${phase}_guard`;
  }
  if (phase === 'commit') return identity && checkout && localHead === parent && remote === parent && manifestParent === parent && stagedTree === manifestTree && indexTree === manifestTree && indexInventory === manifestInventory && indexMatchesManifest && unstagedEmpty && untrackedEmpty ? 'commit' : 'BLOCKED:commit_guard';
  if (phase === 'push') return identity && checkout && localHead === candidate && commitParent === parent && remote === parent && commitTree === manifestTree && commitInventory === manifestInventory && tree === manifestTree && clean ? 'push' : 'BLOCKED:push_guard';
  return 'BLOCKED:unknown_phase';
}
function blockedEffects(result) {
  return result.startsWith('BLOCKED:') ? { commit: 0, push: 0, cleanup: 0, retry: 0 } : { commit: 1, push: result === 'push' ? 1 : 0, cleanup: 0, retry: 0 };
}
function replyMarkerMatches(expected, observed) {
  return expected.source === observed.source && expected.bodyDigest === observed.bodyDigest && expected.head === observed.head;
}
function replyOutcome({ destination = true, markerVisible = false, attempted = false, ambiguous = false } = {}) {
  if (!destination && !attempted) return 'reply_not_applicable';
  if (attempted && ambiguous) return 'reply_outcome_unknown';
  if (markerVisible) return 'already_marked';
  return 'reply_allowed';
}
function replyAttempt({ priorReplies = 0, ambiguous = false } = {}) {
  return ambiguous ? { priorReplies, attempts: 1, posted: 'unknown', retry: false, retryAttempts: 0, additionalReplies: 0, cleanupMutations: 0, status: 'reply_outcome_unknown' } : { priorReplies, attempts: 1, posted: 1, retry: false, additionalReplies: 1, status: 'reply_posted' };
}
function finalClassification({ newActionableEvidence = false } = {}) {
  return newActionableEvidence ? 'sol' : 'final';
}
function evidenceRoute(boundary, newActionableEvidence) {
  if ((boundary === 'before-terra' || boundary === 'final-before-replies' || boundary === 'final-after-replies') && newActionableEvidence) return 'sol';
  return boundary === 'before-terra' ? 'terra' : 'final';
}
function replyBatch(findings, confirmed) {
  const order = [...findings].sort();
  return findings.every((finding) => confirmed.includes(finding)) ? { replies: 1, order } : { replies: 0, order };
}
function gateWithFindings(findings, confirmed) {
  return { verdict: findings.every((finding) => confirmed.includes(finding)) ? 'MERGE' : 'FIX BEFORE MERGE', replyable: confirmed.filter((finding) => findings.includes(finding)) };
}
function replyBodyValid({ disposition, commit = null, gate, head, validation, claimsWholeReady = false, finalReady = false } = {}) {
  return Boolean(disposition && gate && head && validation && (commit === null || commit) && (!claimsWholeReady || finalReady));
}
function summaryApproval(expected, provided) {
  const fields = ['repository', 'pr', 'open', 'draft', 'base', 'headRepository', 'headBranch', 'head', 'destinationLanguage', 'destination', 'bodyBytes', 'bodyLength', 'bodyDigest', 'action'];
  return fields.every((field) => provided[field] !== undefined && provided[field] === expected[field]) && provided.action === 'one-comment';
}
function summaryPost({ approved = false } = {}) {
  return approved ? 'posted' : 'draft';
}
function summaryAttempt({ approved = false, ambiguous = false } = {}) {
  if (!approved) return { status: 'draft', attempts: 0, posted: 0, retryAttempts: 0 };
  if (ambiguous) return { status: 'summary_outcome_unknown', attempts: 1, posted: 'unknown', retryAttempts: 0 };
  return { status: 'posted', attempts: 1, posted: 1, retryAttempts: 0 };
}
function completionReport({ readiness = 'MERGE_READY', draft = 'aggregate summary body' } = {}) {
  return { readiness, proposedSummaryDraft: draft, workflowState: false, postingActions: 0 };
}
function policyOutcome(kind) {
  if (kind === 'absent' || kind === 'pending' || kind === 'missing-approval') return 'WAITING_EXTERNAL_REVIEW';
  if (kind === 'failed' || kind === 'changes-requested' || kind === 'ambiguous') return 'BLOCKED';
  return 'pass';
}

const SCENARIOS = [
  ['01 Sol fix publishes P->C and restarts at Sol', () => assert.deepEqual({ ...publishedCorrection(), route: [gateSuccess('sol', 'P', 'FIX BEFORE MERGE').next, 'sol'] }, { parent: 'P', head: 'C', solApproval: false, terraApproval: false, restart: 'sol', route: ['luna', 'sol'] })],
  ['02 Terra fix publishes P->C and restarts at Sol', () => assert.deepEqual({ ...publishedCorrection(), route: [gateSuccess('terra', 'P', 'FIX BEFORE MERGE').next, 'sol'] }, { parent: 'P', head: 'C', solApproval: false, terraApproval: false, restart: 'sol', route: ['luna', 'sol'] })],
  ['03 grouped corrections and multi-finding gate confirmations use one batch', () => { const a = { findingId: 'a', blockerKey: 'ba', headOid: 'P', confirmationGate: 'sol', proposedDisposition: 'fixed' }; const b = { findingId: 'b', blockerKey: 'bb', headOid: 'P', confirmationGate: 'sol', proposedDisposition: 'fixed' }; const records = [{ ...a, gate: 'sol', confirmation: 'confirmed', evidence: 'a' }, { ...b, gate: 'sol', confirmation: 'confirmed', evidence: 'b' }]; assert.equal(confirmation(a, records, [a, b]), true); assert.equal(confirmation(b, records, [a, b]), true); assert.deepEqual({ ...correctionBatch(['b', 'a']), ...replyBatch(['b', 'a'], ['a', 'b']) }, { tasks: 1, commits: 1, pushes: 1, replies: 1, order: ['a', 'b'] }); }],
  ['04 rejected no-code remains open for correction/owner decision', () => assert.equal(confirmation({ findingId: 'f', blockerKey: 'b', headOid: 'H', confirmationGate: 'sol', proposedDisposition: 'accepted-as-designed' }, [{ findingId: 'f', blockerKey: 'b', gate: 'sol', headOid: 'H', proposedDisposition: 'accepted-as-designed', confirmation: 'rejected', evidence: 'e' }]), false)],
  ['05 one finding replies while same gate remains FIX for another with complete body', () => { assert.deepEqual(gateWithFindings(['a', 'b'], ['a']), { verdict: 'FIX BEFORE MERGE', replyable: ['a'] }); assert.equal(replyBodyValid({ disposition: 'fixed', commit: 'C', gate: 'sol', head: 'H', validation: 'tests-pass' }), true); assert.equal(replyBodyValid({ disposition: 'fixed', gate: 'sol', head: 'H' }), false); assert.equal(replyBodyValid({ disposition: 'fixed', commit: 'C', gate: 'sol', head: 'H', validation: 'tests-pass', claimsWholeReady: true, finalReady: false }), false); }],
  ['06 both requires valid same-head Sol and Terra confirmations', () => assert.equal(confirmation({ findingId: 'f', blockerKey: 'b', headOid: 'H', confirmationGate: 'both', proposedDisposition: 'fixed' }, [{ findingId: 'f', blockerKey: 'b', gate: 'sol', headOid: 'H', proposedDisposition: 'fixed', confirmation: 'confirmed', evidence: 'sol' }]), false)],
  ['07 new evidence before Terra and both final snapshots routes Sol', () => assert.deepEqual([evidenceRoute('before-terra', true), evidenceRoute('final-before-replies', true), evidenceRoute('final-after-replies', true)], ['sol', 'sol', 'sol'])],
  ['08 only exact source/body/head markers are intake-excluded', () => { const expected = { source: 'S', bodyDigest: 'B', head: 'H' }; assert.equal(replyMarkerMatches(expected, { source: 'S', bodyDigest: 'B', head: 'H' }), true); assert.equal(replyMarkerMatches(expected, { source: 'S', bodyDigest: 'partial', head: 'H' }), false); assert.equal(replyOutcome({ markerVisible: true }), 'already_marked'); }],
  ['09 no-op and any unexpected validation mutation stop before commit with no forbidden effects', () => { const noOp = validationResult({ changed: false }); const unauthorized = validationResult({ unauthorized: true }); const authorizedPathUnexpected = validationResult({ unexpectedValidationMutation: true }); const commitBlocked = publicationPhase({ phase: 'commit', unstagedEmpty: false }); assert.equal(noOp.status, 'validation_failed'); assert.equal(unauthorized.status, 'validation_failed'); assert.equal(authorizedPathUnexpected.status, 'validation_failed'); assert.deepEqual([noOp.mutations, unauthorized.mutations, authorizedPathUnexpected.mutations, blockedEffects(commitBlocked)], [{ commit: 0, push: 0, cleanup: 0, retry: 0 }, { commit: 0, push: 0, cleanup: 0, retry: 0 }, { commit: 0, push: 0, cleanup: 0, retry: 0 }, { commit: 0, push: 0, cleanup: 0, retry: 0 }]); }],
  ['10 push failure leaves local commit and stops without retry/cleanup', () => assert.deepEqual(pushResult({ accepted: false }), { localCommit: true, remoteHead: 'P', retry: false, retryAttempts: 0, cleanupMutations: 0, status: 'local_commit_unpushed' })],
  ['11 ambiguous push permits zero later gate/reply/cleanup/retry mutations', () => assert.deepEqual(pushResult({ ambiguous: true }), { localCommit: true, remoteHead: 'unknown', retry: false, retryAttempts: 0, cleanupMutations: 0, laterGateMutations: 0, laterReplyMutations: 0, status: 'push_outcome_unknown' })],
  ['12 unavailable reply destination is deterministic', () => assert.equal(replyOutcome({ destination: false }), 'reply_not_applicable')],
  ['13 attempted reply ambiguity preserves prior replies with one unknown attempt and no retry', () => assert.deepEqual(replyAttempt({ priorReplies: 1, ambiguous: true }), { priorReplies: 1, attempts: 1, posted: 'unknown', retry: false, retryAttempts: 0, additionalReplies: 0, cleanupMutations: 0, status: 'reply_outcome_unknown' })],
  ['14 pending required check waits', () => assert.equal(breaker('final', { policy: 'pending' }), 'WAITING_EXTERNAL_REVIEW:required_checks_pending')],
  ['15 exact 15/5/third boundaries and precedence', () => assert.deepEqual([breaker('gate', { gates: 14 }), breaker('gate', { gates: 15, safety: true }), breaker('correction', { pushes: 4 }), breaker('correction', { pushes: 5, safety: true }), breaker('final', { observations: 3, owner: true })], ['continue', 'ROUND_LIMIT_REACHED:gate_limit', 'continue', 'ROUND_LIMIT_REACHED:push_limit', 'ROUND_LIMIT_REACHED:no_progress'])],
  ['16 aggregate summary needs complete identity/language/body one-action approval and fail-stop', () => { const expected = { repository: 'R', pr: 10, open: true, draft: false, base: 'B', headRepository: 'R', headBranch: 'feature', head: 'H', destinationLanguage: 'en', destination: 'pr-comment', bodyBytes: 'body', bodyLength: 4, bodyDigest: 'D', action: 'one-comment' }; assert.equal(summaryApproval(expected, { repository: 'R', pr: 10, head: 'H' }), false); assert.equal(summaryApproval(expected, { ...expected, base: 'X' }), false); assert.equal(summaryApproval(expected, { ...expected, bodyDigest: 'partial' }), false); assert.equal(summaryApproval(expected, expected), true); assert.equal(summaryPost({ approved: summaryApproval(expected, expected) }), 'posted'); assert.deepEqual(summaryAttempt({ approved: true, ambiguous: true }), { status: 'summary_outcome_unknown', attempts: 1, posted: 'unknown', retryAttempts: 0 }); assert.deepEqual(summaryAttempt({ approved: false }), { status: 'draft', attempts: 0, posted: 0, retryAttempts: 0 }); assert.deepEqual(completionReport({ readiness: 'MERGE_READY' }), { readiness: 'MERGE_READY', proposedSummaryDraft: 'aggregate summary body', workflowState: false, postingActions: 0 }); }],
  ['17 full identity movement fails every boundary with zero cleanup/mutation', () => { const results = [publicationPhase({ phase: 'edit', repository: 'X' }), publicationPhase({ phase: 'commit', base: 'X' }), publicationPhase({ phase: 'push', headRepo: 'X' }), publicationPhase({ phase: 'reply', headBranch: 'other' }), publicationPhase({ phase: 'final', checkoutHead: 'X' }), publicationPhase({ phase: 'summary', lifecycle: 'closed' })]; assert.deepEqual(results, ['BLOCKED:edit_guard', 'BLOCKED:commit_guard', 'BLOCKED:push_guard', 'BLOCKED:reply_guard', 'BLOCKED:final_guard', 'BLOCKED:summary_guard']); assert.deepEqual(results.map(blockedEffects), results.map(() => ({ commit: 0, push: 0, cleanup: 0, retry: 0 }))); }],
  ['18 required check/review/policy outcomes fail closed', () => assert.deepEqual(['absent', 'pending', 'missing-approval', 'failed', 'changes-requested', 'ambiguous'].map(policyOutcome), ['WAITING_EXTERNAL_REVIEW', 'WAITING_EXTERNAL_REVIEW', 'WAITING_EXTERNAL_REVIEW', 'BLOCKED', 'BLOCKED', 'BLOCKED'])],
  ['19 confirmation records enforce exact one-to-one tuples and multiple assigned findings', () => { const base = { findingId: 'f', blockerKey: 'b', gate: 'sol', headOid: 'H', proposedDisposition: 'fixed', confirmation: 'confirmed', evidence: 'e' }; const both = { findingId: 'f', blockerKey: 'b', headOid: 'H', confirmationGate: 'both', proposedDisposition: 'fixed' }; const correct = [base, { ...base, gate: 'terra' }]; assert.equal(confirmation(both, correct), true); assert.equal(confirmation(both, [base]), false); assert.equal(confirmation(both, [base, { ...base, blockerKey: 'wrong', gate: 'terra' }]), false); assert.equal(confirmation(both, [base, { ...base, headOid: 'OLD', gate: 'terra' }]), false); assert.equal(confirmation(both, [base, { ...base, proposedDisposition: 'deferred', gate: 'terra' }]), false); assert.equal(confirmation(both, [base, { ...base, gate: 'terra' }, { ...base, gate: 'sol' }]), false); const solOnly = { findingId: 's', blockerKey: 'bs', headOid: 'H', confirmationGate: 'sol', proposedDisposition: 'fixed' }; const solRecord = { findingId: 's', blockerKey: 'bs', gate: 'sol', headOid: 'H', proposedDisposition: 'fixed', confirmation: 'confirmed', evidence: 's' }; assert.equal(confirmation(solOnly, [solRecord, { ...solRecord, gate: 'terra' }]), false); assert.equal(confirmationRecordsValid([{ ...base, gate: 'bad' }]), false); assert.equal(confirmationRecordsValid([{ ...base, proposedDisposition: 'bad' }]), false); assert.equal(confirmationRecordsValid([{ ...base, blockerKey: undefined }]), false); assert.equal(confirmationRecordsValid([base, base]), false); const other = { findingId: 'g', blockerKey: 'bg', gate: 'sol', headOid: 'H', proposedDisposition: 'fixed', confirmation: 'confirmed', evidence: 'g' }; const assigned = { findingId: 'g', blockerKey: 'bg', headOid: 'H', confirmationGate: 'sol', proposedDisposition: 'fixed' }; assert.equal(confirmation(assigned, [other, ...correct], [assigned, both]), true); assert.equal(confirmation(assigned, [other], [assigned, both]), false); }],
  ['20 blockerKey x breakerOwner deduplicates within result but counts separate results', () => { const history = noProgressHistory([{ resultId: 'sol-1', blockerKey: 'owned', breakerOwner: 'sol', gate: 'terra' }, { resultId: 'sol-1', blockerKey: 'owned', breakerOwner: 'sol', gate: 'sol' }, { resultId: 'sol-1', blockerKey: 'owned', breakerOwner: 'sol', gate: 'sol' }, { resultId: 'shared-1', blockerKey: 'shared', breakerOwner: 'shared', gate: 'sol' }, { resultId: 'shared-1', blockerKey: 'shared', breakerOwner: 'shared', gate: 'sol' }, { resultId: 'shared-2', blockerKey: 'shared', breakerOwner: 'shared', gate: 'terra' }, { resultId: 'shared-3', blockerKey: 'shared', breakerOwner: 'shared', gate: 'sol' }]); assert.equal(history.get('owned:sol'), 1); assert.equal(history.get('shared:shared'), 3); assert.equal(breaker('final', { observations: history.get('shared:shared') }), 'ROUND_LIMIT_REACHED:no_progress'); assert.equal(noProgressObservation([{ blockerKey: 'shared' }, { blockerKey: 'shared' }]), 1); }],
  ['21 concurrent local dirtiness/staged race and post-commit checkout mismatch fail without cleanup/retry', () => { const results = [publicationPhase({ phase: 'gate', fullyClean: false }), publicationPhase({ phase: 'reply', fullyClean: false }), publicationPhase({ phase: 'edit', fullyClean: false }), publicationPhase({ phase: 'commit', indexMatchesManifest: false }), publicationPhase({ phase: 'commit', indexTree: 'raced' }), publicationPhase({ phase: 'push', checkoutHead: 'P' })]; assert.deepEqual(results, ['BLOCKED:gate_guard', 'BLOCKED:reply_guard', 'BLOCKED:edit_guard', 'BLOCKED:commit_guard', 'BLOCKED:commit_guard', 'BLOCKED:push_guard']); assert.equal(publicationPhase({ phase: 'push', localHead: 'C', checkoutHead: 'C' }), 'push'); assert.deepEqual(results.map(blockedEffects), results.map(() => ({ commit: 0, push: 0, cleanup: 0, retry: 0 }))); }],
  ['22 mode-gated supersession preserves Issue and review-only artifacts', () => { const skill = readText(PR_AUTOFIX); assert.match(skill, /final raw argument token is exactly `autofix`/); assert.doesNotMatch(readText(PR_REVIEW_ONLY), /Exact PR `autofix`/); assert.doesNotMatch(readText('skills/closed-loop-issue/SKILL.md'), /CL-D30|LUNA_CORRECT_VALIDATE_COMMIT_PUSH/); assert.doesNotMatch(readText('prompts/tidd-issue.md'), /CL-D30|LUNA_CORRECT_VALIDATE_COMMIT_PUSH/); }],
];

test('fixture: all 22 Issue #10 acceptance scenarios execute against the reference model', () => {
  assert.equal(SCENARIOS.length, 22);
  for (const [name, scenario] of SCENARIOS) assert.doesNotThrow(scenario, name);
});

test('artifact assertions cover exact autofix safety records and remain non-authoritative', () => {
  const skill = readPrMode(PR_AUTOFIX);
  for (const required of [
    '`CLEAN@H` :=', '`POST_COMMIT(C, P)` :=', '`REPLY_EXCEPTION` :=',
    'no untracked path exists outside', 'C` has sole parent `P`',
    'tracked worktree, index, and `unstaged` are clean', 'deliberately does not require local and public head equality',
    'Deduplicate `blockerKey × breakerOwner` values within each completed owner-gate result',
    'A reply marker is bound to source identity', 'exact reply body/digest', 'exact public head',
    'required app/source identity', 'older-head thread', 'top-level status, praise, duplicate summary',
    'shared CL-D1 exact verdict vocabulary', 'CL-D2 invocation-payload duties', 'CL-D29 adversarial duties',
    'fresh independent Sol/Terra roles', 'review-evidence snapshot fingerprint',
    'head branch to be verified writable by a normal actor-authorized non-force push', 'The parent Luna payload contains',
    'run-local staged manifest is complete and immutable', 'parent `P`, staged tree OID',
    'every allowed path/status/mode and staged blob identity', 'index exactly equal to the immutable manifest',
    'source kind, source ID, source URL', 'preflight every planned destination and source',
    'Order the batch deterministically by source identity', 'destination language', 'any movement expires approval',
    'Luna repeats `CLEAN@P` immediately before its first edit',
    '`AFTER_COMMIT` immediately after commit', '`BEFORE_PUSH` immediately before push independently repeats `POST_COMMIT(C, P)`',
    'After verifying public head `C`, require `CLEAN@C`',
    'All three local dimensions remain independently guarded', 'tracked worktree, index, and untracked state outside `RUNTIME_ROOTS`',
    'pre-existing tracked unstaged edit is rejected', 'git log -1 --format=%B',
    'stored bytes/content exactly', 'expected approved message',
    'unexpected worktree or index mutation', 'regardless of path authorization', 'zero cleanup, retry, continuation, or mutation',
    'never claims that the whole PR is ready unless final readiness has independently been reached',
    'parent must create and report the proposed aggregate final-summary body/draft',
    'The draft is not workflow state', 'declining or not posting it never blocks readiness',
    'Before any exact-autofix edit', 'security/risk', 'always stops at `WAITING_FOR_OWNER(reason=owner_decision_required)`',
    'A security or risk finding cannot be delegated', 'The run ends at that boundary with no resume',
    'branch-protection or ruleset bypass', 'normal actor-authorized non-force push without',
    'missing, rejected, ambiguous, unavailable, or bypass-dependent result fails closed',
  ]) assert.ok(skill.includes(required), `missing exact safety artifact: ${required}`);
  assert.doesNotMatch(skill, /before gate invocation 15|at five successful pushes/);
  assert.doesNotMatch(skill, /immediately before push[^.]*local `HEAD` is public parent `P`/s);
  assert.match(skill, /via `git commit -F`/);
  assert.match(skill, /no literal `\\\\n`/);
});

test('shared baseline disposition and decision records remain protected in both workflow authority graphs', () => {
  const enumBlock = 'fixed\\naccepted-as-designed\\ndeferred\\nduplicate\\nnot-applicable\\nneeds-owner-decision';
  const decisionBlock = 'Decision ID\\nKind\\nTarget and revision\\nQuestion\\nOptions and trade-offs\\nRecommendation\\nOwner choice\\nRationale\\nValidity and invalidation conditions';
  const shared = readText('skills/closed-loop-shared/references/records.md').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  assert.ok(shared.includes(enumBlock.replaceAll('\\n', '\n')));
  assert.ok(shared.includes(decisionBlock.replaceAll('\\n', '\n')));
  for (const file of ['skills/closed-loop-issue/SKILL.md', PR_SKILL]) assert.match(readText(file), /shared references/);
});


test('Issue #23 contains self-contained invariant blocks and compacts only history projection', () => {
  const shared = readText('skills/closed-loop-shared/references/gate-contract.md');
  const contract = readText('CONTRACT.md');
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  const pr = readText(PR_SKILL);
  const review = readText(PR_REVIEW_ONLY);
  const autofix = readText(PR_AUTOFIX);
  const issueRoles = artifactSection(issue, '### Issue gate role-authority blocks (CL-D2)');
  const prRoles = artifactSection(pr, '### PR gate role-authority blocks (CL-D2)');
  const container = artifactSection(shared, '### Run-invariant payload blocks (CL-D2, CL-D29)');
  const every = artifactSection(shared, '#### Every-gate invariant payload block (CL-D2)');
  const sol = artifactSection(shared, '#### Sol-only adversarial invariant payload block (AC-ADVERSARIAL-payload, CL-D29)');
  assert.ok(container && every && sol && issueRoles && prRoles);
  assert.match(issueRoles, /Issue Sol role-authority block.*read-only Issue requirements/s);
  assert.match(issueRoles, /Issue Terra role-authority block.*read-only inherited-decision/s);
  assert.match(prRoles, /PR Sol role-authority block.*read-only PR requirements/s);
  assert.match(prRoles, /PR Terra role-authority block.*read-only concurrency/s);
  assert.match(container, /#### Every-gate invariant payload block \(CL-D2\)/);
  assert.match(container, /#### Sol-only adversarial invariant payload block \(AC-ADVERSARIAL-payload, CL-D29\)/);
  assert.match(every, /MERGE \| FIX BEFORE MERGE \| NEEDS DECISION/);
  assert.match(every, /The formal gate child is read-only/);
  assert.match(every, /verdict must be the final line/);
  assert.match(sol, /every initial Sol invocation and every Sol re-invocation/);
  assert.match(sol, /attempt falsification against the authoritative files of the repository under review/);
  assert.match(sol, /actual cited counterexample disproving the claim/);
  assert.equal((shared.match(/Treat the exact target body \(the Issue or pull-request body as applicable\)/g) || []).length, 1);
  assert.match(container, /include each applicable block verbatim in every applicable invocation/);
  assert.match(container, /Defining them once does not reduce the transmitted size of any invariant block/);
  assert.match(shared, /stable finding ID, source gate, raised-against identity or fingerprint, disposition, confirmation gate or evidence/);
  assert.match(shared, /counts grouped by settled disposition/);
  assert.doesNotMatch(shared, /finding ID, blocker key, source gate, raised-against identity/);
  assert.match(contract, /DEC-I23-PAYLOAD-COMPACTION-001/);
  assert.match(contract, /does not reduce the transmitted size of any invariant block/);
  assert.match(issue, /ordinary Sol\/Terra, candidate rereview Sol\/Terra/);
  assert.match(issue, /every CL-D32 post-decision rereview route/);
  assert.match(pr, /Every PR review-only Sol\/Terra invocation/);
  assert.match(pr, /every post-push Sol/);
  assert.match(review, /shared Every-gate invariant payload block verbatim/);
  assert.match(review, /Sol additionally composes the shared Sol-only adversarial invariant payload block verbatim/);
  assert.match(autofix, /shared `Every-gate invariant payload block` verbatim/);
  assert.match(autofix, /including every post-push Sol/);
  assert.doesNotMatch(autofix, /prior findings\/dispositions on re-invocation/);
  assert.doesNotMatch(autofix, /Every payload restates .*prior findings/);
  assert.doesNotMatch(contract, /on a re-invocation\) the prior rounds' findings with their dispositions/);
  assert.equal((issue.match(/\.\.\/closed-loop-shared\/references\/gate-contract\.md/g) || []).length, 1);
  assert.equal((pr.match(/\.\.\/closed-loop-shared\/references\/gate-contract\.md/g) || []).length, 1);
  assert.doesNotMatch(issue, /agents\/sol-reviewer\.md/);
  assert.doesNotMatch(pr, /agents\/sol-reviewer\.md/);
});

// Retrospective measurement evidence for Issue #23. The audit bundle binds the
// sanitized source artifacts and derives transmission/provenance assertions from
// their exact bytes. This is review-driven regression coverage, not runtime
// compliance or behavioral RED coverage.
test('Issue #23 records a bounded real-run settled-history measurement', () => {
  const record = JSON.parse(readText('test/records/issue-23-payload-measurement.json'));
  const audit = JSON.parse(readText('test/records/issue-23-real-run-provenance.json'));
  const digest = (value) => crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
  const bytes = (value) => Buffer.byteLength(value, 'utf8');
  assert.equal(record.recordVersion, 'issue23-retrospective-real-run-measurement-v1');
  assert.equal(record.auditBundle.path, 'test/records/issue-23-real-run-provenance.json');
  assert.equal(record.auditBundle.recordVersion, audit.recordVersion);
  assert.equal(record.auditBundle.sha256, digest(readText(record.auditBundle.path)));
  assert.equal(audit.recordVersion, 'issue23-real-run-provenance-audit-v1');
  assert.equal(audit.classification, 'review-driven regression, not pre-implementation RED and not runtime-compliance proof');
  assert.deepEqual(audit.sourceCase, {
    repository: 'tetsuh/pi-tidd-agents', target: 'PR #33',
    publicHeadOid: '61b2a925a78cb9bed65fdbdf23621d6b1e35fc92', findingId: 'SOL33-TDD-001',
    sourceGate: 'sol', confirmedDisposition: 'not-applicable',
    confirmationEvidenceSha256: 'c6020b9590ea86740337262bf7d65fc68095407d34cc992154e382cb55f6fa5d',
  });
  assert.equal(record.classification, 'retrospective measurement, not test coverage or behavioral RED');
  assert.equal(record.sourceCase.baselineRealRunId, '9b057bb3');
  assert.equal(record.sourceCase.afterReplayRealRunId, 'cfd6cad8');
  assert.equal(record.sourceCase.model, 'openai-codex/gpt-5.6-sol:high');
  assert.equal(record.method.controlledUnit, 'settled-history projection for the same confirmed real finding');
  assert.equal(record.method.wholeTaskTotalsComparable, false);
  assert.equal(record.method.providerTokenReductionClaim, false);
  assert.equal(record.method.runtimeModelComplianceClaim, false);
  const expected = {
    '9b057bb3': { input: 'afe5253c712ce6448dd35dd85ccc48c60e3ce6bfe509b03dbb8520ed05555363', output: '7cd43a02530be546aab39e6160d31b5a4c10613890d39001055537b6df05fe3c', meta: 'eff5d7548f62188f8eb451aea87f8cb20650a63e9f926bca2842a21c14ed50d7' },
    'cfd6cad8': { input: '1c255beffbdfc495fffb73fcf741839801d88da3cf79f85206ed97fe3e2a448d', output: '4d251c49b6ef46a9e34f7207b9631c96b2d5f3e85899bae850', meta: '51504270c579c3b3af90dc82f5d080737ea8ead86a48cc9abd94f27137cdfc72' },
  };
  expected.cfd6cad8.output = '4d251c49b6ef46a9e34f7207b9631c96d235645340c29eb8d5f3e85899bae850';
  for (const [runId, hashes] of Object.entries(expected)) {
    const run = audit.runs[runId];
    assert.equal(run.runId, runId);
    assert.equal(run.metadata.sha256, hashes.meta);
    assert.equal(digest(run.metadata.raw), hashes.meta);
    assert.deepEqual(JSON.parse(run.metadata.raw), run.metadata.json);
    assert.equal(run.metadata.json.runId, runId);
    assert.equal(run.metadata.json.model, 'openai-codex/gpt-5.6-sol:high');
    assert.equal(run.metadata.json.launchContractDigest, run.launchContractDigest);
    for (const [kind, hash] of [['inputArtifact', hashes.input], ['outputArtifact', hashes.output]]) {
      assert.equal(run[kind].sha256, hash);
      assert.equal(bytes(run[kind].text), run[kind].utf8Bytes);
      assert.equal(digest(run[kind].text), hash);
    }
    assert.equal(run.metadata.json.usage.input, run.usage.input);
    assert.equal(run.metadata.json.usage.output, run.usage.output);
  }
  const baseline = audit.runs['9b057bb3'];
  const replay = audit.runs.cfd6cad8;
  for (const marker of audit.sourceContext.baselineInputMustContain) assert.ok(baseline.inputArtifact.text.includes(marker), marker);
  assert.match(baseline.outputArtifact.text, /No blockers, major findings, or minor findings/);
  assert.match(replay.inputArtifact.text, /BEGIN_COMPACT_SETTLED_HISTORY[\s\S]*END_COMPACT_SETTLED_HISTORY/);
  assert.ok(replay.inputArtifact.text.includes(`BEGIN_COMPACT_SETTLED_HISTORY\n${audit.measurementBinding.replayCompactProjectionText}\nEND_COMPACT_SETTLED_HISTORY`));
  for (const marker of audit.sourceContext.replayOutputMarkers) assert.ok(replay.outputArtifact.text.includes(marker), marker);
  for (const value of Object.values(audit.measurementBinding.replayOutputMustContainAuthorityGraphVerification)) assert.ok(replay.outputArtifact.text.includes(value), value);
  assert.equal(record.sourceCase.baselineRealRunId, baseline.runId);
  assert.equal(record.sourceCase.afterReplayRealRunId, replay.runId);
  assert.equal(record.sourceCase.model, baseline.model);
  assert.equal(record.sourceCase.model, replay.model);
  assert.equal(record.sourceCase.baselineLaunchContractDigest, baseline.launchContractDigest);
  assert.equal(record.sourceCase.afterLaunchContractDigest, replay.launchContractDigest);
  for (const [runId, observation] of [['9b057bb3', record.baselineObservation], ['cfd6cad8', record.afterObservation]]) {
    const task = audit.runs[runId].metadata.json.task;
    assert.equal(bytes(task), observation.actualTaskBytes);
    assert.equal(digest(task), observation.actualTaskSha256);
    assert.equal(audit.runs[runId].metadata.sha256, observation.metadataSha256);
    assert.equal(audit.runs[runId].metadata.json.usage.input, observation.providerReportedInputTokensAllTurns);
  }
  // These are historical replay identities, not mutable fingerprints of the
  // current authority files. The hash-bound replay output attests these exact
  // values; later contract changes must not rewrite the measurement record.
  assert.equal(record.revisions.candidateAuthorityRawBytes, 98692);
  assert.equal(record.revisions.candidateAuthorityRawConcatSha256, '7052cc02feee1fa920f85208256d2e0a5c2d79bf6da279e3617f4a806c389139');
  assert.equal(record.revisions.candidateAuthorityGraphBytes, 98991);
  assert.equal(record.revisions.candidateAuthorityGraphSha256, 'eecafc552f18d9240975e49fa756cc2d0b3b46fba6616efcea5a6f9254be91cf');
  assert.equal(record.revisions.candidateAuthorityFraming, 'For each listed file in order: UTF-8 path, one space, decimal raw byte length, LF, raw file bytes, LF.');
  assert.match(audit.measurementBinding.replayOutputMustContainAuthorityGraphVerification.raw, /98,692 bytes.*7052cc02feee1fa920f85208256d2e0a5c2d79bf6da279e3617f4a806c389139/);
  assert.match(audit.measurementBinding.replayOutputMustContainAuthorityGraphVerification.framed, /98,991 bytes.*eecafc552f18d9240975e49fa756cc2d0b3b46fba6616efcea5a6f9254be91cf/);
  const before = record.controlledProjection.before;
  const after = record.controlledProjection.after;
  for (const projection of [before, after]) {
    assert.equal(Buffer.byteLength(projection.text, 'utf8'), projection.utf8Bytes);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(projection.text, 'utf8')).digest('hex'), projection.sha256);
    assert.ok(Number.isSafeInteger(projection.o200kTokens) && projection.o200kTokens > 0);
  }
  assert.equal(before.actuallyTransmittedAsThisProjection, false);
  assert.match(before.text, /evidence=.*impact=.*smallestCorrection=.*rationale=/);
  assert.doesNotMatch(after.text, /evidence=.*impact=.*smallestCorrection=.*rationale=/);
  assert.match(after.text, /findingId=.*sourceGate=.*raisedAgainst=.*disposition=.*confirmationEvidence=/);
  assert.equal(record.controlledProjection.difference.utf8Bytes, after.utf8Bytes - before.utf8Bytes);
  assert.equal(record.controlledProjection.difference.o200kTokens, after.o200kTokens - before.o200kTokens);
  assert.ok(record.controlledProjection.difference.utf8Bytes < 0);
  assert.ok(record.controlledProjection.difference.o200kTokens < 0);
  assert.ok(record.limitations.some((item) => item.includes('not a provider-isolated GPT-5 payload-token metric')));
});

test('Issue #24 workflow-specific ownership remains outside shared records', () => {
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  const pr = readText(PR_SKILL);
  const shared = readText('skills/closed-loop-shared/references/records.md');
  assert.match(issue, /An issue is not ready until it states its acceptance contract and validation plan\. Apply the risk-based test-first default when reviewing that plan\./);
  assert.doesNotMatch(shared, /An issue is not ready until it states its acceptance contract/);
  assert.match(pr, /Merging without required deterministic coverage needs explicit owner approval; this PR-specific requirement remains in this PR Skill\/root\./);
  assert.doesNotMatch(pr, /remains in the selected mode reference/);
  assert.match(shared, /The PR Skill\/root retains the deterministic-coverage owner-approval duty\./);
  assert.doesNotMatch(shared, /PR mode references retain the deterministic-coverage owner-approval duty\./);
  assert.doesNotMatch(shared, /dangerous operations, and ship decisions/);
  assert.match(pr, /dangerous operations, and ship decisions/);
  assert.doesNotMatch(issue, /dangerous operations, and ship decisions/);
  assert.match(issue, /Only under ordinary CL-D31 rules, a missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`\./);
  assert.match(issue, /Under CL-D32, tool, provider, startup, capture, malformed, missing, or uncertain outcomes/);
  assert.doesNotMatch(shared, /retry the invocation once, and if it fails again report `BLOCKED`/);
});

test('Issue #24 pins shared target grammar and PR-specific parsing ownership', () => {
  const contract = readText('CONTRACT.md');
  const shared = readText('skills/closed-loop-shared/references/gate-contract.md');
  assert.match(contract, /The shared `gate-contract\.md` owns common target-reference grammar\./);
  assert.match(contract, /The PR `SKILL\.md` owns CL-D6 mode parsing, target-kind resolution\/handling, evidence identity, shared dispatch, and mode selection\./);
  assert.match(shared, /## Target grammar \(CL-D7, CL-D8\)/);
  assert.doesNotMatch(contract, /The PR `SKILL\.md` owns argument parsing,/);
});

test('Issue 13 negative guards reject stale unqualified publication/resume prose while preserving scoped legacy rules', () => {
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  assert.doesNotMatch(issue, /This MVP never posts|this MVP does not publish|all revisions.*operator.*post/i);
  assert.doesNotMatch(issue, /Whenever the run stops without reaching readiness, emit a resumable block/);
  assert.match(issue, /Before candidate construction and otherwise outside the CL-D31 candidate-publication phase/);
  assert.match(issue, /During candidate construction and the entire candidate-publication phase, never emit or accept/);
  assert.match(issue, /frozen English ledger owns the complete decision record/);
  const readme = readText('README.md');
  assert.doesNotMatch(readme, /Issue behavior remains unchanged\.?$/m);
  assert.match(readme, /CL-D31 exception/);
  const contract = readText('CONTRACT.md');
  const cld28 = artifactSection(contract, '## CL-D28 — Mode-scoped publication boundary (historical no-publication rule)');
  const cld16 = artifactSection(contract, '## CL-D16 — Language Profile package defaults');
  const entrypointDecision = artifactSection(contract, '## DEC-I13-ENTRYPOINT-029 — Equivalent Issue entrypoints');
  assert.ok(cld28); assert.ok(cld16); assert.ok(entrypointDecision);
  assert.doesNotMatch(cld28, /Issue workflow and PR review-only remain no-publication modes/);
  assert.match(cld28, /During CL-D31 only, exact same-session approval authorizes/);
  assert.match(cld16, /exact approved GitHub Issue body PATCH and ledger POST are allowed/);
  assert.match(cld16, /every other provider API mutation remain forbidden/);
  assert.match(contract, /The exception supersedes CL-D13, CL-D13-issue, CL-D16, CL-D28, AC-AUTOFIX, AC-GRANT, and AC-REVIEW-ONLY/);
  assert.match(entrypointDecision, /It remains valid until a later explicit owner-approved contract decision separates the entrypoints or changes their shared Skill architecture/);
});
