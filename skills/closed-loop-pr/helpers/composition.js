'use strict';

// Issue #74 (CL-D44). Cross-operation fields carry one declared shape each, checked before the
// operation runs. Without this a plausible swap — an operation's `data` where its complete
// envelope belongs — crosses the boundary and surfaces later as an unrelated identity or
// capture failure, which is what happened on tetsuh/sitos#165.
//
// The check separates the declared shapes from one another; it is not a validator of producer
// output. Each field carries one predicate for its declared shape, and a value is rejected
// because it fails that one predicate — never because of what it was recognized to be. The
// negative side is therefore closed by construction: there is no enumeration of other shapes
// to be incomplete. `describe` below supplies diagnostic wording for the error message only
// and plays no part in the accept/reject decision.
const INPUT_SHAPES = Object.freeze({
  guard_before_edit: Object.freeze({ expected: 'data:workspace_create' }),
  overlay_compare: Object.freeze({ overlay: 'data:overlay_freeze' }),
  manifest_compare: Object.freeze({ manifest: 'data:manifest_compare' }),
  operator_revalidate: Object.freeze({ captured: 'envelope:operator_capture' }),
  workspace_verify: Object.freeze({ expected: 'data:workspace_create' }),
  workspace_cleanup: Object.freeze({ receipt: 'receipt:workspace_create' }),
  fingerprint_snapshot: Object.freeze({ snapshot: 'data:snapshot' }),
  gate_result_validate: Object.freeze({ result: 'structured:gate_result' }),
});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }

const SNAPSHOT_DATA_KEYS = Object.freeze([
  'after', 'annotations', 'before', 'checkSuites', 'checks', 'comments', 'completeness',
  'inline', 'policies', 'pull', 'reviews', 'statuses', 'threads',
]);

// One predicate per declared shape. Predicate depth is calibrated to what fails downstream:
// `data:snapshot` carries the full producer shape because `fingerprint_snapshot` hashes any
// object silently, while `structured:gate_result` is only a separating probe because the
// closed CL-D36 schema in gate-result.js remains the sole validator of gate results. The
// executed positive composition fixtures keep each predicate in lockstep with its producer.
// manifest_compare's manifest is a compare-mode field; capture mode legitimately omits it,
// so it is validated only when supplied (CL-D57).
const OPTIONAL_INPUTS = Object.freeze({ manifest_compare: Object.freeze(['manifest']) });
const PREDICATES = Object.freeze({
  // The two guard shapes are separating probes (CL-D44 depth calibration): the guards
  // themselves revalidate every field they consume.
  'data:overlay_freeze': (value) => plain(value) && /^[0-9a-f]{40}$/.test(value.parent || '')
    && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.every(plain)
    && Array.isArray(value.authorizedPaths),
  'data:manifest_compare': (value) => plain(value) && /^[0-9a-f]{40}$/.test(value.parent || '')
    && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.every(plain),
  'envelope:operator_capture': (value) => plain(value) && value.version === 1 && value.ok === true
    && value.operation === 'operator_capture' && plain(value.data) && !Object.hasOwn(value, 'error'),
  'data:workspace_create': (value) => {
    if (!plain(value) || !text(value.path) || !text(value.head) || !text(value.tree)
      || !text(value.root) || typeof value.cleanupAllowed !== 'boolean') return false;
    if (value.kind === 'linked') return value.cleanupAllowed === true && plain(value.receipt);
    if (value.kind === 'clone') return value.cleanupAllowed === false && value.retained === true
      && value.fallbackReason === 'linked_unavailable' && !Object.hasOwn(value, 'receipt');
    return false;
  },
  'receipt:workspace_create': (value) => plain(value) && value.version === 1
    && text(value.root) && text(value.storedPath) && Object.hasOwn(value, 'id'),
  'data:snapshot': (value) => plain(value)
    && Object.keys(value).sort().join() === SNAPSHOT_DATA_KEYS.join()
    && plain(value.before) && plain(value.after) && plain(value.pull)
    && plain(value.completeness) && plain(value.policies)
    && ['annotations', 'checkSuites', 'checks', 'comments', 'inline', 'reviews', 'statuses', 'threads']
      .every((key) => Array.isArray(value[key])),
  'structured:gate_result': (value) => plain(value) && value.schemaVersion === 1
    && plain(value.correlation) && typeof value.verdict === 'string',
});

// Diagnostic wording only: a best-effort name for what arrived, so the error reads as
// "expected X, received Y". Looseness or overlap here is not a defect — the rejection above
// never consulted this.
function describe(value) {
  if (!plain(value)) return `a ${value === null ? 'null' : typeof value} value`;
  if (['version', 'ok', 'operation'].every((key) => Object.hasOwn(value, key))) {
    const operation = typeof value.operation === 'string' ? value.operation : 'unknown';
    if (value.ok === false || Object.hasOwn(value, 'error')) return `error envelope:${operation}`;
    if (value.version !== 1 || value.ok !== true || !plain(value.data)) return `malformed envelope:${operation}`;
    return `envelope:${operation}`;
  }
  for (const [spec, predicate] of Object.entries(PREDICATES)) {
    if (spec !== 'envelope:operator_capture' && predicate(value)) return spec;
  }
  return 'an object matching no declared shape';
}

// Returns a message naming the field, the declared shape, and what was actually supplied, or
// null when every declared field satisfies its declared predicate.
function inputShapeProblem(operation, data) {
  const declared = INPUT_SHAPES[operation];
  if (!declared || !plain(data)) return null;
  for (const [field, spec] of Object.entries(declared)) {
    if (!Object.hasOwn(data, field) && (OPTIONAL_INPUTS[operation] || []).includes(field)) continue;
    if (!PREDICATES[spec](data[field])) {
      return `\`${field}\` must be ${spec}, received ${describe(data[field])}`;
    }
  }
  return null;
}

module.exports = { INPUT_SHAPES, inputShapeProblem };
