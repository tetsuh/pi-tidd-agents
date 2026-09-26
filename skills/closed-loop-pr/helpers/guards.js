'use strict';

// Issue #96 rule 1 (CL-D57) — the batch-sequence guards Luna kept re-deriving by hand,
// packaged as read-only operations. Every failure names the violated subcheck and the
// observed value (CL-D55 by construction). Predicates encode the observed defect classes:
// authorized paths are a maximum set, not a demand; the index is compared against the
// immutable staged manifest, never against only the authorized changed files; and a guard
// failure with nothing to name cannot be produced, because each check reports what it saw.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createResult, createError, keysExactly } = require('./protocol');
const { runSync, gitArgs, isolationPaths } = require('./process');
const { RUNTIME_ROOTS, byteSort } = require('./operator');
const { classifyRuntimeRoots, lstatKind } = require('./paths');
const { checkRequiredEvidence } = require('./gate-result');
const { authorizedPathsProblem } = require('./composition');
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
function gitBytes(cwd, args, phase, acceptExitCodes, maxBuffer, stderrFd) {
  return Buffer.from(runSync('git', gitArgs(args), { cwd, phase, encoding: 'buffer', acceptExitCodes, maxBuffer, stderrFd }));
}
function gitText(cwd, args, phase, acceptExitCodes) {
  return gitBytes(cwd, args, phase, acceptExitCodes).toString('utf8');
}
function runtimeRooted(entry) {
  return RUNTIME_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`));
}
// The rules live in composition.js as the boundary's shared pure predicate, so the builder that
// emits an authorized set applies exactly the check the consumer applies (CL-D61).
function checkAuthorizedPaths(paths) {
  const problem = authorizedPathsProblem(paths);
  if (problem !== null) fail('invalid_request', problem.subcheck, problem.message, problem.observed);
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
    // After a push the workspace is the pushed head, so the identity is checked through the same transition
    // workspace_verify takes (#185); without one, the workspace must still be at created.head.
    const workspace = verifyWorkspace(data.cwd, data.expected, data.transition);
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
function messageVerify(data) {
  return wrap('message_verify', () => {
    const phase = 'message_verify';
    if (!text(data.cwd) || !path.isAbsolute(data.cwd) || data.cwd.includes(String.fromCharCode(0))) fail('invalid_request', 'request_shape', 'cwd must be an absolute path without NUL', typeof data.cwd);
    if (typeof data.expected !== 'string' || data.expected.length === 0) fail('invalid_request', 'request_shape', 'expected must be the approved message', typeof data.expected);
    // Each read carries its own bound and names it, so a read past it is this operation's refusal and never a
    // spawn errno reaching the caller as the observed value (CONV-124-AUTHORITY-LISTING-UNBOUNDED, same class).
    const bounded = (args, what) => {
      try { return gitBytes(data.cwd, args, phase, undefined, SMALL_MAX_BYTES); }
      catch (error) {
        if (/ENOBUFS|MAXBUFFER/.test(String(error.message))) fail('output_limit', 'output_limit', `${what} exceeds ${SMALL_MAX_BYTES} bytes`, what);
        throw error;
      }
    };
    // A work tree at its toplevel; a bare repository answers false and a subdirectory a nonempty prefix
    // (ADV-124-BARE-REPOSITORY-ACCEPTED-AS-CHECKOUT).
    if (bounded(['rev-parse', '--is-inside-work-tree', '--show-prefix'], 'the work-tree check').toString('utf8') !== 'true\n\n') fail('invalid_request', 'cwd_toplevel', 'cwd must be the toplevel of a Git work tree', data.cwd);
    // The commit object carries the stored message itself. The log format that shows a message appends one LF to
    // it, and a shell capturing that output strips every trailing LF, so the exact comparison the contract requires
    // cannot be made through either; reading the object needs no byte added and none removed (Issue #114, CL-D74).
    const raw = bounded(['--no-replace-objects', 'cat-file', 'commit', 'HEAD'], 'the commit object');
    const separator = raw.indexOf(Buffer.from([10, 10]));
    if (separator < 0) fail('guard_failed', 'commit_object_shape', 'the commit object carries no header separator', `${raw.length} bytes`);
    const stored = raw.subarray(separator + 2);
    // `git commit -F --cleanup=whitespace` cleans the message before storing it: trailing space, tab and CR off
    // every line — Git's own space class, which keeps a vertical tab and a form feed — leading and
    // trailing blank lines dropped, runs of blank lines collapsed to one. The approved message is put through that
    // same cleanup before the comparison, so a message Git stored as asked is never reported as a difference.
    const kept = [];
    let blank = false;
    for (const line of data.expected.split(String.fromCharCode(10)).map((entry) => entry.replace(/[ \t\r]+$/, ''))) {
      if (line.length === 0) { blank = kept.length > 0; continue; }
      if (blank) kept.push('');
      blank = false;
      kept.push(line);
    }
    const approved = Buffer.from(kept.map((line) => `${line}${String.fromCharCode(10)}`).join(''), 'utf8');
    if (!stored.equals(approved)) fail('guard_failed', 'message_bytes', 'the stored commit message differs from the approved message', `stored ${stored.length} bytes, approved ${approved.length} bytes`);
    return createResult('message_verify', { bytes: stored.length });
  });
}

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

// CL-D72: the gate's required-evidence set, derived rather than assembled by hand — the paths the change
// touches that exist at the head, plus the authority files present there, each identified by the SHA-256 of
// its blob at the head, plus the identity records the parent holds, unchanged. A read-only observation
// through the allowed diff, ls-tree, and cat-file; it reads Git, so it is not one of the pure builders.
const AUTHORITY_AT_HEAD = ['CONTRACT.md', 'README.md'];
const IDENTITY_KINDS = ['git', 'github', 'snapshot'];
// An identity the request repeats must agree with the argument it repeats (CL-D47's rule).
const CORRELATED_SOURCES = { 'git:pr_head': 'headOid', 'git:pr_base': 'baseOid' };
// Each Git read carries its own bound rather than the 16 MiB process default; a read beyond it fails closed by name.
const LISTING_MAX_BYTES = 256 * 1024 * 1024, BLOB_MAX_BYTES = 256 * 1024 * 1024, SMALL_MAX_BYTES = 64 * 1024, WARNING_MAX_BYTES = 64 * 1024;
function requiredEvidenceSet(data) {
  return wrap('required_evidence_set', () => {
    const phase = 'required_evidence_set';
    if (!text(data.cwd) || !path.isAbsolute(data.cwd) || data.cwd.includes('\u0000')) fail('invalid_request', 'request_shape', 'cwd must be an absolute path without NUL', JSON.stringify(data.cwd));
    for (const key of ['baseOid', 'headOid']) if (!text(data[key]) || !OID.test(data[key])) fail('invalid_request', 'request_shape', `${key} must be a commit OID`, String(data[key]));
    if (!Array.isArray(data.identities)) fail('invalid_request', 'request_shape', 'identities must be an array', typeof data.identities);
    for (const entry of data.identities) {
      const shaped = keysExactly(entry, ['identity', 'kind', 'source']) && text(entry.source) && text(entry.identity) && IDENTITY_KINDS.includes(entry.kind);
      if (!shaped) fail('invalid_request', 'identities_shape', 'each identity record carries exactly source, kind (git, github, or snapshot), and identity; file records are derived here', JSON.stringify(entry));
      const argument = CORRELATED_SOURCES[entry.source];
      if (argument && (entry.kind !== 'git' || entry.identity !== data[argument])) fail('invalid_request', 'identity_correlation', `${entry.source} must be a git record equal to ${argument}`, `${entry.kind}:${entry.identity}`);
    }
    // Every Git read of the derivation goes through this reader with its own bound, never the process default: a
    // listing or a blob up to 256 MiB, anything else up to 64 KiB (CONV-124-AUTHORITY-LISTING-UNBOUNDED). One buffer
    // covers both streams of a synchronous spawn, so the child writes its error stream to a file of its own: the
    // payload bound is the spawn's, and the file's size is measured after the read and refused beyond WARNING_MAX_BYTES,
    // naming the stream that passed it (ADV-124-BLOB-BOUND-TRIPPED-BY-STDERR, ADV-124-WARNING-HEADROOM-NOT-ENFORCED).
    // The path comes from the validated cache on every read, so an entry planted at it mid-derivation is refused
    // before anything opens it, and the size is a threshold on what a read may carry, not a cap on Git's writing.
    const bounded = (args, limit, what, acceptExitCodes) => {
      const noisePath = isolationPaths().gitStderr;
      const noiseFd = fs.openSync(noisePath, 'w');
      let read;
      try { read = gitBytes(data.cwd, args, phase, acceptExitCodes, limit, noiseFd); }
      catch (error) {
        if (/ENOBUFS|MAXBUFFER/.test(String(error.message))) fail('output_limit', 'output_limit', `${what} exceeds ${limit} bytes`, what);
        throw error;
      }
      finally { fs.closeSync(noiseFd); }
      const noise = fs.statSync(noisePath).size;
      if (noise > WARNING_MAX_BYTES) { fs.truncateSync(noisePath, 0); fail('output_limit', 'output_limit', `Git wrote ${noise} bytes on its error stream while reading ${what}, beyond the ${WARNING_MAX_BYTES} bytes allowed`, what); }
      return read;
    };
    // A work tree at its toplevel; a bare repository also answers an empty prefix (ADV-124-BARE-REPOSITORY-ACCEPTED-AS-CHECKOUT).
    // Git's whole answer is compared, so a subdirectory whose name begins with a newline cannot pass (ADV-124-CWD-NEWLINE-SUBDIR-ACCEPTED).
    const answer = bounded(['rev-parse', '--is-inside-work-tree', '--show-prefix'], SMALL_MAX_BYTES, 'the work-tree check').toString('utf8');
    if (answer !== 'true\n\n') fail('invalid_request', 'cwd_toplevel', 'cwd must be the toplevel of a Git work tree', data.cwd);
    for (const key of ['baseOid', 'headOid']) {
      if (bounded(['cat-file', '-t', data[key]], SMALL_MAX_BYTES, key, [128]).toString('utf8').trim() !== 'commit') fail('invalid_request', 'commit_presence', `${key} is not a commit in this checkout`, data[key]);
    }
    // Git names a path as bytes and evidence names it as text: a changed path that is not valid UTF-8 cannot be named
    // losslessly and fails closed by its bytes, and both listings are matched by bytes, so two names that decode alike
    // never stand in for each other (ADV-124-NONUTF8-EVIDENCE-PATH-OMISSION).
    const records = (buffer) => { const out = []; let start = 0; for (let k = 0; k <= buffer.length; k += 1) if (k === buffer.length || buffer[k] === 0) { if (k > start) out.push(buffer.subarray(start, k)); start = k + 1; } return out; };
    const changedBytes = records(bounded(['diff', '--name-only', '--no-renames', '-z', data.baseOid, data.headOid, '--'], LISTING_MAX_BYTES, 'the changed-path listing'));
    for (const name of changedBytes) if (!Buffer.from(name.toString('utf8'), 'utf8').equals(name)) fail('invalid_request', 'path_encoding', 'a changed path is not valid UTF-8, so evidence cannot name it losslessly', name.toString('hex'));
    const changed = changedBytes.map((name) => name.toString('utf8'));
    const key = (source) => Buffer.from(source, 'utf8').toString('latin1');
    // The tree at the head, by entry: only a regular blob (100644 or 100755) can be attested as a file; a
    // symlink or a submodule pointer is excluded and named with its mode (owner option A, CL-D72).
    const atHead = new Map();
    for (const record of records(bounded(['ls-tree', '-r', '--full-tree', '-z', data.headOid], LISTING_MAX_BYTES, 'the tree listing'))) {
      // The first tab separates the mode, type, and object from the name; a later tab is part of the name
      // (CONV-124-TAB-PATH-EVIDENCE-OMISSION).
      const tab = record.indexOf(9); atHead.set(record.subarray(tab + 1).toString('latin1'), record.subarray(0, tab).toString('latin1').split(' ')[0]);
    }
    const modeOf = (source) => atHead.get(key(source));
    const regular = (mode) => mode === '100644' || mode === '100755';
    const sources = new Set(changed.filter((source) => modeOf(source) !== undefined && regular(modeOf(source))));
    const excluded = changed.filter((source) => modeOf(source) !== undefined && !regular(modeOf(source))).map((source) => ({ source, mode: modeOf(source) }));
    // An authority entry is read without recursion, so a directory or a symlink under that name shows its own mode: a
    // present entry that is not a regular file is excluded with its mode, and `absent` names only what the head lacks.
    const authorityModes = new Map();
    for (const record of records(bounded(['ls-tree', '--full-tree', '-z', data.headOid, '--', ...AUTHORITY_AT_HEAD], LISTING_MAX_BYTES, 'the authority listing'))) {
      const tab = record.indexOf(9); authorityModes.set(record.subarray(tab + 1).toString('latin1'), record.subarray(0, tab).toString('latin1').split(' ')[0]);
    }
    const authority = { included: [], absent: [], excluded: [] };
    for (const file of AUTHORITY_AT_HEAD) {
      const mode = authorityModes.get(file);
      if (mode === undefined) authority.absent.push(file);
      else if (regular(mode)) { sources.add(file); authority.included.push(file); }
      else authority.excluded.push({ source: file, mode });
    }
    const files = byteSort([...sources]).map((source) => {
      const size = Number(bounded(['cat-file', '-s', `${data.headOid}:${source}`], SMALL_MAX_BYTES, source).toString('utf8').trim());
      if (!(size <= BLOB_MAX_BYTES)) fail('output_limit', 'output_limit', `a changed file exceeds ${BLOB_MAX_BYTES} bytes`, source);
      return { source, kind: 'file', identity: crypto.createHash('sha256').update(bounded(['cat-file', 'blob', `${data.headOid}:${source}`], BLOB_MAX_BYTES, source)).digest('hex') };
    });
    const requiredEvidence = [...files, ...data.identities.map(({ source, kind, identity }) => ({ source, kind, identity }))];
    try { checkRequiredEvidence(requiredEvidence); } catch (error) { fail('invalid_request', 'required_evidence_shape', error.message, error.message); }
    return createResult('required_evidence_set', { requiredEvidence, baseOid: data.baseOid, headOid: data.headOid, changed: changed.length, files: files.length, authority, excluded });
  });
}

module.exports = { guardBeforeEdit, overlayFreeze, overlayCompare, manifestCompare, messageVerify, parsePorcelainRecords, requiredEvidenceCheck, requiredEvidenceSet };
