'use strict';

// Issue #83 (CL-D56) — package-owned request builders. Each builder constructs the consuming
// request from its producing operation's result and validates the construction with the
// boundary's own predicates before returning it, so a builder output the boundary would
// reject is unrepresentable. Builders are pure and read-only: no filesystem, process,
// network, or Git reach, and no authority beyond assembling a request the caller still runs.

const { createResult, createError } = require('./protocol');
const { inputShapeProblem } = require('./composition');
const { SCHEMA, expectedState, checkRequiredEvidence, checkSchema } = require('./gate-result');

// Transition OIDs mirror the CLI's 40-or-64 hex rule; postPushHead mirrors
// operator_revalidate's exact 40-hex commit rule (SOL-98-OID-WIDTH).
const TRANSITION_OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COMMIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const text = (value) => typeof value === 'string' && value.length > 0;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function wrap(operation, construct) {
  try { return construct(); } catch (error) {
    return createError(operation, error.code || 'build_failed', error.message, 'build');
  }
}
// The boundary's own predicate table is the sole gatekeeper of what a builder may emit; a
// construction it would reject never leaves the builder.
function built(operation, consumer, data, rename) {
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
      const shaped = transition !== null && typeof transition === 'object' && !Array.isArray(transition)
        && Object.keys(transition).sort().join() === 'from,to'
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
    if (!text(data.cwd)) fail('invalid_request', 'cwd must be a nonempty string');
    const shapeProblem = inputShapeProblem('workspace_verify', { cwd: data.cwd, expected: data.created });
    if (shapeProblem !== null) fail('input_shape_mismatch', shapeProblem.replace('`expected`', '`created`'));
    if (data.created.kind !== 'linked') fail('invalid_request', 'clone fallback workspace is retained and carries no receipt; there is no cleanup request to build');
    return built('build_workspace_cleanup', 'workspace_cleanup', { receipt: data.created.receipt, cwd: data.cwd });
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
    checkRequiredEvidence(data.requiredEvidence);
    // The canonical CL-D36 schema rides along so the parent copies a derivation instead of
    // re-authoring one (CL-D47's rule applied to schemas).
    // A deep detached copy: the validator's live schema must never be aliased into caller
    // hands, or a caller-side mutation would move the CL-D36 boundary (SOL-98-SCHEMA-ALIAS).
    return createResult('build_gate_expectation', { expected, outputSchema: JSON.parse(JSON.stringify(SCHEMA)) });
  });
}

module.exports = { buildOperatorRevalidate, buildWorkspaceVerify, buildWorkspaceCleanup, buildFingerprintSnapshot, buildGateExpectation, buildManifestCapture, buildManifestCompare };
