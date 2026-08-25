'use strict';

// Provenance: the Issue #28 RUNTIME_ROOTS artifact assertions were authored before
// the prose change and captured against a git archive of base ddadc9b with
// `node --test test/pr-operational-cleanliness.test.js` (exit 1: genuine
// compile/contract RED for missing RUNTIME_ROOTS/expanded-root contract prose).
// The Issue #28 acceptance inventory, mixed-root phase checks, raw-root
// evidence check, and prompt-authority assertion are review-driven contract
// regression coverage, not pre-implementation behavioral RED. The reference
// fixtures are parameterized over each runtime root. They were co-developed, then strengthened review-driven;
// they are non-authoritative specifications and cannot prove LLM/runtime behavior;
// safe and unsafe roots are classified independently.
// npm-pack coverage is a retrospective behavioral characterization,
// not RED evidence.
// Issue #42 provenance is hash-bound in test/records/issue-42-tdd-provenance.json.
// It is compile/contract/model RED only, never runtime-compliance evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { readText, readJson } = require('./helpers');

const CONTRACT = readText('CONTRACT.md');
const PR_SKILL = readText('skills/closed-loop-pr/SKILL.md');
const PR_AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const SKILL = `${PR_SKILL}\n${PR_AUTOFIX}`;
const README = readText('README.md');
const PROMPT = readText('prompts/tidd-pr.md');
const PACKAGE_TEST = readText('test/package.test.js');
const executedCoverage = new Set();
const executedSubcases = new Set();
const executedSubcaseOccurrences = [];
// Inventory labels: Issue #17 vector 01 through Issue #17 vector 23,
// parameterized over the exact owner-approved runtime-root set.
const RUNTIME_ROOTS = ['.pi', '.pi-subagents'];
let ACTIVE_RUNTIME_ROOT = RUNTIME_ROOTS[0];
const ISSUE_17_REQUIRED_VECTORS = Array.from({ length: 23 }, (_, i) => String(i + 1).padStart(2, '0'));
// One literal Issue #28 acceptance table is authoritative for both semantics and
// scope. The expected ID order and scope map are independent literals: the
// assertions below run before execution/coverage derivation so table omissions or
// scope drift cannot self-certify.
const ISSUE_28_EXPECTED_IDS = Object.freeze(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15']);
const ISSUE_28_EXPECTED_SCOPES = Object.freeze({
  '01': 'each-root', '02': 'each-root', '03': 'each-root', '04': 'each-root', '05': 'each-root',
  '06': 'each-root', '07': 'each-root', '08': 'each-root', '09': 'both-roots', '10': 'each-root',
  '11': 'each-root', '12': 'each-root', '13': 'each-root', '14': 'global', '15': 'global',
});
const ISSUE_28_VECTOR_TABLE = Object.freeze([
  { id: '01', scope: 'each-root', semantic: 'root absent with no other dirt passes' },
  { id: '02', scope: 'each-root', semantic: 'artifacts and chain-runs descendants under a real root pass' },
  { id: '03', scope: 'each-root', semantic: 'runtime create, content change, rename, and removal preserve identity' },
  { id: '04', scope: 'each-root', semantic: 'descendant symlinks are lexical and targets are not followed' },
  { id: '05', scope: 'each-root', semantic: 'unsafe root kinds fail closed' },
  { id: '06', scope: 'each-root', semantic: 'tracked modes, statuses, intent-to-add, and conflict stages fail closed' },
  { id: '07', scope: 'each-root', semantic: 'staged deletion cannot cure a forbidden candidate parent entry' },
  { id: '08', scope: 'each-root', semantic: 'lookalike and nested non-root names remain ordinary outside paths' },
  { id: '09', scope: 'both-roots', semantic: 'both enumerated roots present safely at once pass' },
  { id: '10', scope: 'each-root', semantic: 'the current root is unsafe while the other root remains safe' },
  { id: '11', scope: 'each-root', semantic: 'runtime churn remains safe at every named boundary' },
  { id: '12', scope: 'each-root', semantic: 'forbidden root entries fail closed independently at every boundary' },
  { id: '13', scope: 'each-root', semantic: 'dry-run and actual package contain neither runtime root' },
  { id: '14', scope: 'global', semantic: 'ended dirty runs require a fresh invocation' },
  { id: '15', scope: 'global', semantic: 'root additions require a recorded contract decision' },
]);
assert.deepEqual(ISSUE_28_VECTOR_TABLE.map(({ id }) => id), ISSUE_28_EXPECTED_IDS);
assert.deepEqual(Object.fromEntries(ISSUE_28_VECTOR_TABLE.map(({ id, scope }) => [id, scope])), ISSUE_28_EXPECTED_SCOPES);
const ISSUE_28_REQUIRED_COVERAGE = ISSUE_28_VECTOR_TABLE.flatMap(({ id, scope }) =>
  scope === 'each-root' ? RUNTIME_ROOTS.map((root) => `${root}:${id}`) : [`${scope}:${id}`]);
const executedIssue28Coverage = new Set();
const issue28CoverageOccurrences = [];

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n(?:##|###) /);
  return text.slice(start, next === -1 ? undefined : start + heading.length + next);
}
function isRuntimeNamespace(value) {
  return RUNTIME_ROOTS.some((root) => value === root || value.startsWith(`${root}/`));
}
function isPiNamespace(value) { return isRuntimeNamespace(value); }
function runtimePath(value) {
  return value === '.pi' || value.startsWith('.pi/')
    ? `${ACTIVE_RUNTIME_ROOT}${value.slice(3)}`
    : value;
}
function replaceRuntimePaths(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return runtimePath(value);
  if (Array.isArray(value)) return value.map(replaceRuntimePaths);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRuntimePaths(item)]));
  return value;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return JSON.stringify(value); }
function fingerprint(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function gitEntry(path, options = {}) {
  return { path, mode: options.mode || '100644', stage: options.stage || 0,
    intentToAdd: options.intentToAdd || false, status: options.status || 'unchanged',
    blob: options.blob || `blob:${path}` };
}
function baseState(overrides = {}) {
  return replaceRuntimePaths({
    identityOk: true, expectedPublicHead: 'P', localHead: 'P', remoteHead: 'P',
    piRoot: { kind: 'absent', followed: false }, runtimeDescendants: [],
    headEntries: [], indexEntries: [], trackedChanges: [], untrackedPaths: [],
    authorizedPaths: ['src/fix.js'], overlayChanges: [], validatedOverlay: null,
    unexpectedCandidateChanges: [], unstagedChanges: [],
    indexSnapshot: { parent: 'P', tree: 'T-index', treeEntries: [], entries: [], blobs: [] },
    manifest: { parent: 'P', tree: 'T-index', treeEntries: [], entries: [], blobs: [] },
    commit: { oid: 'C', parents: ['P'], tree: 'T-commit', treeEntries: [], entries: [], blobs: [] },
    publishedHead: 'P', rawDiff: '', baseEntries: [], candidateEntries: [],
    ...overrides,
  });
}

// Issue #42's model keeps owner data opaque: only sorted lexical paths and
// no-follow lstat kinds are admissible. It intentionally models mandatory
// boundary observations, not continuous noninterference.
const ISSUE_42_EXPECTED_IDS = Object.freeze(Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0')));
const ISSUE_42_VECTOR_TABLE = Object.freeze([
  { id: '01', semantic: 'ignored pytest cache proceeds' },
  { id: '02', semantic: 'ignored Python bytecode cache proceeds' },
  { id: '03', semantic: 'opaque application ignored directory proceeds' },
  { id: '04', semantic: 'ignored symlink is not followed or copied' },
  { id: '05', semantic: 'ambiguous ignored inventory blocks' },
  { id: '06', semantic: 'tracked or indexed operator changes block' },
  { id: '07', semantic: 'non-ignored untracked path blocks' },
  { id: '08', semantic: 'linked detached workspace identity passes' },
  { id: '09', semantic: 'operator ignored and untracked paths are not copied' },
  { id: '10', semantic: 'workspace validation artifacts stay outside correction scope' },
  { id: '11', semantic: 'staged sandbox artifact blocks' },
  { id: '12', semantic: 'public head movement blocks before push' },
  { id: '13', semantic: 'detached sole-parent normal push passes' },
  { id: '14', semantic: 'operator checkout remains unchanged at boundaries' },
  { id: '15', semantic: 'successful push reports operator behind without reconciliation' },
  { id: '16', semantic: 'cleanup is exact and bounded' },
  { id: '17', semantic: 'partial creation or verification failure has no fallback' },
  { id: '18', semantic: 'ignored state is explicitly enumerated, not porcelain-only' },
  { id: '19', semantic: 'Pi runtime roots remain separately enumerated' },
  { id: '20', semantic: 'review-only and Issue scope remain unchanged' },
]);
assert.deepEqual(ISSUE_42_VECTOR_TABLE.map(({ id }) => id), ISSUE_42_EXPECTED_IDS);
function issue42InventorySafe(value) {
  const inventory = value.ignoredInventory;
  if (!Array.isArray(inventory) || value.ignoredEnumeration !== 'explicit-nul' || value.inventoryStable !== true) return false;
  if (inventory.some((entry) => {
    if (!entry || typeof entry.path !== 'string' || entry.path.includes('\0') || entry.path.includes('\\')) return true;
    const parts = entry.path.split('/');
    return entry.path.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..') ||
      isRuntimeNamespace(entry.path) || !['directory', 'file', 'symlink', 'fifo', 'socket', 'device', 'unknown'].includes(entry.kind) ||
      entry.followed !== false || entry.noFollowLstat === false || entry.race === true;
  })) return false;
  return inventory.every((entry, i) => i === 0 || inventory[i - 1].path < entry.path);
}
function issue42RuntimeRootsSafe(value) {
  const roots = value.runtimeRoots || {};
  return Object.keys(roots).sort().join('\0') === RUNTIME_ROOTS.join('\0') && RUNTIME_ROOTS.every((root) =>
    ['absent', 'directory'].includes(roots[root]?.kind) && roots[root].followed === false);
}
function issue42OperatorSafe(value) {
  const op = value.operator || {};
  const baseline = value.operatorBaseline;
  return op.identity === true && op.head === 'H' && op.branchRef === 'H' &&
    op.trackedChanges.length === 0 && op.indexEntries.length === 0 && op.nonIgnoredUntracked.length === 0 &&
    op.operatorRef === 'H' && op.config === 'unchanged' && op.remoteTracking === 'unchanged' && issue42InventorySafe(op) &&
    !!baseline && stable(op) === stable(baseline);
}
function issue42GitExecutionSafe(ws) {
  return ws.cwd === 'workspace' && ws.gitEnv === 'sanitized-noninteractive' && ws.hooksPath === 'empty-run-owned' &&
    ws.executables === false && ws.sharedMetadataMutation === false && ws.remoteTrackingMutation === false &&
    ws.readOnlyRemoteUpdatesTracking === false;
}
function issue42WorkspaceSafe(value, expectedHead = 'H') {
  const ws = value.workspace || {};
  const linked = ws.kind === 'linked';
  const cloneFallback = ws.kind === 'clone';
  const modeIdentity = linked
    ? ws.commonGitDir === 'common' && ws.worktreeGitDir === 'registered' && ws.gitIndirection && ws.registration === true
    : cloneFallback && ws.commonGitDir === 'clone-owned' && ws.worktreeGitDir === 'clone-owned' && ws.registration === false &&
      ws.source === 'resolved' && ws.linkedUnavailableNoSideEffects === true;
  return modeIdentity && ws.pathOutsideRepository === true && ws.identity === true && ws.head === expectedHead && ws.tree === 'T' &&
    ws.origin === 'origin' && ws.detached === true && ws.canonicalPath === true && ws.repository === 'resolved' &&
    ws.fetchUrl === 'resolved' && ws.pushUrl === 'resolved' && ws.prBranch === 'verified' &&
    ws.copiedOperatorPaths === false && issue42GitExecutionSafe(ws) && ws.creation === 'verified' && ws.enumerationFailure !== true;
}
function issue42ScopeSafe(value) {
  return value.scope?.reviewOnly === false && value.scope?.issue === false && value.scope?.exactAutofix === true;
}
function issue42ValidationSandboxSafe(artifact) {
  if (!artifact) return true;
  return artifact.generatedByValidation === true && artifact.ignored === true && artifact.frozen === true &&
    artifact.noFollowPresence === true && artifact.drift !== true && artifact.staged !== true &&
    artifact.inAllowedPaths !== true && artifact.inEvidence !== true && artifact.inManifest !== true &&
    artifact.inCommitTree !== true && artifact.inPublishedTree !== true;
}
function issue42CommonBoundary(value, expectedWorkspaceHead) {
  const ws = value.workspace || {};
  return issue42OperatorSafe(value) && issue42RuntimeRootsSafe(value) &&
    issue42WorkspaceSafe(value, expectedWorkspaceHead) && issue42ScopeSafe(value) &&
    !ws.partialCreation && !ws.verificationFailure && !ws.fallbackUsedAfterPartial &&
    !ws.cleanupIdentityMismatch && !ws.cleanupFailure && issue42ValidationSandboxSafe(value.validationArtifact);
}
function issue42WorkspaceGuard(value, phase = 'ordinary') {
  const expectedWorkspaceHead = ['after-commit', 'before-push'].includes(phase) ? value.commit?.child : value.publicHead;
  if (!expectedWorkspaceHead || !issue42CommonBoundary(value, expectedWorkspaceHead)) return { status: 'BLOCKED' };
  const ws = value.workspace;
  if (phase === 'before-push' && (value.publicHead !== 'H' || ws.pushRefspec !== 'HEAD:refs/heads/pr-branch' || ws.forcePush === true || ws.localBranchMoved === true || ws.fastForward !== true || value.commit?.parent !== 'H' || value.commit?.parents !== 1)) return { status: 'BLOCKED' };
  if (phase === 'after-commit' && (value.commit?.parent !== 'H' || value.commit?.parents !== 1)) return { status: 'BLOCKED' };
  if (phase === 'post-push' && (value.publicHead !== 'C' || value.behindReport !== 'H -> C' || value.reconciled === true)) return { status: 'BLOCKED' };
  return { status: 'pass' };
}
function issue42PushTransition(value, phase) {
  const { operatorOid: O, parent: P, child: C } = value.transition;
  if (!issue42CommonBoundary(value, C, true) || O !== 'H' || value.operator.head !== O || value.commit.parents !== 1 || value.commit.parent !== P || value.commit.child !== C || value.workspace.parent !== P || value.workspace.child !== C) return { status: 'BLOCKED' };
  if (phase === 'before-push') return value.publicHead === P && value.workspace.pushRefspec === 'HEAD:refs/heads/pr-branch' && value.workspace.fastForward === true && value.workspace.forcePush === false && value.workspace.localBranchMoved === false ? { status: 'pass' } : { status: 'BLOCKED' };
  if (phase === 'post-push') return value.publicHead === C && value.behindReport === `${O} -> ${C}` && value.reconciled === false ? { status: 'pass' } : { status: 'BLOCKED' };
  return { status: 'BLOCKED' };
}
function issue42ReplyBoundary(value) {
  const current = value.publicHead;
  return issue42CommonBoundary(value, current, true) && value.confirmationHead === current && value.replyHead === current ? { status: 'pass' } : { status: 'BLOCKED' };
}
function issue42Cleanup(value) {
  const ws = value.workspace || {};
  const terminal = value.terminalWorkspaceIdentity || {};
  const identityMatches = ['head', 'tree', 'detached', 'identity', 'canonicalPath', 'commonGitDir', 'worktreeGitDir', 'registration']
    .every((key) => ws[key] === terminal[key]);
  return ['success', 'failure'].includes(value.terminalOutcome) && value.terminalObserved === true &&
    issue42CommonBoundary(value, terminal.head) && identityMatches &&
    ws.cleanupAuthorized === true && ws.registration === true && ws.commonGitDir === 'common' &&
    ws.cleanupCommand === 'git worktree remove' && ws.force !== true && ws.prune !== true &&
    ws.recursive !== true && ws.operatorTargeted !== true ? { status: 'pass' } : { status: 'BLOCKED' };
}
function rootSafe(root, descriptor, descendants, untrackedPaths) {
  const kinds = new Set(['absent', 'directory', 'symlink', 'file', 'fifo', 'socket', 'device', 'unknown']);
  if (!kinds.has(descriptor.kind) || descriptor.followed !== false) return false;
  if (descriptor.kind === 'directory') {
    const expectedPrefix = `${root}/`;
    const paths = descendants.map((entry) => entry.path).sort();
    const untracked = untrackedPaths.filter((path) => path === root || path.startsWith(expectedPrefix)).sort();
    return descendants.every((entry) => entry.path.startsWith(expectedPrefix) && entry.lexical === true && entry.followed !== true) &&
      stable(paths) === stable(untracked);
  }
  return descriptor.kind === 'absent' && descendants.length === 0 &&
    untrackedPaths.every((path) => path !== root && !path.startsWith(`${root}/`));
}
function runtimeRootSafe(value) {
  if (value.runtimeRoots) {
    return RUNTIME_ROOTS.every((root) => rootSafe(
      root,
      value.runtimeRoots[root] || { kind: 'absent', followed: false },
      (value.runtimeDescendantsByRoot || {})[root] || [],
      value.untrackedPaths,
    ));
  }
  return rootSafe(ACTIVE_RUNTIME_ROOT, value.piRoot, value.runtimeDescendants, value.untrackedPaths);
}
function forbiddenGit(value) {
  return [...value.headEntries, ...value.indexEntries].some((entry) => isPiNamespace(entry.path));
}
function outsideUntracked(value) {
  return value.untrackedPaths.filter((path) => !isPiNamespace(path));
}
function noPiEntries(entries) { return !entries.some((entry) => isPiNamespace(entry.path)); }
function noPiPaths(paths) { return paths.every((path) => !isPiNamespace(path)); }
function effects(result) {
  return result.status === 'pass' ? { cleanup: 0, retry: 0 } :
    { cleanup: 0, retry: 0, continuation: 0, commit: 0, push: 0, reply: 0, summary: 0 };
}
function blocked(result) { assert.notEqual(result.status, 'pass'); assert.deepEqual(effects(result), { cleanup: 0, retry: 0, continuation: 0, commit: 0, push: 0, reply: 0, summary: 0 }); }
function parentIdentity(value) {
  return value.identityOk && value.expectedPublicHead === 'P' && value.localHead === 'P' &&
    value.remoteHead === 'P' && value.publishedHead === 'P';
}
function authorizedOverlay(value) {
  return parentIdentity(value) && value.authorizedPaths.length > 0 && noPiPaths(value.authorizedPaths) &&
    value.overlayChanges.every((entry) => value.authorizedPaths.includes(entry.path) && !isPiNamespace(entry.path)) &&
    value.trackedChanges.every((path) => value.authorizedPaths.includes(path) && !isPiNamespace(path)) &&
    value.indexEntries.length === 0 && value.unexpectedCandidateChanges.length === 0 &&
    runtimeRootSafe(value) && outsideUntracked(value).length === 0 && !forbiddenGit(value);
}
function overlayClean(value, phase = 'before-validation') {
  const base = baseState(value);
  if (!authorizedOverlay(base)) return { status: 'validation_failed' };
  if (phase === 'before-validation') return base.validatedOverlay === null ? { status: 'pass' } : { status: 'validation_failed' };
  if (!base.validatedOverlay || stable(base.overlayChanges) !== stable(base.validatedOverlay) ||
      stable(base.trackedChanges) !== stable(base.validatedOverlay.map((entry) => entry.path))) {
    return { status: 'validation_failed' };
  }
  return { status: 'pass' };
}
function overlayMatchesSnapshot(base, snapshot) {
  return stable(base.validatedOverlay) === stable(snapshot.entries) &&
    stable(base.validatedOverlay.map((entry) => entry.blob)) === stable(snapshot.blobs);
}
function manifestClean(value) {
  const base = baseState(value);
  const index = base.indexSnapshot;
  const manifest = base.manifest;
  const exact = manifest.parent === index.parent && manifest.tree === index.tree &&
    stable(manifest.treeEntries) === stable(index.treeEntries) &&
    stable(manifest.entries) === stable(index.entries) && stable(manifest.blobs) === stable(index.blobs);
  const currentOverlay = base.validatedOverlay && overlayMatchesSnapshot(base, index) &&
    stable(base.validatedOverlay) === stable(manifest.entries) &&
    stable(base.validatedOverlay.map((entry) => entry.blob)) === stable(manifest.blobs);
  const safe = parentIdentity(base) && runtimeRootSafe(base) && outsideUntracked(base).length === 0 &&
    base.trackedChanges.length === 0 && base.indexEntries.length === 0 && base.unstagedChanges.length === 0 &&
    noPiEntries(base.headEntries) && noPiEntries(base.indexEntries) && noPiEntries(index.entries) &&
    noPiEntries(index.treeEntries) && noPiEntries(manifest.entries) && noPiEntries(manifest.treeEntries) &&
    noPiPaths(base.authorizedPaths);
  return exact && currentOverlay && safe ? { status: 'pass' } : { status: 'BLOCKED:commit_guard' };
}
function postCommitClean(value) {
  const base = baseState(value);
  const parentForbidden = base.headEntries.some((entry) => isPiNamespace(entry.path));
  const indexForbidden = base.indexEntries.some((entry) => isPiNamespace(entry.path));
  const manifestForbidden = !noPiEntries(base.manifest.entries) || !noPiEntries(base.manifest.treeEntries);
  const commitForbidden = !noPiEntries(base.commit.entries) || !noPiEntries(base.commit.treeEntries);
  const identity = base.identityOk && base.expectedPublicHead === 'P' && base.localHead === base.commit.oid &&
    base.remoteHead === 'P' && base.publishedHead === 'P' && base.commit.parents.length === 1 && base.commit.parents[0] === 'P';
  const exact = base.manifest.parent === 'P' && base.commit.tree === base.manifest.tree &&
    stable(base.commit.treeEntries) === stable(base.manifest.treeEntries) &&
    stable(base.commit.entries) === stable(base.manifest.entries) &&
    stable(base.commit.blobs) === stable(base.manifest.blobs) &&
    base.indexSnapshot.parent === base.manifest.parent && base.indexSnapshot.tree === base.manifest.tree &&
    stable(base.indexSnapshot.treeEntries) === stable(base.manifest.treeEntries) &&
    stable(base.indexSnapshot.entries) === stable(base.manifest.entries) &&
    stable(base.indexSnapshot.blobs) === stable(base.manifest.blobs) &&
    stable(base.commit.blobs) === stable(base.indexSnapshot.blobs);
  const safe = runtimeRootSafe(base) && outsideUntracked(base).length === 0 &&
    base.trackedChanges.length === 0 && base.indexEntries.length === 0 && base.unstagedChanges.length === 0 &&
    !parentForbidden && !indexForbidden && !manifestForbidden && !commitForbidden &&
    noPiEntries(base.indexSnapshot.entries) && noPiEntries(base.indexSnapshot.treeEntries);
  return identity && exact && safe ? { status: 'pass' } : { status: 'BLOCKED:push_guard' };
}
const ORDINARY = ['preflight', 'sol', 'terra', 'route-to-Sol', 'luna-delegation', 'luna-first-edit', 'post-push-gate', 'reply-batch', 'individual-reply', 'final-classification', 'post-reply-readiness', 'aggregate-summary'];
const OVERLAY = ['before-validation', 'after-validation', 'before-staging'];
const MANIFEST = ['after-staging', 'before-commit'];
const CP = ['after-commit', 'before-push'];
function classify(boundary, value) {
  if (ORDINARY.includes(boundary)) return operationalClean(value);
  if (OVERLAY.includes(boundary)) return overlayClean(value, boundary);
  if (MANIFEST.includes(boundary)) return manifestClean(value);
  if (CP.includes(boundary)) return postCommitClean(value);
  return { status: 'BLOCKED:unknown_boundary' };
}
function operationalClean(value) {
  const base = baseState(value);
  const ok = base.identityOk && base.localHead === base.expectedPublicHead && base.remoteHead === base.expectedPublicHead &&
    base.publishedHead === base.expectedPublicHead && base.trackedChanges.length === 0 && base.indexEntries.length === 0 &&
    outsideUntracked(base).length === 0 && runtimeRootSafe(base) && !forbiddenGit(base);
  return ok ? { status: 'pass' } : { status: 'BLOCKED' };
}
function mark(vector) { executedCoverage.add(vector); }
function markSubcase(key) { executedSubcases.add(key); executedSubcaseOccurrences.push(key); }
function markIssue28(root, vector) {
  const key = `${root}:${vector}`;
  assert.equal(executedIssue28Coverage.has(key), false, `duplicate Issue #28 coverage: ${key}`);
  executedIssue28Coverage.add(key);
  issue28CoverageOccurrences.push(key);
}
function issue28State(root, descriptor = { kind: 'absent', followed: false }, descendants = [], overrides = {}) {
  const runtimeRoots = Object.fromEntries(RUNTIME_ROOTS.map((candidate) => [candidate, { kind: 'absent', followed: false }]));
  const runtimeDescendantsByRoot = Object.fromEntries(RUNTIME_ROOTS.map((candidate) => [candidate, []]));
  runtimeRoots[root] = descriptor;
  runtimeDescendantsByRoot[root] = descendants;
  return baseState({ runtimeRoots, runtimeDescendantsByRoot, untrackedPaths: descendants.map((entry) => entry.path), ...overrides });
}
function bothRootsSafe(overrides = {}) {
  return baseState({
    runtimeRoots: {
      '.pi': { kind: 'directory', followed: false },
      '.pi-subagents': { kind: 'directory', followed: false },
    },
    runtimeDescendantsByRoot: {
      '.pi': [{ path: '.pi/tasks/probe', lexical: true }],
      '.pi-subagents': [{ path: '.pi-subagents/artifacts/probe', lexical: true }],
    },
    untrackedPaths: ['.pi/tasks/probe', '.pi-subagents/artifacts/probe'],
    ...overrides,
  });
}
function makeUnsafeRoot(value, root) {
  const next = clone(value);
  next.runtimeRoots[root] = { kind: 'symlink', followed: false, target: `/real/${root.slice(1)}` };
  next.runtimeDescendantsByRoot[root] = [];
  next.untrackedPaths = next.untrackedPaths.filter((path) => path !== root && !path.startsWith(`${root}/`));
  return next;
}
function forbiddenEntry(root, suffix = 'forbidden') {
  return gitEntry(`${root}/${suffix}`, { blob: `runtime:${root}/${suffix}` });
}
function forbiddenTreeEntry(root) {
  return gitEntry(`${root}/tree-forbidden`, { blob: `runtime:${root}/tree-forbidden` });
}
function addForbiddenParent(value, root) {
  const next = clone(value);
  next.headEntries.push(forbiddenEntry(root));
  return next;
}
function addForbiddenIndex(value, root) {
  const next = clone(value);
  next.indexEntries.push(forbiddenEntry(root));
  return next;
}
function addManifestForbiddenEntry(value, root) {
  const next = clone(value);
  const entry = forbiddenEntry(root);
  for (const target of [next.validatedOverlay, next.indexSnapshot.entries, next.manifest.entries]) target.push(clone(entry));
  for (const target of [next.indexSnapshot.blobs, next.manifest.blobs]) target.push(entry.blob);
  return next;
}
function addManifestForbiddenTree(value, root) {
  const next = clone(value);
  const entry = forbiddenTreeEntry(root);
  next.indexSnapshot.treeEntries.push(clone(entry));
  next.manifest.treeEntries.push(clone(entry));
  return next;
}
function addPostCommitForbiddenEntry(value, root) {
  const next = clone(value);
  const entry = forbiddenEntry(root);
  for (const target of [next.validatedOverlay, next.indexSnapshot.entries, next.manifest.entries, next.commit.entries]) target.push(clone(entry));
  for (const target of [next.indexSnapshot.blobs, next.manifest.blobs, next.commit.blobs]) target.push(entry.blob);
  return next;
}
function addPostCommitForbiddenTree(value, root) {
  const next = clone(value);
  const entry = forbiddenTreeEntry(root);
  next.indexSnapshot.treeEntries.push(clone(entry));
  next.manifest.treeEntries.push(clone(entry));
  next.commit.treeEntries.push(clone(entry));
  return next;
}
function assertRootForbiddenAtBoundary(boundary, value, root) {
  // Parent and current-index hazards are independent for every ordinary and overlay boundary.
  if (ORDINARY.includes(boundary) || OVERLAY.includes(boundary)) {
    blocked(classify(boundary, addForbiddenParent(value, root)));
    blocked(classify(boundary, addForbiddenIndex(value, root)));
    return;
  }
  if (MANIFEST.includes(boundary)) {
    blocked(classify(boundary, addForbiddenParent(value, root)));
    blocked(classify(boundary, addForbiddenIndex(value, root)));
    // Keep currentOverlay and exact manifest equality intact while introducing only the forbidden entry.
    blocked(classify(boundary, addManifestForbiddenEntry(value, root)));
    // Keep the tree inventory equal across the independent index snapshot and manifest.
    blocked(classify(boundary, addManifestForbiddenTree(value, root)));
    return;
  }
  if (CP.includes(boundary)) {
    blocked(classify(boundary, addForbiddenParent(value, root)));
    blocked(classify(boundary, addForbiddenIndex(value, root)));
    // Keep validatedOverlay/indexSnapshot/manifest/commit entries and blobs aligned.
    blocked(classify(boundary, addPostCommitForbiddenEntry(value, root)));
    // Keep indexSnapshot/manifest/commit tree inventories aligned.
    blocked(classify(boundary, addPostCommitForbiddenTree(value, root)));
    return;
  }
  throw new Error(`unknown forbidden boundary ${boundary}`);
}
// Independent acceptance inventory: this literal is intentionally not derived from
// hazardsForBoundary() or the execution loop, so omissions cannot self-certify.
const BASE_REQUIRED_VECTOR_20_SUBCASES = [
  'preflight:root','preflight:outside','preflight:parent','preflight:index','preflight:identity',
  'sol:root','sol:outside','sol:parent','sol:index','sol:identity',
  'terra:root','terra:outside','terra:parent','terra:index','terra:identity',
  'route-to-Sol:root','route-to-Sol:outside','route-to-Sol:parent','route-to-Sol:index','route-to-Sol:identity',
  'luna-delegation:root','luna-delegation:outside','luna-delegation:parent','luna-delegation:index','luna-delegation:identity',
  'luna-first-edit:root','luna-first-edit:outside','luna-first-edit:parent','luna-first-edit:index','luna-first-edit:identity',
  'post-push-gate:root','post-push-gate:outside','post-push-gate:parent','post-push-gate:index','post-push-gate:identity',
  'reply-batch:root','reply-batch:outside','reply-batch:parent','reply-batch:index','reply-batch:identity',
  'individual-reply:root','individual-reply:outside','individual-reply:parent','individual-reply:index','individual-reply:identity',
  'final-classification:root','final-classification:outside','final-classification:parent','final-classification:index','final-classification:identity',
  'post-reply-readiness:root','post-reply-readiness:outside','post-reply-readiness:parent','post-reply-readiness:index','post-reply-readiness:identity',
  'aggregate-summary:root','aggregate-summary:outside','aggregate-summary:parent','aggregate-summary:index','aggregate-summary:identity',
  'before-validation:root','before-validation:outside','before-validation:parent','before-validation:index','before-validation:identity','before-validation:overlayAuthority',
  'after-validation:root','after-validation:outside','after-validation:parent','after-validation:index','after-validation:identity','after-validation:overlayAuthority','after-validation:overlayDrift','after-validation:overlayIndex',
  'before-staging:root','before-staging:outside','before-staging:parent','before-staging:index','before-staging:identity','before-staging:overlayAuthority','before-staging:overlayDrift','before-staging:overlayIndex',
  'after-staging:root','after-staging:outside','after-staging:parent','after-staging:index','after-staging:identity','after-staging:stagedIndexPath','after-staging:stagedIndexTree','after-staging:manifestPath','after-staging:manifestTree','after-staging:manifestBlob','after-staging:validatedOverlayIndex','after-staging:validatedOverlayManifest','after-staging:validatedOverlayStagedManifest','after-staging:unstaged',
  'before-commit:root','before-commit:outside','before-commit:parent','before-commit:index','before-commit:identity','before-commit:stagedIndexPath','before-commit:stagedIndexTree','before-commit:manifestPath','before-commit:manifestTree','before-commit:manifestBlob','before-commit:validatedOverlayIndex','before-commit:validatedOverlayManifest','before-commit:validatedOverlayStagedManifest','before-commit:unstaged',
  'after-commit:root','after-commit:outside','after-commit:parent','after-commit:index','after-commit:identity','after-commit:manifestPath','after-commit:manifestTree','after-commit:commitPath','after-commit:commitTree','after-commit:commitBlob','after-commit:unstaged',
  'before-push:root','before-push:outside','before-push:parent','before-push:index','before-push:identity','before-push:manifestPath','before-push:manifestTree','before-push:commitPath','before-push:commitTree','before-push:commitBlob','before-push:unstaged',
];
const REQUIRED_VECTOR_20_SUBCASES = RUNTIME_ROOTS.flatMap((root) => BASE_REQUIRED_VECTOR_20_SUBCASES.map((key) => `${root}:${key}`));
function hazardsForBoundary(boundary) {
  if (ORDINARY.includes(boundary)) return ['root', 'outside', 'parent', 'index', 'identity'];
  if (boundary === 'before-validation') return ['root', 'outside', 'parent', 'index', 'identity', 'overlayAuthority'];
  if (boundary === 'after-validation' || boundary === 'before-staging') return ['root', 'outside', 'parent', 'index', 'identity', 'overlayAuthority', 'overlayDrift', 'overlayIndex'];
  if (boundary === 'after-staging' || boundary === 'before-commit') return ['root', 'outside', 'parent', 'index', 'identity', 'stagedIndexPath', 'stagedIndexTree', 'manifestPath', 'manifestTree', 'manifestBlob', 'validatedOverlayIndex', 'validatedOverlayManifest', 'validatedOverlayStagedManifest', 'unstaged'];
  if (boundary === 'after-commit' || boundary === 'before-push') return ['root', 'outside', 'parent', 'index', 'identity', 'manifestPath', 'manifestTree', 'commitPath', 'commitTree', 'commitBlob', 'unstaged'];
  return [];
}
function withHazard(value, hazard) {
  const next = clone(value);
  switch (hazard) {
    case 'root': next.piRoot = { kind: 'symlink', followed: false, target: '/real/pi' }; next.runtimeDescendants = []; break;
    case 'outside': next.untrackedPaths = [...next.untrackedPaths, 'notes.txt']; break;
    case 'parent': next.headEntries = [...next.headEntries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'index': next.indexEntries = [...next.indexEntries, gitEntry(runtimePath('.pi/file'), { stage: 2, intentToAdd: true, status: 'add' })]; break;
    case 'identity': next.identityOk = false; break;
    case 'overlayAuthority': next.authorizedPaths = [runtimePath('.pi/file')]; break;
    case 'overlayDrift': next.overlayChanges = next.overlayChanges.map((entry) => ({ ...entry, blob: 'drifted' })); break;
    case 'overlayIndex': next.overlayChanges = next.overlayChanges.map((entry) => ({ ...entry, blob: 'index-drift' })); break;
    case 'stagedIndexPath': next.indexSnapshot.entries = [...next.indexSnapshot.entries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'stagedIndexTree': next.indexSnapshot.treeEntries = [...next.indexSnapshot.treeEntries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'manifestPath': next.manifest.entries = [...next.manifest.entries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'manifestTree': next.manifest.treeEntries = [...next.manifest.treeEntries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'manifestBlob': next.manifest.blobs = [...next.manifest.blobs, 'wrong']; break;
    case 'validatedOverlayIndex': next.indexSnapshot.entries = [gitEntry('src/fix.js', { status: 'modify', blob: 'A' })]; next.indexSnapshot.blobs = ['A']; break;
    case 'validatedOverlayManifest': next.manifest.entries = [gitEntry('src/fix.js', { status: 'modify', blob: 'A' })]; next.manifest.blobs = ['A']; break;
    case 'validatedOverlayStagedManifest': {
      const aEntries = [gitEntry('src/fix.js', { status: 'modify', blob: 'A' })];
      next.indexSnapshot.entries = aEntries;
      next.indexSnapshot.blobs = ['A'];
      next.manifest.entries = clone(aEntries);
      next.manifest.blobs = ['A'];
      break;
    }
    case 'unstaged': next.unstagedChanges = [...next.unstagedChanges, 'src/fix.js']; break;
    case 'commitPath': next.commit.entries = [...next.commit.entries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'commitTree': next.commit.treeEntries = [...next.commit.treeEntries, gitEntry(runtimePath('.pi/file'))]; break;
    case 'commitBlob': next.commit.blobs = ['wrong']; break;
    default: throw new Error(`unknown Issue #17 hazard ${hazard}`);
  }
  return next;
}

test('record: Issue #42 pre-implementation RED is hash-bound and narrowly classified', () => {
  const record = readJson('test/records/issue-42-tdd-provenance.json');
  assert.equal(record.classification, 'pre-implementation compile/contract/model RED');
  assert.equal(record.runtimeCompliance, false);
  assert.equal(record.command, 'node --test test/pr-operational-cleanliness.test.js');
  assert.equal(record.innerExitCode, 1);
  assert.deepEqual(record.summary, { tests: 33, passed: 31, failed: 2 });
  assert.deepEqual(record.failingTests, [
    'artifact: Issue #42 isolated-workspace contract is present and single-checkout CLEAN wording is retired',
    'fixture: Issue #42 acceptance vectors 01–20 are explicitly modeled',
  ]);
  const auditBytes = fs.readFileSync(record.auditBundle.path);
  assert.equal(crypto.createHash('sha256').update(auditBytes).digest('hex'), record.auditBundle.sha256);
  const audit = JSON.parse(auditBytes);
  assert.equal(audit.runId, record.source.runId);
  for (const artifact of [audit.commandArtifact, audit.resultArtifact]) {
    assert.equal(Buffer.byteLength(artifact.text, 'utf8'), artifact.utf8Bytes);
    assert.equal(crypto.createHash('sha256').update(artifact.text).digest('hex'), artifact.sha256);
  }
  assert.match(audit.commandArtifact.text, /node --test test\/pr-operational-cleanliness\.test\.js/);
  for (const marker of [...record.failingTests, 'ℹ tests 33', 'ℹ pass 31', 'ℹ fail 2']) assert.ok(audit.resultArtifact.text.includes(marker), marker);
  assert.equal(audit.sourceLineDigests.commandEventLineSha256, record.source.commandLineSha256);
  assert.equal(audit.sourceLineDigests.resultEventLineSha256, record.source.resultLineSha256);
  const greenBytes = fs.readFileSync(record.greenValidationBundle.path);
  assert.equal(crypto.createHash('sha256').update(greenBytes).digest('hex'), record.greenValidationBundle.sha256);
  const green = JSON.parse(greenBytes);
  assert.equal(green.classification, 'review-driven pre-binding clean-copy validation evidence, not final mutually-bound-tree attestation, pre-implementation RED, or runtime-compliance proof');
  assert.match(green.method, /Before adding this audit hash/);
  assert.ok(green.limitations.some((item) => item.includes('does not claim to test its own final binding')));
  for (const artifact of [green.npmTestArtifact, green.npmPackArtifact]) {
    assert.equal(Buffer.byteLength(artifact.text, 'utf8'), artifact.utf8Bytes);
    assert.equal(crypto.createHash('sha256').update(artifact.text).digest('hex'), artifact.sha256);
  }
  assert.deepEqual(green.exitCodes, [0, 0]);
  assert.deepEqual(green.observedSummary, { tests: 285, passed: 285, failed: 0, packFiles: 18, packBytes: 45025 });
  for (const marker of ['ℹ tests 285', 'ℹ pass 285', 'ℹ fail 0']) assert.ok(green.npmTestArtifact.text.includes(marker), marker);
});

test('artifact: Issue #42 isolated-workspace contract is present and single-checkout CLEAN wording is retired', () => {
  const d10 = section(CONTRACT, '## CL-D10 — Worktree precondition for autofix');
  const d30 = section(CONTRACT, '## CL-D30 — Exact PR autofix publishes one bounded correction per public head');
  const invariants = section(SKILL, '### Isolated exact-autofix invariants (CL-D10, CL-D30)');
  const preflight = section(SKILL, '### Worktree precondition (CL-D10)');
  const phases = section(SKILL, '### Exact identity and Luna publication phases');
  for (const text of [CONTRACT, PR_AUTOFIX]) {
    assert.match(text, /OPERATOR_CHECKOUT@H/);
    assert.match(text, /AUTOFIX_WORKSPACE@H/);
    assert.match(text, /OPERATOR_CHECKOUT_UNCHANGED@O/);
    assert.match(text, /opaque.*ignored|ignored.*opaque/i);
    assert.match(text, /git worktree add --detach/);
    assert.match(text, /temporary clone.*fallback/i);
    assert.match(text, /explicitly enumerate(?:d)? ignored|ignored.*explicitly enumerate|enumerat(?:e|ed).*ignored/i);
    assert.match(text, /(?:without (?:reading|following).*contents|never (?:read|follow).*contents|reads? no contents|contents.*never read)/i);
  }
  assert.match(invariants, /WORKSPACE_POST_COMMIT|POST_COMMIT.*workspace/i);
  assert.match(invariants, /linked permits only verified remote-tracking `O -> C`, clone operator stays `O`/);
  for (const text of [CONTRACT, PR_AUTOFIX, README]) assert.match(text, /verified remote-tracking[^.\n]*(?:ref `C`|`O -> C`)/);
  assert.match(PR_AUTOFIX, /After public\/workspace `C`, linked alone passes `postPushHead:C`; clone omits it and requires `O` equality/);
  assert.match(CONTRACT, /Only linked after public\/workspace verification may `operator_revalidate` receive `postPushHead: C`/);
  assert.match(README, /only then may `operator_revalidate` receive `postPushHead: C`/);
  assert.doesNotMatch(CONTRACT, /neither mode mutates[^.\n]*remote-tracking state/i);
  assert.match(preflight, /outside the repository|isolated workspace/i);
  assert.match(phases, /workspace cwd|workspace path|AUTOFIX_WORKSPACE@H/i);
  assert.doesNotMatch(preflight, /branch must already be checked out and satisfy `CLEAN@H`/);
  assert.match(d30, /(?:unexpected )?non-ignored untracked.*block(?:ed|s)?/i);
});

test('fixture: Issue #42 acceptance vectors 01–20 are explicitly modeled', () => {
  const baseline = baseState({
    operatorBaseline: null,
    operator: {
      identity: true, head: 'H', branchRef: 'H', trackedChanges: [], indexEntries: [],
      nonIgnoredUntracked: [], ignoredEnumeration: 'explicit-nul', inventoryStable: true,
      operatorRef: 'H', config: 'unchanged', remoteTracking: 'unchanged',
      ignoredInventory: [{ path: 'app/.pytest_cache', kind: 'directory', followed: false, noFollowLstat: true }],
    },
    workspace: {
      kind: 'linked', pathOutsideRepository: true, canonicalPath: true, identity: true, head: 'H', tree: 'T', origin: 'origin',
      repository: 'resolved', fetchUrl: 'resolved', pushUrl: 'resolved', prBranch: 'verified',
      commonGitDir: 'common', worktreeGitDir: 'registered', cwd: 'workspace',
      gitEnv: 'sanitized-noninteractive', hooksPath: 'empty-run-owned', executables: false,
      sharedMetadataMutation: false, remoteTrackingMutation: false, readOnlyRemoteUpdatesTracking: false,
      pushRefspec: 'HEAD:refs/heads/pr-branch', forcePush: false, localBranchMoved: false, fastForward: true,
      detached: true, copiedOperatorPaths: false, gitIndirection: true, registration: true,
      creation: 'verified', enumerationFailure: false,
    },
    publicHead: 'H', commit: { parent: 'H', child: 'C', parents: 1 },
    runtimeRoots: { '.pi': { kind: 'directory', followed: false }, '.pi-subagents': { kind: 'absent', followed: false } },
    scope: { reviewOnly: false, issue: false, exactAutofix: true },
    validationArtifact: null,
  });
  baseline.operatorBaseline = clone(baseline.operator);
  assert.equal(issue42WorkspaceGuard(baseline).status, 'pass');
  assert.equal(issue42WorkspaceGuard({ ...baseline, operator: { ...baseline.operator, branchRef: 'C' } }).status, 'BLOCKED');
  const cases = [
    baseline,
    { ...baseline, operator: { ...baseline.operator, ignoredInventory: [{ path: '__pycache__', kind: 'directory', followed: false }] } },
    { ...baseline, operator: { ...baseline.operator, ignoredInventory: [{ path: 'app-local', kind: 'directory', followed: false }] } },
    { ...baseline, operator: { ...baseline.operator, ignoredInventory: [{ path: 'secret-link', kind: 'symlink', followed: false }] } },
    { ...baseline, operator: { ...baseline.operator, ignoredInventory: [{ path: 'unsafe-cache', kind: 'unknown', followed: false, noFollowLstat: false }] } },
    { ...baseline, operator: { ...baseline.operator, trackedChanges: ['src/a'] } },
    { ...baseline, operator: { ...baseline.operator, nonIgnoredUntracked: ['.claude'] } },
    baseline,
    { ...baseline, workspace: { ...baseline.workspace, copiedOperatorPaths: true } },
    { ...baseline, validationArtifact: { generatedByValidation: true, ignored: true, frozen: true, noFollowPresence: true, staged: false, inAllowedPaths: false, inEvidence: false, inManifest: false, inCommitTree: false, inPublishedTree: false } },
    { ...baseline, validationArtifact: { generatedByValidation: true, ignored: true, frozen: true, noFollowPresence: true, staged: true } },
    { ...baseline, publicHead: 'Q' },
    { ...baseline, workspace: { ...baseline.workspace, head: 'C', parent: 'H', child: 'C', pushRefspec: 'HEAD:refs/heads/pr-branch', fastForward: true }, transition: { operatorOid: 'H', parent: 'H', child: 'C' }, publicHead: 'H' },
    baseline,
    { ...baseline, operator: { ...baseline.operator, head: 'H', branchRef: 'H' }, workspace: { ...baseline.workspace, head: 'C' }, publicHead: 'C', behindReport: 'H -> C', reconciled: false },
    { ...baseline, terminalOutcome: 'success', terminalObserved: true,
      terminalWorkspaceIdentity: clone({ head: baseline.workspace.head, tree: baseline.workspace.tree, detached: baseline.workspace.detached, identity: baseline.workspace.identity, canonicalPath: baseline.workspace.canonicalPath, commonGitDir: baseline.workspace.commonGitDir, worktreeGitDir: baseline.workspace.worktreeGitDir, registration: baseline.workspace.registration }),
      workspace: { ...baseline.workspace, cleanupAuthorized: true, cleanupCommand: 'git worktree remove', force: false, prune: false, recursive: false, operatorTargeted: false } },
    { ...baseline, workspace: { ...baseline.workspace, partialCreation: true, creation: 'partial' } },
    { ...baseline, operator: { ...baseline.operator, ignoredEnumeration: 'explicit-nul', inventoryStable: true } },
    { ...baseline, runtimeRoots: { '.pi': { kind: 'directory', followed: false }, '.pi-subagents': { kind: 'absent', followed: false } } },
    { ...baseline, scope: { reviewOnly: false, issue: false, exactAutofix: true } },
  ];
  assert.equal(cases.length, ISSUE_42_VECTOR_TABLE.length);
  for (const [index, value] of cases.entries()) {
    const id = ISSUE_42_VECTOR_TABLE[index].id;
    const candidate = { ...value, operatorBaseline: clone(value.operator) };
    if (['05', '06', '07', '09', '11', '17'].includes(id)) {
      assert.equal(issue42WorkspaceGuard(candidate).status, 'BLOCKED', `vector ${id}`);
    } else if (id === '12') {
      assert.equal(issue42WorkspaceGuard(candidate, 'before-push').status, 'BLOCKED', `vector ${id}`);
    } else if (id === '13') {
      assert.equal(issue42PushTransition(candidate, 'before-push').status, 'pass', `vector ${id}`);
      assert.equal(value.workspace.pushRefspec, 'HEAD:refs/heads/pr-branch');
      assert.equal(value.workspace.forcePush, false);
    } else if (id === '15') {
      assert.equal(issue42WorkspaceGuard(candidate, 'post-push').status, 'pass', `vector ${id}`);
      assert.equal(value.reconciled, false);
    } else if (id === '16') {
      assert.equal(issue42Cleanup(candidate).status, 'pass', `vector ${id}`);
    } else {
      assert.equal(issue42WorkspaceGuard(candidate).status, 'pass', `vector ${id}`);
    }
  }
  assert.equal(issue42WorkspaceGuard({ ...baseline, operator: { ...baseline.operator, indexEntries: ['src/a'] } }).status, 'BLOCKED');
  assert.equal(issue42WorkspaceGuard({ ...baseline, validationArtifact: { generatedByValidation: true, ignored: true, frozen: true, noFollowPresence: true, inEvidence: true } }).status, 'BLOCKED');
  assert.equal(issue42WorkspaceGuard({ ...baseline, validationArtifact: { generatedByValidation: true, ignored: true, frozen: true, noFollowPresence: true, drift: true } }).status, 'BLOCKED');
  assert.equal(issue42WorkspaceGuard({ ...baseline, runtimeRoots: { ...baseline.runtimeRoots, '.pi': { kind: 'symlink', followed: false } } }).status, 'BLOCKED');
  assert.equal(issue42WorkspaceGuard({ ...baseline, scope: { reviewOnly: true, issue: false, exactAutofix: false } }).status, 'BLOCKED');
  assert.equal(issue42Cleanup(baseline).status, 'BLOCKED');
  assert.equal(issue42Cleanup({ ...baseline, terminalOutcome: 'success', terminalObserved: true, workspace: { ...baseline.workspace, cleanupAuthorized: true, cleanupCommand: 'git worktree prune' } }).status, 'BLOCKED');
  assert.equal(issue42Cleanup({ ...baseline, terminalOutcome: 'failure', terminalObserved: true, workspace: { ...baseline.workspace, cleanupAuthorized: true, cleanupCommand: 'git worktree remove', force: false, prune: false, operatorTargeted: true } }).status, 'BLOCKED');
});

test('fixture: Issue #42 workspace transitions are deterministic and fail closed', () => {
  const base = baseState({
    operator: { identity: true, head: 'H', branchRef: 'H', operatorRef: 'H', trackedChanges: [], indexEntries: [], nonIgnoredUntracked: [], config: 'unchanged', remoteTracking: 'unchanged', ignoredEnumeration: 'explicit-nul', inventoryStable: true, ignoredInventory: [{ path: 'cache/local', kind: 'directory', followed: false, noFollowLstat: true }] },
    workspace: { kind: 'linked', pathOutsideRepository: true, canonicalPath: true, identity: true, head: 'H', tree: 'T', origin: 'origin', repository: 'resolved', fetchUrl: 'resolved', pushUrl: 'resolved', prBranch: 'verified', commonGitDir: 'common', worktreeGitDir: 'registered', cwd: 'workspace', gitEnv: 'sanitized-noninteractive', hooksPath: 'empty-run-owned', executables: false, sharedMetadataMutation: false, remoteTrackingMutation: false, readOnlyRemoteUpdatesTracking: false, pushRefspec: 'HEAD:refs/heads/pr-branch', forcePush: false, localBranchMoved: false, fastForward: true, detached: true, copiedOperatorPaths: false, gitIndirection: true, registration: true, creation: 'verified', enumerationFailure: false },
    publicHead: 'H', commit: { parent: 'H', child: 'C', parents: 1 },
    runtimeRoots: { '.pi': { kind: 'directory', followed: false }, '.pi-subagents': { kind: 'absent', followed: false } },
    scope: { reviewOnly: false, issue: false, exactAutofix: true },
  });
  base.operatorBaseline = clone(base.operator);
  assert.equal(issue42WorkspaceGuard(base).status, 'pass');
  assert.equal(issue42WorkspaceGuard(base, 'after-commit').status, 'BLOCKED');
  assert.equal(issue42WorkspaceGuard(base, 'before-push').status, 'BLOCKED');
  const cloneFallback = { ...base, workspace: { ...base.workspace, kind: 'clone', commonGitDir: 'clone-owned', worktreeGitDir: 'clone-owned', registration: false, gitIndirection: false, source: 'resolved', linkedUnavailableNoSideEffects: true } };
  assert.equal(issue42WorkspaceGuard(cloneFallback).status, 'pass');
  assert.equal(issue42WorkspaceGuard({ ...cloneFallback, workspace: { ...cloneFallback.workspace, linkedUnavailableNoSideEffects: false } }).status, 'BLOCKED');
  for (const bad of [
    { workspace: { ...base.workspace, commonGitDir: 'operator' } },
    { workspace: { ...base.workspace, cwd: 'operator' } },
    { workspace: { ...base.workspace, gitEnv: 'inherited' } },
    { workspace: { ...base.workspace, hooksPath: 'operator-hooks' } },
    { workspace: { ...base.workspace, sharedMetadataMutation: true } },
    { workspace: { ...base.workspace, remoteTrackingMutation: true } },
    { workspace: { ...base.workspace, repository: 'other' } },
    { workspace: { ...base.workspace, kind: 'clone', source: 'unbound' } },
    { workspace: { ...base.workspace, pushRefspec: 'HEAD:main' } },
    { workspace: { ...base.workspace, forcePush: true } },
    { workspace: { ...base.workspace, localBranchMoved: true } },
  ]) assert.equal(issue42WorkspaceGuard({ ...base, ...bad }, 'before-push').status, 'BLOCKED');
  assert.equal(issue42WorkspaceGuard({ ...base, operator: { ...base.operator, ignoredInventory: [{ path: 'cache/renamed', kind: 'directory', followed: false, noFollowLstat: true }] } }).status, 'BLOCKED');
  for (const bad of [
    { operator: { ...base.operator, ignoredEnumeration: 'unstable' } },
    { operator: { ...base.operator, ignoredInventory: [{ path: '../secret', kind: 'file', followed: false }] } },
    { operator: { ...base.operator, ignoredInventory: [{ path: './secret', kind: 'file', followed: false }] } },
    { operator: { ...base.operator, ignoredInventory: [{ path: '/secret', kind: 'file', followed: false }] } },
    { operator: { ...base.operator, ignoredInventory: [{ path: 'cache/local', kind: 'file', followed: false, race: true }] } },
    { operator: { ...base.operator, remoteTracking: 'changed' } },
  ]) assert.equal(issue42WorkspaceGuard({ ...base, ...bad }).status, 'BLOCKED');
  const pushed = { ...base, workspace: { ...base.workspace, head: 'C' }, publicHead: 'C', behindReport: 'H -> C', reconciled: false };
  assert.equal(issue42WorkspaceGuard(pushed, 'post-push').status, 'pass');
  for (const bad of [{ reconciled: true }, { behindReport: 'updated' }, { operator: { ...base.operator, head: 'C' } }, { operator: { ...base.operator, ignoredInventory: [{ path: 'cache/new', kind: 'directory', followed: false, noFollowLstat: true }] } }, { operator: { ...base.operator, indexEntries: ['src/drift'] } }, { operator: { ...base.operator, config: 'changed' } }]) assert.equal(issue42WorkspaceGuard({ ...pushed, ...bad }, 'post-push').status, 'BLOCKED');
  const firstPush = { ...base, transition: { operatorOid: 'H', parent: 'H', child: 'P' }, publicHead: 'H', commit: { parent: 'H', child: 'P', parents: 1 }, workspace: { ...base.workspace, head: 'P', parent: 'H', child: 'P' } };
  assert.equal(issue42PushTransition(firstPush, 'before-push').status, 'pass');
  assert.equal(issue42PushTransition({ ...firstPush, workspace: { ...firstPush.workspace, head: 'H' } }, 'before-push').status, 'BLOCKED');
  assert.equal(issue42PushTransition({ ...firstPush, publicHead: 'P', behindReport: 'H -> P', reconciled: false }, 'post-push').status, 'pass');
  const secondPush = { ...base, transition: { operatorOid: 'H', parent: 'P', child: 'C' }, publicHead: 'P', commit: { parent: 'P', child: 'C', parents: 1 }, workspace: { ...base.workspace, head: 'C', parent: 'P', child: 'C' } };
  assert.equal(issue42PushTransition(secondPush, 'before-push').status, 'pass');
  assert.equal(issue42PushTransition({ ...secondPush, workspace: { ...secondPush.workspace, head: 'P' } }, 'before-push').status, 'BLOCKED');
  assert.equal(issue42PushTransition({ ...secondPush, publicHead: 'C', behindReport: 'H -> C', reconciled: false }, 'post-push').status, 'pass');
  assert.equal(issue42PushTransition({ ...secondPush, operator: { ...base.operator, remoteTracking: 'changed' } }, 'before-push').status, 'BLOCKED');
  assert.equal(issue42PushTransition({ ...secondPush, validationArtifact: { generatedByValidation: true, ignored: true, frozen: true, noFollowPresence: true, drift: true } }, 'before-push').status, 'BLOCKED');
  const latestReply = { ...secondPush, publicHead: 'C', confirmationHead: 'C', replyHead: 'C' };
  assert.equal(issue42ReplyBoundary(latestReply).status, 'pass');
  assert.equal(issue42ReplyBoundary({ ...latestReply, confirmationHead: 'P' }).status, 'BLOCKED');
  assert.equal(issue42ReplyBoundary({ ...latestReply, replyHead: 'P' }).status, 'BLOCKED');
  assert.equal(issue42ReplyBoundary({ ...latestReply, workspace: { ...latestReply.workspace, head: 'P' } }).status, 'BLOCKED');
  assert.equal(issue42ReplyBoundary({ ...latestReply, scope: { reviewOnly: true, issue: false, exactAutofix: false } }).status, 'BLOCKED');
  assert.equal(issue42ReplyBoundary({ ...latestReply, runtimeRoots: { ...latestReply.runtimeRoots, '.pi': { kind: 'symlink', followed: false } } }).status, 'BLOCKED');
  assert.equal(issue42ReplyBoundary({ ...latestReply, validationArtifact: { generatedByValidation: true, ignored: true, frozen: true, noFollowPresence: true, drift: true } }).status, 'BLOCKED');
  for (const terminalFailure of ['creation_failed', 'validation_failed', 'commit_failed', 'push_rejected', 'push_outcome_unknown', 'cleanup_failed']) {
    assert.equal(issue42OperatorSafe({ ...base, terminalFailure }), true, terminalFailure);
    assert.equal(issue42OperatorSafe({ ...base, terminalFailure, operator: { ...base.operator, config: 'changed' } }), false, terminalFailure);
  }
  const terminalIdentity = (workspace) => clone({
    head: workspace.head, tree: workspace.tree, detached: workspace.detached, identity: workspace.identity,
    canonicalPath: workspace.canonicalPath, commonGitDir: workspace.commonGitDir,
    worktreeGitDir: workspace.worktreeGitDir, registration: workspace.registration,
  });
  for (const terminalOutcome of ['success', 'failure']) assert.equal(issue42Cleanup({
    ...base, terminalOutcome, terminalObserved: true, terminalWorkspaceIdentity: terminalIdentity(base.workspace),
    workspace: { ...base.workspace, cleanupAuthorized: true, cleanupCommand: 'git worktree remove' },
  }).status, 'pass');
  const unpushedCommit = {
    ...base, terminalOutcome: 'failure', terminalObserved: true,
    terminalWorkspaceIdentity: terminalIdentity({ ...base.workspace, head: 'C' }), publicHead: 'P',
    workspace: { ...base.workspace, head: 'C', cleanupAuthorized: true, cleanupCommand: 'git worktree remove' },
  };
  assert.equal(issue42Cleanup(unpushedCommit).status, 'pass');
  assert.equal(issue42Cleanup({ ...unpushedCommit, workspace: { ...unpushedCommit.workspace, head: 'H' } }).status, 'BLOCKED');
  for (const bad of [{ cleanupCommand: 'git worktree prune' }, { recursive: true }, { cleanupIdentityMismatch: true }, { operatorTargeted: true }, { gitEnv: 'inherited' }, { hooksPath: 'operator-hooks' }]) assert.equal(issue42Cleanup({
    ...base, terminalOutcome: 'failure', terminalObserved: true, terminalWorkspaceIdentity: terminalIdentity(base.workspace),
    workspace: { ...base.workspace, cleanupAuthorized: true, cleanupCommand: 'git worktree remove', ...bad },
  }).status, 'BLOCKED');
});

// Section-scoped compile/contract coverage, including forbidden stale wording.
test('artifact: Issue #17 sections define scoped operational cleanliness', () => {
  const d10 = section(CONTRACT, '## CL-D10 — Worktree precondition for autofix');
  const d30 = section(CONTRACT, '## CL-D30 — Exact PR autofix publishes one bounded correction per public head');
  const invariants = section(SKILL, '### Isolated exact-autofix invariants (CL-D10, CL-D30)');
  const preflight = section(SKILL, '### Worktree precondition (CL-D10)');
  const phases = section(SKILL, '### Exact identity and Luna publication phases');
  const boundaries = section(SKILL, '### Public-head loop and evidence');
  const replies = section(SKILL, '### Source-finding replies and final readiness');
  for (const text of [d30, invariants]) {
    assert.match(text, /RUNTIME_ROOTS|runtime-root/);
    assert.match(text, /real (?:repository-root )?\.pi directory|real directory|real directory or verified clone/);
    assert.match(text, /without following links|not follow|no-follow/);
    assert.match(text, /outside.*untracked|untracked.*outside/si);
    assert.match(text, /HEAD.*index|index.*HEAD/si);
  }
  assert.match(d10, /`OPERATOR_CHECKOUT@H`/);
  assert.match(preflight, /`OPERATOR_CHECKOUT@H`/);
  assert.match(boundaries, /`OPERATOR_CHECKOUT@H`/);
  assert.match(boundaries, /`WORKSPACE_POST_COMMIT\(C, P\)`/);
  assert.match(phases, /`AUTOFIX_WORKSPACE@P`/);
  assert.match(phases, /`WORKSPACE_POST_COMMIT\(C, P\)`/);
  assert.match(replies, /`OPERATOR_CHECKOUT_UNCHANGED@O`/);
  assert.match(replies, /`REPLY_EXCEPTION`/);
  assert.match(replies, /safe untracked runtime-root bytes and contents are excluded from every gate payload, candidate draft, finding\/validation evidence, Luna correction scope, disposition claim, source reply, and aggregate-summary claim/i);
  const requiredDenial = /the workflow must not claim those runtime bytes were cleaned, preserved, validated, committed, or published\./i;
  assert.match(replies, requiredDenial);
  assert.match(replies, /only truthful runtime-content statement permitted.*excluded from candidate\/evidence identity.*reclassified.*without following links/is);
  const repliesWithoutRequiredDenial = replies.replace(requiredDenial, '');
  assert.doesNotMatch(repliesWithoutRequiredDenial, /runtime (?:bytes|contents|state) (?:were|was) (?:cleaned|preserved|validated|committed|published)/i);
  for (const text of [preflight, boundaries, phases, replies]) {
    assert.doesNotMatch(text, /untracked baseline clean/i);
    assert.doesNotMatch(text, /untracked state(?: to be)? fully clean/i);
    assert.doesNotMatch(text, /all three local dimensions.*completely clean/i);
  }
  assert.doesNotMatch(boundaries, /At every exact-autofix boundary.*ordinary operational cleanliness/si);
  assert.match(boundaries, /Every pre-push boundary/);
  assert.match(boundaries, /immediately after a push require `WORKSPACE_POST_PUSH\(C, O\)`/);
  assert.match(boundaries, /Correction-overlay and staged-manifest boundaries use the named condition deltas/);
  assert.match(phases, /BEFORE_VALIDATION.*immediately before focused validation/si);
  assert.match(phases, /AFTER_VALIDATION.*requires `AUTOFIX_WORKSPACE@P`/si);
  assert.match(phases, /BEFORE_STAGING.*requires `AUTOFIX_WORKSPACE@P`/si);
  assert.match(phases, /AFTER_STAGING.*immediately after staging/si);
  assert.match(phases, /BEFORE_COMMIT.*immediately before commit/si);
  assert.match(phases, /AFTER_COMMIT.*POST_COMMIT\(C, P\)/si);
  assert.match(phases, /BEFORE_PUSH.*POST_COMMIT\(C, P\)/si);
  assert.match(phases, /distinct post-commit\/pre-push guard/);
  assert.match(d30, /raw.*effective diff|raw.*diff/si);
  assert.match(README, /RUNTIME_ROOTS.*\.pi.*\.pi-subagents/si);
  assert.match(README, /artifactDir: "session".*artifactDir: "temp".*do \*\*not\*\* guarantee.*\.pi-subagents/is);
  assert.match(README, /AFTER_COMMIT.*BEFORE_PUSH.*independently reclassify/si);
  assert.match(d30, /AFTER_COMMIT.*BEFORE_PUSH.*independently require.*reclassif/si);
  for (const text of [d10, d30, invariants, README]) assert.match(text, /RUNTIME_ROOTS/);
  for (const text of [d30, invariants, README]) {
    assert.match(text, /\.pi.*\.pi-subagents/si);
    assert.match(text, /enumerat|exact.*set|independently/si);
  }
  assert.match(phases, /safe untracked runtime(?:-root)? churn.*may change.*descendant create.*content change.*rename.*removal/si);
  assert.match(phases, /every `RUNTIME_ROOTS` member without following links/i);
  assert.match(phases, /Every other state must remain unchanged/);
});

test('artifact: Issue #17 stale cleanliness prose is rejected section-by-section', () => {
  for (const [name, text] of [
    ['CL-D10', section(CONTRACT, '## CL-D10 — Worktree precondition for autofix')],
    ['public-head', section(SKILL, '### Public-head loop and evidence')],
    ['publication', section(SKILL, '### Exact identity and Luna publication phases')],
    ['reply-final', section(SKILL, '### Source-finding replies and final readiness')],
  ]) {
    assert.doesNotMatch(text, /untracked baseline clean|untracked state to be fully clean|all three local dimensions .*completely clean/i, name);
  }
  assert.match(SKILL, /outside-`?\.pi|outside.*untracked/i);
  assert.doesNotMatch(README, /\.pi.*generally ignored/i);
});

test('artifact: Issue #20 names each invariant once and references it at every phase', () => {
  const d10 = section(CONTRACT, '## CL-D10 — Worktree precondition for autofix');
  const d30 = section(CONTRACT, '## CL-D30 — Exact PR autofix publishes one bounded correction per public head');
  const preflight = section(SKILL, '### Worktree precondition (CL-D10)');
  const boundaries = section(SKILL, '### Public-head loop and evidence');
  const phases = section(SKILL, '### Exact identity and Luna publication phases');
  const replies = section(SKILL, '### Source-finding replies and final readiness');
  const addendum = SKILL.slice(SKILL.indexOf('## Exact PR `autofix` addendum (CL-D30)'));
  const definitionCount = (text, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...text.matchAll(new RegExp(`^[-*] ${'`'}${escaped}${'`'} :=`, 'gm'))].length;
  };

  for (const name of ['OPERATOR_CHECKOUT@H', 'AUTOFIX_WORKSPACE@H', 'WORKSPACE_POST_COMMIT(C, P)', 'WORKSPACE_POST_PUSH(C, O)', 'OPERATOR_CHECKOUT_UNCHANGED@O', 'REPLY_EXCEPTION']) {
    assert.equal(definitionCount(CONTRACT, name), 1, `${name} must be defined exactly once in CONTRACT.md`);
    assert.equal(definitionCount(SKILL, name), 1, `${name} must be defined exactly once in the PR Skill`);
  }
  assert.match(d10, /`OPERATOR_CHECKOUT@H`/);
  assert.match(preflight, /`OPERATOR_CHECKOUT@H`/);
  assert.match(boundaries, /`OPERATOR_CHECKOUT@H`/);
  assert.match(boundaries, /`WORKSPACE_POST_COMMIT\(C, P\)`/);
  for (const guard of ['BEFORE_VALIDATION', 'AFTER_VALIDATION', 'BEFORE_STAGING', 'AFTER_STAGING', 'BEFORE_COMMIT']) {
    const pattern = new RegExp('`' + guard + '`[^\\n]*`AUTOFIX_WORKSPACE@P`|`' + guard + '`[\\s\\S]{0,320}`AUTOFIX_WORKSPACE@P`');
    assert.match(phases, pattern, `${guard} must name CLEAN@P and state only its delta`);
  }
  for (const guard of ['AFTER_COMMIT', 'BEFORE_PUSH']) {
    const guardLine = phases.split('\n').find((line) => line.startsWith(`- \`${guard}\``));
    assert.ok(guardLine, `${guard} guard must exist`);
    assert.match(guardLine, /local `HEAD=C` while remote\/public head remains `P`/, `${guard} must independently state its local/public head delta`);
    assert.match(guardLine, /`WORKSPACE_POST_COMMIT\(C, P\)`/, `${guard} must independently name WORKSPACE_POST_COMMIT(C, P)`);
  }
  assert.match(phases, /every runtime-root path.*fails closed regardless of its mode, stage, intent-to-add, or add\/modify\/rename\/delete\/conflict status/si);
  assert.doesNotMatch(phases, /every staged mode\/stage\/intent\/add\/modify\/rename\/delete\/conflict, fails closed/i);
  assert.match(replies, /`REPLY_EXCEPTION`/);
  assert.ok((SKILL.match(/`REPLY_EXCEPTION`/g) || []).length >= 5, 'every provider-mutation boundary must reference REPLY_EXCEPTION');
  assert.equal((SKILL.match(/all three local dimensions remain independently guarded/gi) || []).length, 1);
  // CL-D43 raised this from the 25,022-byte pre-refactor baseline to 28,000: it measured 23,677
  // bytes at c2ad0db, so 1,345 bytes remained and it would have become the binding guard one
  // pull request after the six-file ceiling was raised. Revision-qualified, not a running total.
  assert.ok(Buffer.byteLength(addendum) < 28000, 'the CL-D30 addendum must stay inside its recorded guard');

  const retainedVectorMap = {
    'OPERATOR_CHECKOUT@H': ['01', '02', '06', '08', '09', '10', '11', '12', '13', '19', '20'],
    'WORKSPACE_POST_COMMIT(C, P)': ['17', '18', '19', '20'],
  };
  for (const [name, ids] of Object.entries(retainedVectorMap)) {
    assert.ok(ids.length > 0, `${name} needs retained Issue #17 vector coverage`);
    for (const id of ids) assert.ok(ISSUE_17_REQUIRED_VECTORS.includes(id), `${name} maps to unknown vector ${id}`);
  }
});

test('artifact: RUNTIME_ROOTS is the documented exact set and classifies roots independently', () => {
  assert.deepEqual(RUNTIME_ROOTS, ['.pi', '.pi-subagents']);
  const definition = /`?RUNTIME_ROOTS`?\s*:=\s*[^\n{]*\{ "\.pi", "\.pi-subagents" \}/g;
  assert.equal((CONTRACT.match(definition) || []).length, 1, 'CONTRACT.md must define RUNTIME_ROOTS exactly once');
  assert.equal((SKILL.match(definition) || []).length, 1, 'PR Skill must define RUNTIME_ROOTS exactly once');
  assert.doesNotMatch(PROMPT, /RUNTIME_ROOTS\s*:=/, 'thin prompt must not define RUNTIME_ROOTS');
  for (const text of [CONTRACT, SKILL, README]) {
    assert.match(text, /RUNTIME_ROOTS/);
    assert.match(text, /\{ "\.pi", "\.pi-subagents" \}/);
    assert.doesNotMatch(text, /\.pi\*/);
  }
  const safeBoth = baseState({
    runtimeRoots: {
      '.pi': { kind: 'directory', followed: false },
      '.pi-subagents': { kind: 'directory', followed: false },
    },
    runtimeDescendantsByRoot: {
      '.pi': [{ path: '.pi/tasks/probe', lexical: true }],
      '.pi-subagents': [{ path: '.pi-subagents/missions/probe', lexical: true }],
    },
    untrackedPaths: ['.pi/tasks/probe', '.pi-subagents/missions/probe'],
  });
  assert.equal(operationalClean(safeBoth).status, 'pass');
  const mixedUnsafe = { ...safeBoth, runtimeRoots: { ...safeBoth.runtimeRoots, '.pi-subagents': { kind: 'symlink', followed: false } }, runtimeDescendantsByRoot: { ...safeBoth.runtimeDescendantsByRoot, '.pi-subagents': [] }, untrackedPaths: ['.pi/tasks/probe'] };
  assert.equal(operationalClean(mixedUnsafe).status, 'BLOCKED');
});

test('fixture: Issue #28 acceptance vectors 01–15 cover their declared root scope exactly once', () => {
  ACTIVE_RUNTIME_ROOT = RUNTIME_ROOTS[0];
  for (const { id: vector, scope } of ISSUE_28_VECTOR_TABLE) {
    if (scope !== 'each-root') continue;
    for (const root of RUNTIME_ROOTS) {
      markIssue28(root, vector);
      const descendant = (suffix, content = undefined) => ({ path: `${root}/${suffix}`, lexical: true, ...(content === undefined ? {} : { content }) });
      switch (vector) {
        case '01': // Root absent, no other dirt: pass.
          assert.equal(operationalClean(issue28State(root)).status, 'pass');
          break;
        case '02': { // Real root with the default artifact and chain-run descendants: pass.
          const descendants = [descendant('artifacts/probe'), descendant('chain-runs/probe')];
          assert.equal(operationalClean(issue28State(root, { kind: 'directory', followed: false }, descendants)).status, 'pass');
          break;
        }
        case '03': { // Create, content change, rename, and removal preserve identity.
          const candidate = { base: [{ path: 'src/fix.js', blob: 'A' }], head: [{ path: 'src/fix.js', blob: 'B' }] };
          const before = fingerprint(candidate);
          for (const event of [
            { type: 'create', entries: [descendant('task', 'one')] },
            { type: 'content-change', entries: [descendant('task', 'two')] },
            { type: 'rename', entries: [descendant('renamed', 'two')] },
            { type: 'remove', entries: [] },
          ]) {
            assert.equal(operationalClean(issue28State(root, { kind: 'directory', followed: false }, event.entries)).status, 'pass', event.type);
            assert.equal(fingerprint(candidate), before, event.type);
          }
          break;
        }
        case '04': { // Descendant symlinks are lexical; following a target blocks.
          const lexical = issue28State(root, { kind: 'directory', followed: false }, [{ ...descendant('link'), kind: 'symlink', target: '/outside/secret', followed: false }]);
          assert.equal(operationalClean(lexical).status, 'pass');
          const followed = clone(lexical);
          followed.runtimeDescendantsByRoot[root][0].followed = true;
          blocked(operationalClean(followed));
          break;
        }
        case '05': // Symlink, file, FIFO, socket, device, and unknown roots are unsafe.
          for (const descriptor of [
            { kind: 'symlink', followed: false }, { kind: 'file', followed: false }, { kind: 'fifo', followed: false },
            { kind: 'socket', followed: false }, { kind: 'device', followed: false }, { kind: 'unknown', followed: false },
          ]) blocked(operationalClean(issue28State(root, descriptor)));
          break;
        case '06': { // Every tracked mode/status/stage, intent-to-add, and conflict stage blocks.
          for (const mode of ['120000', '100644', '160000', '040000']) {
            blocked(operationalClean(issue28State(root, undefined, [], { headEntries: [gitEntry(root, { mode })] })));
          }
          for (const options of [
            { status: 'add' }, { status: 'modify' }, { status: 'rename' }, { status: 'delete' },
            { intentToAdd: true }, { stage: 1 }, { stage: 2 }, { stage: 3 },
          ]) blocked(operationalClean(issue28State(root, undefined, [], { indexEntries: [gitEntry(`${root}/file`, options)] })));
          break;
        }
        case '07': // A staged deletion cannot cure a forbidden entry in candidate parent P.
          blocked(operationalClean(issue28State(root, undefined, [], { headEntries: [gitEntry(`${root}/file`)], indexEntries: [gitEntry(`${root}/file`, { status: 'delete' })] })));
          break;
        case '08': { // Only lookalikes corresponding to the current root occurrence are tested.
          const lookalikes = root === '.pi'
            ? ['.pi2/file', 'x/.pi/file', 'foo.pi/bar']
            : ['.pi-subagentsX/file', 'x/.pi-subagents/file', 'foo.pi-subagents/bar'];
          for (const path of lookalikes) blocked(operationalClean(issue28State(root, undefined, [], { untrackedPaths: [path] })));
          break;
        }
        case '10': { // Only the current root is unsafe; the other remains safe.
          blocked(operationalClean(makeUnsafeRoot(bothRootsSafe(), root)));
          break;
        }
        case '11': { // Runtime churn remains safe at every named ordinary/overlay/manifest/commit boundary.
          const churn = (value, changedRoot) => {
            const next = clone(value);
            next.runtimeDescendantsByRoot[changedRoot] = [{ path: `${changedRoot}/churn`, lexical: true, content: 'changed' }];
            next.untrackedPaths = Object.values(next.runtimeDescendantsByRoot).flat().map((entry) => entry.path);
            return next;
          };
          const entries = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
          const ordinary = bothRootsSafe();
          const overlay = bothRootsSafe({ overlayChanges: entries, trackedChanges: ['src/fix.js'], authorizedPaths: ['src/fix.js'], validatedOverlay: clone(entries) });
          const beforeValidation = { ...overlay, validatedOverlay: null };
          const manifest = bothRootsSafe({ ...overlay, trackedChanges: [], indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, unstagedChanges: [] });
          const commit = bothRootsSafe({ ...manifest, localHead: 'C', commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] }, indexEntries: [] });
          for (const boundary of ORDINARY) assert.equal(classify(boundary, churn(ordinary, root)).status, 'pass', `${boundary}:${root}`);
          assert.equal(classify('before-validation', churn(beforeValidation, root)).status, 'pass', `before-validation:${root}`);
          for (const boundary of ['after-validation', 'before-staging']) assert.equal(classify(boundary, churn(overlay, root)).status, 'pass', `${boundary}:${root}`);
          for (const boundary of MANIFEST) assert.equal(classify(boundary, churn(manifest, root)).status, 'pass', `${boundary}:${root}`);
          for (const boundary of CP) assert.equal(classify(boundary, churn(commit, root)).status, 'pass', `${boundary}:${root}`);
          break;
        }
        case '12': { // A forbidden root entry blocks every named boundary, regardless of the other safe root.
          const entries = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
          const overlay = bothRootsSafe({ overlayChanges: entries, trackedChanges: ['src/fix.js'], authorizedPaths: ['src/fix.js'], validatedOverlay: clone(entries) });
          const manifest = bothRootsSafe({ ...overlay, trackedChanges: [], indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, unstagedChanges: [] });
          const commit = bothRootsSafe({ ...manifest, localHead: 'C', commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] }, indexEntries: [] });
          const phases = [
            ['preflight', bothRootsSafe()], ['sol', bothRootsSafe()], ['terra', bothRootsSafe()],
            ['route-to-Sol', bothRootsSafe()], ['luna-delegation', bothRootsSafe()], ['luna-first-edit', bothRootsSafe()],
            ['post-push-gate', bothRootsSafe()], ['reply-batch', bothRootsSafe()], ['individual-reply', bothRootsSafe()],
            ['final-classification', bothRootsSafe()], ['post-reply-readiness', bothRootsSafe()], ['aggregate-summary', bothRootsSafe()],
            ['before-validation', { ...overlay, validatedOverlay: null }], ['after-validation', overlay], ['before-staging', overlay],
            ['after-staging', manifest], ['before-commit', manifest], ['after-commit', commit], ['before-push', commit],
          ];
          for (const [boundary, valid] of phases) assertRootForbiddenAtBoundary(boundary, valid, root);
          break;
        }
        case '13': // Packaging test covers dry-run report and actual tarball for every enumerated root.
          assert.match(PACKAGE_TEST, /const runtimeRoots = \['\.pi', '\.pi-subagents'\]/);
          assert.match(PACKAGE_TEST, /pack\(\['--dry-run', '--json'\]\)/);
          assert.match(PACKAGE_TEST, /pack\(\['--json', '--pack-destination', destination\]\)/);
          assert.match(PACKAGE_TEST, /actual tarball/);
          assert.match(PACKAGE_TEST, new RegExp(`entry === '${root}'|entry === root`));
          break;
        default:
          throw new Error(`unknown root-scoped Issue #28 vector ${vector}`);
      }
    }
  }
  const bothRootsVector = ISSUE_28_VECTOR_TABLE.find(({ scope }) => scope === 'both-roots');
  assert.equal(bothRootsVector.id, '09');
  markIssue28(bothRootsVector.scope, bothRootsVector.id); // Both roots present and safe simultaneously: pass.
  assert.equal(operationalClean(bothRootsSafe()).status, 'pass');
  for (const { id, scope } of ISSUE_28_VECTOR_TABLE.filter(({ scope }) => scope === 'global')) {
    markIssue28(scope, id);
    if (id === '14') { // An ended dirty run cannot resume; only explicit fresh invocation works.
      const terminate = (run) => ({ ...run, status: 'BLOCKED', resumable: false, acceptedState: null });
      const continueRun = (run) => run.resumable ? { status: 'resumed', runId: run.runId } : { status: 'BLOCKED', runId: run.runId, resumed: false };
      const startFresh = (command, prior) => command === 'explicit-command'
        ? { runId: `${command}-${prior.runId + 1}`, status: 'fresh', resumable: false, acceptedState: null, priorStateAccepted: false }
        : { status: 'BLOCKED', runId: prior.runId, resumed: false };
      const ended = terminate({ runId: 41, status: 'dirty_candidate_baseline', resumable: true, acceptedState: { candidate: 'stale' } });
      assert.equal(continueRun(ended).status, 'BLOCKED');
      assert.equal(startFresh(undefined, ended).status, 'BLOCKED');
      const fresh = startFresh('explicit-command', ended);
      assert.notEqual(fresh.runId, ended.runId); assert.equal(fresh.status, 'fresh'); assert.equal(fresh.priorStateAccepted, false); assert.equal(fresh.acceptedState, null);
    } else if (id === '15') { // The exact set equals the guarded set; additions require a recorded decision.
      assert.match(CONTRACT, /RUNTIME_ROOTS.*\{ "\.pi", "\.pi-subagents" \}/s);
      assert.match(SKILL, /RUNTIME_ROOTS.*\{ "\.pi", "\.pi-subagents" \}/s);
      assert.match(SKILL, /every member of `RUNTIME_ROOTS`/);
      assert.match(CONTRACT, /future additions require a recorded contract decision naming the producing tool, default configuration, and affected version range/);
    }
  }
  assert.deepEqual([...executedIssue28Coverage].sort(), [...ISSUE_28_REQUIRED_COVERAGE].sort());
  assert.equal(issue28CoverageOccurrences.length, ISSUE_28_REQUIRED_COVERAGE.length, 'duplicate or missing Issue #28 coverage');
});

test('fixture: Issue #28 every phase independently blocks either unsafe root and forbidden Git state', () => {
  ACTIVE_RUNTIME_ROOT = RUNTIME_ROOTS[0];
  const entries = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
  const overlay = bothRootsSafe({ overlayChanges: entries, trackedChanges: ['src/fix.js'], authorizedPaths: ['src/fix.js'], validatedOverlay: clone(entries) });
  const manifest = bothRootsSafe({ ...overlay, trackedChanges: [], indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, unstagedChanges: [] });
  const commit = bothRootsSafe({ ...manifest, localHead: 'C', commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] }, indexEntries: [] });
  const phases = [
    ['preflight', bothRootsSafe()],
    ['before-validation', { ...overlay, validatedOverlay: null }],
    ['after-validation', overlay],
    ['after-staging', manifest],
    ['before-commit', manifest],
    ['after-commit', commit],
    ['before-push', commit],
  ];
  for (const [boundary, valid] of phases) {
    assert.equal(classify(boundary, valid).status, 'pass', `${boundary}: baseline`);
    for (const root of RUNTIME_ROOTS) {
      // Unsafe-root checks are separate from forbidden-entry checks.
      blocked(classify(boundary, makeUnsafeRoot(valid, root)));
      assertRootForbiddenAtBoundary(boundary, valid, root);
    }
  }
});

const vectors = [
  ['01', 'absent .pi passes ordinary cleanliness', () => assert.equal(operationalClean(baseState()).status, 'pass')],
  ['02', 'real .pi root with consistent runtime descendants passes', () => assert.equal(operationalClean(baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/tasks/probe', lexical: true }], untrackedPaths: ['.pi/tasks/probe'] })).status, 'pass')],
  ['03', 'runtime create/content-change/rename/remove preserve candidate evidence', () => {
    const candidate = { base: [{ path: 'src/fix.js', blob: 'A' }], head: [{ path: 'src/fix.js', blob: 'B' }] };
    const before = fingerprint(candidate);
    const events = [
      { type: 'create', before: [], after: [{ path: '.pi/task', content: 'one', lexical: true }] },
      { type: 'content-change', before: [{ path: '.pi/task', content: 'one', lexical: true }], after: [{ path: '.pi/task', content: 'two', lexical: true }] },
      { type: 'rename', before: [{ path: '.pi/task', content: 'two', lexical: true }], after: [{ path: '.pi/renamed', content: 'two', lexical: true }] },
      { type: 'remove', before: [{ path: '.pi/renamed', content: 'two', lexical: true }], after: [] },
    ];
    for (const event of events) {
      assert.notEqual(event.type, undefined);
      assert.notDeepEqual(event.before, event.after);
      const value = baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: event.after, untrackedPaths: event.after.map((entry) => entry.path) });
      assert.equal(operationalClean(value).status, 'pass', event.type);
      assert.equal(fingerprint(candidate), before, event.type);
    }
  }],
  ['04', 'deep lexical runtime descendants pass', () => assert.equal(operationalClean(baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/a/b/c', lexical: true }], untrackedPaths: ['.pi/a/b/c'] })).status, 'pass')],
  ['05', 'descendant symlink is lexical and outside target is not followed', () => {
    const value = baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/link', kind: 'symlink', target: '/outside/secret', lexical: true, followed: false }], untrackedPaths: ['.pi/link'] });
    assert.equal(runtimeRootSafe(value), true); assert.equal(operationalClean(value).status, 'pass');
    const followed = { ...value, runtimeDescendants: [{ ...value.runtimeDescendants[0], followed: true }] };
    assert.equal(runtimeRootSafe(followed), false); assert.equal(operationalClean(followed).status, 'BLOCKED');
  }],
  ['06', 'repository-root symlink blocks without following target', () => assert.equal(operationalClean(baseState({ piRoot: { kind: 'symlink', followed: false, target: '/real/pi' }, runtimeDescendants: [] })).status, 'BLOCKED')],
  ['07', 'non-directory and unknown roots block', () => { for (const kind of ['file', 'fifo', 'socket', 'device', 'unknown']) assert.equal(operationalClean(baseState({ piRoot: { kind, followed: false }, runtimeDescendants: [] })).status, 'BLOCKED'); }],
  ['08', 'similar names remain outside runtime namespace', () => { for (const path of ['.pi2/file', '.pi-subagentsX/file', 'x/.pi/file', 'x/.pi-subagents/file', 'foo.pi/bar', 'foo.pi-subagents/bar']) assert.equal(operationalClean(baseState({ untrackedPaths: [path] })).status, 'BLOCKED'); }],
  ['09', 'every other untracked path blocks', () => assert.equal(operationalClean(baseState({ untrackedPaths: ['notes.txt', 'src/tmp'] })).status, 'BLOCKED')],
  ['10', 'HEAD or index tracked pi blocks', () => { blocked(operationalClean(baseState({ headEntries: [gitEntry('.pi/file')] }))); blocked(operationalClean(baseState({ indexEntries: [gitEntry('.pi/file')] }))); }],
  ['11', 'forbidden candidate modes block', () => { for (const mode of ['120000', '100644', '160000', '040000']) blocked(operationalClean(baseState({ headEntries: [gitEntry('.pi', { mode })] }))); }],
  ['12', 'staged variants block and parent deletion remains fatal', () => { for (const options of [{ status: 'add' }, { status: 'modify' }, { status: 'rename' }, { status: 'delete' }, { intentToAdd: true }, { stage: 1 }, { stage: 2 }, { stage: 3 }]) blocked(operationalClean(baseState({ indexEntries: [gitEntry('.pi/file', options)] }))); blocked(operationalClean(baseState({ headEntries: [gitEntry('.pi/file')], indexEntries: [] }))); }],
  ['13', 'tracked unstaged pi remains candidate dirt', () => blocked(operationalClean(baseState({ trackedChanges: ['.pi/file'], headEntries: [gitEntry('.pi/file')] })))],
  ['14', 'authorized overlay and runtime churn pass only with exact authority', () => {
    const overlay = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
    const value = baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/tasks/new', lexical: true }], untrackedPaths: ['.pi/tasks/new'], overlayChanges: overlay, trackedChanges: ['src/fix.js'], authorizedPaths: ['src/fix.js'], validatedOverlay: clone(overlay) });
    assert.equal(overlayClean(value, 'after-validation').status, 'pass'); blocked(overlayClean({ ...value, authorizedPaths: ['.pi/file'] }, 'after-validation')); blocked(overlayClean({ ...value, indexEntries: [gitEntry('other.js')] }, 'after-validation')); blocked(overlayClean({ ...value, trackedChanges: ['other.js'] }, 'after-validation'));
  }],
  ['15', 'validation drift fails before staging without effects', () => {
    const frozen = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
    const result = overlayClean(baseState({ overlayChanges: [{ ...frozen[0], blob: 'C' }], trackedChanges: ['src/fix.js'], validatedOverlay: frozen }), 'after-validation'); blocked(result);
  }],
  ['16', 'manifest compares independent index state and rejects every mismatch', () => {
    const entries = [gitEntry('src/fix.js', { status: 'modify', blob: 'B' })];
    const good = baseState({ overlayChanges: entries, validatedOverlay: entries, trackedChanges: [], indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] } });
    assert.equal(manifestClean(good).status, 'pass');
    for (const bad of [
      { manifest: { ...good.manifest, tree: 'different' } },
      { indexSnapshot: { ...good.indexSnapshot, entries: [gitEntry('other.js')] } },
      { manifest: { ...good.manifest, entries: [gitEntry(runtimePath('.pi/file'))] } },
      { manifest: { ...good.manifest, treeEntries: [gitEntry(runtimePath('.pi/file'))] } },
      { manifest: { ...good.manifest, blobs: ['wrong'] } },
      withHazard(good, 'validatedOverlayStagedManifest'),
      { unstagedChanges: ['src/fix.js'] },
    ]) blocked(manifestClean({ ...good, ...bad }));
  }],
  ['17', 'commit tree pi and parent pi stop before push', () => {
    const entries = [gitEntry('src/fix.js', { status: 'modify', blob: 'B' })];
    const good = baseState({ localHead: 'C', overlayChanges: entries, validatedOverlay: entries, indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] } });
    assert.equal(postCommitClean(good).status, 'pass'); blocked(postCommitClean({ ...good, headEntries: [gitEntry('.pi/file')] })); blocked(postCommitClean({ ...good, commit: { ...good.commit, entries: [gitEntry('.pi/file')] } })); blocked(postCommitClean({ ...good, commit: { ...good.commit, treeEntries: [gitEntry('.pi/file')] } }));
  }],
  ['18', 'post-commit C over remote P uses distinct guard', () => {
    const entries = [gitEntry('src/fix.js', { status: 'modify', blob: 'B' })];
    const value = baseState({ localHead: 'C', piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/tasks/probe', lexical: true }], untrackedPaths: ['.pi/tasks/probe'], overlayChanges: entries, validatedOverlay: entries, indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] } });
    assert.equal(postCommitClean(value).status, 'pass'); blocked(operationalClean(value));
  }],
  ['19', 'runtime churn preserves every applicable exact-autofix boundary', () => {
    const entries = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
    const ordinary = baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/tasks/churn', lexical: true }], untrackedPaths: ['.pi/tasks/churn'] });
    for (const boundary of ORDINARY) assert.equal(classify(boundary, ordinary).status, 'pass', boundary);
    const overlay = { ...ordinary, overlayChanges: entries, trackedChanges: ['src/fix.js'], authorizedPaths: ['src/fix.js'], validatedOverlay: clone(entries) };
    assert.equal(classify('before-validation', { ...overlay, validatedOverlay: null }).status, 'pass');
    for (const boundary of ['after-validation', 'before-staging']) assert.equal(classify(boundary, overlay).status, 'pass', boundary);
    const manifest = { ...overlay, trackedChanges: [], indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, unstagedChanges: [] };
    for (const boundary of MANIFEST) assert.equal(classify(boundary, manifest).status, 'pass', boundary);
    const cp = { ...manifest, localHead: 'C', piRoot: { kind: 'absent', followed: false }, runtimeDescendants: [], untrackedPaths: [], commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] }, indexEntries: [] };
    const stableIdentity = stable({ localHead: cp.localHead, remoteHead: cp.remoteHead, publishedHead: cp.publishedHead, headEntries: cp.headEntries, indexEntries: cp.indexEntries, indexSnapshot: cp.indexSnapshot, manifest: cp.manifest, commit: cp.commit, overlayChanges: cp.overlayChanges, validatedOverlay: cp.validatedOverlay });
    assert.equal(classify('after-commit', cp).status, 'pass');
    const runtimeTransitions = [
      { kind: 'directory', descendants: [{ path: runtimePath('.pi/task'), content: 'one', lexical: true }] },
      { kind: 'directory', descendants: [{ path: runtimePath('.pi/task'), content: 'two', lexical: true }] },
      { kind: 'directory', descendants: [{ path: runtimePath('.pi/renamed'), content: 'two', lexical: true }] },
      { kind: 'directory', descendants: [] },
      { kind: 'absent', descendants: [] },
    ];
    for (const transition of runtimeTransitions) {
      const beforePush = { ...cp, piRoot: { kind: transition.kind, followed: false }, runtimeDescendants: transition.descendants, untrackedPaths: transition.descendants.map((entry) => entry.path) };
      assert.equal(classify('before-push', beforePush).status, 'pass', transition.kind);
      assert.equal(stable({ localHead: beforePush.localHead, remoteHead: beforePush.remoteHead, publishedHead: beforePush.publishedHead, headEntries: beforePush.headEntries, indexEntries: beforePush.indexEntries, indexSnapshot: beforePush.indexSnapshot, manifest: beforePush.manifest, commit: beforePush.commit, overlayChanges: beforePush.overlayChanges, validatedOverlay: beforePush.validatedOverlay }), stableIdentity);
    }
    const unsafe = { ...cp, piRoot: { kind: 'symlink', followed: false }, runtimeDescendants: [] };
    assert.equal(classify('before-push', unsafe).status, 'BLOCKED:push_guard');
  }],
  ['20', 'each boundary independently rejects each applicable hazard before effects', () => {
    const entries = [{ path: 'src/fix.js', status: 'modify', mode: '100644', blob: 'B' }];
    const ordinary = baseState({ piRoot: { kind: 'directory', followed: false }, runtimeDescendants: [{ path: '.pi/tasks/x', lexical: true }], untrackedPaths: ['.pi/tasks/x'] });
    const overlay = baseState({ ...ordinary, overlayChanges: entries, trackedChanges: ['src/fix.js'], authorizedPaths: ['src/fix.js'], validatedOverlay: clone(entries) });
    const beforeValidation = { ...overlay, validatedOverlay: null };
    const manifest = baseState({ ...overlay, trackedChanges: [], indexSnapshot: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, manifest: { parent: 'P', tree: 'T', treeEntries: [], entries, blobs: ['B'] }, unstagedChanges: [] });
    const cp = baseState({ ...manifest, localHead: 'C', commit: { oid: 'C', parents: ['P'], tree: 'T', treeEntries: [], entries, blobs: ['B'] } });
    const boundaries = [...ORDINARY, ...OVERLAY, ...MANIFEST, ...CP];
    for (const boundary of boundaries) {
      const valid = boundary === 'after-commit' || boundary === 'before-push' ? cp
        : boundary === 'after-staging' || boundary === 'before-commit' ? manifest
          : boundary === 'before-validation' ? beforeValidation
            : boundary === 'after-validation' || boundary === 'before-staging' ? overlay : ordinary;
      assert.equal(classify(boundary, valid).status, 'pass', `${boundary}: valid baseline`);
      for (const hazard of hazardsForBoundary(boundary)) {
        const key = `${ACTIVE_RUNTIME_ROOT}:${boundary}:${hazard}`;
        markSubcase(key);
        const result = classify(boundary, withHazard(valid, hazard));
        blocked(result);
      }
    }
  }],
  ['21', 'base-only runtime-root deletion preserves exact raw diff through blocked correction', () => {
    const runtimeEntry = runtimePath('.pi/old');
    const baseEntries = [{ path: runtimeEntry, blob: 'OLD' }, { path: 'src/fix.js', blob: 'A' }];
    const candidateEntries = [{ path: 'src/fix.js', blob: 'B' }];
    const freezeRawDiff = (base, candidate) => Buffer.from(`RAW-DIFF\\n${base[0].path}:${base[0].blob}\\n${candidate[0].path}:${candidate[0].blob}\\n`, 'utf8');
    const frozenRawDiff = freezeRawDiff(baseEntries, candidateEntries);
    const frozenDigest = crypto.createHash('sha256').update(frozenRawDiff).digest('hex');
    assert.ok(frozenRawDiff.includes(Buffer.from(runtimeEntry)), `raw diff must contain active runtime root ${ACTIVE_RUNTIME_ROOT}`);
    // The blocked transition proves raw bytes and digest are unchanged.
    const attemptUnauthorizedCorrection = (value) => {
      const failed = overlayClean(value, 'after-validation');
      return { status: failed.status, rawDiff: value.rawDiff, digest: crypto.createHash('sha256').update(value.rawDiff).digest('hex'), effects: failed.status === 'pass' ? { correction: 1 } : { correction: 0 } };
    };
    const value = baseState({ baseEntries, candidateEntries, rawDiff: frozenRawDiff, overlayChanges: [{ path: runtimeEntry, status: 'add', blob: 'NEW' }], validatedOverlay: [{ path: runtimeEntry, status: 'add', blob: 'NEW' }], authorizedPaths: ['src/fix.js'] });
    const result = attemptUnauthorizedCorrection(value);
    assert.equal(result.status, 'validation_failed');
    assert.deepEqual(result.rawDiff, frozenRawDiff);
    assert.equal(result.digest, frozenDigest);
    assert.deepEqual(result.effects, { correction: 0 });
  }],
  ['22', 'package path predicate covers exact and descendants but not near names', () => { for (const root of RUNTIME_ROOTS) for (const path of [root, `${root}/tasks/probe`, `${root}/a/b`]) assert.equal(isRuntimeNamespace(path), true); for (const path of ['.pi2/x', '.pi-subagentsX/x', 'x/.pi/y', 'x/.pi-subagents/y', 'foo.pi/z', 'foo.pi-subagents/z']) assert.equal(isRuntimeNamespace(path), false); }],
  ['23', 'dirty run rejects continuation and creates a clean fresh run', () => {
    // A fresh invocation receives a new run ID and no prior accepted state.
    const terminate = (run) => ({ ...run, status: 'BLOCKED', resumable: false, acceptedState: null });
    const continueRun = (run) => run.resumable ? { status: 'resumed', runId: run.runId } : { status: 'BLOCKED', runId: run.runId, resumed: false };
    const startFresh = (command, prior) => command === 'explicit-command'
      ? { runId: `${command}-${prior.runId + 1}`, status: 'fresh', resumable: false, acceptedState: null, priorStateAccepted: false }
      : { status: 'BLOCKED', runId: prior.runId, resumed: false };
    const dirty = { runId: 41, status: 'dirty_candidate_baseline', resumable: true, acceptedState: { candidate: 'stale' } };
    const ended = terminate(dirty);
    assert.equal(continueRun(ended).status, 'BLOCKED');
    assert.equal(continueRun(ended).resumed, false);
    assert.equal(startFresh(undefined, ended).status, 'BLOCKED');
    assert.equal(startFresh('resume', ended).status, 'BLOCKED');
    const fresh = startFresh('explicit-command', ended);
    assert.notEqual(fresh.runId, ended.runId);
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.priorStateAccepted, false);
    assert.equal(fresh.acceptedState, null);
  }],
];
for (const [id, name, assertion] of vectors) test(`fixture: Issue #17 vector ${id} — ${name}`, () => {
  for (const root of RUNTIME_ROOTS) {
    ACTIVE_RUNTIME_ROOT = root;
    mark(id);
    assertion();
  }
  ACTIVE_RUNTIME_ROOT = RUNTIME_ROOTS[0];
});

test('fixture: Issue #17 required acceptance-vector inventory is complete', () => {
  assert.deepEqual([...executedCoverage].sort(), [...ISSUE_17_REQUIRED_VECTORS].sort());
  assert.equal(executedCoverage.size, ISSUE_17_REQUIRED_VECTORS.length);
});
test('fixture: Issue #17 vector 20 boundary-hazard inventory is complete for every runtime root', () => {
  assert.deepEqual([...executedSubcases].sort(), [...REQUIRED_VECTOR_20_SUBCASES].sort());
  assert.equal(executedSubcases.size, REQUIRED_VECTOR_20_SUBCASES.length);
  assert.equal(executedSubcaseOccurrences.length, executedSubcases.size, 'duplicate boundary-hazard subcase execution');
});
