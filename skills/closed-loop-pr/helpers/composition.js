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

const { RUNTIME_ROOTS } = require('./operator');

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }

// The authorized-path rules manifest_compare, overlay_freeze, and guard_before_edit apply to a
// request, as one pure predicate shared with the builder that emits such a request, so a set
// the consumer would refuse never leaves the builder (ADV-108-MANIFEST-CAPTURE-VALIDATION).
// Returns null, or the consumer's own { subcheck, message, observed }.
function authorizedPathsProblem(paths) {
  const problem = (subcheck, message, observed) => ({ subcheck, message, observed });
  if (!Array.isArray(paths) || paths.length === 0) return problem('authorized_paths_shape', 'authorizedPaths must be a nonempty array', Array.isArray(paths) ? `length ${paths.length}` : typeof paths);
  for (const entry of paths) {
    // Control characters would make a path unmatchable against NUL-delimited Git output, and
    // a blank path is not a path at all; both are rejected here rather than by a later Git
    // invocation whose failure would name the wrong subcheck.
    if (!text(entry) || entry.startsWith('/') || entry.trim().length === 0
      // eslint-disable-next-line no-control-regex
      || /[\u0000-\u001f\u007f]/.test(entry)
      || entry.split('/').some((part) => ['', '.', '..'].includes(part))) {
      return problem('authorized_paths_shape', `authorized path is not a normalized relative path: ${JSON.stringify(entry)}`, entry);
    }
  }
  // Repository metadata is unobservable to the guards: Git never reports `.git` contents as
  // worktree or index state, so an authorized path there could be written while every guard
  // reported a clean, in-bounds overlay. It is refused for the same reason runtime roots are.
  const metadata = paths.find((entry) => entry.split('/').some((part) => part.toLowerCase() === '.git'));
  if (metadata !== undefined) return problem('repository_metadata_exclusion', `authorized path is inside repository metadata, which no guard can observe: ${metadata}`, metadata);
  if (new Set(paths).size !== paths.length) return problem('authorized_paths_shape', 'authorizedPaths carries a duplicate', paths.find((entry, i) => paths.indexOf(entry) !== i));
  const rooted = paths.find((entry) => RUNTIME_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`)));
  if (rooted !== undefined) return problem('runtime_root_exclusion', `authorized path is under a runtime root: ${rooted}`, rooted);
  return null;
}

// Exact key set: every required key present, no key outside required plus optional.
const keySet = (value, required, optional) => required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const guardShape = (value) => plain(value) && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.parent || '')
  && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.every(plain);

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
  // The two guard producers carry the same envelope keys, so each predicate states its own
  // producer's exact key set. Exactness is what makes them mutually exclusive: a value
  // carrying both producers' fields satisfies neither, because each rejects the other's.
  'data:overlay_freeze': (value) => guardShape(value)
    && keySet(value, ['parent', 'entries', 'authorizedPaths'], [])
    && Array.isArray(value.authorizedPaths)
    && value.entries.every((entry) => keySet(entry, ['path', 'status', 'rawDiffSha256'], ['sourcePath'])
      && text(entry.path) && text(entry.status) && /^[0-9a-f]{64}$/.test(entry.rawDiffSha256)),
  'data:manifest_compare': (value) => guardShape(value)
    && keySet(value, ['parent', 'entries'], [])
    && value.entries.every((entry) => keySet(entry, ['path', 'status', 'srcMode', 'dstMode', 'srcOid', 'dstOid'], ['sourcePath'])
      && ['path', 'status', 'srcMode', 'dstMode', 'srcOid', 'dstOid'].every((field) => text(entry[field]))),
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
  'structured:gate_result': (value) => plain(value) && [1, 2].includes(value.schemaVersion)
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

module.exports = { INPUT_SHAPES, inputShapeProblem, authorizedPathsProblem };
