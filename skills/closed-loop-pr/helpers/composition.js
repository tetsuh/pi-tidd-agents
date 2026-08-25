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
});
// Each declared shape accepts exactly one classification. No shape is a tolerant alternative
// for another: accepting two would restore the ambiguity this check exists to remove.
const ACCEPTED = Object.freeze({
  'envelope:operator_capture': 'envelope',
  'data:workspace_create': 'workspace_data',
  'receipt:workspace_create': 'receipt',
  'data:snapshot': 'other',
});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Classification reads structure, never a caller's label. An envelope is the protocol document;
// a receipt is the run-owned cleanup grant; workspace data is what `workspace_create` returns.
function classifyInputShape(value) {
  if (!plain(value)) return 'other';
  if (['version', 'ok', 'operation'].every((key) => Object.hasOwn(value, key)) && (Object.hasOwn(value, 'data') || Object.hasOwn(value, 'error'))) return 'envelope';
  if (value.version === 1 && typeof value.root === 'string' && typeof value.storedPath === 'string' && Object.hasOwn(value, 'id')) return 'receipt';
  if (plain(value.receipt) && typeof value.root === 'string' && typeof value.kind === 'string') return 'workspace_data';
  return 'other';
}

function describe(value, classification) {
  if (classification === 'envelope') return `envelope:${typeof value.operation === 'string' ? value.operation : 'unknown'}`;
  if (classification === 'receipt') return 'receipt:workspace_create';
  if (classification === 'workspace_data') return 'data:workspace_create';
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
    if (spec.startsWith('envelope:') && value.operation !== spec.slice('envelope:'.length)) {
      return `\`${field}\` must be ${spec}, received ${describe(value, classification)}`;
    }
  }
  return null;
}

module.exports = { INPUT_SHAPES, classifyInputShape, inputShapeProblem };
