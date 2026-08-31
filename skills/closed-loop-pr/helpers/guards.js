'use strict';

// Issue #96 rule 1 (CL-D57) — the batch-sequence guards Luna kept re-deriving by hand,
// packaged as read-only operations. Every failure names the violated subcheck and the
// observed value (CL-D55 by construction). Predicates encode the observed defect classes:
// authorized paths are a maximum set, not a demand; the index is compared against the
// immutable staged manifest, never against only the authorized changed files; and a guard
// failure with nothing to name cannot be produced, because each check reports what it saw.

const crypto = require('node:crypto');
const { createResult, createError } = require('./protocol');
const { runSync, gitArgs } = require('./process');
const { RUNTIME_ROOTS } = require('./operator');
const { classifyRuntimeRoots } = require('./paths');
const { verifyWorkspace } = require('./workspace');

const OID = /^[0-9a-f]{40}$/;
const text = (value) => typeof value === 'string' && value.length > 0;
function fail(code, subcheck, message, observed) {
  throw Object.assign(new Error(`${subcheck}: ${message}`), { code, details: { subcheck, observed: observed === undefined ? message : observed } });
}
// Every failure leaving a guard names its subcheck and what was observed — including raw
// process failures, which are normalized rather than allowed to escape unnamed (CL-D55).
function wrap(operation, observe) {
  try { return observe(); } catch (error) {
    const details = error.details && error.details.subcheck !== undefined
      ? error.details
      : { subcheck: 'process_failure', observed: error.message };
    return createError(operation, error.code || 'guard_failed', error.message, operation, details);
  }
}
// The runtime-root fail-stop invariant: classify each root no-follow before excluding its
// descendant churn; any type other than absent or a real directory stops with the root named.
function assertSafeRuntimeRoots(cwd) {
  const classes = classifyRuntimeRoots(cwd);
  for (const [root, info] of Object.entries(classes)) {
    if (!info.safe) fail('guard_failed', 'runtime_root_classification', `runtime root is not absent or a real directory: ${root} is ${info.kind}`, `${root}:${info.kind}`);
  }
}
function gitBytes(cwd, args, phase, acceptExitCodes) {
  return Buffer.from(runSync('git', gitArgs(args), { cwd, phase, encoding: 'buffer', acceptExitCodes }));
}
function gitText(cwd, args, phase, acceptExitCodes) {
  return gitBytes(cwd, args, phase, acceptExitCodes).toString('utf8');
}
function runtimeRooted(entry) {
  return RUNTIME_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`));
}
function checkAuthorizedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) fail('invalid_request', 'authorized_paths_shape', 'authorizedPaths must be a nonempty array', Array.isArray(paths) ? `length ${paths.length}` : typeof paths);
  for (const entry of paths) {
    if (!text(entry) || entry.startsWith('/') || entry.split('/').some((part) => ['', '.', '..'].includes(part))) {
      fail('invalid_request', 'authorized_paths_shape', `authorized path is not a normalized relative path: ${JSON.stringify(entry)}`, entry);
    }
  }
  if (new Set(paths).size !== paths.length) fail('invalid_request', 'authorized_paths_shape', 'authorizedPaths carries a duplicate', paths.find((entry, i) => paths.indexOf(entry) !== i));
  const rooted = paths.find(runtimeRooted);
  if (rooted !== undefined) fail('invalid_request', 'runtime_root_exclusion', `authorized path is under a runtime root: ${rooted}`, rooted);
  return new Set(paths);
}
// `git status --porcelain -z` observation of the working tree, runtime roots excluded: the
// safe untracked runtime churn is outside every overlay by rule, never a finding here.
function porcelainEntries(cwd, phase) {
  const raw = gitText(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], phase);
  const entries = [];
  const records = raw.split('\0').filter((record) => record.length > 0);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const staged = record[0], unstaged = record[1], entry = record.slice(3);
    if (staged === 'R' || staged === 'C') i += 1;
    if (runtimeRooted(entry)) continue;
    entries.push({ path: entry, staged, unstaged });
  }
  return entries;
}
function diffDigest(cwd, entry, phase) {
  const bytes = entry.staged === '?'
    ? gitBytes(cwd, ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', entry.path], phase, [1])
    : gitBytes(cwd, ['diff', '--no-ext-diff', '--', entry.path], phase);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function guardBeforeEdit(data) {
  return wrap('guard_before_edit', () => {
    const phase = 'guard_before_edit';
    if (!text(data.cwd)) fail('invalid_request', 'request_shape', 'cwd must be a nonempty string', typeof data.cwd);
    checkAuthorizedPaths(data.authorizedPaths);
    const workspace = verifyWorkspace(data.cwd, data.expected);
    if (workspace && workspace.ok === false) {
      fail(workspace.error.code, 'workspace_identity', workspace.error.message);
    }
    return createResult('guard_before_edit', {
      subchecks: ['request_shape', 'authorized_paths_shape', 'runtime_root_exclusion', 'workspace_identity'],
      authorizedPaths: [...data.authorizedPaths],
    });
  });
}

function overlayObservation(cwd, authorized, phase) {
  assertSafeRuntimeRoots(cwd);
  const entries = [];
  for (const entry of porcelainEntries(cwd, phase)) {
    if (entry.staged !== ' ' && entry.staged !== '?') {
      fail('guard_failed', 'index_clean', `index is not clean before staging: ${entry.path}`, entry.path);
    }
    if (authorized && !authorized.has(entry.path)) {
      fail('guard_failed', 'authorized_subset', `changed path is outside the authorized maximum set: ${entry.path}`, entry.path);
    }
    entries.push({ path: entry.path, status: entry.staged === '?' ? 'A?' : entry.unstaged, rawDiffSha256: diffDigest(cwd, entry, phase) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { parent: gitText(cwd, ['rev-parse', 'HEAD'], phase).trim(), entries };
}

function overlayFreeze(data) {
  return wrap('overlay_freeze', () => {
    const phase = 'overlay_freeze';
    if (!text(data.cwd)) fail('invalid_request', 'request_shape', 'cwd must be a nonempty string', typeof data.cwd);
    const authorized = checkAuthorizedPaths(data.authorizedPaths);
    const overlay = overlayObservation(data.cwd, authorized, phase);
    // Authorized paths are a maximum set, not a demand: the overlay must stay inside them
    // and must not be empty, but no authorized path is required to change.
    if (overlay.entries.length === 0) fail('guard_failed', 'overlay_nonempty', 'no authorized path changed; there is no overlay to freeze', 'clean working tree');
    return createResult('overlay_freeze', { ...overlay, authorizedPaths: [...data.authorizedPaths].sort() });
  });
}

function checkFrozenOverlay(overlay) {
  const plain = overlay !== null && typeof overlay === 'object' && !Array.isArray(overlay);
  if (!plain || !OID.test(overlay.parent || '') || !Array.isArray(overlay.entries) || overlay.entries.length === 0
    || !Array.isArray(overlay.authorizedPaths)
    || overlay.entries.some((entry) => !text(entry.path) || !text(entry.status) || !/^[0-9a-f]{64}$/.test(entry.rawDiffSha256 || ''))) {
    fail('invalid_request', 'overlay_shape', 'overlay must be the data of a prior overlay_freeze', typeof overlay);
  }
}

function overlayCompare(data) {
  return wrap('overlay_compare', () => {
    const phase = 'overlay_compare';
    if (!text(data.cwd)) fail('invalid_request', 'request_shape', 'cwd must be a nonempty string', typeof data.cwd);
    checkFrozenOverlay(data.overlay);
    const observed = overlayObservation(data.cwd, new Set(data.overlay.authorizedPaths), phase);
    if (observed.parent !== data.overlay.parent) {
      fail('guard_failed', 'overlay_drift', `parent moved: frozen ${data.overlay.parent}, observed ${observed.parent}`, observed.parent);
    }
    const frozen = new Map(data.overlay.entries.map((entry) => [entry.path, entry]));
    for (const entry of observed.entries) {
      const expected = frozen.get(entry.path);
      if (!expected) fail('guard_failed', 'overlay_drift', `path entered the overlay after the freeze: ${entry.path}`, entry.path);
      if (expected.status !== entry.status || expected.rawDiffSha256 !== entry.rawDiffSha256) {
        fail('guard_failed', 'overlay_drift', `frozen bytes changed for ${entry.path}: status ${expected.status}→${entry.status}, rawDiffSha256 ${expected.rawDiffSha256}→${entry.rawDiffSha256}`, entry.path);
      }
      frozen.delete(entry.path);
    }
    const missing = frozen.keys().next();
    if (!missing.done) fail('guard_failed', 'overlay_drift', `path left the overlay after the freeze: ${missing.value}`, missing.value);
    return createResult('overlay_compare', { subchecks: ['overlay_shape', 'overlay_drift'], entryCount: observed.entries.length });
  });
}

// The comparison source is always the index diff against the stated parent — never the whole
// index versus authorized changed files — so an entry the parent commit already carries can
// never be misclassified as unauthorized.
function stagedEntries(cwd, parent, phase) {
  assertSafeRuntimeRoots(cwd);
  const raw = gitText(cwd, ['diff', '--no-ext-diff', '--no-abbrev', '--cached', '--raw', '-z', parent, '--'], phase);
  const records = raw.split('\0').filter((record) => record.length > 0);
  const entries = [];
  for (let i = 0; i < records.length; i += 1) {
    const meta = records[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d+)?$/);
    if (!meta) fail('guard_failed', 'index_observation', `unparsable raw diff record: ${records[i]}`);
    const entry = { srcMode: meta[1], dstMode: meta[2], srcOid: meta[3], dstOid: meta[4], status: meta[5], path: records[i + 1] };
    i += meta[5] === 'R' || meta[5] === 'C' ? 2 : 1;
    if (meta[5] === 'R' || meta[5] === 'C') entry.path = records[i];
    if (runtimeRooted(entry.path)) fail('guard_failed', 'runtime_root_exclusion', `runtime-root path is staged: ${entry.path}`, entry.path);
    entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return entries;
}

function manifestCompare(data) {
  return wrap('manifest_compare', () => {
    const phase = 'manifest_compare';
    if (!text(data.cwd)) fail('invalid_request', 'request_shape', 'cwd must be a nonempty string', typeof data.cwd);
    if (!OID.test(data.parent || '')) fail('invalid_request', 'request_shape', 'parent must be a 40-hex commit OID', String(data.parent));
    const capture = Object.hasOwn(data, 'authorizedPaths'), compare = Object.hasOwn(data, 'manifest');
    if (capture === compare) fail('invalid_request', 'request_shape', 'supply exactly one of authorizedPaths (capture) or manifest (compare)', capture ? 'both supplied' : 'neither supplied');
    const observed = stagedEntries(data.cwd, data.parent, phase);
    if (capture) {
      const authorized = checkAuthorizedPaths(data.authorizedPaths);
      if (observed.length === 0) fail('guard_failed', 'manifest_nonempty', 'the index equals the parent; there is no staged manifest to capture', 'empty index diff');
      for (const entry of observed) {
        if (!authorized.has(entry.path)) fail('guard_failed', 'authorized_subset', `staged path is outside the authorized maximum set: ${entry.path}`, entry.path);
      }
      return createResult('manifest_compare', { manifest: { parent: data.parent, entries: observed } });
    }
    const manifest = data.manifest;
    const shaped = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.parent === data.parent && Array.isArray(manifest.entries) && manifest.entries.length > 0;
    if (!shaped) fail('invalid_request', 'manifest_shape', 'manifest must be the data of a prior manifest_compare capture for the same parent', typeof manifest);
    const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    for (const entry of observed) {
      const want = expected.get(entry.path);
      if (!want) fail('guard_failed', 'manifest_drift', `staged path is not in the immutable manifest: ${entry.path}`, entry.path);
      for (const field of ['srcMode', 'dstMode', 'srcOid', 'dstOid', 'status']) {
        if (want[field] !== entry[field]) fail('guard_failed', 'manifest_drift', `manifest ${field} changed for ${entry.path}: ${want[field]}→${entry[field]}`, entry.path);
      }
      expected.delete(entry.path);
    }
    const missing = expected.keys().next();
    if (!missing.done) fail('guard_failed', 'manifest_drift', `manifest entry is no longer staged: ${missing.value}`, missing.value);
    return createResult('manifest_compare', { subchecks: ['manifest_shape', 'manifest_drift'], entryCount: observed.length });
  });
}

module.exports = { guardBeforeEdit, overlayFreeze, overlayCompare, manifestCompare };
