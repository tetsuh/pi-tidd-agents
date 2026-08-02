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
const ENTRY_ARTIFACTS = [
  'skills/closed-loop-issue/SKILL.md',
  'skills/closed-loop-pr/SKILL.md',
  'prompts/tidd-issue.md',
  'prompts/tidd-pr.md',
];

// Superseded rules must not survive beside their replacements. Three times a
// contradiction reached review because the clause literal was satisfied by the
// stale half of the document: the mode grammar stated twice, publication offered
// after its removal, and external resume restored after it was withdrawn. A
// clause proves a rule is present; nothing proves an obsolete rule is gone
// unless it is named. Retired phrasings go here.
const PR_SKILL = 'skills/closed-loop-pr/SKILL.md';

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
  { files: [PR_SKILL], pattern: /observation origin is part of resumable state/i,
    reason: 'external evidence is no longer carried across runs' },
  { files: [PR_SKILL], pattern: /a resume against the same head restores/i,
    reason: 'external evidence is no longer carried across runs' },
  { files: ENTRY_ARTIFACTS, pattern: /whose only inputs are repository files/i,
    reason: 'the RED classes are separated by what a test does, not by where its inputs come from' },
  { files: [
      'skills/closed-loop-issue/SKILL.md',
      'skills/closed-loop-pr/SKILL.md',
      'CONTRACT.md',
    ], pattern: /produce (?:a )?counterexample from ground-truth files for each/i,
    reason: 'CL-D29 requires falsification attempts and actual cited counterexamples, not one invented counterexample per claim' },
  { files: [
      'skills/closed-loop-issue/SKILL.md',
      'skills/closed-loop-pr/SKILL.md',
      'CONTRACT.md',
    ], pattern: /survives (?:the check )?as (?:a )?finding/i,
    reason: 'CL-D29 makes no counterexample neither a finding nor proof' },
];

test('entry artifacts preserve the scoped CL-D30 boundary', () => {
  const skill = readText(PR_SKILL);
  assert.match(skill, /This addendum is selected only when.*exactly `autofix`/s);
  assert.match(skill, /Review-only retains the preceding/);
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
  assert.match(contract, /Exact PR `autofix` may post only CL-D30's bounded confirmed GitHub source-finding replies/);
  assert.doesNotMatch(contract, /this MVP never posts/i);
  assert.doesNotMatch(contract, /## CL-D28 — The MVP does not publish/);
  assert.doesNotMatch(contract, /## AC-AUTOFIX — Autofix is file-mutation permission only/);
  assert.doesNotMatch(contract, /This MVP does not exercise it \(CL-D28\)/);
  const readme = readText('README.md');
  assert.match(readme, /PR review-only retains the legacy resumable `tidd-status`/);
  assert.match(readme, /Exact PR `autofix` ends/);
});

test('contract scopes the exact provider-mutation exceptions', () => {
  const contract = readText('CONTRACT.md');
  const autofix = artifactSection(contract, '## AC-AUTOFIX — Autofix token grants only bounded CL-D30 actions');
  const grant = artifactSection(contract, '## AC-GRANT — Run-scoped bounded publication grant');
  const exceptions = 'provider mutation other than the exact scoped CL-D30 confirmed source-finding replies and CL-D31 optional body PATCH/ledger POST';
  for (const [name, section] of [['AC-AUTOFIX', autofix], ['AC-GRANT', grant]]) {
    assert.ok(section, `${name} section must exist for provider-mutation protection`);
    assert.ok(section.includes(exceptions), `${name} must preserve only the exact scoped provider-mutation exceptions`);
    assert.doesNotMatch(section, /does not authorize[^.]*provider mutation\./s, `${name} must not restore an unqualified provider-mutation prohibition`);
  }
});

test('provider mutation exceptions remain scoped in PR Skills and prompt', () => {
  const exception = 'exact confirmed CL-D30 GitHub source-finding replies are the sole provider-mutation exception';
  const language = artifactSection(readText(PR_SKILL), '## Language Profile (CL-D16)');
  const autofix = artifactSection(readText(PR_SKILL), '## Autofix (AC-AUTOFIX, CL-D3, CL-D4, CL-D10)');
  const publication = artifactSection(readText(PR_SKILL), '## Publication (AC-GRANT, CL-D28, CL-D30)');
  for (const [name, section] of [['Language Profile', language], ['Autofix', autofix], ['Publication', publication]]) {
    assert.ok(section, `${name} section must exist for provider-mutation protection`);
    assert.match(section, new RegExp(exception, 'i'));
    assert.doesNotMatch(section, /(?:neither mode|does not authorize|never authorizes)[^.]*provider(?:-specific| mutation|[- ]side)[^.]*\./s, `${name} restores an unqualified provider-mutation prohibition`);
  }
  const prompt = readText('prompts/tidd-pr.md');
  assert.match(prompt, new RegExp(exception, 'i'));
  assert.doesNotMatch(prompt, /never authorizes[^.]*provider(?:-specific| mutation|[- ]side)[^.]*\./s);
  assert.match(prompt, /Issue mutation/);
});

test('no superseded rule survives beside its replacement', () => {
  for (const { files, pattern, reason } of SUPERSEDED) {
    for (const file of files) {
      assert.doesNotMatch(readText(file), pattern, `${file} still carries a retired rule: ${reason}`);
    }
  }
});

test('exact-autofix Luna ownership is protected within its authored sections', () => {
  const skill = readText(PR_SKILL);
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
  ['22 mode-gated supersession preserves Issue and review-only artifacts', () => { const skill = readText(PR_SKILL); assert.match(skill, /not applied to Issue workflow or PR review-only mode/); assert.match(skill, /Review-only retains the preceding/); assert.doesNotMatch(readText('skills/closed-loop-issue/SKILL.md'), /CL-D30|LUNA_CORRECT_VALIDATE_COMMIT_PUSH/); assert.doesNotMatch(readText('prompts/tidd-issue.md'), /CL-D30|LUNA_CORRECT_VALIDATE_COMMIT_PUSH/); }],
];

test('fixture: all 22 Issue #10 acceptance scenarios execute against the reference model', () => {
  assert.equal(SCENARIOS.length, 22);
  for (const [name, scenario] of SCENARIOS) assert.doesNotThrow(scenario, name);
});

test('artifact assertions cover exact autofix safety records and remain non-authoritative', () => {
  const skill = readText(PR_SKILL);
  for (const required of [
    'local `HEAD`', 'manifest must still match the index exactly',
    'C` has sole parent `P`', 'complete worktree, index, and untracked state are clean',
    'Deduplicate `blockerKey × breakerOwner` values within each completed owner-gate result',
    'A reply marker is bound to source identity', 'exact reply body/digest', 'exact public head',
    'required app/source identity', 'older-head thread', 'top-level status, praise, duplicate summary',
    'shared CL-D1 exact verdict vocabulary', 'CL-D2 invocation-payload duties', 'CL-D29 adversarial duties',
    'fresh independent Sol/Terra roles', 'review-evidence snapshot fingerprint',
    'head branch to be verified writable by a normal actor-authorized non-force push', 'The parent Luna payload must contain',
    'run-local staged manifest is complete and immutable', 'parent OID, staged tree OID',
    'exact path/status/mode inventory', 'staged blob identities', 'source kind, source ID, source URL',
    'preflight every planned destination and source', 'Order the batch deterministically by source identity',
    'destination language', 'any movement expires approval',
    'local `HEAD` is public parent `P`', 'local `HEAD` is verified commit `C`',
    'After the non-force push, verify that the public head became `C`',
    'all three local dimensions', 'the tracked worktree', 'the untracked state',
    'pre-existing tracked unstaged edit is rejected', 'git log -1 --format=%B',
    'stored commit message bytes/content', 'expected approved message',
    'unexpected worktree or index mutation', 'whether the changed path is authorized', 'stop without cleanup',
    'never claims that the whole PR is ready unless final readiness has independently been reached',
    'parent must create and report the proposed aggregate final-summary body/draft',
    'The draft is not workflow state', 'declining or not posting it never blocks readiness',
    'Before any exact-autofix edit', 'security/risk', 'always stops at `WAITING_FOR_OWNER(reason=owner_decision_required)`',
    'A security or risk finding cannot be delegated', 'The run ends at that boundary with no resume',
    'branch-protection or ruleset bypass', 'normal actor-authorized non-force push without',
    'bypass-dependent branch/ruleset write preflight fails closed',
  ]) assert.ok(skill.includes(required), `missing exact safety artifact: ${required}`);
  assert.doesNotMatch(skill, /before gate invocation 15|at five successful pushes/);
  assert.doesNotMatch(skill, /immediately before push[^.]*local `HEAD` is public parent `P`/s);
  assert.match(skill, /via `git commit -F`/);
  assert.match(skill, /absence of literal `\\\\n`/);
});

test('shared baseline disposition and decision records remain protected in both Skills', () => {
  const enumBlock = 'fixed\\naccepted-as-designed\\ndeferred\\nduplicate\\nnot-applicable\\nneeds-owner-decision';
  const decisionBlock = 'Decision ID\\nKind\\nTarget and revision\\nQuestion\\nOptions and trade-offs\\nRecommendation\\nOwner choice\\nRationale\\nValidity and invalidation conditions';
  for (const file of ['skills/closed-loop-issue/SKILL.md', PR_SKILL]) {
    const text = readText(file).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    assert.ok(text.includes(enumBlock.replaceAll('\\n', '\n')));
    assert.ok(text.includes(decisionBlock.replaceAll('\\n', '\n')));
  }
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
