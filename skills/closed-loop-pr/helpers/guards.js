'use strict';

// Issue #96 rule 1 (CL-D57) — the batch-sequence guards Luna kept re-deriving by hand,
// packaged as read-only operations. Every failure names the violated subcheck and the
// observed value (CL-D55 by construction). Predicates encode the observed defect classes:
// authorized paths are a maximum set, not a demand; the index is compared against the
// immutable staged manifest, never against only the authorized changed files; and a guard
// failure with nothing to name cannot be produced, because each check reports what it saw.

const crypto = require('node:crypto');
const path = require('node:path');
const { createResult, createError } = require('./protocol');
const { runSync, gitArgs } = require('./process');
const { RUNTIME_ROOTS } = require('./operator');
const { classifyRuntimeRoots, lstatKind } = require('./paths');
const { checkRequiredEvidence } = require('./gate-result');
const { verifyWorkspace } = require('./workspace');

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
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
    // Control characters would make a path unmatchable against NUL-delimited Git output, and
    // a blank path is not a path at all; both are rejected here rather than by a later Git
    // invocation whose failure would name the wrong subcheck.
    if (!text(entry) || entry.startsWith('/') || entry.trim().length === 0
      // eslint-disable-next-line no-control-regex
      || /[\u0000-\u001f\u007f]/.test(entry)
      || entry.split('/').some((part) => ['', '.', '..'].includes(part))) {
      fail('invalid_request', 'authorized_paths_shape', `authorized path is not a normalized relative path: ${JSON.stringify(entry)}`, entry);
    }
  }
  // Repository metadata is unobservable to these guards: Git never reports `.git` contents as
  // worktree or index state, so an authorized path there could be written while every guard
  // reported a clean, in-bounds overlay. It is refused for the same reason runtime roots are.
  const metadata = paths.find((entry) => entry.split('/').some((part) => part.toLowerCase() === '.git'));
  if (metadata !== undefined) fail('invalid_request', 'repository_metadata_exclusion', `authorized path is inside repository metadata, which no guard can observe: ${metadata}`, metadata);
  if (new Set(paths).size !== paths.length) fail('invalid_request', 'authorized_paths_shape', 'authorizedPaths carries a duplicate', paths.find((entry, i) => paths.indexOf(entry) !== i));
  const rooted = paths.find(runtimeRooted);
  if (rooted !== undefined) fail('invalid_request', 'runtime_root_exclusion', `authorized path is under a runtime root: ${rooted}`, rooted);
  return new Set(paths);
}
// `git status --porcelain -z` observation of the working tree, runtime roots excluded: the
// safe untracked runtime churn is outside every overlay by rule, never a finding here.
function porcelainEntries(cwd, phase) {
  return parsePorcelainRecords(gitText(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], phase));
}
// Pure so the documented short-format cases can be exercised directly: Git's own table lists
// rename and copy in either column, and a record shape that cannot be produced on demand is
// still a record shape this parser must not desynchronise on.
const PORCELAIN_STATUS = /^[ MTADRCU?!]{2} /;
function parsePorcelainRecords(raw) {
  const entries = [];
  if (raw.length === 0) return entries;
  // The grammar is checked before anything is read from it: a truncated observation must be a
  // named failure, never a rename entry that quietly lost its source endpoint and with it the
  // authorized-maximum-set check (SOL-99-PORCELAIN-MALFORMED-RECORDS).
  if (!raw.endsWith('\0')) fail('guard_failed', 'porcelain_grammar', 'porcelain observation is not NUL-terminated', `${raw.length} bytes`);
  const records = raw.slice(0, -1).split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!PORCELAIN_STATUS.test(record) || record.length < 4) {
      fail('guard_failed', 'porcelain_grammar', `porcelain record is malformed: ${JSON.stringify(record)}`, record);
    }
    const staged = record[0], unstaged = record[1], entry = record.slice(3);
    // Rename/copy records carry the source endpoint as the following NUL record; retain it,
    // never drop it (SOL-99-RENAME-ENDPOINT-SCOPE). The status may sit in either column —
    // `RM` is an index rename with a later worktree edit — and consuming the extra record on
    // the index column alone would desynchronise the parse and read a source path as its own
    // entry (SOL-99-UNSTAGED-RENAME-PARSER).
    const renameOrCopy = ['R', 'C'].includes(staged) || ['R', 'C'].includes(unstaged);
    if (renameOrCopy && (i + 1 >= records.length || records[i + 1].length === 0)) {
      fail('guard_failed', 'porcelain_grammar', `rename or copy record carries no source endpoint: ${JSON.stringify(record)}`, record);
    }
    const sourcePath = renameOrCopy ? records[i + 1] : undefined;
    if (renameOrCopy) i += 1;
    if (runtimeRooted(entry) && (sourcePath === undefined || runtimeRooted(sourcePath))) continue;
    entries.push({ path: entry, staged, unstaged, ...(sourcePath === undefined ? {} : { sourcePath }) });
  }
  return entries;
}

function diffDigest(cwd, entry, phase) {
  // `--binary` puts literal content in the patch and `--no-abbrev` prints full blob names, so
  // the frozen digest covers raw content bytes and complete blob identity as the contract
  // states, rather than an abbreviated index line and a "Binary files differ" placeholder.
  const bytes = entry.staged === '?'
    ? gitBytes(cwd, ['diff', '--no-ext-diff', '--binary', '--no-abbrev', '--no-index', '--', '/dev/null', entry.path], phase, [1])
    : gitBytes(cwd, ['diff', '--no-ext-diff', '--binary', '--no-abbrev', '--', entry.path], phase);
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
    // A rename mutates its source; the source endpoint must be inside the maximum set too.
    // A copy leaves its source untouched, so only the destination is required.
    if (authorized && (entry.staged === 'R' || entry.unstaged === 'R') && entry.sourcePath !== undefined && !authorized.has(entry.sourcePath)) {
      fail('guard_failed', 'authorized_subset', `rename source is outside the authorized maximum set: ${entry.sourcePath}`, entry.sourcePath);
    }
    if (entry.staged !== ' ' && entry.staged !== '?') {
      fail('guard_failed', 'index_clean', `index is not clean before staging: ${entry.path}`, entry.path);
    }
    if (authorized && !authorized.has(entry.path)) {
      fail('guard_failed', 'authorized_subset', `changed path is outside the authorized maximum set: ${entry.path}`, entry.path);
    }
    entries.push({ path: entry.path, status: entry.staged === '?' ? 'A?' : entry.unstaged, rawDiffSha256: diffDigest(cwd, entry, phase), ...(entry.sourcePath === undefined ? {} : { sourcePath: entry.sourcePath }) });
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
      if (expected.status !== entry.status || expected.rawDiffSha256 !== entry.rawDiffSha256 || expected.sourcePath !== entry.sourcePath) {
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
    const renameOrCopy = meta[5] === 'R' || meta[5] === 'C';
    const entry = { srcMode: meta[1], dstMode: meta[2], srcOid: meta[3], dstOid: meta[4], status: meta[5], path: renameOrCopy ? records[i + 2] : records[i + 1] };
    if (renameOrCopy) entry.sourcePath = records[i + 1];
    i += renameOrCopy ? 2 : 1;
    if (runtimeRooted(entry.path)) fail('guard_failed', 'runtime_root_exclusion', `runtime-root path is staged: ${entry.path}`, entry.path);
    if (entry.sourcePath !== undefined && runtimeRooted(entry.sourcePath)) fail('guard_failed', 'runtime_root_exclusion', `runtime-root path is a staged rename source: ${entry.sourcePath}`, entry.sourcePath);
    entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return entries;
}

function manifestCompare(data) {
  return wrap('manifest_compare', () => {
    const phase = 'manifest_compare';
    if (!text(data.cwd)) fail('invalid_request', 'request_shape', 'cwd must be a nonempty string', typeof data.cwd);
    if (!OID.test(data.parent || '')) fail('invalid_request', 'request_shape', 'parent must be a 40- or 64-hex commit OID', String(data.parent));
    const capture = Object.hasOwn(data, 'authorizedPaths'), compare = Object.hasOwn(data, 'manifest');
    if (capture === compare) fail('invalid_request', 'request_shape', 'supply exactly one of authorizedPaths (capture) or manifest (compare)', capture ? 'both supplied' : 'neither supplied');
    const observed = stagedEntries(data.cwd, data.parent, phase);
    if (capture) {
      const authorized = checkAuthorizedPaths(data.authorizedPaths);
      if (observed.length === 0) fail('guard_failed', 'manifest_nonempty', 'the index equals the parent; there is no staged manifest to capture', 'empty index diff');
      for (const entry of observed) {
        if (!authorized.has(entry.path)) fail('guard_failed', 'authorized_subset', `staged path is outside the authorized maximum set: ${entry.path}`, entry.path);
        // A rename mutates its source endpoint; a copy reads it without change.
        if (entry.status === 'R' && !authorized.has(entry.sourcePath)) fail('guard_failed', 'authorized_subset', `rename source is outside the authorized maximum set: ${entry.sourcePath}`, entry.sourcePath);
      }
      // The capture data itself is the immutable manifest, so the documented composition —
      // feed the capture's data straight back as `manifest` — is executable as written.
      return createResult('manifest_compare', { parent: data.parent, entries: observed });
    }
    const manifest = data.manifest;
    const shaped = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.parent === data.parent && Array.isArray(manifest.entries) && manifest.entries.length > 0;
    if (!shaped) fail('invalid_request', 'manifest_shape', 'manifest must be the data of a prior manifest_compare capture for the same parent', typeof manifest);
    const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    for (const entry of observed) {
      const want = expected.get(entry.path);
      if (!want) fail('guard_failed', 'manifest_drift', `staged path is not in the immutable manifest: ${entry.path}`, entry.path);
      for (const field of ['srcMode', 'dstMode', 'srcOid', 'dstOid', 'status', 'sourcePath']) {
        if (want[field] !== entry[field]) fail('guard_failed', 'manifest_drift', `manifest ${field} changed for ${entry.path}: ${want[field]}→${entry[field]}`, entry.path);
      }
      expected.delete(entry.path);
    }
    const missing = expected.keys().next();
    if (!missing.done) fail('guard_failed', 'manifest_drift', `manifest entry is no longer staged: ${missing.value}`, missing.value);
    return createResult('manifest_compare', { subchecks: ['manifest_shape', 'manifest_drift'], entryCount: observed.length });
  });
}

// CL-D61: a required-evidence entry naming a file that does not exist is an assembly error to
// catch before any gate runs (PR #104 spent Terra's only retry on one), never a gate outcome.
// Only `file`-kind sources are paths; the other kinds carry digests or GitHub identities.
function requiredEvidenceCheck(data) {
  return wrap('required_evidence_check', () => {
    if (!text(data.cwd)) fail('invalid_request', 'request_shape', 'cwd must be a nonempty string', typeof data.cwd);
    try { checkRequiredEvidence(data.requiredEvidence); } catch (error) { fail('invalid_request', 'required_evidence_shape', error.message, error.message); }
    let checked = 0, skipped = 0;
    for (const entry of data.requiredEvidence) {
      if (entry.kind !== 'file') { skipped += 1; continue; }
      const kind = lstatKind(path.isAbsolute(entry.source) ? entry.source : path.join(data.cwd, entry.source));
      if (kind !== 'file') fail('invalid_request', 'required_evidence_presence', `required evidence source is not an existing file (${kind}): ${entry.source}`, entry.source);
      checked += 1;
    }
    return createResult('required_evidence_check', { checked, skipped });
  });
}

module.exports = { guardBeforeEdit, overlayFreeze, overlayCompare, manifestCompare, parsePorcelainRecords, requiredEvidenceCheck };
