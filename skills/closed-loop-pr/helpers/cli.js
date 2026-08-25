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
});
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(message) { const error = new Error(message); error.code = 'invalid_request'; error.phase = 'cli'; throw error; }
function validateRequest(value) {
  if (!object(value) || value.version !== 1 || typeof value.operation !== 'string' || !object(value.data)) invalid('request must contain version:1, a known operation, and object data');
  for (const key of Object.keys(value)) if (!['version', 'operation', 'data'].includes(key)) invalid(`unknown request envelope field: ${key}`);
  const schema = SCHEMAS[value.operation];
  if (!schema) invalid('unknown operation');
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(value.data)) if (!allowed.has(key)) invalid(`unknown request field: ${key}`);
  for (const key of schema.required) if (!Object.hasOwn(value.data, key)) invalid(`missing request field: ${key}`);
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
    default: invalid('unknown operation');
  }
}
async function main() {
  let operation = 'cli';
  try {
    const input = fs.readFileSync(0);
    const request = validateRequest(JSON.parse(input.toString('utf8')));
    operation = request.operation;
    const result = await dispatch(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok || result.data?.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(createError(operation, error.code || 'helper_failed', error.message, error.phase || 'cli'))}\n`);
    process.exitCode = 1;
  }
}
main();

module.exports = { SCHEMAS, validateRequest, dispatch };
