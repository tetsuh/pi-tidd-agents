'use strict';

const fs = require('node:fs');
const helpers = require('./index');
const fingerprints = require('./fingerprints');
const { createError, createResult, isResult } = require('./protocol');

const SCHEMAS = Object.freeze({
  operator_capture: { required: ['cwd', 'identity'], optional: [] },
  operator_revalidate: { required: ['captured', 'cwd'], optional: ['postPushHead'] },
  writability: { required: ['owner', 'repo', 'branchRef', 'enterprisePolicyComplete', 'enterpriseRulesets'], optional: ['cwd'] },
  snapshot: { required: ['owner', 'repo', 'number'], optional: ['cwd'] },
  fingerprint_issue_spec: { required: ['body', 'comments'], optional: [] },
  fingerprint_pr_base: { required: ['oid'], optional: [] },
  fingerprint_pr_tree: { required: ['oid'], optional: [] },
  fingerprint_pr_diff: { required: ['base64'], optional: [] },
  fingerprint_pr_commits: { required: ['commits'], optional: [] },
  fingerprint_pr_head: { required: ['oid'], optional: [] },
  fingerprint_snapshot: { required: ['snapshot'], optional: [] },
  workspace_create: { required: ['cwd', 'head', 'tree'], optional: ['runRoot', 'allowCloneFallback'] },
  workspace_verify: { required: ['cwd', 'expected'], optional: ['transition'] },
  workspace_cleanup: { required: ['receipt', 'cwd'], optional: [] },
  gate_result_validate: { required: ['result', 'expected'], optional: [] },
  evidence_verify: { required: ['envelope', 'expected'], optional: [] },
  guard_before_edit: { required: ['cwd', 'expected', 'authorizedPaths'], optional: [] },
  overlay_freeze: { required: ['cwd', 'authorizedPaths'], optional: [] },
  overlay_compare: { required: ['cwd', 'overlay'], optional: [] },
  manifest_compare: { required: ['cwd', 'parent'], optional: ['authorizedPaths', 'manifest'] },
  build_operator_revalidate: { required: ['captured', 'cwd'], optional: ['postPushHead'] },
  build_workspace_verify: { required: ['created', 'cwd'], optional: ['transition'] },
  build_workspace_cleanup: { required: ['created', 'cwd'], optional: [] },
  build_fingerprint_snapshot: { required: ['snapshot'], optional: [] },
  build_gate_expectation: { required: ['workflow', 'correlation', 'assignedFindings', 'requiredEvidence'], optional: [] },
  marker_create: { required: ['binding', 'visibleBody'], optional: [] },
  marker_reconcile: { required: ['binding', 'visibleSha256', 'source', 'comments', 'paginationComplete', 'currentHead', 'expectedAuthor'], optional: [] },
});
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const GUARD_OPERATIONS = new Set(['guard_before_edit', 'overlay_freeze', 'overlay_compare', 'manifest_compare']);
// A recognized guard request that fails validation before dispatch still names its subcheck
// and observed value (CL-D55): a request-shape defect is a named failure, never a bare one.
function invalid(message, operation, observed) {
  const error = new Error(message); error.code = 'invalid_request'; error.phase = 'cli';
  if (operation && GUARD_OPERATIONS.has(operation)) {
    error.operation = operation;
    error.phase = operation;
    error.details = { subcheck: 'request_shape', observed: observed === undefined ? message : observed };
  }
  throw error;
}
function validateRequest(value) {
  // Recognize a guard operation before any envelope check fires, so every applicable
  // envelope-validation failure is named too; unrecognized operations keep reporting as cli.
  const guardOperation = object(value) && typeof value.operation === 'string' && GUARD_OPERATIONS.has(value.operation) ? value.operation : undefined;
  if (!object(value) || value.version !== 1 || typeof value.operation !== 'string' || !object(value.data)) {
    const observed = !object(value) ? `request ${Array.isArray(value) ? 'array' : typeof value}`
      : value.version !== 1 ? `version ${JSON.stringify(value.version)}`
        : typeof value.operation !== 'string' ? `operation ${typeof value.operation}`
          : `data ${Array.isArray(value.data) ? 'array' : typeof value.data}`;
    invalid('request must contain version:1, a known operation, and object data', guardOperation, observed);
  }
  for (const key of Object.keys(value)) if (!['version', 'operation', 'data'].includes(key)) invalid(`unknown request envelope field: ${key}`, guardOperation, key);
  const schema = SCHEMAS[value.operation];
  if (!schema) invalid('unknown operation');
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(value.data)) if (!allowed.has(key)) invalid(`unknown request field: ${key}`, value.operation, key);
  for (const key of schema.required) if (!Object.hasOwn(value.data, key)) invalid(`missing request field: ${key}`, value.operation, key);
  if (value.operation === 'workspace_verify' && Object.hasOwn(value.data, 'transition')) {
    const transition = value.data.transition;
    if (!object(transition) || Object.keys(transition).some((key) => !['from', 'to'].includes(key)) || !Object.hasOwn(transition, 'from') || !Object.hasOwn(transition, 'to') || !Object.values(transition).every((oid) => typeof oid === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid))) invalid('workspace transition requires only from and to OIDs');
  }
  if (value.operation === 'workspace_create' && Object.hasOwn(value.data, 'runRoot') && (typeof value.data.runRoot !== 'string' || value.data.runRoot.trim().length === 0)) invalid('workspace runRoot must be a nonempty string');
  return value;
}
function wrap(operation, result) { return isResult(result) ? { ...result, operation } : createResult(operation, result); }
function fingerprintResult(operation, domain, fingerprint) {
  return createResult(operation, { fingerprint, record: helpers.createEvidenceFingerprintRecord(domain, fingerprint) });
}
async function dispatch(request) {
  const { operation, data } = request;
  switch (operation) {
    case 'operator_capture': return wrap(operation, helpers.captureOperatorCheckout(data));
    case 'operator_revalidate': return wrap(operation, helpers.revalidateOperatorCheckout(data.captured, { cwd: data.cwd, postPushHead: data.postPushHead }));
    case 'writability': return wrap(operation, await helpers.collectWritability(data));
    case 'snapshot': return wrap(operation, await helpers.collectSnapshot(data));
    case 'fingerprint_issue_spec': return fingerprintResult(operation, 'issue_spec', fingerprints.issueSpecFingerprint(data));
    case 'fingerprint_pr_base': return fingerprintResult(operation, 'pr_base', fingerprints.prBaseFingerprint(data.oid));
    case 'fingerprint_pr_tree': return fingerprintResult(operation, 'pr_tree', fingerprints.prTreeFingerprint(data.oid));
    case 'fingerprint_pr_diff': {
      if (typeof data.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.base64)) invalid('diff must be canonical Base64');
      const bytes = Buffer.from(data.base64, 'base64');
      if (bytes.toString('base64') !== data.base64) invalid('diff must be canonical Base64');
      return fingerprintResult(operation, 'pr_diff', fingerprints.prDiffFingerprint(bytes));
    }
    case 'fingerprint_pr_commits': return fingerprintResult(operation, 'pr_commits', fingerprints.prCommitsFingerprint(data.commits));
    case 'fingerprint_pr_head': return fingerprintResult(operation, 'pr_head', fingerprints.prHeadFingerprint(data.oid));
    case 'fingerprint_snapshot': return fingerprintResult(operation, 'snapshot', fingerprints.snapshotFingerprint(data.snapshot));
    case 'workspace_create': return wrap(operation, helpers.createWorkspace(data));
    case 'workspace_verify': return wrap(operation, helpers.verifyWorkspace(data.cwd, data.expected, data.transition));
    case 'workspace_cleanup': return wrap(operation, await helpers.cleanupWorkspace(data.receipt, data.cwd));
    case 'gate_result_validate': return wrap(operation, helpers.validateGateResult(data.result, data.expected));
    case 'evidence_verify': return wrap(operation, helpers.verifyEvidence(data));
    case 'guard_before_edit': return wrap(operation, helpers.guardBeforeEdit(data));
    case 'overlay_freeze': return wrap(operation, helpers.overlayFreeze(data));
    case 'overlay_compare': return wrap(operation, helpers.overlayCompare(data));
    case 'manifest_compare': return wrap(operation, helpers.manifestCompare(data));
    case 'build_operator_revalidate': return wrap(operation, helpers.buildOperatorRevalidate(data));
    case 'build_workspace_verify': return wrap(operation, helpers.buildWorkspaceVerify(data));
    case 'build_workspace_cleanup': return wrap(operation, helpers.buildWorkspaceCleanup(data));
    case 'build_fingerprint_snapshot': return wrap(operation, helpers.buildFingerprintSnapshot(data));
    case 'build_gate_expectation': return wrap(operation, helpers.buildGateExpectation(data));
    case 'marker_create': return wrap(operation, helpers.createReplyMarker(data));
    case 'marker_reconcile': return wrap(operation, helpers.reconcileReply(data));
    default: invalid('unknown operation');
  }
}
async function main() {
  let operation = 'cli';
  try {
    const input = fs.readFileSync(0);
    const request = validateRequest(JSON.parse(input.toString('utf8')));
    operation = request.operation;
    const shapeProblem = helpers.inputShapeProblem(operation, request.data);
    if (shapeProblem) { const error = new Error(shapeProblem); error.code = 'input_shape_mismatch'; error.phase = operation; throw error; }
    const result = await dispatch(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok || result.data?.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(createError(error.operation || operation, error.code || 'helper_failed', error.message, error.phase || 'cli', error.details))}\n`);
    process.exitCode = 1;
  }
}
main();

module.exports = { SCHEMAS, validateRequest, dispatch };
