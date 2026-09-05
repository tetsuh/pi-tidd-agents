'use strict';

const crypto = require('node:crypto');
const { createResult, createError } = require('./protocol');

// Issue #40 (CL-D45). Deterministic source-reply markers and read-only reconciliation.
//
// `visibleSha256` is computed over the canonical visible reply body alone — LF-normalized
// UTF-8 bytes that exclude the marker line — so no marker field enters its own digest and the
// definition is non-circular. Reconciliation judges only supplied refetched evidence: this
// module reaches no filesystem, process, or network primitive, so it cannot POST, retry, or
// resolve anything regardless of its result, and every outcome is terminal for the run under
// the recorded Option A.
// The stem is the version token; the canonical delimiter after it is one ASCII space. They
// are held separately because detection must find the stem followed by ANY whitespace — a TAB
// after the version token would otherwise hide the whole marker from both parsing paths —
// while canonical recognition still demands the single-space form via re-serialization.
const MARKER_STEM = '<!-- pi-tidd-agents:source-reply:v1';
const MARKER_PREFIX = `${MARKER_STEM} `;
const MARKER_FIELDS = ['repo', 'pr', 'sourceKind', 'sourceId', 'sourceUrl', 'sourceBodySha256', 'sourceCreatedAt', 'sourceUpdatedAt', 'head', 'findings', 'gates', 'commit', 'visibleSha256'];
const BINDING_KEYS = ['commit', 'findings', 'gates', 'head', 'number', 'repository', 'sourceBodySha256', 'sourceCreatedAt', 'sourceId', 'sourceKind', 'sourceUpdatedAt', 'sourceUrl'];
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[^\s/]+\/[^\s/]+$/;
const KINDS = ['issue_comment', 'review', 'review_comment', 'review_thread'];
const SOURCE_ID = /^[A-Za-z0-9_=-]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// A shape-valid string is not an instant: 2026-99-99T99:99:99Z matches the regex. Round-trip
// through the platform calendar so only real canonical UTC instants pass.
function utcInstant(value) { return TIMESTAMP.test(value) && new Date(value).toISOString() === `${value.slice(0, 19)}.000Z`; }
// The gate contract leaves finding IDs open (non-empty text), so the marker accepts what the
// gate accepts and rejects only what would corrupt its own serialization separators.
const FINDING_ID = /^[^\s:,]+$/;
const DISPOSITIONS = ['fixed', 'accepted-as-designed', 'deferred', 'duplicate', 'not-applicable', 'needs-owner-decision'];
// Version 1 and version 2 gate vocabularies both parse for one release (CL-D60): a marker
// names its gates in the vocabulary of the envelope it was written from.
const GATES = ['sol', 'terra', 'sol+terra', 'adversarial', 'safety', 'decision-drift', 'adversarial+safety', 'adversarial+decision-drift', 'convergence'];

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonicalVisible(body) { return body.replace(/\r\n?/g, '\n'); }
// The digested visible form is LF-terminated, so a body written without a trailing newline
// still round-trips: reconstruction from published bytes always yields LF-terminated text.
function canonicalDigestible(body) { const visible = canonicalVisible(body); return visible.endsWith('\n') ? visible : `${visible}\n`; }

function checkBinding(binding) {
  if (!plain(binding)) fail('invalid_reply_binding', 'binding must be an object');
  if (Object.keys(binding).sort().join() !== BINDING_KEYS.join()) fail('invalid_reply_binding', 'binding must carry exactly its declared fields');
  if (!text(binding.repository) || !REPOSITORY.test(binding.repository)) fail('invalid_reply_binding', 'repository must be owner/name');
  if (!Number.isInteger(binding.number) || binding.number <= 0) fail('invalid_reply_binding', 'number must be a positive integer');
  if (!KINDS.includes(binding.sourceKind)) fail('invalid_reply_binding', `sourceKind must be one of ${KINDS.join(', ')}`);
  if (!text(binding.sourceId) || !SOURCE_ID.test(binding.sourceId)) fail('invalid_reply_binding', 'sourceId must be a stable provider ID');
  if (!text(binding.sourceUrl) || /\s/.test(binding.sourceUrl) || !binding.sourceUrl.startsWith(`https://github.com/${binding.repository}/pull/${binding.number}#`)) fail('invalid_reply_binding', 'sourceUrl must address the bound repository and pull request');
  if (!text(binding.sourceBodySha256) || !DIGEST.test(binding.sourceBodySha256)) fail('invalid_reply_binding', 'sourceBodySha256 must be a lowercase SHA-256');
  for (const field of ['sourceCreatedAt', 'sourceUpdatedAt']) if (!text(binding[field]) || !utcInstant(binding[field])) fail('invalid_reply_binding', `${field} must be a real canonical UTC instant`);
  if (!text(binding.head) || !OID.test(binding.head)) fail('invalid_reply_binding', 'head must be an object ID');
  if (!Array.isArray(binding.findings) || binding.findings.length === 0) fail('invalid_reply_binding', 'findings must be a non-empty array');
  const seen = new Set();
  for (const finding of binding.findings) {
    if (!plain(finding) || Object.keys(finding).sort().join() !== 'disposition,findingId') fail('invalid_reply_binding', 'each finding must carry exactly findingId and disposition');
    if (!text(finding.findingId) || !FINDING_ID.test(finding.findingId)) fail('invalid_reply_binding', 'findingId must match the gate finding grammar');
    if (!DISPOSITIONS.includes(finding.disposition)) fail('invalid_reply_binding', `disposition must be one of ${DISPOSITIONS.join(', ')}`);
    if (seen.has(finding.findingId)) fail('invalid_reply_binding', 'finding IDs must be unique');
    seen.add(finding.findingId);
  }
  if (!GATES.includes(binding.gates)) fail('invalid_reply_binding', `gates must be one of ${GATES.join(', ')}`);
  if (binding.commit !== null && (!text(binding.commit) || !OID.test(binding.commit))) fail('invalid_reply_binding', 'commit must be an object ID or null');
}

function serializeFindings(findings) {
  return findings.slice().sort((a, b) => (a.findingId < b.findingId ? -1 : 1)).map((finding) => `${finding.findingId}:${finding.disposition}`).join(',');
}

function serializeMarker(binding, visibleSha256) {
  const values = {
    repo: binding.repository, pr: String(binding.number), sourceKind: binding.sourceKind,
    sourceId: binding.sourceId, sourceUrl: binding.sourceUrl, sourceBodySha256: binding.sourceBodySha256,
    sourceCreatedAt: binding.sourceCreatedAt, sourceUpdatedAt: binding.sourceUpdatedAt, head: binding.head,
    findings: serializeFindings(binding.findings), gates: binding.gates,
    commit: binding.commit === null ? 'none' : binding.commit, visibleSha256,
  };
  const line = `${MARKER_PREFIX}${MARKER_FIELDS.map((field) => `${field}=${values[field]}`).join(' ')} -->`;
  // A serialized value containing an HTML comment terminator would end the hidden marker early
  // and leak the remainder as visible text, so the line must contain exactly the final one.
  if (!line.endsWith(' -->') || line.slice(0, -3).includes('-->') || line.includes('--!>')) fail('invalid_reply_binding', 'a bound value would terminate the marker comment');
  return line;
}

function createReplyMarker({ binding, visibleBody } = {}) {
  try {
    checkBinding(binding);
    if (typeof visibleBody !== 'string' || visibleBody.trim().length === 0) fail('invalid_reply_binding', 'visibleBody must be a non-empty string');
    const visible = canonicalDigestible(visibleBody);
    // A marker line inside the visible bytes would make the digest domain ambiguous: the same
    // published body would parse into two candidate visible regions.
    if (new RegExp(`${MARKER_STEM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(visible)) fail('invalid_reply_binding', 'visibleBody must not contain a source-reply marker');
    const visibleSha256 = sha256(Buffer.from(visible, 'utf8'));
    const marker = serializeMarker(binding, visibleSha256);
    const body = `${visible}${marker}\n`;
    return createResult('marker_create', { marker, visibleSha256, body });
  } catch (error) {
    return createError('marker_create', error.code || 'invalid_reply_binding', error.message, 'marker_create');
  }
}

// A line is a canonical v1 marker only when re-serializing its parsed fields reproduces it
// byte for byte with exactly the declared field set: prefix and suffix alone are not
// recognition, because any altered interior — a TAB for a space, a duplicated or reordered
// field — would otherwise hide inside a canonical-looking line and be silently skipped.
function canonicalFields(line) {
  if (!line.startsWith(MARKER_PREFIX) || !line.endsWith(' -->')) return null;
  const fields = {};
  for (const token of line.slice(MARKER_PREFIX.length, -' -->'.length).split(' ')) {
    const split = token.indexOf('=');
    if (split > 0) fields[token.slice(0, split)] = token.slice(split + 1);
  }
  // Re-serialization equality is the whole test: a missing, extra, duplicated, or reordered
  // field, or any noncanonical separator, cannot reproduce the line from the declared order.
  const reserialized = `${MARKER_PREFIX}${MARKER_FIELDS.map((field) => `${field}=${fields[field]}`).join(' ')} -->`;
  return reserialized === line ? fields : null;
}

function parseMarkers(body) {
  const markers = [];
  for (const line of canonicalVisible(body).split('\n')) {
    const fields = canonicalFields(line);
    if (fields) markers.push(fields);
  }
  return markers;
}

// A current-v1 marker prefix outside a canonical marker line is altered evidence, not absence:
// text added around a published marker must not let the reply vanish into
// reply_confirmed_absent, which downstream intake would trust. A candidate naming another
// source is that source's problem; one naming ours, or too mangled to rule ours out, is a
// conflict — fail closed toward the owner, never toward absence.
function noncanonicalCandidate(body, expectedFields) {
  const content = canonicalVisible(body);
  let from = 0;
  for (;;) {
    const at = content.indexOf(MARKER_STEM, from);
    if (at === -1) return false;
    const follower = content[at + MARKER_STEM.length];
    // A longer token — v12, v1x — is another version and stays outside this vocabulary; only
    // the exact v1 token followed by whitespace or the end of the content is a candidate.
    if (follower !== undefined && !/\s/.test(follower)) { from = at + MARKER_STEM.length; continue; }
    const lineStart = content.lastIndexOf('\n', at) + 1;
    const newline = content.indexOf('\n', at);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd);
    if (!canonicalFields(line)) {
      const close = content.indexOf('-->', at);
      const candidate = content.slice(at + MARKER_STEM.length, close === -1 ? lineEnd : Math.min(close, lineEnd));
      // Tokens split on any whitespace, so a TAB- or vertical-TAB-separated candidate still
      // reveals which source it names instead of hiding it inside one mangled token. Every
      // occurrence of a source-binding key is retained: a last-wins dictionary would let a
      // second sourceId shadow the one naming this source, turning a conflict into absence.
      const kinds = [];
      const ids = [];
      for (const token of candidate.split(/\s+/)) {
        const split = token.indexOf('=');
        if (split <= 0) continue;
        const name = token.slice(0, split);
        if (name === 'sourceKind') kinds.push(token.slice(split + 1));
        if (name === 'sourceId') ids.push(token.slice(split + 1));
      }
      // Absence is valid only when the candidate carries exactly one source binding and it
      // unambiguously identifies another source; anything unparseable, missing, duplicated,
      // or contradictory cannot rule this source out and is altered evidence.
      const unambiguousOther = kinds.length === 1 && ids.length === 1
        && !(kinds[0] === expectedFields.sourceKind && ids[0] === expectedFields.sourceId);
      if (!unambiguousOther) return true;
    }
    from = at + MARKER_STEM.length;
  }
}

function conflict(reason) { return { classification: 'reply_conflict', reason }; }
function ambiguous(reason) { return { classification: 'reply_ambiguous', reason }; }

function classify({ binding, visibleSha256, source, comments, paginationComplete, currentHead, expectedAuthor }) {
  // Insufficient evidence first: an incomplete listing can hide a duplicate or the reply
  // itself, so nothing conclusive can be said in either direction.
  if (paginationComplete !== true) return ambiguous('pagination_incomplete');
  if (!Array.isArray(comments)) return ambiguous('destination_evidence_missing');
  // Every destination comment is prevalidated in full before any contradiction. Otherwise a
  // moved head or source drift could mask insufficient destination evidence and make the same
  // evidence produce a different classification depending on which condition was checked first.
  for (const comment of comments) {
    if (!plain(comment) || typeof comment.body !== 'string' || !text(comment.author)) return ambiguous('destination_evidence_missing');
    if (!(typeof comment.id === 'number' && Number.isFinite(comment.id)) && !text(comment.id)) return ambiguous('destination_evidence_missing');
  }
  // Contradictory run state next: the binding is only meaningful at its exact head.
  if (currentHead !== binding.head) return conflict('current_head_moved');
  if (!plain(source)) return conflict('source_missing');
  if (source.kind !== binding.sourceKind || source.id !== binding.sourceId || source.url !== binding.sourceUrl) return conflict('wrong_source');
  if (source.bodySha256 !== binding.sourceBodySha256 || source.createdAt !== binding.sourceCreatedAt || source.updatedAt !== binding.sourceUpdatedAt) return conflict('source_changed');

  const markerLine = serializeMarker(binding, visibleSha256);
  const expectedFields = parseMarkers(markerLine)[0];
  let exact = null;
  let exactCount = 0;
  for (const comment of comments) {
    if (noncanonicalCandidate(comment.body, expectedFields)) return conflict('altered_marker_candidate');
    for (const marker of parseMarkers(comment.body)) {
      if (marker.sourceKind !== expectedFields.sourceKind || marker.sourceId !== expectedFields.sourceId) continue;
      if (MARKER_FIELDS.every((field) => marker[field] === expectedFields[field])) {
        // A byte-exact marker and body from any other author is a copy, not the workflow's one
        // allowed reply; classifying it as published would let impersonation settle the run.
        if (comment.author !== expectedAuthor) return conflict('foreign_author_marker');
        exactCount += 1;
        exact = comment;
      } else {
        // A marker bound to this source that differs in any field — head, digest, findings —
        // is contradictory evidence about the one allowed reply, whoever wrote it.
        return conflict('conflicting_marker_for_source');
      }
    }
  }
  if (exactCount === 0) return { classification: 'reply_confirmed_absent', reason: 'no_matching_marker' };
  if (exactCount > 1) return conflict('duplicate_markers');
  // The marker ends the reply body, so the published layout is exactly visible + marker + LF.
  // Position is part of the claim: removing the marker from any position would let a body with
  // the marker moved to the front or middle reconstruct the same visible bytes and pass as
  // published, so the LF-terminated comment must end with the marker line and the digest
  // covers only the preceding prefix.
  const body = canonicalDigestible(exact.body);
  const terminal = `${markerLine}\n`;
  if (!body.endsWith(terminal)) return conflict('visible_text_altered');
  const visible = body.slice(0, -terminal.length);
  if (sha256(Buffer.from(visible, 'utf8')) !== visibleSha256) return conflict('visible_text_altered');
  return { classification: 'reply_confirmed_published', reason: 'exact_match', commentId: String(exact.id) };
}

function reconcileReply(input = {}) {
  try {
    checkBinding(input.binding);
    if (!text(input.visibleSha256) || !DIGEST.test(input.visibleSha256)) fail('invalid_reply_binding', 'visibleSha256 must be a lowercase SHA-256');
    if (!text(input.currentHead) || !OID.test(input.currentHead)) fail('invalid_reply_binding', 'currentHead must be an object ID');
    if (!text(input.expectedAuthor) || /\s/.test(input.expectedAuthor)) fail('invalid_reply_binding', 'expectedAuthor must be the workflow actor login');
    return createResult('marker_reconcile', classify(input));
  } catch (error) {
    return createError('marker_reconcile', error.code || 'invalid_reply_binding', error.message, 'marker_reconcile');
  }
}

module.exports = { createReplyMarker, reconcileReply, REPLY_MARKER_PREFIX: MARKER_PREFIX };
