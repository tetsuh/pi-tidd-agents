'use strict';

// CL-D96 (#196): which tracked paths a finding's text names, and so which paths a writer may edit, split from autofix.js
// under the per-file alarm. Names match
// whole and longest first, so the tail of a longer tracked or ambiguous name is never a name of its own
// (ADV-208-AUTHORIZED-PATHS); a basename counts when exactly one tracked file carries it.

const path = require('node:path');
const { git } = require('./run');

// A name continues through any letter, number, or combining mark, read as whole code points (ADV-208-PATH-UNICODE).
const PATH_CHAR = /^[\p{L}\p{N}\p{M}_.\-/]$/u;
function namedPaths(text, tracked) {
  const byBase = new Map(); for (const p of tracked) { const b = path.posix.basename(p); byBase.set(b, byBase.has(b) ? null : p); }
  // An ambiguous basename (null) still takes its span, so its tail names nothing; it names no path itself.
  const candidates = [...tracked.map((p) => [p, p]), ...[...byBase].filter(([b, p]) => p !== b)].sort((a, b) => b[0].length - a[0].length);
  const taken = [], named = new Set();
  // The code point ending at i, and the one starting at i; undefined past either end.
  const before = (i) => (i <= 0 ? undefined : [...text.slice(Math.max(0, i - 2), i)].at(-1));
  const at = (i) => (i >= text.length ? undefined : String.fromCodePoint(text.codePointAt(i)));
  const plain = (c) => c === undefined || !PATH_CHAR.test(c);
  const bounded = (i, end) => {
    const startOk = plain(before(i)) || (text.slice(i - 2, i) === './' && plain(before(i - 2)));
    const endOk = plain(at(end)) || (at(end) === '.' && plain(at(end + 1)));
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
// authorizedPaths: tracked paths the open findings name, plus the pull request's changed files; null when no finding
// names a tracked path.
function authorizedPaths(ws, open, target) {
  const tracked = git(ws, ['ls-files', '-z']).split('\0').filter(Boolean), named = new Set();
  for (const e of open) {
    const w = e.record.workflowRecord || {};
    for (const p of namedPaths([e.record.evidence, e.record.correction, e.record.impact, w.path, w.sourceId, w.correctiveChange].filter(Boolean).join('\n'), tracked)) named.add(p);
  }
  if (!named.size) return null;
  const changed = git(ws, ['diff', '--name-only', '-z', `${target.baseOid}...${target.headOid}`]).split('\0').filter(Boolean);
  return [...new Set([...named, ...changed])].sort();
}

module.exports = { namedPaths, authorizedPaths };
