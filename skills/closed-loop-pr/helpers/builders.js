'use strict';

// Issue #83 (CL-D56) — package-owned request builders. Each builder constructs the consuming
// request from its producing operation's result and validates the construction with the
// boundary's own predicates before returning it, so a builder output the boundary would
// reject is unrepresentable. Builders are pure and read-only: no filesystem, process,
// network, or Git reach, and no authority beyond assembling a request the caller still runs.

const { createResult, createError, keysExactly } = require('./protocol');
const { inputShapeProblem, normalizeDeclaredInputs, authorizedPathsProblem, cleanupCwdProblem } = require('./composition');
const { SCHEMA, expectedState, checkRequiredEvidence, checkSchema, ROOT_GATES } = require('./gate-result');

// Transition OIDs mirror the CLI's 40-or-64 hex rule; postPushHead mirrors
// operator_revalidate's exact 40-hex commit rule (SOL-98-OID-WIDTH).
const TRANSITION_OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COMMIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const text = (value) => typeof value === 'string' && value.length > 0;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function wrap(operation, construct) {
  try { return construct(); } catch (error) {
    return createError(operation, error.code || 'build_failed', error.message, 'build');
  }
}
// The boundary's own predicate table is the sole gatekeeper of what a builder may emit; a
// construction it would reject never leaves the builder.
function built(operation, consumer, data, rename) {
  // The producer payload becomes its envelope before the check, so a builder emits one canonical form (CL-D70).
  data = normalizeDeclaredInputs(consumer, data);
  let problem = inputShapeProblem(consumer, data);
  if (problem !== null) {
    if (rename) problem = problem.replace(`\`${rename.from}\``, `\`${rename.to}\``);
    fail('input_shape_mismatch', problem);
  }
  return createResult(operation, { request: { version: 1, operation: consumer, data } });
}

function buildOperatorRevalidate(data) {
  return wrap('build_operator_revalidate', () => {
    if (!text(data.cwd)) fail('invalid_request', 'cwd must be a nonempty string');
    if (Object.hasOwn(data, 'postPushHead') && !(typeof data.postPushHead === 'string' && COMMIT_OID_PATTERN.test(data.postPushHead))) fail('invalid_request', 'postPushHead must be a commit OID string');
    const request = { captured: data.captured, cwd: data.cwd };
    if (Object.hasOwn(data, 'postPushHead')) request.postPushHead = data.postPushHead;
    return built('build_operator_revalidate', 'operator_revalidate', request);
  });
}

function buildWorkspaceVerify(data) {
  return wrap('build_workspace_verify', () => {
    if (!text(data.cwd)) fail('invalid_request', 'cwd must be a nonempty string');
    if (Object.hasOwn(data, 'transition')) {
      const transition = data.transition;
      const shaped = keysExactly(transition, ['from', 'to'])
        && Object.values(transition).every((oid) => typeof oid === 'string' && TRANSITION_OID_PATTERN.test(oid));
      if (!shaped) fail('invalid_request', 'workspace transition requires only from and to OIDs');
    }
    const request = { cwd: data.cwd, expected: data.created };
    if (Object.hasOwn(data, 'transition')) request.transition = data.transition;
    return built('build_workspace_verify', 'workspace_verify', request, { from: 'expected', to: 'created' });
  });
}

function buildWorkspaceCleanup(data) {
  return wrap('build_workspace_cleanup', () => {
    // Refused here as well as by the CLI, so a direct caller is told rather than silently overridden (CL-D76).
    if (Object.hasOwn(data, 'cwd')) fail('invalid_request', 'unknown request field: cwd');
    const shapeProblem = inputShapeProblem('workspace_verify', { expected: data.created });
    if (shapeProblem !== null) fail('input_shape_mismatch', shapeProblem.replace('`expected`', '`created`'));
    if (data.created.kind !== 'linked') fail('invalid_request', 'clone fallback workspace is retained and carries no receipt; there is no cleanup request to build');
    // The cwd is the repository the receipt states, not the caller's: a run standing in the workspace handed that in and
    // ended BLOCKED (Issue #142). It is the copy workspace_cleanup holds against the stored receipt, not the one beside it.
    const { receipt } = data.created;
    const identity = plainObject(receipt.creationIdentity) ? receipt.creationIdentity : {};
    const cwd = identity.repositoryCwd;
    if (!text(cwd)) fail('invalid_request', 'the receipt states no repository to run the cleanup from');
    if (!text(identity.path)) fail('invalid_request', 'the receipt states no workspace to remove');
    // Every string the request carries must name what it spells: no filesystem call accepts a NUL byte, and a lone
    // surrogate is written as U+FFFD. The whole receipt is walked, not a list of fields, so a field added to the
    // stored identity is covered too (ADV-144-INVALID-REPOSITORY-NUL, ADV-144-UNCHECKED-REQUEST-PATHS).
    (function scan(value, trail) {
      if (typeof value === 'string') {
        if (value.includes(String.fromCharCode(0)) || !value.isWellFormed()) fail('invalid_request', `the receipt's ${trail.join('.')} carries a NUL byte or a lone surrogate`);
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) scan(child, [...trail, key]);
      }
      // Anything else is left to the boundary's own receipt shape check in built(), which names an absent or
      // non-string root or storedPath in its vocabulary instead of crashing (ADV-144-RECEIPT-PATH-TYPE).
    })(receipt, []);
    // A cwd at or inside the workspace being removed is the CL-D49 caller error; the boundary's own predicate refuses it
    // before the request exists (CL-D68), judged against the workspace the operation compares, not `created.path`.
    const cwdProblem = cleanupCwdProblem(cwd, identity.path);
    if (cwdProblem !== null) fail(cwdProblem.subcheck === 'cleanup_cwd_relative' ? 'cleanup_cwd_relative' : 'cleanup_cwd_inside_workspace', cwdProblem.message);
    return built('build_workspace_cleanup', 'workspace_cleanup', { receipt, cwd });
  });
}

// CL-D73: the parent still decides which fresh finding reopens which settled blocker — the normalization rule in
// autofix-addendum.md is its judgment — and states that judgment as data. The assembly is the package's: a fresh
// finding keys itself, an explicit reopen carries the settled key, and a reopen the ledger does not hold is refused
// (#125 run 2 sent a tuple with no key at all).
function buildGateAssignments(data) {
  return wrap('build_gate_assignments', () => {
    if (!Array.isArray(data.findings)) fail('invalid_request', 'findings must be the validated result findings array');
    if (!Array.isArray(data.settledKeys) || !data.settledKeys.every(text)) fail('invalid_request', 'settledKeys must be an array of settled blocker keys');
    const reopens = Object.hasOwn(data, 'reopens') ? data.reopens : {};
    if (reopens === null || typeof reopens !== 'object' || Array.isArray(reopens)) fail('invalid_request', 'reopens must map a fresh finding id to the settled blocker key it reopens');
    const ids = data.findings.map((finding) => (finding === null || typeof finding !== 'object' ? undefined : finding.findingId));
    if (!ids.every(text)) fail('invalid_request', 'every finding must carry a findingId');
    if (new Set(ids).size !== ids.length) fail('invalid_request', 'a findingId is assigned more than once');
    const settled = new Set(data.settledKeys);
    for (const [findingId, key] of Object.entries(reopens)) {
      if (!ids.includes(findingId)) fail('invalid_request', `reopens names ${findingId}, which is not among the findings`);
      if (!text(key) || !settled.has(key)) fail('invalid_request', `reopens names the blocker key ${key}, which the ledger does not hold`);
    }
    const assignedFindings = data.findings.map((finding) => {
      const findingId = finding.findingId;
      const carried = finding.blockerKey;
      const stated = Object.hasOwn(reopens, findingId) ? reopens[findingId] : undefined;
      // Only an assigned finding carries a key, and it always carries one. The key the parent assigned is
      // immutable: re-keying an assigned finding to its own id restarts the no-progress count for that blocker
      // under a new key, and a key on a fresh finding is one nothing assigned.
      if (finding.origin === 'assigned') {
        if (!text(carried)) fail('invalid_request', `assigned finding ${findingId} carries no blockerKey`);
        if (stated !== undefined && stated !== carried) fail('invalid_request', `finding ${findingId} already carries the blocker key ${carried}; reopens cannot move it to ${stated}`);
        return { findingId, blockerKey: carried };
      }
      if (carried !== undefined) fail('invalid_request', `finding ${findingId} is not assigned, so it carries no blockerKey of its own`);
      // A fresh finding keys itself. An id the ledger already holds is a reopen whatever else it is, and whether it
      // is one stays the parent's judgment to state, so it is refused here rather than assumed either way.
      if (stated !== undefined) return { findingId, blockerKey: stated };
      if (settled.has(findingId)) fail('invalid_request', `finding ${findingId} is a settled blocker key; state the reopen in reopens`);
      return { findingId, blockerKey: findingId };
    });
    return createResult('build_gate_assignments', { assignedFindings });
  });
}

function buildFingerprintSnapshot(data) {
  return wrap('build_fingerprint_snapshot', () => built('build_fingerprint_snapshot', 'fingerprint_snapshot', { snapshot: data.snapshot }));
}

// CL-D61: the two manifest_compare requests derive every value from a producing operation —
// the frozen overlay's parent and authorized set, the capture's parent — so a request carrying
// both mode fields (the PR #103 killer) is unrepresentable here.
function buildManifestCapture(data) {
  return wrap('build_manifest_capture', () => {
    if (!text(data.cwd)) fail('invalid_request', 'cwd must be a nonempty string');
    const problem = inputShapeProblem('overlay_compare', { cwd: data.cwd, overlay: data.overlay });
    if (problem !== null) fail('input_shape_mismatch', problem);
    // The declared shape only separates producers; the consumer's authorized-path rules are the
    // deeper check, applied here so an empty, duplicate, non-normalized, metadata, or runtime-root
    // set fails at build, naming the consumer's subcheck, never at the post-writer boundary.
    const paths = authorizedPathsProblem(data.overlay.authorizedPaths);
    if (paths !== null) fail('input_shape_mismatch', `\`overlay\` must be data:overlay_freeze with an authorized set manifest_compare accepts (${paths.subcheck}): ${paths.message}`);
    return built('build_manifest_capture', 'manifest_compare', { cwd: data.cwd, parent: data.overlay.parent, authorizedPaths: [...data.overlay.authorizedPaths] });
  });
}

function buildManifestCompare(data) {
  return wrap('build_manifest_compare', () => {
    if (!text(data.cwd)) fail('invalid_request', 'cwd must be a nonempty string');
    const captured = data.captured, parent = captured !== null && typeof captured === 'object' ? captured.parent : undefined;
    return built('build_manifest_compare', 'manifest_compare', { cwd: data.cwd, parent, manifest: captured }, { from: 'manifest', to: 'captured' });
  });
}

function buildGateExpectation(data) {
  return wrap('build_gate_expectation', () => {
    if (!['issue', 'pr'].includes(data.workflow)) fail('invalid_request', 'workflow must be issue or pr');
    checkSchema(SCHEMA.properties.correlation, data.correlation, 'correlation');
    const expected = {
      workflow: data.workflow, correlation: data.correlation,
      assignedFindings: data.assignedFindings, requiredEvidence: data.requiredEvidence,
    };
    expectedState(expected);
    // A gate outside its root cannot validate later; refuse it before an expectation exists (CONV-123-ROOT-GATE-LAUNCH).
    if (!ROOT_GATES[data.workflow].includes(data.correlation.gate)) fail('gate_outside_root', `gate ${data.correlation.gate} is not a ${data.workflow} gate`);
    checkRequiredEvidence(data.requiredEvidence);
    // The canonical CL-D36 schema rides along so the parent copies a derivation instead of
    // re-authoring one (CL-D47's rule applied to schemas).
    // A deep detached copy: the validator's live schema must never be aliased into caller
    // hands, or a caller-side mutation would move the CL-D36 boundary (SOL-98-SCHEMA-ALIAS).
    return createResult('build_gate_expectation', { expected, outputSchema: JSON.parse(JSON.stringify(SCHEMA)) });
  });
}

module.exports = { buildOperatorRevalidate, buildWorkspaceVerify, buildWorkspaceCleanup, buildFingerprintSnapshot, buildGateExpectation, buildGateAssignments, buildManifestCapture, buildManifestCompare };
