'use strict';

// Issue #40 — deterministic source-reply markers and read-only post-attempt reconciliation,
// without weakening one-shot mutation authority.
//
// TDD provenance: recorded with the focused command below, which produced 0 passes. Every
// failure is compile/contract RED — the authority scenario against the missing section and
// record, the rest because `createReplyMarker` and `reconcileReply` did not exist at capture —
// so no behavioral RED is claimed for this file. That local output is not claimed as
// repository-preserved or runtime-compliance evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf, cliSchemas } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const CONTRACT = readText('CONTRACT.md');
const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');

const HEAD = 'a'.repeat(40);
const SOURCE_SHA = crypto.createHash('sha256').update(Buffer.from('please fix the guard\n', 'utf8')).digest('hex');
const VISIBLE = 'Fixed by `b`.repeat? no — the guard now rejects the swap.\nConfirming gate: Sol at the exact head.\n';

function binding(overrides = {}) {
  return {
    repository: 'tetsuh/pi-tidd-agents',
    number: 76,
    sourceKind: 'issue_comment',
    sourceId: '5442524616',
    sourceUrl: 'https://github.com/tetsuh/pi-tidd-agents/pull/76#issuecomment-5442524616',
    sourceBodySha256: SOURCE_SHA,
    sourceCreatedAt: '2026-08-27T10:00:00Z',
    sourceUpdatedAt: '2026-08-27T10:00:00Z',
    head: HEAD,
    findings: [{ findingId: 'SOL-76-OWNER-PROVENANCE', disposition: 'fixed' }],
    gates: 'sol',
    commit: 'b'.repeat(40),
    ...overrides,
  };
}
function markerOf(overrides = {}, visibleBody = VISIBLE) {
  return helpers.createReplyMarker({ binding: binding(overrides), visibleBody });
}
function source(overrides = {}) {
  return {
    kind: 'issue_comment', id: '5442524616',
    url: 'https://github.com/tetsuh/pi-tidd-agents/pull/76#issuecomment-5442524616',
    bodySha256: SOURCE_SHA, createdAt: '2026-08-27T10:00:00Z', updatedAt: '2026-08-27T10:00:00Z',
    ...overrides,
  };
}
function reconcile({ b = binding(), visibleSha256, src = source(), comments = [], paginationComplete = true, currentHead = HEAD, expectedAuthor = 'tetsuh' } = {}) {
  const sha = visibleSha256 ?? markerOf().data.visibleSha256;
  return helpers.reconcileReply({ binding: b, visibleSha256: sha, source: src, comments, paginationComplete, currentHead, expectedAuthor });
}
function publishedComment(overrides = {}) {
  const made = markerOf();
  return { id: '900001', body: made.data.body, author: 'tetsuh', ...overrides };
}
function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
}

test('Issue #40 authority defines the marker grammar, the four outcomes, and the terminal policy', () => {
  const section = sectionOf(AUTOFIX, '### Source-reply markers and reconciliation (CL-D45)');
  assert.ok(section, 'autofix must own a CL-D45 marker section');
  assert.match(section, /`pi-tidd-agents:source-reply:v1`/);
  assert.match(section, /`visibleSha256` covers the canonical visible reply body alone — LF-normalized, LF-terminated UTF-8 bytes that exclude the marker line — so no marker field enters its own digest/);
  assert.match(section, /`reply_confirmed_published`, `reply_confirmed_absent`, `reply_ambiguous`, and `reply_conflict`/);
  assert.match(section, /exactly one of the four/);
  assert.match(section, /Only an exact one-marker, one-body match on complete evidence from the expected workflow author classifies as published/);
  assert.match(section, /incomplete pagination or missing refetched evidence is ambiguous, never absent/);
  assert.match(section, /contradictory evidence — a duplicate, altered, wrong-head, wrong-source, or foreign-author marker, or a changed or deleted source — is a conflict/);
  assert.match(section, /Reconciliation is read-only and repeatable, judges only refetched evidence, and performs no request/);
  assert.match(section, /Every reconciliation outcome, including `reply_confirmed_absent`, is terminal for the run: no second POST exists under this decision/);
  assert.match(section, /a fresh owner-authorized run remains the only continuation/);
  assert.match(section, /never resolves threads, approves, requests rereview, invokes bots, edits or deletes comments, or posts an aggregate summary/);
  assert.match(section, /Per-source outcomes stay ordered by source identity, and no batch outcome claims whole-PR readiness/);

  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.match(map, /\| `marker_create` \| `binding`, `visibleBody` \|/);
  assert.match(map, /\| `marker_reconcile` \| `binding`, `visibleSha256`, `source`, `comments`, `paginationComplete`, `currentHead`, `expectedAuthor` \|/);

  const decision = sectionOf(CONTRACT, '## CL-D45 — Source replies carry deterministic markers and reconcile read-only');
  assert.ok(decision, 'CONTRACT.md must record CL-D45');
  for (const field of ['*Decision ID:* CL-D45', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D45 record must carry ${field}`);
  }
  assert.match(decision, /Option A/);
  assert.match(decision, /declares no CL-D44 field/);
});

test('Issue #40 marker serialization is deterministic and the digest is non-circular', () => {
  const first = markerOf();
  assert.equal(first.ok, true, JSON.stringify(first));
  const again = markerOf();
  assert.equal(first.data.marker, again.data.marker, 'same binding must serialize to identical marker bytes');
  assert.equal(first.data.body, again.data.body);

  // Finding order in the input does not change the canonical serialization.
  const findings = [
    { findingId: 'SOL-76-B', disposition: 'accepted-as-designed' },
    { findingId: 'SOL-76-A', disposition: 'fixed' },
  ];
  const forward = markerOf({ findings });
  const reversed = markerOf({ findings: [...findings].reverse() });
  assert.equal(forward.data.marker, reversed.data.marker);
  assert.ok(forward.data.marker.indexOf('SOL-76-A') < forward.data.marker.indexOf('SOL-76-B'));

  // Non-circular: the digest covers the visible bytes alone, the marker line sits outside
  // them, and stripping the marker line from the published body reproduces the digest.
  const expected = crypto.createHash('sha256').update(Buffer.from(VISIBLE, 'utf8')).digest('hex');
  assert.equal(first.data.visibleSha256, expected);
  assert.ok(first.data.marker.includes(`visibleSha256=${expected}`));
  assert.ok(first.data.body.endsWith(`${first.data.marker}\n`));
  const visible = first.data.body.slice(0, first.data.body.length - first.data.marker.length - 1);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(visible, 'utf8')).digest('hex'), expected);

  // CRLF input normalizes to the same canonical bytes.
  assert.equal(markerOf({}, VISIBLE.replace(/\n/g, '\r\n')).data.visibleSha256, expected);

  // A marker line inside the visible body would make the digest domain ambiguous.
  const nested = markerOf({}, `${VISIBLE}${first.data.marker}\n`);
  assert.equal(nested.ok, false);
  assert.equal(nested.error.code, 'invalid_reply_binding');
});

test('Issue #40 the marker is fail-closed on every malformed binding field', () => {
  const cases = [
    ['repository', { repository: 'pi-tidd-agents' }],
    ['number', { number: 0 }],
    ['sourceKind', { sourceKind: 'Comment!' }],
    ['sourceKind', { sourceKind: 'comments' }],
    ['sourceId', { sourceId: 'has space' }],
    ['sourceUrl', { sourceUrl: 'http://github.com/x' }],
    ['sourceUrl', { sourceUrl: 'https://github.com/a b' }],
    ['sourceUrl', { sourceUrl: 'https://github.com/other/repo/pull/76#issuecomment-1' }],
    ['sourceUrl', { sourceUrl: 'https://github.com/tetsuh/pi-tidd-agents/pull/99#issuecomment-1' }],
    ['sourceBodySha256', { sourceBodySha256: 'z'.repeat(64) }],
    ['sourceCreatedAt', { sourceCreatedAt: 'yesterday' }],
    ['sourceCreatedAt', { sourceCreatedAt: '2026-99-99T99:99:99Z' }],
    ['sourceCreatedAt', { sourceCreatedAt: '2026-02-30T00:00:00Z' }],
    ['sourceUpdatedAt', { sourceUpdatedAt: '2026-13-01T00:00:00Z' }],
    ['sourceUpdatedAt', { sourceUpdatedAt: '2026-08-27' }],
    ['head', { head: 'g'.repeat(40) }],
    ['findings', { findings: [] }],
    ['findings', { findings: [{ findingId: 'SOL:76', disposition: 'fixed' }] }],
    ['findings', { findings: [{ findingId: 'SOL,76', disposition: 'fixed' }] }],
    ['findings', { findings: [{ findingId: 'has space', disposition: 'fixed' }] }],
    // A gate-valid ID containing an HTML comment terminator would end the hidden marker early
    // and leak the remainder as visible text (SOL-77-HTML-COMMENT-TERMINATOR).
    ['findings', { findings: [{ findingId: 'X-->Y', disposition: 'fixed' }] }],
    ['findings', { findings: [{ findingId: 'X--!>Y', disposition: 'fixed' }] }],
    ['repository', { repository: 'a-->b/c' }],
    ['findings', { findings: [{ findingId: 'SOL-76-A', disposition: 'Fixed' }] }],
    ['findings', { findings: [{ findingId: 'SOL-76-A', disposition: 'bogus' }] }],
    ['findings', { findings: [{ findingId: 'SOL-76-A', disposition: 'fixed' }, { findingId: 'SOL-76-A', disposition: 'deferred' }] }],
    ['gates', { gates: 'luna' }],
    ['commit', { commit: 'short' }],
    ['extra', { extra: true }],
  ];
  for (const [field, override] of cases) {
    const result = markerOf(override);
    assert.equal(result.ok, false, `${field}: ${JSON.stringify(override)} must fail closed`);
    assert.equal(result.error.code, 'invalid_reply_binding');
    assert.equal(result.error.phase, 'marker_create');
  }
  assert.equal(markerOf({}, '').error.code, 'invalid_reply_binding');
  assert.equal(markerOf({ commit: null }).ok, true, 'a no-code disposition carries no corrective commit');
  // The gate contract leaves finding IDs open, so a gate-legal ID outside the SOL/TERRA house
  // pattern is accepted; only serialization-breaking characters are rejected.
  assert.equal(markerOf({ findings: [{ findingId: 'parent.48/x', disposition: 'deferred' }] }).ok, true);
});

test('Issue #40 reconciliation classifies each fixture distinctly and exactly once', () => {
  const outcomes = new Set(['reply_confirmed_published', 'reply_confirmed_absent', 'reply_ambiguous', 'reply_conflict']);

  // Published: exactly one marker, exact body, complete evidence.
  const published = reconcile({ comments: [publishedComment(), { id: '1', body: 'unrelated comment', author: 'passerby' }] });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(published.data.classification, 'reply_confirmed_published');
  assert.equal(published.data.commentId, '900001');

  // Absent: complete evidence, no matching marker anywhere.
  const absent = reconcile({ comments: [{ id: '1', body: 'unrelated', author: 'passerby' }] });
  assert.equal(absent.data.classification, 'reply_confirmed_absent');

  // Duplicate: two exact markers.
  assert.equal(reconcile({ comments: [publishedComment(), publishedComment({ id: '900002' })] }).data.classification, 'reply_conflict');

  // Altered: the marker matches but the visible text changed after publication.
  const altered = publishedComment();
  altered.body = altered.body.replace('Confirming gate', 'Confirming gates');
  assert.equal(reconcile({ comments: [altered] }).data.classification, 'reply_conflict');

  // Stale head: a marker bound to the same source at another head is contradictory evidence.
  const foreign = { id: '900003', body: markerOf({ head: 'c'.repeat(40) }).data.body, author: 'tetsuh' };
  assert.equal(reconcile({ comments: [foreign] }).data.classification, 'reply_conflict');

  // Wrong source: the refetched source does not match the binding.
  assert.equal(reconcile({ src: source({ bodySha256: 'd'.repeat(64) }), comments: [publishedComment()] }).data.classification, 'reply_conflict');
  assert.equal(reconcile({ src: null, comments: [publishedComment()] }).data.classification, 'reply_conflict');

  // Incomplete pagination: insufficient evidence is ambiguous even when a match is visible.
  assert.equal(reconcile({ paginationComplete: false, comments: [publishedComment()] }).data.classification, 'reply_ambiguous');

  // A moved current head is contradictory run state.
  assert.equal(reconcile({ currentHead: 'e'.repeat(40), comments: [publishedComment()] }).data.classification, 'reply_conflict');

  // A byte-exact copy of the marker and body from any other author is a conflict, never the
  // workflow's published reply; a comment carrying no authorship is insufficient evidence.
  assert.equal(reconcile({ comments: [publishedComment({ author: 'impostor' })] }).data.classification, 'reply_conflict');
  assert.equal(reconcile({ comments: [{ id: '9', body: publishedComment().body }] }).data.classification, 'reply_ambiguous');

  // SOL-77-ALTERED-MARKER-ABSENCE: a current-v1 marker candidate outside a canonical marker
  // line, bound to this source, is altered evidence — never reply_confirmed_absent.
  const marker = markerOf().data.marker;
  for (const [label, body] of [
    ['leading text', `body\nx ${marker}\n`],
    ['leading whitespace', `body\n ${marker}\n`],
    ['trailing text', `body\n${marker} tail\n`],
    ['embedded mid-line', `pre ${marker} post\n`],
    ['truncated candidate', 'body\nsee <!-- pi-tidd-agents:source-reply:v1 sourceKind=iss\n'],
  ]) {
    const settled = reconcile({ comments: [{ id: '9', body, author: 'tetsuh' }] });
    assert.equal(settled.data.classification, 'reply_conflict', `${label}: ${JSON.stringify(settled.data)}`);
    assert.equal(settled.data.reason, 'altered_marker_candidate', label);
  }
  // Reopened SOL-77-ALTERED-MARKER-ABSENCE: noncanonical internal whitespace inside an
  // otherwise canonical-looking line — TAB or vertical TAB for the single-space separator, a
  // reordered field pair — must classify as altered evidence, never as absence. Canonical
  // recognition is re-serialization equality, not prefix and suffix.
  const inner = marker.slice('<!-- pi-tidd-agents:source-reply:v1 '.length, -' -->'.length).split(' ');
  for (const [label, line] of [
    ['TAB separator', marker.replace('sourceKind=issue_comment sourceId', 'sourceKind=issue_comment\tsourceId')],
    ['vertical-TAB separator', marker.replace(' sourceUrl=', '\u000BsourceUrl=')],
    ['reordered fields', `<!-- pi-tidd-agents:source-reply:v1 ${[inner[1], inner[0], ...inner.slice(2)].join(' ')} -->`],
    ['duplicated field token', `<!-- pi-tidd-agents:source-reply:v1 ${inner.join(' ')} ${inner[0]} -->`],
  ]) {
    const settled = reconcile({ comments: [{ id: '9', body: `body\n${line}\n`, author: 'tetsuh' }] });
    assert.equal(settled.data.classification, 'reply_conflict', `${label}: ${JSON.stringify(settled.data)}`);
    assert.equal(settled.data.reason, 'altered_marker_candidate', label);
  }
  // Reopened again at the version delimiter: the whitespace immediately after the v1 token is
  // part of detection, so replacing it with TAB or vertical TAB must still classify as altered
  // evidence — the stem is matched separately from its canonical single-space delimiter.
  for (const [label, line] of [
    ['TAB after the version token', marker.replace(':v1 ', ':v1\t')],
    ['vertical TAB after the version token', marker.replace(':v1 ', ':v1\u000B')],
  ]) {
    const settled = reconcile({ comments: [{ id: '9', body: `body\n${line}\n`, author: 'tetsuh' }] });
    assert.equal(settled.data.classification, 'reply_conflict', `${label}: ${JSON.stringify(settled.data)}`);
    assert.equal(settled.data.reason, 'altered_marker_candidate', label);
  }
  // A longer version token is another vocabulary, not an altered current-v1 candidate.
  assert.equal(reconcile({ comments: [{ id: '9', body: 'x <!-- pi-tidd-agents:source-reply:v12 sourceKind=issue_comment sourceId=5442524616 --> y\n', author: 'tetsuh' }] }).data.classification, 'reply_confirmed_absent');

  // A TAB-mangled candidate naming a different source still leaves absence undisturbed.
  const otherTab = markerOf({ sourceId: '999', sourceUrl: 'https://github.com/tetsuh/pi-tidd-agents/pull/76#issuecomment-999' }).data.marker
    .replace('sourceId=999 sourceUrl', 'sourceId=999\tsourceUrl');
  assert.equal(reconcile({ comments: [{ id: '9', body: `x ${otherTab}\n`, author: 'tetsuh' }] }).data.classification, 'reply_confirmed_absent');

  // A noncanonical candidate naming a different source, and an unknown marker version, do not
  // manufacture a conflict for this binding: absence stays absence.
  const otherSource = markerOf({ sourceId: '999', sourceUrl: 'https://github.com/tetsuh/pi-tidd-agents/pull/76#issuecomment-999' }).data.marker;
  assert.equal(reconcile({ comments: [{ id: '9', body: `x ${otherSource}\n`, author: 'tetsuh' }] }).data.classification, 'reply_confirmed_absent');
  assert.equal(reconcile({ comments: [{ id: '9', body: 'x <!-- pi-tidd-agents:source-reply:v2 sourceKind=issue_comment sourceId=5442524616 --> y\n', author: 'tetsuh' }] }).data.classification, 'reply_confirmed_absent');

  for (const result of [published, absent]) assert.ok(outcomes.has(result.data.classification));
});

test('Issue #40 reconciliation is read-only, repeatable, and mutation-free by construction', () => {
  const comments = [publishedComment(), { id: '1', body: 'unrelated' }];
  const frozenInput = JSON.stringify({ b: binding(), src: source(), comments });
  const first = reconcile({ comments });
  const second = reconcile({ comments });
  assert.deepEqual(first, second, 'the same evidence must reconcile identically');
  assert.equal(JSON.stringify({ b: binding(), src: source(), comments }), frozenInput, 'reconciliation must not mutate its evidence');

  // Structural: the module reaches no filesystem, process, or network primitive, so it cannot
  // POST, retry, or resolve anything regardless of its result.
  const sourceText = readText('skills/closed-loop-pr/helpers/reply.js');
  for (const forbidden of ["require('node:fs')", "require('node:child_process')", "require('node:https')", "require('node:http')", "require('node:net')", 'fetch(']) {
    assert.equal(sourceText.includes(forbidden), false, `reply.js must not reach ${forbidden}`);
  }
});

test('Issue #40 a visible body without a trailing newline still round-trips to published', () => {
  // SOL-77-VISIBLE-DIGEST-NEWLINE: the digested visible form is LF-terminated, so a body
  // authored without a final newline must reconcile as published, not visible_text_altered.
  const bare = markerOf({}, 'single line, no trailing newline');
  assert.equal(bare.ok, true, JSON.stringify(bare));
  const settled = reconcile({ visibleSha256: bare.data.visibleSha256, comments: [{ id: '7', body: bare.data.body, author: 'tetsuh' }] });
  assert.equal(settled.data.classification, 'reply_confirmed_published', JSON.stringify(settled));
});

test('Issue #40 the packaged CLI routes both operations under JSON v1', () => {
  assert.deepEqual(cliSchemas().marker_create, ['binding', 'visibleBody']);
  assert.deepEqual(cliSchemas().marker_reconcile, ['binding', 'visibleSha256', 'source', 'comments', 'paginationComplete', 'currentHead', 'expectedAuthor']);

  const made = cli('marker_create', { binding: binding(), visibleBody: VISIBLE });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.status, 0);
  const settled = cli('marker_reconcile', {
    binding: binding(), visibleSha256: made.data.visibleSha256,
    source: source(), comments: [{ id: '900001', body: made.data.body, author: 'tetsuh' }],
    paginationComplete: true, currentHead: HEAD, expectedAuthor: 'tetsuh',
  });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal(settled.data.classification, 'reply_confirmed_published');

  for (const data of [
    { binding: binding(), visibleBody: VISIBLE, extra: 1 },
    { binding: binding() },
  ]) {
    const rejected = cli('marker_create', data);
    assert.equal(rejected.error.code, 'invalid_request');
    assert.notEqual(rejected.status, 0);
  }
  const badBinding = cli('marker_create', { binding: binding({ gates: 'luna' }), visibleBody: VISIBLE });
  assert.equal(badBinding.error.code, 'invalid_reply_binding');
  assert.notEqual(badBinding.status, 0);
});
