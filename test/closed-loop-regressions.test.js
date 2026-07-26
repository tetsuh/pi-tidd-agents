'use strict';

// This file holds two different kinds of check, and the distinction matters.
//
// 1. Artifact assertions read the shipped prompt files and assert something about
//    them. They can fail when the artifacts regress.
// 2. Reference fixtures are executable specifications of a grammar or byte
//    serialization that the skills describe in prose. The runtime implementation
//    is that prose, interpreted by a model, so a fixture cannot verify runtime
//    behaviour. It pins the intended semantics and gives an implementer exact
//    vectors to check against. Fixture tests are named with a `fixture:` prefix
//    so nobody reads them as proof that the workflow behaves this way.
//
// Prose obligations belong in test/contract-clauses.json, not here.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readText } = require('./helpers');

const SINGLE_TOKEN_REF = /^(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+|#?\d+|PR\d+)$/;

function expandPrompt(file, args) {
  // Pi's documented `$@` substitution joins all arguments with a space.
  return readText(file).replaceAll('$@', args.join(' '));
}

/** Reference implementation of the target and mode grammar documented in CL-D6/CL-D7. */
function parseReferenceArgs(args, kind) {
  if (args.length === 0) return { usage: true };
  const wantsAutofix = kind === 'pr' && args.at(-1) === 'autofix';
  const targetArgs = wantsAutofix ? args.slice(0, -1) : args;
  const mode = wantsAutofix ? 'autofix' : 'review-only';
  if (targetArgs.length === 2 && /^(Issue|PR)$/.test(targetArgs[0]) && /^#\d+$/.test(targetArgs[1])) {
    return { target: targetArgs.join(' '), mode };
  }
  if (targetArgs.length === 1 && SINGLE_TOKEN_REF.test(targetArgs[0])) {
    return { target: targetArgs[0], mode };
  }
  return { usage: true };
}

const TARGETS = [
  'https://github.com/acme/widgets/pull/123',
  '#123',
  '123',
  'Issue #123',
  'PR #123',
  'PR123',
];

test('prompts pass the raw argument vector and no longer split it positionally', () => {
  for (const file of ['prompts/tidd-issue.md', 'prompts/tidd-pr.md']) {
    const text = readText(file);
    assert.match(text, /Raw arguments.*\$@/);
    // Positional binding broke two-token references such as `PR #123`, which #3
    // lists as an accepted form: `$2` captured `#123` and the mode parser
    // rejected it. Guard against a regression to that syntax.
    assert.doesNotMatch(text, /\$\{1:-MISSING\}/);
    assert.doesNotMatch(text, /\$\{2:-NONE\}/);
  }
});

test('every accepted target reference survives prompt expansion intact', () => {
  for (const target of TARGETS) {
    const file = target.startsWith('Issue') ? 'prompts/tidd-issue.md' : 'prompts/tidd-pr.md';
    const expanded = expandPrompt(file, target.split(' '));
    assert.ok(
      expanded.includes(`Raw arguments (preserve this complete vector for the Skill to parse): ${target}`),
      `${file} loses the target reference ${JSON.stringify(target)} on expansion`,
    );
  }
});

test('fixture: the documented grammar accepts every reference form', () => {
  for (const target of TARGETS) {
    const kind = target.startsWith('Issue') ? 'issue' : 'pr';
    assert.equal(parseReferenceArgs(target.split(' '), kind).target, target);
  }
});

test('fixture: the documented grammar keeps the autofix boundary exact', () => {
  assert.equal(parseReferenceArgs(['PR', '#123'], 'pr').mode, 'review-only');
  assert.equal(parseReferenceArgs(['PR', '#123', 'autofix'], 'pr').mode, 'autofix');
  assert.equal(parseReferenceArgs(['123', 'autofix'], 'pr').mode, 'autofix');
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'Autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', '--autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'autofix', 'extra'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['autofix', '#123'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs([], 'pr'), { usage: true });
  // The issue workflow has no autofix mode, so the token is just an extra argument.
  assert.deepEqual(parseReferenceArgs(['#123', 'autofix'], 'issue'), { usage: true });
});

function canonicalText(records) {
  return records.map((record) => String(record).replaceAll('\r\n', '\n').replaceAll('\r', '\n')).join('\n');
}

test('fixture: text fingerprint serialization is newline-stable and delimiter-stable', () => {
  const lf = canonicalText(['body\nline', '42:2026-01-01T00:00:00Z:comment']);
  const crlf = canonicalText(['body\r\nline', '42:2026-01-01T00:00:00Z:comment']);
  assert.equal(lf, crlf, 'CRLF input must hash identically to LF input');
  assert.equal(lf.endsWith('\n'), false, 'no trailing separator');
  assert.equal(
    crypto.createHash('sha256').update(Buffer.from(lf, 'utf8')).digest('hex'),
    crypto.createHash('sha256').update(Buffer.from(crlf, 'utf8')).digest('hex'),
  );
});

// CL-D28 removed publication from this MVP. Prose obligations live in the clause
// manifest, but "no phrasing anywhere still offers publication in exchange for
// permission" is a negative assertion the manifest cannot express, and an earlier
// removal pass missed three of these four files.
const ENTRY_ARTIFACTS = [
  'skills/closed-loop-issue/SKILL.md',
  'skills/closed-loop-pr/SKILL.md',
  'prompts/tidd-issue.md',
  'prompts/tidd-pr.md',
];

// Superseded rules must not survive beside their replacements. Three times a
// contradiction reached review because the clause literal was satisfied by the
// stale half of the document: the mode grammar stated twice, publication offered
// after its removal, and external resume restored after it was withdrawn. A
// clause proves a rule is present; nothing proves an obsolete rule is gone
// unless it is named. Retired phrasings go here.
const PR_SKILL = 'skills/closed-loop-pr/SKILL.md';

const SUPERSEDED = [
  { files: ENTRY_ARTIFACTS, pattern: /after explicit approval/i,
    reason: 'CL-D28 removed publication, so no approval unlocks it' },
  { files: ENTRY_ARTIFACTS, pattern: /without explicit approval/i,
    reason: 'CL-D28 removed publication, so no approval unlocks it' },
  { files: ENTRY_ARTIFACTS, pattern: /when publication is (granted|authorized)/i,
    reason: 'CL-D28 removed publication, so no grant unlocks it' },
  { files: ENTRY_ARTIFACTS, pattern: /require the separate run-scoped publication grant/i,
    reason: 'CL-D28 removed publication, so no grant unlocks it' },
  { files: [PR_SKILL], pattern: /observation origin is part of resumable state/i,
    reason: 'external evidence is no longer carried across runs' },
  { files: [PR_SKILL], pattern: /a resume against the same head restores/i,
    reason: 'external evidence is no longer carried across runs' },
  { files: ENTRY_ARTIFACTS, pattern: /whose only inputs are repository files/i,
    reason: 'the RED classes are separated by what a test does, not by where its inputs come from' },
];

test('no entry artifact states the CL-D28 publication boundary weakly', () => {
  for (const file of ENTRY_ARTIFACTS) {
    assert.match(readText(file), /does not publish/, `${file} does not state the CL-D28 boundary`);
  }
});

test('no superseded rule survives beside its replacement', () => {
  for (const { files, pattern, reason } of SUPERSEDED) {
    for (const file of files) {
      assert.doesNotMatch(readText(file), pattern, `${file} still carries a retired rule: ${reason}`);
    }
  }
});
