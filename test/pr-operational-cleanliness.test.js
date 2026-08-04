'use strict';

// Provenance: the artifact assertions were authored first and produced a captured
// compile/contract RED after a syntax typo was corrected. The reference fixtures
// were co-developed, then strengthened review-driven. They are non-authoritative
// specifications and cannot prove LLM/runtime behavior. npm-pack coverage is a
// retrospective behavioral characterization, not RED evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readText } = require('./helpers');

const CONTRACT = readText('CONTRACT.md');
const SKILL = readText('skills/closed-loop-pr/SKILL.md');
const README = readText('README.md');
const executedCoverage = new Set();
const executedSubcases = new Set();
const executedSubcaseOccurrences = [];
// Inventory labels: Issue #17 vector 01 through Issue #17 vector 23.
const ISSUE_17_REQUIRED_VECTORS = Array.from({ length: 23 }, (_, i) => String(i + 1).padStart(2, '0'));

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n(?:##|###) /);
  return text.slice(start, next === -1 ? undefined : start + heading.length + next);
}
function isPiNamespace(value) { return value === '.pi' || value.startsWith('.pi/'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return JSON.stringify(value); }
function fingerprint(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function gitEntry(path, options = {}) {
  return { path, mode: options.mode || '100644', stage: options.stage || 0,
    intentToAdd: options.intentToAdd || false, status: options.status || 'unchanged',
    blob: options.blob || `blob:${path}` };
}
function baseState(overrides = {}) {
  return {
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
  };
}
function runtimeRootSafe(value) {
  const kinds = new Set(['absent', 'directory', 'symlink', 'file', 'fifo', 'socket', 'device', 'unknown']);
  if (!kinds.has(value.piRoot.kind) || value.piRoot.followed !== false) return false;
  if (value.piRoot.kind === 'directory') {
    const descendants = value.runtimeDescendants.map((entry) => entry.path).sort();
    const untracked = value.untrackedPaths.filter((path) => isPiNamespace(path)).sort();
    return value.runtimeDescendants.every((entry) => entry.path.startsWith('.pi/') && entry.lexical === true && entry.followed !== true) &&
      stable(descendants) === stable(untracked);
  }
  return value.piRoot.kind === 'absent' && value.runtimeDescendants.length === 0 &&
    value.untrackedPaths.every((path) => !isPiNamespace(path));
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
// Independent acceptance inventory: this literal is intentionally not derived from
// hazardsForBoundary() or the execution loop, so omissions cannot self-certify.
const REQUIRED_VECTOR_20_SUBCASES = [
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
    case 'parent': next.headEntries = [...next.headEntries, gitEntry('.pi/file')]; break;
    case 'index': next.indexEntries = [...next.indexEntries, gitEntry('.pi/file', { stage: 2, intentToAdd: true, status: 'add' })]; break;
    case 'identity': next.identityOk = false; break;
    case 'overlayAuthority': next.authorizedPaths = ['.pi/file']; break;
    case 'overlayDrift': next.overlayChanges = next.overlayChanges.map((entry) => ({ ...entry, blob: 'drifted' })); break;
    case 'overlayIndex': next.overlayChanges = next.overlayChanges.map((entry) => ({ ...entry, blob: 'index-drift' })); break;
    case 'stagedIndexPath': next.indexSnapshot.entries = [...next.indexSnapshot.entries, gitEntry('.pi/file')]; break;
    case 'stagedIndexTree': next.indexSnapshot.treeEntries = [...next.indexSnapshot.treeEntries, gitEntry('.pi/file')]; break;
    case 'manifestPath': next.manifest.entries = [...next.manifest.entries, gitEntry('.pi/file')]; break;
    case 'manifestTree': next.manifest.treeEntries = [...next.manifest.treeEntries, gitEntry('.pi/file')]; break;
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
    case 'commitPath': next.commit.entries = [...next.commit.entries, gitEntry('.pi/file')]; break;
    case 'commitTree': next.commit.treeEntries = [...next.commit.treeEntries, gitEntry('.pi/file')]; break;
    case 'commitBlob': next.commit.blobs = ['wrong']; break;
    default: throw new Error(`unknown Issue #17 hazard ${hazard}`);
  }
  return next;
}

// Section-scoped compile/contract coverage, including forbidden stale wording.
test('artifact: Issue #17 sections define scoped operational cleanliness', () => {
  const d10 = section(CONTRACT, '## CL-D10 — Worktree precondition for autofix');
  const d30 = section(CONTRACT, '## CL-D30 — Exact PR autofix publishes one bounded correction per public head');
  const preflight = section(SKILL, '### Worktree precondition (CL-D10)');
  const phases = section(SKILL, '### Exact identity and Luna publication phases');
  const boundaries = section(SKILL, '### Public-head loop and evidence');
  const replies = section(SKILL, '### Source-finding replies and final readiness');
  for (const text of [d10, d30, preflight, phases, boundaries]) {
    assert.match(text, /repository-root `?\.pi/);
    assert.match(text, /real (?:repository-root )?\.pi directory|real directory/);
    assert.match(text, /without following links|not follow/);
    assert.match(text, /outside.*untracked|untracked.*outside/si);
    assert.match(text, /HEAD.*index|index.*HEAD/si);
  }
  assert.match(replies, /repository-root directory|\.pi\/\*\*/);
  assert.match(replies, /safe untracked repository-root `?\.pi\/\*\*` runtime bytes and contents are excluded from every gate payload, candidate draft, finding\/validation evidence, Luna correction scope, disposition claim, source reply, and aggregate-summary claim/i);
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
  assert.match(boundaries, /each ordinary exact-autofix boundary listed in this paragraph/);
  assert.match(boundaries, /distinct phase guards below/);
  assert.match(phases, /BEFORE_VALIDATION|immediately before focused validation/);
  assert.match(phases, /AFTER_VALIDATION|immediately after focused/);
  assert.match(phases, /BEFORE_STAGING|immediately before staging/);
  assert.match(phases, /AFTER_STAGING|immediately after staging/);
  assert.match(phases, /BEFORE_COMMIT|immediately before commit/);
  assert.match(phases, /AFTER_COMMIT.*POST_COMMIT_PRE_PUSH|Immediately after commit.*POST_COMMIT_PRE_PUSH/si);
  assert.match(phases, /BEFORE_PUSH.*POST_COMMIT_PRE_PUSH|Immediately before push.*full identical/si);
  assert.match(phases, /outside-`?\.pi\/\*\*.*empty/si);
  assert.match(phases, /distinct `?POST_COMMIT_PRE_PUSH|distinct post-commit\/pre-push/);
  assert.match(d30, /raw.*effective diff|raw.*diff/si);
  assert.match(README, /untracked descendants.*\.pi|untracked.*\.pi.*runtime/si);
  assert.match(README, /AFTER_COMMIT.*BEFORE_PUSH.*independently reclassify/si);
  assert.match(d30, /AFTER_COMMIT.*BEFORE_PUSH.*independently reclassif/si);
  assert.match(phases, /safe untracked runtime churn.*may change.*descendant create.*content change.*rename.*removal/si);
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
  ['08', 'similar names remain outside runtime namespace', () => { for (const path of ['.pi2/file', 'x/.pi/file', 'foo.pi/bar']) assert.equal(operationalClean(baseState({ untrackedPaths: [path] })).status, 'BLOCKED'); }],
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
      { manifest: { ...good.manifest, entries: [gitEntry('.pi/file')] } },
      { manifest: { ...good.manifest, treeEntries: [gitEntry('.pi/file')] } },
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
      { kind: 'directory', descendants: [{ path: '.pi/task', content: 'one', lexical: true }] },
      { kind: 'directory', descendants: [{ path: '.pi/task', content: 'two', lexical: true }] },
      { kind: 'directory', descendants: [{ path: '.pi/renamed', content: 'two', lexical: true }] },
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
        const key = `${boundary}:${hazard}`;
        markSubcase(key);
        const result = classify(boundary, withHazard(valid, hazard));
        blocked(result);
      }
    }
  }],
  ['21', 'base-only .pi deletion preserves exact raw diff through blocked correction', () => {
    const baseEntries = [{ path: '.pi/old', blob: 'OLD' }, { path: 'src/fix.js', blob: 'A' }];
    const candidateEntries = [{ path: 'src/fix.js', blob: 'B' }];
    const freezeRawDiff = (base, candidate) => Buffer.from(`RAW-DIFF\\n${base[0].path}:${base[0].blob}\\n${candidate[0].path}:${candidate[0].blob}\\n`, 'utf8');
    const frozenRawDiff = freezeRawDiff(baseEntries, candidateEntries);
    const frozenDigest = crypto.createHash('sha256').update(frozenRawDiff).digest('hex');
    // The blocked transition proves raw bytes and digest are unchanged.
    const attemptUnauthorizedCorrection = (value) => {
      const failed = overlayClean(value, 'after-validation');
      return { status: failed.status, rawDiff: value.rawDiff, digest: crypto.createHash('sha256').update(value.rawDiff).digest('hex'), effects: failed.status === 'pass' ? { correction: 1 } : { correction: 0 } };
    };
    const value = baseState({ baseEntries, candidateEntries, rawDiff: frozenRawDiff, overlayChanges: [{ path: '.pi/new', status: 'add', blob: 'NEW' }], validatedOverlay: [{ path: '.pi/new', status: 'add', blob: 'NEW' }], authorizedPaths: ['src/fix.js'] });
    const result = attemptUnauthorizedCorrection(value);
    assert.equal(result.status, 'validation_failed');
    assert.deepEqual(result.rawDiff, frozenRawDiff);
    assert.equal(result.digest, frozenDigest);
    assert.deepEqual(result.effects, { correction: 0 });
  }],
  ['22', 'package path predicate covers exact and descendants but not near names', () => { for (const path of ['.pi', '.pi/tasks/probe', '.pi/a/b']) assert.equal(isPiNamespace(path), true); for (const path of ['.pi2/x', 'x/.pi/y', 'foo.pi/z']) assert.equal(isPiNamespace(path), false); }],
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
for (const [id, name, assertion] of vectors) test(`fixture: Issue #17 vector ${id} — ${name}`, () => { mark(id); assertion(); });

test('fixture: Issue #17 required acceptance-vector inventory is complete', () => {
  assert.deepEqual([...executedCoverage].sort(), [...ISSUE_17_REQUIRED_VECTORS].sort());
  assert.equal(executedCoverage.size, ISSUE_17_REQUIRED_VECTORS.length);
});
test('fixture: Issue #17 vector 20 boundary-hazard inventory is complete', () => {
  assert.deepEqual([...executedSubcases].sort(), [...REQUIRED_VECTOR_20_SUBCASES].sort());
  assert.equal(executedSubcases.size, REQUIRED_VECTOR_20_SUBCASES.length);
  assert.equal(executedSubcaseOccurrences.length, executedSubcases.size, 'duplicate boundary-hazard subcase execution');
});
