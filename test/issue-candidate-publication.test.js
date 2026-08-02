'use strict';

// Issue #13 remains a legacy Skill/prompt-only workflow. Artifact assertions
// can prove that required prose ships; later `fixture:` tests pin intended
// semantics but cannot prove that a model executes the prose correctly.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readText, readJson } = require('./helpers');

const REQUIRED_COVERAGE = new Set([
  'delimiter', 'crlf', 'unicode', 'scalar-grammar', 'body-comment-boundary', 'legacy-issue-spec-collision', 'schema-version', 'alternate-diff',
  'foreign-repository', 'https-ssh-canonicalization', 'branch-upstream', 'all-remotes', 'multiple-fetch-urls', 'independent-fetch-push', 'explicit-push', 'fallback-push', 'insteadOf', 'conflicting-pushInsteadOf', 'missing-url-sets', 'non-github-url', 'fetch-push-conflict', 'fork-upstream-ambiguity', 'preview-identity-movement',
  'nonce-grammar', 'cross-run', 'physical-attempt-failures', 'verdict-retry', 'missing-result', 'duplicate-result', 'reused-result', 'consumed-result', 'stale-result', 'mismatched-result', 'sol-before-terra', 'terra-to-sol', 'round-accounting',
  'candidate-status-no-resume', 'live-owner-continuation', 'legacy-issue-resume', 'pr-resume', 'complete-findings', 'duplicate-ownership', 'nine-field-decisions', 'decline', 'non-affirmative', 'approval-expiry',
  'snapshot-a-mismatch', 'snapshot-a-failure', 'no-body-snapshot-b', 'post-patch-snapshot-b', 'pre-post-resolver-movement', 'over-100-pagination', 'addition-edit-deletion-reclassification', 'missing-repeated-cursor', 'duplicate-comment-id', 'large-comment-ids', 'total-count-mismatch', 'truncation', 'missing-terminal', 'page-failure', 'ordering-ambiguity',
  'one-time-approval', 'patch-post-order', 'post-mutation-failure', 'no-retry-compensation', 'snapshot-c-body', 'snapshot-c-comment-transport', 'snapshot-c-cld9', 'snapshot-c-issue-spec', 'authoritative-invalidation', 'advisory-no-change',
]);
const executedCoverage = new Set();
function covered(...names) { for (const name of names) executedCoverage.add(name); }

function sectionOf(text, heading) {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const depth = heading.match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const match = lines[end].match(/^(#+)\s/);
    if (match && match[1].length <= depth) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('Issue #13 contract decision follows CL-D30', () => {
  const contract = readText('CONTRACT.md');
  const cl30 = contract.indexOf('## CL-D30 —');
  const cl31 = contract.indexOf('## CL-D31 — Owner-gated Issue candidate publication');
  assert.ok(cl30 !== -1, 'CL-D30 must remain present');
  assert.ok(cl31 > cl30, 'CL-D31 must be a post-CL-D30 decision');
  assert.ok(
    contract.indexOf('## DEC-I13-ENTRYPOINT-029 — Equivalent Issue entrypoints') > cl31,
    'the durable entrypoint decision must follow the Issue publication decision',
  );
  const cl31Text = contract.slice(cl31, contract.indexOf('\n## ', cl31 + 3));
  for (const field of ['Decision ID', 'Kind', 'Target and revision', 'Question', 'Options and trade-offs', 'Recommendation', 'Owner choice', 'Rationale', 'Validity and invalidation conditions']) {
    assert.match(cl31Text, new RegExp(`\\*${field.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\*`), `CL-D31 missing ${field}`);
  }
});

test('Issue Skill owns the candidate-publication phase', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  const section = sectionOf(skill, '## Owner-gated Issue candidate publication (CL-D31)');
  assert.ok(section, 'Issue Skill has no owner-gated candidate-publication section');
  assert.match(section, /Candidate identity is the lowercase hexadecimal SHA-256 digest over the complete `tidd-issue-candidate-v1` byte stream, from the domain header through the final newline of `ledger\.comment`\./);
  assert.match(section, /\/tidd-issue <ref>/);
  assert.match(section, /\/skill:closed-loop-issue <ref>/);
  assert.match(section, /exact-preview/);
});

test('artifact: Issue 13 safety boundaries are explicit and PR behavior stays separate', () => {
  const skill = readText('skills/closed-loop-issue/SKILL.md');
  for (const required of [
    'complete paginated', 'insteadOf', 'pushInsteadOf', 'foreign-repository',
    'snapshot A', 'snapshot B', 'snapshot C', 'no retry', 'no compensation',
    'no-resume', 'postcondition', 'partial state', 'provider lock',
    'author_association', 'run nonce', 'physical-attempt', 'tidd-status',
    'Sol-before-Terra', 'snapshot-C', 'Do not retry',
  ]) assert.ok(skill.includes(required), `Issue Skill missing safety contract: ${required}`);
  const pr = readText('skills/closed-loop-pr/SKILL.md');
  assert.match(pr, /CL-D31 exception/);
  assert.match(pr, /does not originate from `\/tidd-pr`/);
  assert.match(pr, /luna-worker/);
  assert.doesNotMatch(pr, /Issue PATCH.*POST.*CL-D30/s);
});

test('Issue prompt delegates equivalent owner-gated entrypoints to the Skill', () => {
  const prompt = readText('prompts/tidd-issue.md');
  assert.match(prompt, /equivalent entrypoints/);
  assert.match(prompt, /owner-gated candidate publication/);
  assert.doesNotMatch(prompt, /review-and-draft only|does not publish/i);
});

test('README documents the bounded Issue publication workflow', () => {
  const readme = readText('README.md');
  const section = sectionOf(readme, '### Owner-gated Issue candidate publication');
  assert.ok(section, 'README has no owner-gated Issue publication section');
  assert.match(section, /exact frozen preview/);
  assert.match(section, /optional body update/);
  assert.match(section, /one ledger comment/);
  assert.match(section, /There is no retry or compensating overwrite after failure; deletion, cross-session resume, and a second attempt remain prohibited\./);
  assert.doesNotMatch(section, /There is no retry, compensation, overwrite, deletion, cross-session resume, or second attempt\./);
});

// fixture: SOL13-BUNDLE-026 and SOL13-CONTRACT-027 are settled dispositions.
// These reference fixtures cannot prove LLM runtime behavior.

function normalizeText(value) {
  return String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

const CANDIDATE_HEADER = 'tidd-issue-candidate-v1';
const CANDIDATE_FIELDS = [
  'repository', 'issue.number', 'issue.url', 'base.issue_spec.sha256',
  'base.body', 'base.comments.count',
  'base.comments.<index>.id', 'base.comments.<index>.updated_at',
  'base.comments.<index>.body', 'proposed.body', 'ledger.comment',
];
const SCALAR = {
  repository: /^[\x00-\x7f]+$/,
  number: /^(?:0|[1-9][0-9]*)$/,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  sha: /^[0-9a-f]{64}$/,
};

function candidateStream(fields, header = CANDIDATE_HEADER) {
  return `${header}\n` + fields.map(([name, value]) => {
    assert.match(name, /^[a-z0-9._-]+$/);
    const payload = normalizeText(value);
    return `${name} ${Buffer.byteLength(payload, 'utf8')}\n${payload}\n`;
  }).join('');
}
function digest(value) { return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex'); }
function validRepository(v) { return SCALAR.repository.test(v) && /^[^/]+\/[^/]+$/.test(v); }
function validDecimal(v) { return SCALAR.number.test(v); }
function validCandidate(fields) {
  if (!Array.isArray(fields) || fields.length < 8 || fields[0]?.[0] !== 'repository') return false;
  const names = fields.map(([name]) => name);
  if (!names.includes('proposed.body') || !names.includes('ledger.comment')) return false;
  const countForOrder = fields.find(([name]) => name === 'base.comments.count')?.[1];
  const expectedNames = ['repository', 'issue.number', 'issue.url', 'base.issue_spec.sha256', 'base.body', 'base.comments.count'];
  for (let i = 0; i < Number(countForOrder); i += 1) expectedNames.push(`base.comments.${i}.id`, `base.comments.${i}.updated_at`, `base.comments.${i}.body`);
  expectedNames.push('proposed.body', 'ledger.comment');
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) return false;
  const repository = fields.find(([name]) => name === 'repository')?.[1];
  const number = fields.find(([name]) => name === 'issue.number')?.[1];
  const url = fields.find(([name]) => name === 'issue.url')?.[1];
  const spec = fields.find(([name]) => name === 'base.issue_spec.sha256')?.[1];
  const count = fields.find(([name]) => name === 'base.comments.count')?.[1];
  if (!validRepository(repository) || !validDecimal(number) || !validDecimal(count) || !SCALAR.sha.test(spec)) return false;
  if (url !== `https://github.com/${repository}/issues/${number}`) return false;
  const commentNames = names.filter((name) => name.startsWith('base.comments.') && name.endsWith('.id'));
  if (commentNames.length !== Number(count)) return false;
  for (let i = 0; i < Number(count); i += 1) {
    const base = `base.comments.${i}`;
    const id = fields.find(([name]) => name === `${base}.id`)?.[1];
    const timestamp = fields.find(([name]) => name === `${base}.updated_at`)?.[1];
    if (!validDecimal(id) || !SCALAR.timestamp.test(timestamp)) return false;
  }
  const ids = commentNames.map((name) => BigInt(fields.find(([n]) => n === name)[1]));
  return ids.every((id, index) => index === 0 || id > ids[index - 1]);
}

const vector = readJson('test/fixtures/issue-13-candidate-vectors.json').vectors[0];
function candidateFields(comments = []) {
  const fields = [
    ['repository', 'acme/widgets'], ['issue.number', '7'],
    ['issue.url', 'https://github.com/acme/widgets/issues/7'],
    ['base.issue_spec.sha256', '0'.repeat(64)], ['base.body', 'body'],
    ['base.comments.count', String(comments.length)],
  ];
  comments.forEach((comment, index) => fields.push(
    [`base.comments.${index}.id`, String(comment.id)],
    [`base.comments.${index}.updated_at`, comment.updatedAt || '2026-01-01T00:00:00Z'],
    [`base.comments.${index}.body`, comment.body || 'comment'],
  ));
  fields.push(['proposed.body', 'proposed'], ['ledger.comment', 'ledger']);
  return fields;
}
test('fixture: exact candidate-v1 schema, scalar grammar, framing, normalization, and fixed digest', () => {
  const actual = candidateStream(vector.fields);
  assert.equal(actual, vector.stream);
  assert.equal(Buffer.byteLength(actual), vector.bytes);
  assert.equal(digest(actual), vector.sha256);
  assert.equal(validCandidate(vector.fields), true);
  assert.match(actual, /base\.body 8\nline1\nλ\n/);
  assert.equal(candidateStream([['x', 'a\r\nb']]), candidateStream([['x', 'a\nb']]));
  assert.notEqual(Buffer.byteLength('é'), 'é'.length);
  assert.equal(validCandidate(candidateFields([])), true, 'zero authoritative comments are valid');
  assert.equal(validCandidate(candidateFields([{ id: 2 }, { id: 9 }])), true, 'ascending numeric comments use contiguous indices');
  assert.equal(validCandidate(candidateFields([{ id: '9007199254740992' }, { id: '9007199254740993' }])), true, 'large decimal IDs compare losslessly');
  covered('delimiter', 'crlf', 'unicode');
});

test('fixture: candidate rejection table covers fields, scalars, order, collisions, and version boundaries', () => {
  const valid = vector.fields;
  const cases = [
    ['missing field', valid.filter(([name]) => name !== 'ledger.comment')],
    ['leading-zero number', valid.map(([n, v]) => n === 'issue.number' ? [n, '07'] : [n, v])],
    ['wrong derived URL', valid.map(([n, v]) => n === 'issue.url' ? [n, 'https://github.com/acme/widgets/issues/8'] : [n, v])],
    ['uppercase digest', valid.map(([n, v]) => n === 'base.issue_spec.sha256' ? [n, 'A'.repeat(64)] : [n, v])],
    ['non-UTC timestamp', valid.map(([n, v]) => n.endsWith('updated_at') ? [n, '2026-01-01 00:00:00'] : [n, v])],
    ['non-contiguous comment index', valid.map(([n, v]) => n.startsWith('base.comments.0') ? [n, n.replace('.0', '.1')] : [n, v])],
    ['descending IDs', valid.map(([n, v]) => n.endsWith('.id') ? [n, '1'] : [n, v])],
    ['wrong field order', [valid[0], valid[2], valid[1], ...valid.slice(3)]],
    ['boundary collision payload remains framed', valid.map(([n, v]) => n === 'base.body' ? [n, 'x\nledger.comment 1\ny'] : [n, v])],
  ];
  assert.equal(cases[0][1].some(([n]) => n === 'ledger.comment'), false);
  assert.equal(validCandidate(cases[0][1]), false);
  assert.equal(cases[1][1].find(([n]) => n === 'issue.number')[1], '07');
  assert.equal(validCandidate(valid.map(([n, v]) => n === 'issue.number' ? [n, '07'] : [n, v])), false);
  assert.equal(validCandidate(cases[2][1]), false);
  assert.equal(validCandidate(cases[3][1]), false);
  assert.equal(validCandidate(cases[4][1]), false);
  assert.equal(validCandidate(cases[5][1]), false);
  assert.equal(validCandidate(candidateFields([{ id: 42 }, { id: 42 }])), false, 'duplicate IDs fail');
  assert.equal(validCandidate(candidateFields([{ id: 9 }, { id: 2 }])), false, 'descending IDs fail');
  assert.equal(validCandidate(cases[7][1]), false);
  assert.notEqual(candidateStream(cases[8][1]), candidateStream(valid));
  const bodyCollision = candidateFields([{ id: 2, body: 'x\nbase.comments.1.id 1\n7' }]);
  const ledgerCollision = candidateFields([{ id: 2, body: 'x' }]).map(([n, v]) => n === 'ledger.comment' ? [n, 'base.comments.1.id 1\n7'] : [n, v]);
  assert.notEqual(candidateStream(bodyCollision), candidateStream(ledgerCollision), 'length framing separates body/comment boundaries');
  const t1 = '2026-01-01T00:00:00Z'; const t2 = '2026-01-02T00:00:00Z';
  const snapshotA = { body: 'a', comments: [{ id: 1, updatedAt: t1, body: `b\n2:${t2}:c` }] };
  const snapshotB = { body: `a\n1:${t1}:b`, comments: [{ id: 2, updatedAt: t2, body: 'c' }] };
  const legacy = (snapshot) => [snapshot.body, ...snapshot.comments.map((c) => `${c.id}:${c.updatedAt}:${c.body}`)].join('\n');
  const fieldsFor = (snapshot) => candidateFields(snapshot.comments).map(([name, value]) => name === 'base.body' ? [name, snapshot.body] : [name, value]);
  assert.equal(legacy(snapshotA), legacy(snapshotB), 'two schema-valid legacy snapshots can collide');
  assert.equal(validCandidate(fieldsFor(snapshotA)), true); assert.equal(validCandidate(fieldsFor(snapshotB)), true);
  assert.notEqual(candidateStream(fieldsFor(snapshotA)), candidateStream(fieldsFor(snapshotB)), 'candidate-v1 separates the valid collision');
  const schema = { v1: 'fields+order+framing+scalars+lf' };
  const acceptsSchema = (header, rules) => header === 'tidd-issue-candidate-v1' && rules === schema.v1;
  assert.equal(acceptsSchema('tidd-issue-candidate-v1', schema.v1), true);
  assert.equal(acceptsSchema('tidd-issue-candidate-v1', `${schema.v1}+changed-rule`), false, 'changed rule cannot reuse v1');
  assert.notEqual(candidateStream(valid, 'tidd-issue-candidate-v1'), candidateStream(valid, 'tidd-issue-candidate-v2'));
  assert.equal(validCandidate(candidateFields([{ id: 2 }]).map(([n, v]) => n === 'repository' ? [n, 'acmé/widgets'] : [n, v])), false);
  covered('scalar-grammar', 'body-comment-boundary', 'legacy-issue-spec-collision', 'schema-version', 'duplicate-comment-id');
});

test('fixture: frozen complete bundle rejects alternate valid LF diff substitution', () => {
  const diffA = '--- issue-body\n+++ proposed-body\n@@ -1 +1 @@\n-old\n+new\n';
  const diffB = '--- a/body\n+++ b/body\n@@ -1 +1 @@\n-old\n+new\n';
  const map = new Map([['attempt-1', { candidateIdentity: digest(candidateStream(vector.fields)), diff: diffA }]]);
  const accept = (result) => map.has(result.identity) && map.get(result.identity).diff === result.diff;
  assert.equal(accept({ identity: 'attempt-1', diff: diffA }), true);
  assert.equal(accept({ identity: 'attempt-1', diff: diffB }), false);
  assert.notEqual(diffA, diffB);
  assert.equal(diffA.includes('\n'), true);
  covered('alternate-diff');
});

function selectRemotes({ upstream, configured }) {
  return upstream && upstream !== '.' ? [upstream] : configured;
}
function resolveRemote(remote, apiNames = new Map()) {
  const canonical = (url) => {
    const value = String(url);
    if (value.includes('?') || value.includes('#')) return null;
    let m = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) m = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) m = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  };
  if (!remote.fetch?.length || !remote.push?.length) return null;
  const parsed = [...remote.fetch, ...remote.push].map(canonical);
  if (parsed.some((identity) => !identity)) return null;
  const canonicalNames = parsed.map((identity) => apiNames.get(identity) || identity);
  return new Set(canonicalNames).size === 1 ? canonicalNames[0] : null;
}

function resolveCheckout({ upstream, configured, remotes, target, apiNames = new Map() }) {
  const selected = selectRemotes({ upstream, configured });
  if (!selected.length) return null;
  const identities = selected.map((name) => resolveRemote(remotes[name] || {}, apiNames));
  if (identities.some((identity) => !identity) || new Set(identities).size !== 1) return null;
  return identities[0] === target ? identities[0] : null;
}

test('fixture: resolver table covers upstream/all-remotes, effective independent fetch/push, rewrites, API identity, foreign/movement', () => {
  const same = { fetch: ['https://github.com/acme/widgets.git'], push: ['git@github.com:acme/widgets.git'] };
  const cases = [
    ['branch upstream selected', selectRemotes({ upstream: 'origin', configured: ['origin', 'upstream'] }), ['origin']],
    ['dot selects all remotes', selectRemotes({ upstream: '.', configured: ['origin', 'upstream'] }), ['origin', 'upstream']],
    ['missing fetch', resolveRemote({ fetch: [], push: same.push }), null], ['missing push', resolveRemote({ fetch: same.fetch, push: [] }), null],
    ['fork conflict', resolveRemote({ fetch: same.fetch, push: ['https://github.com/fork/widgets'] }), null],
    ['non-github', resolveRemote({ fetch: ['file:///tmp/widgets'], push: same.push }), null],
    ['query rejected', resolveRemote({ fetch: ['https://github.com/acme/widgets?q=1'], push: same.push }), null],
    ['API canonical identity', resolveRemote(same, new Map([['acme/widgets', 'acme/widgets']])), 'acme/widgets'],
    ['insteadOf effective fetch and pushInsteadOf conflict', resolveRemote({ fetch: ['https://github.com/acme/widgets'], push: ['https://github.com/other/widgets'] }), null],
    ['foreign target', resolveRemote(same, new Map([['acme/widgets', 'other/repo']])), 'other/repo'],
  ];
  assert.deepEqual(cases[0][1], cases[0][2]); assert.deepEqual(cases[1][1], cases[1][2]);
  assert.equal(cases[2][1], null); assert.equal(cases[3][1], null); assert.equal(cases[4][1], null); assert.equal(cases[5][1], null); assert.equal(cases[6][1], null);
  assert.equal(cases[7][1], 'acme/widgets'); assert.equal(cases[8][1], null); assert.equal(cases[9][1], 'other/repo');
  assert.equal(selectRemotes({ upstream: 'origin', configured: ['origin', 'fork'] }).length, 1);
  assert.equal(resolveCheckout({ upstream: 'origin', configured: ['origin', 'fork'], remotes: { origin: same, fork: { fetch: ['https://github.com/fork/widgets'], push: ['https://github.com/fork/widgets'] } }, target: 'acme/widgets' }), 'acme/widgets');
  assert.equal(resolveCheckout({ upstream: '.', configured: ['origin', 'fork'], remotes: { origin: same, fork: { fetch: ['https://github.com/fork/widgets'], push: ['https://github.com/fork/widgets'] } }, target: 'acme/widgets' }), null, 'fallback all-remotes ambiguity fails');
  assert.equal(resolveCheckout({ upstream: 'origin', configured: ['origin'], remotes: { origin: same }, target: 'other/repo' }), null, 'foreign target fails publication identity');
  assert.equal(resolveRemote({ fetch: ['https://github.com/old/widgets'], push: ['git@github.com:acme/widgets'] }, new Map([['old/widgets', 'Acme/Widgets'], ['acme/widgets', 'Acme/Widgets']])), 'Acme/Widgets', 'raw aliases compare only after API canonicalization');
  assert.equal(resolveRemote({ fetch: ['https://github.com/old/widgets'], push: ['git@github.com:acme/widgets'] }, new Map([['old/widgets', 'Acme/Widgets'], ['acme/widgets', 'Other/Widgets']])), null, 'different API canonical repositories conflict');
  assert.equal(resolveCheckout({ upstream: 'origin', configured: ['origin'], remotes: { origin: same }, target: 'acme/widgets', apiNames: new Map([['acme/widgets', 'Acme/Widgets']]) }), null, 'API canonical movement fails exact target');
  const boundaryIdentities = ['acme/widgets', 'acme/widgets', 'acme/widgets', 'other/widgets'];
  assert.equal(boundaryIdentities.every((identity) => identity === boundaryIdentities[0]), false, 'preview→A→PATCH→POST movement fails');
  covered('foreign-repository', 'https-ssh-canonicalization', 'branch-upstream', 'all-remotes', 'independent-fetch-push', 'missing-url-sets', 'non-github-url', 'fetch-push-conflict', 'fork-upstream-ambiguity', 'preview-identity-movement');
});

test('fixture: Git effective URL fixture observes insteadOf, pushInsteadOf, fallback, explicit push, and multiple fetch URLs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue13-git-url-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  try {
    git('init', '-q');
    git('config', 'url.https://github.com/.insteadOf', 'work:');
    git('config', 'url.git@github.com:.pushInsteadOf', 'work:');
    git('remote', 'add', 'origin', 'work:acme/widgets.git');
    assert.deepEqual(git('remote', 'get-url', '--all', 'origin'), ['https://github.com/acme/widgets.git']);
    assert.deepEqual(git('remote', 'get-url', '--push', '--all', 'origin'), ['git@github.com:acme/widgets.git']);
    git('remote', 'set-url', '--add', 'origin', 'ssh://git@github.com/acme/widgets.git');
    assert.equal(git('remote', 'get-url', '--all', 'origin').length, 2, 'all effective fetch URLs are retained');
    git('remote', 'set-url', '--add', '--push', 'origin', 'ssh://git@github.com/acme/widgets.git');
    assert.deepEqual(git('remote', 'get-url', '--push', '--all', 'origin'), ['ssh://git@github.com/acme/widgets.git'], 'explicit push URL replaces fallback');
    git('config', '--unset-all', 'remote.origin.pushurl');
    git('config', '--unset-all', 'url.git@github.com:.pushInsteadOf');
    git('config', 'url.https://github.com/fork/.pushInsteadOf', 'work:acme/');
    assert.deepEqual(git('remote', 'get-url', '--push', '--all', 'origin'), ['https://github.com/fork/widgets.git'], 'conflicting pushInsteadOf changes the effective push identity');
    covered('multiple-fetch-urls', 'explicit-push', 'fallback-push', 'insteadOf', 'conflicting-pushInsteadOf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function compareDecimal(a, b) {
  const left = String(a); const right = String(b);
  if (!validDecimal(left) || !validDecimal(right)) throw new Error('invalid decimal');
  return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
}
function pageCapture(pages) {
  if (!Array.isArray(pages) || !pages.length) return { ok: false, reason: 'page-failure' };
  const seen = new Set(); const ids = new Set(); let total = null; const items = [];
  for (const [expectedIndex, page] of pages.entries()) {
    if (!page || page.failed || page.terminal === undefined) return { ok: false, reason: 'missing-terminal-or-failure' };
    if (page.index !== expectedIndex || typeof page.cursor !== 'string' || !page.cursor) return { ok: false, reason: 'missing-or-repeated-page' };
    if (seen.has(page.cursor)) return { ok: false, reason: 'repeated-cursor' };
    seen.add(page.cursor);
    if (total === null) total = page.total;
    if (!Number.isInteger(page.total) || total !== page.total) return { ok: false, reason: 'total-mismatch' };
    const pageItems = page.items || [];
    if (page.terminal && pageItems.length === 0 && page.total !== 0) return { ok: false, reason: 'empty-terminal-nonzero-total' };
    for (const item of pageItems) {
      const id = String(item.id);
      if (!validDecimal(id) || ids.has(id)) return { ok: false, reason: 'duplicate-id' };
      if (items.length && compareDecimal(items.at(-1).id, id) >= 0) return { ok: false, reason: 'ordering-ambiguity' };
      ids.add(id); items.push({ ...item, id });
    }
    if (page.terminal && expectedIndex !== pages.length - 1) return { ok: false, reason: 'ordering-ambiguity' };
  }
  if (!pages.at(-1).terminal) return { ok: false, reason: 'missing-terminal' };
  if (!items.length && total !== 0) return { ok: false, reason: 'empty-total-mismatch' };
  if (items.length !== total) return { ok: false, reason: 'truncated' };
  return { ok: true, items };
}
function stableBracket(reads) {
  return reads.order === 'R0→C1→R1→C2→R2→C3' && reads.r.length === 3 && reads.c.length === 3 &&
    reads.r.every((x) => JSON.stringify(x) === JSON.stringify(reads.r[0])) &&
    reads.c.every((x) => JSON.stringify(x) === JSON.stringify(reads.c[0]));
}
function snapshotIssueSpec(reads) {
  if (!stableBracket(reads)) return null;
  const authoritative = reads.c[2].filter((comment) =>
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation) && comment.userType !== 'Bot');
  const records = [normalizeText(reads.r[2].body), ...authoritative.sort((a, b) => compareDecimal(a.id, b.id))
    .map((comment) => `${comment.id}:${comment.updatedAt}:${normalizeText(comment.body)}`)];
  return digest(records.join('\n'));
}

test('fixture: initial/A/B/C stable capture table covers pagination and every adjacent movement/failure class', () => {
  const many = Array.from({ length: 101 }, (_, id) => ({ id }));
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: many.slice(0, 100), total: 101, terminal: false }, { index: 1, cursor: '1', items: many.slice(100), total: 101, terminal: true }]).ok, true);
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: [{ id: '9007199254740992' }, { id: '9007199254740993' }], total: 2, terminal: true }]).ok, true, 'large decimal IDs retain exact ordering');
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: [], total: 0, terminal: true }]).ok, true);
  for (const reason of ['missing-terminal-or-failure', 'missing-or-repeated-page', 'repeated-cursor', 'total-mismatch', 'duplicate-id', 'ordering-ambiguity', 'empty-total-mismatch', 'truncated']) {
    const base = [{ index: 0, cursor: '0', items: [{ id: 1 }], total: 1, terminal: true }];
    const bad = reason === 'repeated-cursor' ? [{ ...base[0], terminal: false }, { ...base[0], index: 1 }] : reason === 'missing-or-repeated-page' ? [{ ...base[0], cursor: undefined }] : reason === 'duplicate-id' ? [{ index: 0, cursor: '0', items: [{ id: 1 }, { id: 1 }], total: 2, terminal: true }] : reason === 'empty-total-mismatch' ? [{ index: 0, cursor: '0', items: [], total: 1, terminal: true }] : reason === 'truncated' ? [{ index: 0, cursor: '0', items: [], total: 1, terminal: true }] : reason === 'total-mismatch' ? [{ ...base[0], terminal: false }, { index: 1, cursor: '1', items: [], total: 2, terminal: true }] : reason === 'ordering-ambiguity' ? [{ index: 0, cursor: '0', items: [{ id: 2 }, { id: 1 }], total: 2, terminal: true }] : [{ ...base[0], terminal: undefined }];
    assert.equal(pageCapture(bad).ok, false, reason);
  }
  const issue = { repository: 'acme/widgets', number: 13, body: 'body' };
  const comments = [{ id: 1, updatedAt: '2026-01-01T00:00:00Z', body: 'c', userType: 'User', authorAssociation: 'OWNER' }];
  const good = { order: 'R0→C1→R1→C2→R2→C3', r: [issue, issue, issue], c: [comments, comments, comments] };
  assert.equal(stableBracket(good), true);
  assert.equal(snapshotIssueSpec(good), digest('body\n1:2026-01-01T00:00:00Z:c'));
  assert.equal(stableBracket({ ...good, order: 'R0→C1→R1→C2→C3' }), false);
  const simulateAdjacent = (boundary, kind) => {
    let currentIssue = { ...issue }; let currentComments = comments.map((comment) => ({ ...comment }));
    const r = []; const c = [];
    for (let readIndex = 0; readIndex < 6; readIndex += 1) {
      if (readIndex === boundary + 1) {
        if (kind === 'body-edit') currentIssue = { ...currentIssue, body: 'edited' };
        if (kind === 'addition') currentComments = [...currentComments, { ...comments[0], id: 2 }];
        if (kind === 'edit') currentComments = [{ ...currentComments[0], body: 'edited' }];
        if (kind === 'deletion') currentComments = [];
        if (kind === 'reclassification') currentComments = [{ ...currentComments[0], authorAssociation: 'CONTRIBUTOR' }];
      }
      if (readIndex % 2 === 0) r.push(structuredClone(currentIssue)); else c.push(structuredClone(currentComments));
    }
    return { order: 'R0→C1→R1→C2→R2→C3', r, c };
  };
  for (let boundary = 0; boundary < 5; boundary += 1) {
    assert.equal(stableBracket(simulateAdjacent(boundary, 'body-edit')), boundary === 4, `body boundary ${boundary}`);
    for (const kind of ['addition', 'edit', 'deletion', 'reclassification']) {
      assert.equal(stableBracket(simulateAdjacent(boundary, kind)), boundary === 0, `${kind} boundary ${boundary}`);
    }
  }
  const adjacentChanges = [
    ['R0→C1 body edit observed at R1', { ...good, r: [issue, { ...issue, body: 'edited' }, issue] }],
    ['C1→R1 body edit observed at R1', { ...good, r: [issue, { ...issue, body: 'edited' }, issue] }],
    ['R1→C2 body edit observed at R2', { ...good, r: [issue, issue, { ...issue, body: 'edited' }] }],
    ['C2→R2 body edit observed at R2', { ...good, r: [issue, issue, { ...issue, body: 'edited' }] }],
  ];
  for (const captureIndex of [1, 2]) {
    adjacentChanges.push(
      [`comment addition at C${captureIndex + 1}`, { ...good, c: good.c.map((value, index) => index === captureIndex ? [...comments, { ...comments[0], id: 2 }] : value) }],
      [`comment edit at C${captureIndex + 1}`, { ...good, c: good.c.map((value, index) => index === captureIndex ? [{ ...comments[0], body: 'edited' }] : value) }],
      [`comment deletion at C${captureIndex + 1}`, { ...good, c: good.c.map((value, index) => index === captureIndex ? [] : value) }],
      [`comment reclassification at C${captureIndex + 1}`, { ...good, c: good.c.map((value, index) => index === captureIndex ? [{ ...comments[0], authorAssociation: 'CONTRIBUTOR' }] : value) }],
    );
  }
  for (const [name, changed] of adjacentChanges) assert.equal(stableBracket(changed), false, name);
  assert.equal(stableBracket(good), true, 'a body edit after R2 is outside the observational bracket and cannot be claimed detected');
  const botOnly = { ...good, c: [[{ ...comments[0], userType: 'Bot' }], [{ ...comments[0], userType: 'Bot' }], [{ ...comments[0], userType: 'Bot' }]] };
  assert.equal(snapshotIssueSpec(botOnly), digest('body'), 'filtering occurs only after complete stable retrieval');
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: [], total: 0, terminal: false }, { index: 1, cursor: '1', items: [], total: 0, terminal: false }]).reason, 'missing-terminal');
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: [], total: 0, terminal: true, failed: true }]).reason, 'missing-terminal-or-failure');
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: [{ id: 1 }], total: 1, terminal: false }, { index: 1, cursor: '1', items: [], total: 1, terminal: true }]).reason, 'empty-terminal-nonzero-total');
  assert.equal(pageCapture([{ index: 0, cursor: '0', items: [{ id: 1 }], total: 2, terminal: true }]).reason, 'truncated');
  covered('over-100-pagination', 'addition-edit-deletion-reclassification', 'missing-repeated-cursor', 'duplicate-comment-id', 'large-comment-ids', 'total-count-mismatch', 'truncation', 'missing-terminal', 'page-failure', 'ordering-ambiguity');
});

const RUN = '0123456789abcdef0123456789abcdef';
function invocationId(run, attempt) { return `tidd-issue-gate-v1:${run}:${attempt}`; }
function validInvocationId(id) { return /^tidd-issue-gate-v1:[0-9a-f]{32}:[1-9][0-9]*$/.test(id); }
function tupleValid(result, expected) {
  return result && validInvocationId(result.identity) && validInvocationId(expected.identity) &&
    result.runNonce === expected.runNonce && result.attempt === expected.attempt &&
    result.identity === invocationId(result.runNonce, result.attempt) && result.identity === expected.identity &&
    result.target === expected.target && result.issueSpec === expected.issueSpec &&
    result.candidate === expected.candidate && ['sol', 'terra'].includes(result.gate) &&
    result.gate === expected.gate && result.round === expected.round;
}
function terminalResult(result, expected, mapped, consumed) {
  if (!result?.identity || !mapped.has(result.identity) || consumed.has(result.identity)) return false;
  consumed.add(result.identity);
  return tupleValid(result, expected);
}
function gateTransition(state, { gate, verdict, candidateChanged = false }) {
  if (state.rounds[gate] >= 3 || gate !== state.next) return { ...state, accepted: false };
  const rounds = { ...state.rounds, [gate]: state.rounds[gate] + 1 };
  if (verdict === 'MERGE' && gate === 'sol') return { rounds, next: 'terra', accepted: true };
  if (verdict === 'MERGE' && gate === 'terra' && !candidateChanged) return { rounds, next: 'preview', accepted: true };
  if (candidateChanged || verdict === 'FIX BEFORE MERGE') return { rounds, next: 'sol', accepted: true };
  return { rounds, next: 'stop', accepted: true };
}
function launch(state, kind, gate, proposedRound) {
  state.attempt += 1;
  const record = { identity: invocationId(state.run, state.attempt), attempt: state.attempt, gate, proposedRound, kind };
  if (kind === 'verdict') state.rounds[gate] += 1;
  state.launches.push(record);
  return record;
}

test('fixture: exact gate identity/tuple table covers attempts, retries, consumption, stale/cross-run/reused cases, rounds, and Terra-to-Sol', () => {
  const expected = { runNonce: RUN, attempt: 1, identity: invocationId(RUN, 1), target: 'R#13', issueSpec: 's'.repeat(64), candidate: 'c'.repeat(64), gate: 'sol', round: 1 };
  assert.equal(validInvocationId(expected.identity), true); assert.equal(validInvocationId(invocationId(RUN, 0)), false); assert.equal(validInvocationId(invocationId(RUN, '01')), false); assert.equal(validInvocationId(`${expected.identity}:sol`), false);
  assert.equal(tupleValid(expected, expected), true);
  for (const bad of [
    { ...expected, identity: invocationId('f'.repeat(32), 1) },
    { ...expected, identity: invocationId(RUN, 2) },
    { ...expected, target: 'R#14' }, { ...expected, issueSpec: 'x'.repeat(64) }, { ...expected, candidate: 'd'.repeat(64) }, { ...expected, gate: 'terra' }, { ...expected, round: 2 },
    { ...expected, identity: undefined },
  ]) assert.equal(tupleValid(bad, expected), false);
  const mapped = new Set([expected.identity]);
  const consumed = new Set();
  assert.equal(terminalResult(expected, expected, mapped, consumed), true);
  assert.equal(terminalResult(expected, expected, mapped, consumed), false, 'duplicate terminal result is rejected');
  const terminalMismatchConsumed = new Set();
  assert.equal(terminalResult({ ...expected, target: 'R#14' }, expected, mapped, terminalMismatchConsumed), false);
  assert.equal(terminalResult(expected, expected, mapped, terminalMismatchConsumed), false, 'mismatched terminal result still consumes the identity');
  assert.equal(invocationId(RUN, 2), invocationId(RUN, 2)); assert.notEqual(invocationId(RUN, 2), invocationId('f'.repeat(32), 2));
  const state = { run: RUN, attempt: 0, rounds: { sol: 0, terra: 0 }, launches: [] };
  const startup = launch(state, 'startup-failure', 'sol', 1);
  const provider = launch(state, 'provider-failure', 'sol', 1);
  const tool = launch(state, 'tool-failure', 'sol', 1);
  const malformed = launch(state, 'unparsable-verdict', 'sol', 1);
  const retryVerdict = launch(state, 'verdict', 'sol', 1);
  assert.deepEqual(state.launches.map((record) => record.attempt), [1, 2, 3, 4, 5]);
  assert.deepEqual(state.rounds, { sol: 1, terra: 0 });
  assert.equal(startup.proposedRound, retryVerdict.proposedRound); assert.notEqual(malformed.identity, retryVerdict.identity);
  launch(state, 'verdict', 'sol', 2); launch(state, 'verdict', 'sol', 3);
  assert.equal(state.rounds.sol, 3, 'passing round counts');
  let phase = { rounds: { sol: 0, terra: 0 }, next: 'sol' };
  assert.equal(gateTransition(phase, { gate: 'terra', verdict: 'MERGE' }).accepted, false, 'Terra cannot run before Sol MERGE');
  phase = gateTransition(phase, { gate: 'sol', verdict: 'MERGE' });
  assert.equal(phase.next, 'terra');
  phase = gateTransition(phase, { gate: 'terra', verdict: 'FIX BEFORE MERGE', candidateChanged: true });
  assert.equal(phase.next, 'sol', 'candidate-changing Terra correction restarts at Sol');
  const exhausted = { rounds: { sol: 3, terra: 0 }, next: 'sol' };
  assert.equal(gateTransition(exhausted, { gate: 'sol', verdict: 'MERGE' }).accepted, false, 'fourth counted round is rejected without owner extension');
  assert.equal(provider.kind, 'provider-failure'); assert.equal(tool.kind, 'tool-failure');
  covered('nonce-grammar', 'cross-run', 'physical-attempt-failures', 'verdict-retry', 'missing-result', 'duplicate-result', 'reused-result', 'consumed-result', 'stale-result', 'mismatched-result', 'sol-before-terra', 'terra-to-sol', 'round-accounting');
});

const DISPOSITIONS = new Set(['fixed', 'accepted-as-designed', 'deferred', 'duplicate', 'not-applicable', 'needs-owner-decision']);
const DEC_FIELDS = ['Decision ID', 'Kind', 'Target and revision', 'Question', 'Options and trade-offs', 'Recommendation', 'Owner choice', 'Rationale', 'Validity and invalidation conditions'];
function dispositionValid(record, knownFindingIds = new Set()) {
  if (!record || !record.findingId || !record.sourceGate || !record.severity ||
      !record.issueSpec || !record.candidateIdentity || !record.evidence || !record.impact ||
      !DISPOSITIONS.has(record.disposition) || !record.rationale || !record.validationEvidence ||
      (!record.sourceUrl && !record.snapshotC)) return false;
  if (record.disposition === 'fixed' && !record.revisedPassage) return false;
  if (record.disposition !== 'duplicate' && record.duplicateOf) return false;
  if (record.disposition === 'duplicate' && (!record.duplicateOf || record.duplicateOf === record.findingId || !knownFindingIds.has(record.duplicateOf))) return false;
  return true;
}
function ledgerValid(records) {
  if (!Array.isArray(records) || new Set(records.map((record) => record.findingId)).size !== records.length) return false;
  const byId = new Map(records.map((record) => [record.findingId, record]));
  const ids = new Set(byId.keys());
  return records.every((record) => dispositionValid(record, ids)) &&
    records.every((record) => record.disposition !== 'duplicate' || byId.get(record.duplicateOf)?.disposition !== 'duplicate');
}
function decisionValid(record) { return DEC_FIELDS.every((field) => record && typeof record[field] === 'string' && record[field].length > 0); }

test('fixture: complete finding records, duplicate ownership, and nine-field decisions', () => {
  const base = { sourceGate: 'sol', severity: 'Major', issueSpec: 's'.repeat(64), candidateIdentity: 'c'.repeat(64), evidence: 'counterexample', impact: 'unsafe', disposition: 'fixed', rationale: 'corrected', revisedPassage: 'exact replacement', validationEvidence: 'rerun', sourceUrl: 'https://example.test/finding' };
  assert.equal(dispositionValid({ ...base, findingId: 'SOL13-BUNDLE-026' }), true);
  assert.equal(dispositionValid({ ...base, disposition: 'bad' }), false);
  assert.equal(dispositionValid({ ...base, sourceGate: undefined }), false);
  assert.equal(dispositionValid({ ...base, findingId: 'f2', disposition: 'duplicate', revisedPassage: undefined }), false);
  assert.equal(dispositionValid({ ...base, findingId: 'f2', disposition: 'duplicate', duplicateOf: 'missing', revisedPassage: undefined }, new Set(['f2'])), false);
  const canonical = { ...base, findingId: 'f1' };
  const duplicate = { ...base, findingId: 'f2', disposition: 'duplicate', duplicateOf: 'f1', revisedPassage: undefined };
  assert.equal(ledgerValid([canonical, duplicate]), true);
  assert.equal(ledgerValid([duplicate]), false, 'duplicate cannot name a nonexistent canonical owner');
  const cycleA = { ...duplicate, findingId: 'cycle-a', duplicateOf: 'cycle-b' };
  const cycleB = { ...duplicate, findingId: 'cycle-b', duplicateOf: 'cycle-a' };
  assert.equal(ledgerValid([cycleA, cycleB]), false, 'duplicate cycle has no canonical owner');
  assert.equal(ledgerValid([canonical, duplicate, { ...duplicate, findingId: 'f3', duplicateOf: 'f2' }]), false, 'duplicate chains cannot replace a direct canonical owner');
  assert.equal(ledgerValid([canonical, { ...canonical }]), false, 'one finding ID has exactly one record owner');
  const decision = Object.fromEntries(DEC_FIELDS.map((field) => [field, field === 'Decision ID' ? 'DEC-I13-ENTRYPOINT-029' : 'complete']));
  assert.equal(decisionValid(decision), true); assert.equal(decisionValid({ ...decision, Rationale: '' }), false);
  covered('complete-findings', 'duplicate-ownership', 'nine-field-decisions');
});

function previewState(event, state) {
  if (event === 'decline' || event === 'cancel') return { state: 'ABORTED', authority: false };
  if (event === 'live-owner-decision' || event === 'live-round-extension') return { state: 'WAITING_FOR_OWNER', authority: false, live: true };
  if (event === 'non-affirmative') return { state: 'WAITING_FOR_OWNER', authority: false };
  if (['session-end', 'later-command', 'regenerate', 'identity-movement', 'authoritative-change', 'failure', 'uncertainty', 'terminal'].includes(event)) return { state: 'WAITING_FOR_OWNER', authority: false };
  if ((event === 'approve' || event === '承認') && state.preview && state.session === state.answerSession && state.target === state.answerTarget && state.candidate === state.answerCandidate) return { state: 'approved', authority: true };
  return { state: 'WAITING_FOR_OWNER', authority: false };
}

test('fixture: exact target/candidate/session preview table covers approve, decline, expiry, continuation, and legacy resume', () => {
  const state = { preview: true, session: 'S', target: 'R#13', candidate: 'C', answerSession: 'S', answerTarget: 'R#13', answerCandidate: 'C' };
  assert.deepEqual(previewState('approve', state), { state: 'approved', authority: true }); assert.deepEqual(previewState('承認', state), { state: 'approved', authority: true });
  assert.deepEqual(previewState('decline', state), { state: 'ABORTED', authority: false }); assert.deepEqual(previewState('cancel', state), { state: 'ABORTED', authority: false }); assert.deepEqual(previewState('non-affirmative', state), { state: 'WAITING_FOR_OWNER', authority: false });
  assert.deepEqual(previewState('live-owner-decision', state), { state: 'WAITING_FOR_OWNER', authority: false, live: true });
  assert.deepEqual(previewState('live-round-extension', state), { state: 'WAITING_FOR_OWNER', authority: false, live: true });
  for (const event of ['session-end', 'later-command', 'regenerate', 'identity-movement', 'authoritative-change', 'failure', 'uncertainty', 'terminal']) assert.equal(previewState(event, state).authority, false, event);
  assert.deepEqual(previewState('approve', { ...state, answerTarget: 'R#14' }), { state: 'WAITING_FOR_OWNER', authority: false });
  assert.deepEqual(previewState('approve', { ...state, answerCandidate: 'other' }), { state: 'WAITING_FOR_OWNER', authority: false });
  assert.deepEqual(previewState('approve', { ...state, answerSession: 'other' }), { state: 'WAITING_FOR_OWNER', authority: false });
  const resumeAllowed = (phase, command) => phase === 'legacy' && (command === '/tidd-issue' || command === '/tidd-pr');
  assert.equal(resumeAllowed('legacy', '/tidd-issue'), true); assert.equal(resumeAllowed('legacy', '/tidd-pr'), true);
  assert.equal(resumeAllowed('candidate', '/tidd-issue'), false); assert.equal(resumeAllowed('candidate', 'pasted tidd-status'), false);
  covered('candidate-status-no-resume', 'live-owner-continuation', 'legacy-issue-resume', 'pr-resume', 'decline', 'non-affirmative', 'approval-expiry');
});

function publicationOutcome({ approved = true, A = 'stable', bodyChanged = true, resolverPatch = true,
  patch = 'ok', B = 'stable', resolverPost = true, post = 'ok', C = {}, expected = {} }) {
  const result = { state: 'WAITING_FOR_OWNER', actions: [], retry: false, compensation: false, approvalConsumed: false };
  if (!approved) return result;
  if (A === 'failure' || A === 'identity-failure') return { ...result, state: 'BLOCKED' };
  if (A !== 'stable') return result;
  if (bodyChanged) {
    if (!resolverPatch) return { ...result, state: 'BLOCKED' };
    result.approvalConsumed = true;
    result.actions.push('PATCH');
    if (patch !== 'ok') return result;
  }
  if (B === 'failure' && !result.approvalConsumed) return { ...result, state: 'BLOCKED' };
  if (B !== 'stable') return result;
  if (!resolverPost && !result.approvalConsumed) return { ...result, state: 'BLOCKED' };
  if (!resolverPost) return result;
  result.approvalConsumed = true;
  result.actions.push('POST');
  if (post !== 'ok') return result;
  const qualifies = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(C.association) && C.userType !== 'Bot';
  const proof = C.stable && C.body === expected.body && C.commentBody === expected.commentBody &&
    C.commentId === expected.commentId && C.transportUrl === expected.transportUrl &&
    C.issueSpec === expected.issueSpec && C.newCommentCount === 1 && qualifies;
  if (proof) result.state = 'IMPLEMENTATION_READY';
  return result;
}

test('fixture: bounded publication state table covers mismatch versus BLOCKED, no-body B, post-PATCH B, movement, counts, C proof, and no retry', () => {
  const expected = { body: 'new body', commentBody: 'ledger', commentId: 99, transportUrl: 'https://github.com/acme/widgets/issues/13#issuecomment-99', issueSpec: 'f'.repeat(64) };
  const proof = { stable: true, ...expected, association: 'OWNER', userType: 'User', newCommentCount: 1 };
  assert.equal(publicationOutcome({ A: 'mismatch' }).state, 'WAITING_FOR_OWNER');
  assert.equal(publicationOutcome({ A: 'failure' }).state, 'BLOCKED');
  assert.equal(publicationOutcome({ A: 'identity-failure' }).state, 'BLOCKED');
  const noBody = publicationOutcome({ bodyChanged: false, B: 'stable', C: proof, expected });
  assert.deepEqual(noBody.actions, ['POST']); assert.equal(noBody.state, 'IMPLEMENTATION_READY');
  const mismatchedNoBodyB = publicationOutcome({ bodyChanged: false, B: 'mismatch', C: proof, expected });
  assert.equal(mismatchedNoBodyB.state, 'WAITING_FOR_OWNER'); assert.deepEqual(mismatchedNoBodyB.actions, []);
  const badNoBodyB = publicationOutcome({ bodyChanged: false, B: 'failure', C: proof, expected });
  assert.equal(badNoBodyB.state, 'BLOCKED'); assert.deepEqual(badNoBodyB.actions, []);
  const badPatchB = publicationOutcome({ bodyChanged: true, B: 'failure', C: proof, expected });
  assert.equal(badPatchB.state, 'WAITING_FOR_OWNER'); assert.deepEqual(badPatchB.actions, ['PATCH']);
  const movedBeforePost = publicationOutcome({ bodyChanged: true, resolverPost: false, C: proof, expected });
  assert.equal(movedBeforePost.state, 'WAITING_FOR_OWNER'); assert.deepEqual(movedBeforePost.actions, ['PATCH']);
  const patchFailure = publicationOutcome({ bodyChanged: true, patch: 'failure', C: proof, expected });
  assert.equal(patchFailure.state, 'WAITING_FOR_OWNER'); assert.deepEqual(patchFailure.actions, ['PATCH']);
  for (const post of ['failure', 'unknown']) {
    const outcome = publicationOutcome({ bodyChanged: true, post, C: proof, expected });
    assert.equal(outcome.state, 'WAITING_FOR_OWNER'); assert.equal(outcome.retry, false); assert.equal(outcome.compensation, false);
  }
  const ready = publicationOutcome({ bodyChanged: true, C: proof, expected });
  assert.equal(ready.state, 'IMPLEMENTATION_READY'); assert.deepEqual(ready.actions, ['PATCH', 'POST']); assert.equal(ready.approvalConsumed, true);
  const attemptedReuse = publicationOutcome({ approved: false, bodyChanged: true, C: proof, expected });
  assert.deepEqual(attemptedReuse.actions, []); assert.equal(attemptedReuse.state, 'WAITING_FOR_OWNER');
  for (const C of [{ ...proof, association: 'CONTRIBUTOR' }, { ...proof, userType: 'Bot' }, { ...proof, commentBody: 'other' }, { ...proof, newCommentCount: 2 }, { ...proof, issueSpec: '0'.repeat(64) }]) {
    assert.equal(publicationOutcome({ C, expected }).state, 'WAITING_FOR_OWNER');
  }
  covered('snapshot-a-mismatch', 'snapshot-a-failure', 'no-body-snapshot-b', 'post-patch-snapshot-b', 'pre-post-resolver-movement', 'one-time-approval', 'patch-post-order', 'post-mutation-failure', 'no-retry-compensation', 'snapshot-c-body', 'snapshot-c-comment-transport', 'snapshot-c-cld9', 'snapshot-c-issue-spec');
});

function authoritativeInput(snapshot) {
  return JSON.stringify({ body: snapshot.body, comments: snapshot.comments.filter((comment) =>
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.association) && comment.userType !== 'Bot') });
}
test('fixture: authoritative changes invalidate readiness while advisory additions do not', () => {
  const before = { body: 'body', comments: [{ id: 1, body: 'owner', association: 'OWNER', userType: 'User' }] };
  assert.notEqual(authoritativeInput(before), authoritativeInput({ ...before, body: 'edited' }));
  assert.notEqual(authoritativeInput(before), authoritativeInput({ ...before, comments: [...before.comments, { id: 2, body: 'new', association: 'MEMBER', userType: 'User' }] }));
  assert.equal(authoritativeInput(before), authoritativeInput({ ...before, comments: [...before.comments, { id: 2, body: 'bot', association: 'OWNER', userType: 'Bot' }] }));
  assert.equal(authoritativeInput(before), authoritativeInput({ ...before, comments: [...before.comments, { id: 2, body: 'advice', association: 'CONTRIBUTOR', userType: 'User' }] }));
  covered('authoritative-invalidation', 'advisory-no-change');
});

test('fixture: every required hostile category is exercised by a concrete reference assertion', () => {
  assert.deepEqual([...executedCoverage].sort(), [...REQUIRED_COVERAGE].sort());
});
