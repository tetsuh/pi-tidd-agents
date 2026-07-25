'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readText } = require('./helpers');

function expandPrompt(file, args) {
  // Pi's documented `$@` substitution joins all arguments; no fallback syntax is used.
  return readText(file).replaceAll('$@', args.join(' '));
}

function parseReferenceArgs(args, kind) {
  if (args.length === 0) return { usage: true };
  const mode = kind === 'pr' && args.at(-1) === 'autofix' ? 'autofix' : 'review-only';
  const targetArgs = mode === 'autofix' ? args.slice(0, -1) : args;
  if (kind === 'pr' && args.at(-1) !== 'autofix' && args.length > 2) return { usage: true };
  if (targetArgs.length === 2 && /^(Issue|PR)$/.test(targetArgs[0]) && /^#\d+$/.test(targetArgs[1])) {
    return { target: targetArgs.join(' '), mode };
  }
  if (targetArgs.length === 1 && /^(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pulls?)\/\d+|#?\d+|PR\d+)$/.test(targetArgs[0])) {
    return { target: targetArgs[0], mode };
  }
  return { usage: true };
}

const TARGETS = [
  'https://github.com/acme/widgets/pulls/123',
  '#123',
  '123',
  'Issue #123',
  'PR #123',
  'PR123',
];

test('prompt expansion uses supported $@ and preserves every accepted complete target reference', () => {
  for (const file of ['prompts/tidd-issue.md', 'prompts/tidd-pr.md']) {
    assert.doesNotMatch(readText(file), /\$\{@:-MISSING\}/);
    assert.match(readText(file), /Raw arguments.*\$@/);
  }
  for (const target of TARGETS) {
    const args = target.split(' ');
    const file = target.startsWith('Issue') ? 'prompts/tidd-issue.md' : 'prompts/tidd-pr.md';
    assert.match(expandPrompt(file, args), new RegExp(`Raw arguments.*${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(parseReferenceArgs(args, file.includes('issue') ? 'issue' : 'pr').target, target);
  }
});

test('prompt expansion keeps exact autofix and review-only boundaries', () => {
  assert.equal(parseReferenceArgs(['PR', '#123'], 'pr').mode, 'review-only');
  assert.equal(parseReferenceArgs(['PR', '#123', 'autofix'], 'pr').mode, 'autofix');
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'Autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', '--autofix'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs(['PR', '#123', 'autofix', 'extra'], 'pr'), { usage: true });
  assert.deepEqual(parseReferenceArgs([], 'pr'), { usage: true });
});

test('skills state the raw-vector two-token parser and foreign gh API path', () => {
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  const pr = readText('skills/closed-loop-pr/SKILL.md');
  assert.match(issue, /complete raw argument vector.*one two-token reference/);
  assert.match(pr, /complete raw argument vector.*one two-token reference/);
  assert.match(pr, /foreign review-only target/);
  assert.match(pr, /no local Git object or checkout is required/);
  assert.match(pr, /Autofix and every publication action refuse such a target/);
});

function canonicalText(records) {
  return records.map((record) => String(record).replaceAll('\r\n', '\n').replaceAll('\r', '\n')).join('\n');
}

test('fingerprint text serialization is LF-normalized, ordered, and delimiter-stable', () => {
  const lf = canonicalText(['body\nline', '42:2026-01-01T00:00:00Z:comment']);
  const crlf = canonicalText(['body\r\nline', '42:2026-01-01T00:00:00Z:comment']);
  assert.equal(lf, crlf);
  assert.equal(lf.endsWith('\n'), false);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(lf, 'utf8')).digest('hex'), crypto.createHash('sha256').update(Buffer.from(crlf, 'utf8')).digest('hex'));
  const pr = readText('skills/closed-loop-pr/SKILL.md');
  const issue = readText('skills/closed-loop-issue/SKILL.md');
  assert.match(pr, /canonical UTF-8 bytes/);
  assert.match(issue, /canonical UTF-8 bytes/);
  assert.match(pr, /omit a trailing separator/);
  assert.match(issue, /no trailing separator/);
});

test('foreign PR fingerprint fixtures use valid explicit gh API endpoints', () => {
  const fixture = {
    repository: 'acme/widgets',
    pull: 'repos/acme/widgets/pulls/123',
    base: 'base-sha',
    head: 'head-sha',
    tree: 'tree-sha',
    diff: 'diff bytes from application/vnd.github.v3.diff',
    commits: ['first\nbody', 'second\nbody'],
  };
  assert.equal(fixture.repository.includes('/'), true);
  assert.equal(fixture.pull, 'repos/acme/widgets/pulls/123');
  assert.equal(fixture.diff.includes('diff bytes'), true);
  assert.deepEqual(fixture.commits, ['first\nbody', 'second\nbody']);
  for (const file of [
    'skills/closed-loop-issue/SKILL.md',
    'skills/closed-loop-pr/SKILL.md',
    'prompts/tidd-issue.md',
    'prompts/tidd-pr.md',
  ]) {
    assert.doesNotMatch(readText(file), /gh api --repo/);
  }
  const skill = readText('skills/closed-loop-pr/SKILL.md');
  for (const token of [
    'gh api repos/<owner>/<repo>/pulls/<n>',
    'gh api -H \'Accept: application/vnd.github.v3.diff\' repos/<owner>/<repo>/pulls/<n>',
    'gh api --paginate repos/<owner>/<repo>/pulls/<n>/commits',
    'gh api repos/<owner>/<repo>/git/commits/<sha> --jq .tree.sha',
    'same raw effective diff bytes',
    'no checkout',
  ]) assert.match(skill, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('README records the validated pi-subagents minimum', () => {
  assert.match(readText('README.md'), /0\.36\.0 or newer/);
  assert.match(readText('README.md'), /0\.36\.0; do not assume support for older versions/);
});

test('PR workflow snapshots current-head external evidence before Sol without polling', () => {
  const skill = readText('skills/closed-loop-pr/SKILL.md');
  assert.match(skill, /one initial external-review snapshot.*current `pr_head`/);
  assert.match(skill, /before the first Sol invocation/);
  assert.match(skill, /observation origin/);
  assert.match(skill, /must not busy-poll/);
});

test('issue status block explicitly marks publication as not applicable', () => {
  assert.match(readText('skills/closed-loop-issue/SKILL.md'), /publication_grant: not-applicable/);
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
  return Buffer.concat(records.flatMap((record, index) => index === 0 ? [record] : [Buffer.from('\n'), record]));
}

test('candidate evidence hashes the exact fully framed worker overlay', () => {
  const skill = readText('skills/closed-loop-pr/SKILL.md');
  assert.match(skill, /exact uncommitted working-tree overlay/);
  assert.match(skill, /three fixed patch records in this order/);
  assert.doesNotMatch(skill, /Emit four records/);
  assert.match(skill, /`staged`/);
  assert.match(skill, /`unstaged`/);
  assert.match(skill, /one `untracked` record per non-ignored path/);
  assert.match(skill, /candidate_diff/);
  assert.match(skill, /<type>\\t<pathByteLength>\\t<byteLength>\\t<path>\\t<rawBytes>/);
  assert.match(skill, /records are separated by one LF byte/);
  assert.match(skill, /git ls-files --others --exclude-standard -z/);
  assert.match(skill, /every post-fix review payload/);
  assert.match(skill, /Do not commit, push, or otherwise mutate git state merely to calculate candidate evidence/);

  const records = [
    ['committed-base-head', '', Buffer.from('base patch\n', 'utf8')],
    ['staged', '', Buffer.from('staged patch\r\n', 'utf8')],
    ['unstaged', '', Buffer.from([0x75, 0x6e, 0x73, 0x74, 0x61, 0x67, 0x65, 0x64])],
    ...[
      ['z.txt', Buffer.from([0x00, 0xff, 0x0a])],
      ['a.txt', Buffer.from('a\r\nb', 'utf8')],
    ].sort((a, b) => Buffer.compare(Buffer.from(a[0], 'utf8'), Buffer.from(b[0], 'utf8')))
      .map(([path, bytes]) => ['untracked', path, bytes]),
  ].map(([type, path, bytes]) => candidateRecord(type, path, bytes));
  const stream = candidateStream(records);
  const digest = crypto.createHash('sha256').update(stream).digest('hex');
  assert.equal(digest, '5ef65fe9f1e225cf4d12fdec4efc6e10fe3b9585f41134c6cb57081dc9470d40');
  assert.ok(stream.subarray(0, records[0].length).equals(records[0]));
  assert.equal(records[3].toString('utf8', 0, 20), 'untracked\t5\t4\ta.txt\t');
  assert.deepEqual(records.slice(3).map((record) => record.toString('utf8').split('\t')[3]), ['a.txt', 'z.txt']);

  for (let index = 0; index < records.length; index += 1) {
    const changed = records.slice();
    changed[index] = candidateRecord(`changed-${index}`, index >= 3 ? (index === 3 ? 'a.txt' : 'z.txt') : '', records[index].subarray(records[index].lastIndexOf(0x09) + 1));
    assert.notEqual(crypto.createHash('sha256').update(candidateStream(changed)).digest('hex'), digest, `record ${index} must affect candidate_diff`);
  }
});
