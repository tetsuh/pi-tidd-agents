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

function candidateRecord(type, path, bytes) {
  const pathBytes = Buffer.from(path, 'utf8');
  const raw = Buffer.from(bytes);
  return Buffer.concat([
    Buffer.from(`${type}\t${pathBytes.length}\t${raw.length}\t${path}\t`, 'utf8'),
    raw,
  ]);
}

function candidateStream(records) {
  return Buffer.concat(records.flatMap((record, index) => (index === 0 ? [record] : [Buffer.from('\n'), record])));
}

test('fixture: candidate_diff framing produces a stable reference digest', () => {
  const records = [
    ['committed-base-head', '', Buffer.from('base patch\n', 'utf8')],
    ['staged', '', Buffer.from('staged patch\r\n', 'utf8')],
    ['unstaged', '', Buffer.from([0x75, 0x6e, 0x73, 0x74, 0x61, 0x67, 0x65, 0x64])],
    ...[
      ['z.txt', Buffer.from([0x00, 0xff, 0x0a])],
      ['a.txt', Buffer.from('a\r\nb', 'utf8')],
    ]
      .sort((a, b) => Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')))
      .map(([path, bytes]) => ['untracked', path, bytes]),
  ].map(([type, path, bytes]) => candidateRecord(type, path, bytes));

  const stream = candidateStream(records);

  // Reference vector. An implementation of the CL-D23 framing that produces a
  // different digest for this input has diverged from the specification.
  assert.equal(
    crypto.createHash('sha256').update(stream).digest('hex'),
    '5ef65fe9f1e225cf4d12fdec4efc6e10fe3b9585f41134c6cb57081dc9470d40',
  );

  // Binary bytes in an untracked record are never newline-normalized.
  assert.equal(records[3].toString('utf8', 0, 20), 'untracked\t5\t4\ta.txt\t');
  assert.deepEqual(
    records.slice(3).map((record) => record.toString('utf8').split('\t')[3]),
    ['a.txt', 'z.txt'],
    'untracked records sort by UTF-8 path bytes',
  );

  // Every record must contribute to the digest.
  for (let index = 0; index < records.length; index += 1) {
    const changed = records.slice();
    changed[index] = candidateRecord(
      `changed-${index}`,
      index >= 3 ? (index === 3 ? 'a.txt' : 'z.txt') : '',
      records[index].subarray(records[index].lastIndexOf(0x09) + 1),
    );
    assert.notEqual(
      crypto.createHash('sha256').update(candidateStream(changed)).digest('hex'),
      crypto.createHash('sha256').update(stream).digest('hex'),
      `record ${index} must affect candidate_diff`,
    );
  }
});
