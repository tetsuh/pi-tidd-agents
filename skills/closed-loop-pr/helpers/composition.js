'use strict';

// Issue #74 (CL-D44). Cross-operation fields carry one declared shape each, checked before the
// operation runs. Without this a plausible swap — an operation's `data` where its complete
// envelope belongs — crosses the boundary and surfaces later as an unrelated identity or
// capture failure, which is what happened on tetsuh/sitos#165.
const INPUT_SHAPES = Object.freeze({
  operator_revalidate: Object.freeze({ captured: 'envelope:operator_capture' }),
  workspace_verify: Object.freeze({ expected: 'data:workspace_create' }),
  workspace_cleanup: Object.freeze({ receipt: 'receipt:workspace_create' }),
  fingerprint_snapshot: Object.freeze({ snapshot: 'data:snapshot' }),
  gate_result_validate: Object.freeze({ result: 'structured:gate_result' }),
});
// Each declared shape accepts exactly one classification. No shape is a tolerant alternative
// for another: accepting two would restore the ambiguity this check exists to remove.
const ACCEPTED = Object.freeze({
  'envelope:operator_capture': 'envelope',
  'data:workspace_create': 'workspace_data',
  'receipt:workspace_create': 'receipt',
  'data:snapshot': 'snapshot_data',
  'structured:gate_result': 'gate_result',
});
const SNAPSHOT_DATA_KEYS = Object.freeze([
  'after', 'annotations', 'before', 'checkSuites', 'checks', 'comments', 'completeness',
  'inline', 'policies', 'pull', 'reviews', 'statuses', 'threads',
]);

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Classification reads structure, never a caller's label. An envelope is the protocol document;
// a receipt is the run-owned cleanup grant; workspace data is what `workspace_create` returns.
function classifyInputShape(value) {
  if (!plain(value)) return 'other';
  if (['version', 'ok', 'operation'].every((key) => Object.hasOwn(value, key)) && (Object.hasOwn(value, 'data') || Object.hasOwn(value, 'error'))) return 'envelope';
  if (value.version === 1 && typeof value.root === 'string' && typeof value.storedPath === 'string' && Object.hasOwn(value, 'id')) return 'receipt';
  if (plain(value.receipt) && typeof value.root === 'string' && typeof value.kind === 'string') return 'workspace_data';
  if (value.schemaVersion === 1 && plain(value.correlation)
    && typeof value.verdict === 'string' && Array.isArray(value.evidenceRead)
    && Array.isArray(value.findings) && Array.isArray(value.confirmations)
    && Array.isArray(value.decisions) && Array.isArray(value.adversarialResults)) return 'gate_result';
  const keys = Object.keys(value).sort();
  if (keys.length === SNAPSHOT_DATA_KEYS.length && keys.every((key, index) => key === SNAPSHOT_DATA_KEYS.slice().sort()[index])
    && plain(value.before) && plain(value.after) && plain(value.pull)
    && Array.isArray(value.annotations) && Array.isArray(value.checkSuites)
    && Array.isArray(value.checks) && Array.isArray(value.comments)
    && plain(value.completeness) && Array.isArray(value.inline)
    && plain(value.policies) && Array.isArray(value.reviews)
    && Array.isArray(value.statuses) && Array.isArray(value.threads)) return 'snapshot_data';
  return 'other';
}

function describe(value, classification) {
  if (classification === 'envelope') {
    const operation = typeof value.operation === 'string' ? value.operation : 'unknown';
    if (value.ok === false || Object.hasOwn(value, 'error')) return `error envelope:${operation}`;
    if (value.version !== 1 || value.ok !== true || !plain(value.data)) return `malformed envelope:${operation}`;
    return `envelope:${operation}`;
  }
  if (classification === 'receipt') return 'receipt:workspace_create';
  if (classification === 'workspace_data') return 'data:workspace_create';
  if (classification === 'snapshot_data') return 'data:snapshot';
  if (classification === 'gate_result') return 'structured:gate_result';
  return plain(value) ? 'an object matching no declared shape' : `a ${value === null ? 'null' : typeof value} value`;
}

// Returns a message naming the field, the declared shape, and what was actually supplied, or
// null when every declared field carries its declared shape.
function inputShapeProblem(operation, data) {
  const declared = INPUT_SHAPES[operation];
  if (!declared || !plain(data)) return null;
  for (const [field, spec] of Object.entries(declared)) {
    const value = data[field];
    const classification = classifyInputShape(value);
    const expectedClass = ACCEPTED[spec];
    if (classification !== expectedClass || (expectedClass === 'other' && !plain(value))) {
      return `\`${field}\` must be ${spec}, received ${describe(value, classification)}`;
    }
    if (spec.startsWith('envelope:')) {
      const producer = spec.slice('envelope:'.length);
      const successful = value.version === 1 && value.ok === true && plain(value.data) && !Object.hasOwn(value, 'error');
      if (value.operation !== producer || !successful) {
        return `\`${field}\` must be ${spec}, received ${describe(value, classification)}`;
      }
    }
  }
  return null;
}

module.exports = { INPUT_SHAPES, classifyInputShape, inputShapeProblem };
