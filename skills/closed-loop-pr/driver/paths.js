'use strict';

// CL-D96 (#196): which tracked paths a finding's text names, split from autofix.js under the per-file alarm. Names match
// whole and longest first, so the tail of a longer tracked or ambiguous name is never a name of its own
// (ADV-208-AUTHORIZED-PATHS); a basename counts when exactly one tracked file carries it.

const path = require('node:path');

const PATH_CHAR = /[\p{L}\p{N}_.\-/]/u;
function namedPaths(text, tracked) {
  const byBase = new Map(); for (const p of tracked) { const b = path.posix.basename(p); byBase.set(b, byBase.has(b) ? null : p); }
  // An ambiguous basename (null) still takes its span, so its tail names nothing; it names no path itself.
  const candidates = [...tracked.map((p) => [p, p]), ...[...byBase].filter(([b, p]) => p !== b)].sort((a, b) => b[0].length - a[0].length);
  const taken = [], named = new Set();
  const bounded = (i, end) => {
    const before = text[i - 1], after = text[end];
    const startOk = before === undefined || !PATH_CHAR.test(before) || (text.slice(i - 2, i) === './' && (i < 3 || !PATH_CHAR.test(text[i - 3])));
    const endOk = after === undefined || !PATH_CHAR.test(after) || (after === '.' && (text[end + 1] === undefined || !PATH_CHAR.test(text[end + 1])));
    return startOk && endOk;
  };
  for (const [needle, target] of candidates) {
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
      const end = i + needle.length;
      if (!bounded(i, end) || taken.some(([a, b]) => i < b && a < end)) continue;
      taken.push([i, end]); if (target) named.add(target);
    }
  }
  return named;
}

module.exports = { namedPaths };
