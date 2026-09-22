'use strict';

// Provenance: the original focused compile/contract test failed 0/1 before
// implementation because publish-review.sh was absent. Behavioral publication
// fixtures below were co-developed with implementation; they use a stubbed `gh`
// and never mutate GitHub.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { repoPath, readText } = require('./helpers');

const TEMPLATE = 'skills/closed-loop-pr/references/publish-review.sh';
const REPOSITORY = 'tetsuh/pi-tidd-agents';
const PR = '41';
const HEAD = 'a'.repeat(40);
const URL = `https://github.com/${REPOSITORY}/pull/${PR}`;
function resolveGitBash() {
  if (process.env.PI_GIT_BASH) return process.env.PI_GIT_BASH;
  const command = process.platform === 'win32' ? 'where.exe' : 'bash';
  const args = process.platform === 'win32' ? ['bash.exe'] : ['-lc', 'command -v bash'];
  return execFileSync(command, args, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
}

const BASH = resolveGitBash();

function gitBashPath(value) {
  if (process.platform !== 'win32') return value;
  return execFileSync(BASH, ['-lc', 'cygpath -u "$1"', '--', value], { encoding: 'utf8' }).trim();
}

function hostPath(value) {
  if (process.platform !== 'win32') return value;
  return execFileSync(BASH, ['-lc', 'cygpath -w "$1"', '--', value], { encoding: 'utf8' }).trim();
}

function shellQuote(value) {
  return `'${gitBashPath(value).split("'").join("'\"'\"'")}'`;
}

const fixtureRoots = new Set();
test.after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function materialize(root, { head = HEAD, comments = '', postOutput = `https://github.com/${REPOSITORY}/pull/${PR}#issuecomment-99`, visibleBytes } = {}) {
  const artifactDir = path.join(root, 'artifact directory with spaces');
  fs.mkdirSync(artifactDir, { recursive: true });
  const visible = visibleBytes || Buffer.from(`# Review state: MERGE_READY\nReviewed pull request: ${URL}\nReviewed public head: ${head}\n`, 'utf8');
  const visibleSha256 = sha256(visible);
  const marker = `<!-- pi-tidd-agents:review-publication:v1 repo=${REPOSITORY} pr=${PR} head=${head} visibleSha256=${visibleSha256} -->`;
  const body = Buffer.concat([visible, Buffer.from(`${marker}\n`, 'utf8')]);
  fs.writeFileSync(path.join(artifactDir, 'review-comment.md'), body, { mode: 0o600 });
  const completeSha256 = sha256(body);
  const script = readText(TEMPLATE)
    .replaceAll('__PI_REVIEW_REPOSITORY__', REPOSITORY)
    .replaceAll('__PI_REVIEW_PR_NUMBER__', PR)
    .replaceAll('__PI_REVIEW_HEAD__', head)
    .replaceAll('__PI_REVIEW_PR_URL__', URL)
    .replaceAll('__PI_REVIEW_BODY_SHA256__', completeSha256)
    .replaceAll('__PI_REVIEW_MARKER__', marker);
  fs.writeFileSync(path.join(artifactDir, 'publish-review.sh'), script, { encoding: 'utf8', mode: 0o600 });

  const bin = path.join(root, 'stub bin');
  fs.mkdirSync(bin, { recursive: true });
  const posted = path.join(root, 'posted body');
  const log = path.join(root, 'gh calls');
  const stub = path.join(bin, 'gh');
  fs.writeFileSync(stub, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
if [[ "$1 ${'${2:-}'}" == 'auth status' ]]; then
  [[ -z "${'${GH_AUTH_DELAY:-}'}" ]] || sleep "$GH_AUTH_DELAY"
  exit "${'${GH_AUTH_RC:-0}'}"
fi
if [[ "$1" == 'api' && "${'${2:-}'}" == "repos/$GH_EXPECTED_REPOSITORY/pulls/$GH_EXPECTED_PR_NUMBER" ]]; then
  [[ "$#" == 4 && "$3" == '--jq' ]] || exit 64
  count=0
  [[ ! -f "$GH_VIEW_COUNT_FILE" ]] || count="$(cat "$GH_VIEW_COUNT_FILE")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$GH_VIEW_COUNT_FILE"
  current_head="$GH_HEAD"
  if [[ "$count" -gt 1 && -n "${'${GH_HEAD_SECOND:-}'}" ]]; then current_head="$GH_HEAD_SECOND"; fi
  if [[ "$count" == 1 && -n "${'${GH_MUTATE_ORIGINAL_ON_IDENTITY:-}'}" ]]; then printf 'tampered\\n' >> "$GH_ORIGINAL_FILE"; fi
  if [[ "$count" == 1 && -n "${'${GH_MUTATE_SNAPSHOT_ON_IDENTITY:-}'}" ]]; then
    for snapshot in "$GH_ARTIFACT_DIR"/.pi-review-publish.*/review-comment.md; do
      [[ -f "$snapshot" ]] && printf 'tampered\\n' >> "$snapshot"
    done
  fi
  # Raw mode returns identity bytes the template's own filter could never produce, so the guards that stand
  # between the filter and the field split can be exercised at all.
  if [[ -n "${'${GH_RAW_IDENTITY:-}'}" ]]; then printf '%b' "$GH_RAW_IDENTITY"; exit 0; fi
  # Issue #141: the template's own filter runs, through the real jq, over a pull request shaped as the REST API
  # returns it, so each field the template reads, its position, and its null handling are what the tests check.
  draft="${'${GH_DRAFT:-false}'}"; base="${'${GH_BASE:-'}${'b'.repeat(40)}}"; base_json="${'${GH_BASE_JSON:-}'}"; head_repo="${'${GH_HEAD_REPO-$GH_REPOSITORY}'}"; head_repo_json="${'${GH_HEAD_REPO_JSON:-}'}"; head_ref="${'${GH_HEAD_REF-feature}'}"; head_ref_json="${'${GH_HEAD_REF_JSON:-}'}"
  if [[ "$count" -gt 1 ]]; then
    draft="${'${GH_DRAFT_SECOND:-$draft}'}"; base="${'${GH_BASE_SECOND:-$base}'}"; base_json="${'${GH_BASE_JSON_SECOND:-$base_json}'}"; head_repo="${'${GH_HEAD_REPO_SECOND-$head_repo}'}"; head_repo_json="${'${GH_HEAD_REPO_JSON_SECOND:-$head_repo_json}'}"; head_ref="${'${GH_HEAD_REF_SECOND:-$head_ref}'}"; head_ref_json="${'${GH_HEAD_REF_JSON_SECOND:-$head_ref_json}'}"
  fi
  jq -nr --arg repo "$GH_REPOSITORY" --arg number "$GH_PR_NUMBER" --arg state "$GH_STATE" --arg draft "$draft" --arg head "$current_head" --arg url "$GH_PR_URL" --arg base "$base" --arg baseJson "$base_json" --arg headRepo "$head_repo" --arg headRepoJson "$head_repo_json" --arg headRef "$head_ref" --arg headRefJson "$head_ref_json" \
    '{ number: ($number|tonumber), state: $state, draft: ($draft|fromjson), html_url: $url, base: { sha: (if $baseJson == "" then $base else ($baseJson|fromjson) end), ref: "main", repo: { full_name: $repo } }, head: { sha: $head, ref: (if $headRefJson == "" then $headRef else ($headRefJson|fromjson) end), repo: (if $headRepoJson == "" then (if $headRepo == "" then null else { full_name: $headRepo } end) else { full_name: ($headRepoJson|fromjson) } end) } }' \
    | jq -r "$4"
  exit 0
fi
if [[ "$1 ${'${2:-}'}" == 'api --paginate' ]]; then
  [[ "$#" == 5 && "$3" == "repos/$GH_EXPECTED_REPOSITORY/issues/$GH_EXPECTED_PR_NUMBER/comments?per_page=100" && "$4" == '--jq' ]] || exit 64
  cat "$GH_COMMENTS_FILE"
  exit "${'${GH_API_RC:-0}'}"
fi
if [[ "$1 ${'${2:-}'}" == 'pr comment' ]]; then
  body_file=''
  previous=''
  for arg in "$@"; do
    if [[ "$previous" == '--body-file' ]]; then body_file="$arg"; fi
    previous="$arg"
  done
  [[ -n "$body_file" ]] || exit 64
  cp -- "$body_file" "$GH_POSTED_FILE"
  printf '%s\\n' "$GH_POST_OUTPUT"
  exit "${'${GH_POST_RC:-0}'}"
fi
exit 64
`, { encoding: 'utf8', mode: 0o700 });
  return { artifactDir, bin, posted, log, viewCount: path.join(root, 'view count'), commentsFile: path.join(root, 'comments'), body, marker, completeSha256, head, stub };
}

function runPublisher(fixture, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    TMPDIR: gitBashPath(fixture.root),
    GH_CALL_LOG: gitBashPath(fixture.log),
    GH_REPOSITORY: REPOSITORY,
    GH_PR_NUMBER: PR,
    GH_STATE: 'open',
    GH_HEAD: fixture.head,
    GH_PR_URL: URL,
    GH_COMMENTS_FILE: gitBashPath(fixture.commentsFile),
    GH_POSTED_FILE: gitBashPath(fixture.posted),
    GH_POST_OUTPUT: `https://github.com/${REPOSITORY}/pull/${PR}#issuecomment-99`,
    GH_VIEW_COUNT_FILE: gitBashPath(fixture.viewCount),
    GH_EXPECTED_REPOSITORY: REPOSITORY,
    GH_EXPECTED_PR_NUMBER: PR,
    GH_ORIGINAL_FILE: gitBashPath(path.join(fixture.artifactDir, 'review-comment.md')),
    GH_ARTIFACT_DIR: gitBashPath(fixture.artifactDir),
    ...extra,
  };
  return execFileSync(BASH, [gitBashPath(path.join(fixture.artifactDir, 'publish-review.sh'))], {
    cwd: fixture.root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPublisherAsync(fixture, extra = {}, onSpawn) {
  const env = {
    ...process.env,
    PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`,
    GH_CALL_LOG: gitBashPath(fixture.log),
    GH_REPOSITORY: REPOSITORY,
    GH_PR_NUMBER: PR,
    GH_STATE: 'open',
    GH_HEAD: fixture.head,
    GH_PR_URL: URL,
    GH_COMMENTS_FILE: gitBashPath(fixture.commentsFile),
    GH_POSTED_FILE: gitBashPath(fixture.posted),
    GH_POST_OUTPUT: `https://github.com/${REPOSITORY}/pull/${PR}#issuecomment-99`,
    GH_VIEW_COUNT_FILE: gitBashPath(fixture.viewCount),
    GH_EXPECTED_REPOSITORY: REPOSITORY,
    GH_EXPECTED_PR_NUMBER: PR,
    GH_ORIGINAL_FILE: gitBashPath(path.join(fixture.artifactDir, 'review-comment.md')),
    ...extra,
  };
  return new Promise((resolve) => {
    const child = execFile(BASH, [gitBashPath(path.join(fixture.artifactDir, 'publish-review.sh'))], {
      cwd: fixture.root, env, encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    if (onSpawn) onSpawn(child);
  });
}

function fixture(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue41-test-'));
  fixtureRoots.add(root);
  const result = materialize(root, options);
  result.root = root;
  fs.writeFileSync(result.commentsFile, options?.comments || '', 'utf8');
  return result;
}

function callCount(f) {
  return fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

function pathWithoutGh(root) {
  const bin = path.join(root, 'path without gh');
  fs.mkdirSync(bin);
  for (const command of ['dirname', 'git', 'mktemp', 'cp', 'sha256sum', 'shasum', 'iconv', 'tail', 'od', 'tr', 'awk', 'grep', 'mkdir', 'rm', 'rmdir']) {
    const resolved = execFileSync(BASH, ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, command), `#!/usr/bin/env bash\nexec ${shellQuote(resolved)} "$@"\n`, { encoding: 'utf8', mode: 0o700 });
  }
  return bin;
}

test('Issue #41 ships a review-only-owned guarded publication template', () => {
  assert.ok(fs.existsSync(repoPath(TEMPLATE)), `missing guarded publication template: ${TEMPLATE}`);
  const reviewOnly = readText('skills/closed-loop-pr/references/review-only.md');
  assert.match(reviewOnly, /review-comment\.md/);
  assert.match(reviewOnly, /publish-review\.sh/);
  assert.match(reviewOnly, /owner executing that command is the publication grant/i);
  assert.match(reviewOnly, /publication_grant: review-only not-applicable/);
});

test('Issue #41 template is syntax-valid, portable, and does not source body bytes', () => {
  const template = readText(TEMPLATE);
  execFileSync('bash', ['-n', repoPath(TEMPLATE)]);
  assert.match(template, /gh pr comment \"\$REVIEW_PR_URL\" --body-file \"\$POST_FILE\"/);
  for (const placeholder of ['REPOSITORY', 'PR_NUMBER', 'HEAD', 'PR_URL', 'BODY_SHA256', 'MARKER']) {
    assert.equal((template.match(new RegExp(`__PI_REVIEW_${placeholder}__`, 'g')) || []).length, 1);
  }
  assert.match(template, /gh api --paginate/);
  assert.match(template, /sha256sum/);
  assert.match(template, /shasum -a 256/);
  assert.match(template, /iconv -f UTF-8 -t UTF-8/);
  assert.match(template, /must end with one LF/);
  assert.match(template, /Generation contract/);
  assert.match(template, /mktemp -d/);
  assert.match(template, /TMPDIR:-\/tmp/);
  assert.doesNotMatch(template, /jq\s+-/);
  assert.doesNotMatch(template, /eval\b|source\s+.*review-comment|cat .*review-comment.*\|.*bash/);
});

test('Issue #41 CI scopes token permissions and uses Git Bash for Windows coverage', () => {
  const workflow = readText('.github/workflows/test.yml');
  const harness = readText('test/pr-review-publication.test.js');
  assert.match(workflow, /permissions:\r?\n  contents: read\r?\n/);
  assert.match(workflow, /publication-git-bash:\r?\n    runs-on: windows-latest/);
  assert.match(harness, /execFileSync\(BASH, \['-lc', 'cygpath -u "\$1"', '--', value\]/);
  assert.doesNotMatch(harness, /path\.join\(path\.dirname\(BASH\), 'cygpath\.exe'\)/);
});

test('Issue #41 successful owner script posts exact bytes once and emits receipt', () => {
  const f = fixture();
  const output = runPublisher(f);
  assert.match(output, /publication succeeded/);
  assert.match(output, /comment_url: https:\/\/github\.com\/tetsuh\/pi-tidd-agents\/pull\/41#issuecomment-99/);
  assert.deepEqual(fs.readFileSync(f.posted), Buffer.from(f.body));
  assert.equal(callCount(f), 5, 'auth, two identity brackets, paginated comments, and one POST are expected');
  const receipt = output.match(/receipt: (.+)\n/)?.[1];
  const receiptPath = receipt && hostPath(receipt);
  assert.ok(receiptPath && fs.existsSync(receiptPath));
  const receiptDir = fs.statSync(path.dirname(receiptPath));
  const artifactDir = fs.statSync(f.artifactDir);
  assert.deepEqual([receiptDir.dev, receiptDir.ino], [artifactDir.dev, artifactDir.ino]);
  assert.match(fs.readFileSync(receiptPath, 'utf8'), new RegExp(f.completeSha256));
});

test('Issue #41 rejects missing authentication before any provider mutation', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_AUTH_RC: '1' }));
  assert.equal(callCount(f), 1);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rejects changed head before any POST', () => {
  const f = fixture({ head: 'b'.repeat(40) });
  assert.throws(() => runPublisher(f, { GH_HEAD: 'c'.repeat(40) }));
  assert.equal(callCount(f), 2, 'only auth and identity may run before head guard');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rejects a closed pull request before any POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_STATE: 'closed' }));
  assert.equal(callCount(f), 2);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rejects wrong repository or PR identity before any POST', () => {
  for (const identity of [{ GH_REPOSITORY: 'other/repo' }, { GH_PR_NUMBER: '99' }]) {
    const f = fixture();
    assert.throws(() => runPublisher(f, identity));
    assert.equal(callCount(f), 2);
    assert.equal(fs.existsSync(f.posted), false);
  }
});

test('Issue #41 rejects missing gh without provider access', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { PATH: pathWithoutGh(f.root) }));
  assert.equal(callCount(f), 0);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rejects artifact placement inside a repository', () => {
  const f = fixture();
  execFileSync('git', ['init', '-q', f.root]);
  assert.throws(() => runPublisher(f));
  assert.equal(callCount(f), 0);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 sanitizes inherited Git discovery variables for placement checks', () => {
  const f = fixture();
  execFileSync('git', ['init', '-q', f.root]);
  assert.throws(() => runPublisher(f, {
    GIT_DIR: path.join(f.root, 'nonexistent-git-dir'),
    GIT_WORK_TREE: path.join(f.root, 'misleading-work-tree'),
    GIT_COMMON_DIR: path.join(f.root, 'nonexistent-common-dir'),
    GIT_CEILING_DIRECTORIES: f.root,
  }));
  assert.equal(callCount(f), 0);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 fails closed on inherited Git configuration injection', () => {
  const f = fixture();
  execFileSync('git', ['init', '-q', f.root]);
  assert.throws(() => runPublisher(f, { GIT_CONFIG_COUNT: 'not-a-number' }));
  assert.equal(callCount(f), 0);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rejects altered review bytes before any provider lookup', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.artifactDir, 'review-comment.md'), 'tampered\n');
  assert.throws(() => runPublisher(f));
  assert.equal(callCount(f), 0);
});

test('Issue #41 rejects hash-bound malformed UTF-8 before any provider lookup', () => {
  const visible = Buffer.concat([Buffer.from('# Review state: MERGE_READY\n', 'utf8'), Buffer.from([0xff, 0x0a])]);
  const f = fixture({ visibleBytes: visible });
  assert.throws(() => runPublisher(f));
  assert.equal(callCount(f), 0);
});

test('Issue #41 rejects hash-bound CR and CRLF before any provider lookup', () => {
  for (const visible of [Buffer.from('# Review\rline\n', 'utf8'), Buffer.from('# Review\r\n', 'utf8')]) {
    const f = fixture({ visibleBytes: visible });
    assert.throws(() => runPublisher(f));
    assert.equal(callCount(f), 0);
  }
});

test('Issue #41 rejects a hash-bound artifact without the final LF', () => {
  const f = fixture();
  const body = f.body.subarray(0, -1);
  fs.writeFileSync(path.join(f.artifactDir, 'review-comment.md'), body);
  const digest = sha256(body);
  const scriptPath = path.join(f.artifactDir, 'publish-review.sh');
  fs.writeFileSync(scriptPath, fs.readFileSync(scriptPath, 'utf8').replace(f.completeSha256, digest), { mode: 0o600 });
  assert.throws(() => runPublisher(f));
  assert.equal(callCount(f), 0);
});

test('Issue #41 scans complete paginated comment evidence and rejects a later-page marker', () => {
  const f = fixture();
  fs.writeFileSync(f.commentsFile, `first page\nsecond page\n${f.marker}\n`, 'utf8');
  assert.throws(() => runPublisher(f));
  assert.equal(callCount(f), 3, 'auth, identity, and one complete paginated scan; no POST');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rejects incomplete paginated evidence without a POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_API_RC: '1' }));
  assert.equal(callCount(f), 3);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 rechecks exact head immediately before POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_HEAD_SECOND: 'c'.repeat(40) }));
  assert.equal(callCount(f), 4, 'second identity read must happen after duplicate scan and before POST');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #141 rejects a draft pull request before any POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_DRAFT: 'true' }), /draft|identity/);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #141 rechecks the draft state, base OID, and head repository and branch immediately before POST', () => {
  for (const [name, value] of [['GH_DRAFT_SECOND', 'true'], ['GH_BASE_SECOND', 'c'.repeat(40)], ['GH_HEAD_REF_SECOND', 'retargeted'], ['GH_HEAD_REPO_SECOND', 'someone/fork']]) {
    const f = fixture();
    assert.throws(() => runPublisher(f, { [name]: value }), undefined, name);
    assert.equal(callCount(f), 4, `${name}: the second identity read happens after the duplicate scan and before POST`);
    assert.equal(fs.existsSync(f.posted), false, `${name}: nothing was posted`);
  }
});

test('Issue #141 rejects a pull request whose head repository no longer exists', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_HEAD_REPO: '' }));
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #141 rejects a pull request whose head branch is empty (CONV-145-HEADREF-GUARD-UNEXERCISED)', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_HEAD_REF: '' }), /head branch is missing/);
  assert.equal(callCount(f), 2, 'refused at the first identity read, after authentication');
  assert.equal(fs.existsSync(f.posted), false);
});

// Issue #148: each identity field is refused by its own clause. With a tab-separated read an empty field collapsed
// and the next value shifted into it, so a missing head repository was only ever refused by the head-branch clause.
for (const [label, extra, reason] of [
  ['only the head repository is empty', { GH_HEAD_REPO: '' }, /head repository is missing/],
  ['only the head branch is empty', { GH_HEAD_REF: '' }, /head branch is missing/],
  ['only the base OID is malformed', { GH_BASE: 'not-an-oid' }, /base OID is malformed/],
]) {
  test(`Issue #148 ${label}: refused by that field's own clause, before any POST`, () => {
    const f = fixture();
    assert.throws(() => runPublisher(f, extra), (error) => reason.test(String(error.stderr)), label);
    assert.equal(callCount(f), 2, 'refused at the first identity read, after authentication');
    assert.equal(fs.existsSync(f.posted), false);
  });
}

for (const [field, type, extra] of [
  ['head repository', 'object', { GH_HEAD_REPO_JSON: '{}' }],
  ['head repository', 'array', { GH_HEAD_REPO_JSON: '[]' }],
  ['head branch', 'object', { GH_HEAD_REF_JSON: '{}' }],
  ['head branch', 'array', { GH_HEAD_REF_JSON: '[]' }],
  ['base OID', 'null', { GH_BASE_JSON: 'null' }],
  ['head branch', 'null', { GH_HEAD_REF_JSON: 'null' }],
]) {
  test(`Issue #149 rejects a ${type} ${field} identity value before any POST`, () => {
    const f = fixture();
    assert.throws(() => runPublisher(f, extra));
    assert.equal(callCount(f), 2, 'malformed identity is refused at the first read, after authentication');
    assert.equal(fs.existsSync(f.posted), false);
  });
}

test('Issue #149 rejects a unit-separator collision across identity reads before POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, {
    GH_HEAD_REPO: `owner\x1frepo`,
    GH_HEAD_REF: 'feature',
    GH_HEAD_REPO_SECOND: 'owner',
    GH_HEAD_REF_SECOND: `repo\x1ffeature`,
  }), /unit separator|identity/);
  assert.equal(callCount(f), 2, 'the delimiter-bearing collision pair is refused on the first identity read before POST');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #149 rejects a NUL-removal collision across identity reads before POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, {
    GH_HEAD_REPO: 'ownerrepo',
    GH_HEAD_REPO_JSON_SECOND: '"owner\\u0000repo"',
  }), /control character|identity/);
  assert.equal(callCount(f), 4, 'the NUL-bearing second identity is refused before POST');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #149 rejects a trailing-LF collision across identity reads before POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, {
    GH_HEAD_REF: 'feature',
    GH_HEAD_REF_JSON_SECOND: '"feature\\n"',
  }), /control character|identity/);
  assert.equal(callCount(f), 4, 'the trailing-LF second identity is refused before POST');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #149 refuses a tab relocation across identity reads before POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, {
    GH_HEAD_REPO: 'owner\trepo',
    GH_HEAD_REF: 'feature',
    GH_HEAD_REPO_SECOND: 'owner',
    GH_HEAD_REF_SECOND: 'repo\tfeature',
  }), (error) => /base OID, head repository, or head branch changed at before-post/.test(String(error.stderr)));
  assert.equal(callCount(f), 4, 'the tab is carried through both reads and refused by the pre-POST comparison');
  assert.equal(fs.existsSync(f.posted), false, 'the relocated tab must not reach POST');
});

// Issue #149: the tuple the two identity reads compare is injective only while its delimiter is a character the
// identity filter refuses inside a field. Reading the delimiter out of the template keeps that invariant pinned:
// with an ordinary character (a colon, say) every character-specific case below still passes.
function decodeShellLiteral(token) {
  const ansi = token.match(/^\$'(.*)'$/);
  if (ansi) {
    return ansi[1].replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\(.)/g, (whole, hex, unicode, escape) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (unicode) return String.fromCharCode(parseInt(unicode, 16));
      return { t: '\t', n: '\n', r: '\r', 0: '\0' }[escape] ?? escape;
    });
  }
  const quoted = token.match(/^'(.*)'$/) || token.match(/^"(.*)"$/);
  assert.ok(quoted, `the identity tuple's delimiter is not a readable literal: ${token}`);
  return quoted[1];
}

function joinDelimiter() {
  const line = readText(TEMPLATE).match(/^\s*local target=.*$/m);
  assert.ok(line, 'the template still binds the identity tuple in one assignment');
  const parts = line[0].match(/^\s*local target="\$actual_base"(.+?)"\$actual_head_repo"(.+?)"\$actual_head_ref"$/);
  assert.ok(parts, `the identity tuple is joined in an unreadable way: ${line[0]}`);
  assert.equal(parts[1], parts[2], 'both field boundaries use the same delimiter');
  return decodeShellLiteral(parts[1]);
}

function refusedIdentityCharacters() {
  const refused = [...readText(TEMPLATE).matchAll(/contains\("\\u([0-9a-fA-F]{4})"\)/g)]
    .map((match) => String.fromCharCode(parseInt(match[1], 16)));
  assert.ok(refused.length > 0, 'the identity filter still refuses characters by code point');
  return new Set(refused);
}

test('Issue #149 joins the bound identity with a character the identity filter refuses', () => {
  const delimiter = joinDelimiter();
  const codePoint = `U+${delimiter.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  assert.ok(refusedIdentityCharacters().has(delimiter),
    `the identity tuple is joined with ${codePoint}, which the filter accepts inside a field, so two identities can serialize alike`);
  const f = fixture();
  assert.throws(() => runPublisher(f, {
    GH_HEAD_REPO: `owner${delimiter}repo`,
    GH_HEAD_REF: 'feature',
    GH_HEAD_REPO_SECOND: 'owner',
    GH_HEAD_REF_SECOND: `repo${delimiter}feature`,
  }), `a relocated ${codePoint} must not reach POST`);
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #149 refuses a private snapshot tampered with between validation and POST', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_MUTATE_SNAPSHOT_ON_IDENTITY: '1' }),
    (error) => /private review-comment snapshot changed before POST/.test(String(error.stderr)));
  assert.equal(callCount(f), 4, 'the snapshot is re-hashed after the pre-POST identity read');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #149 refuses identity evidence that carries more than one record', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_RAW_IDENTITY: 'one\\ntwo\\n' }),
    (error) => /identity evidence has multiple records/.test(String(error.stderr)));
  assert.equal(callCount(f), 2, 'refused at the first identity read, after authentication');
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #141 rejects a malformed base OID', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_BASE: 'not-an-oid' }));
  assert.equal(fs.existsSync(f.posted), false);
});

test('Issue #41 posts the validated private snapshot when the original changes later', () => {
  const f = fixture();
  assert.match(runPublisher(f, { GH_MUTATE_ORIGINAL_ON_IDENTITY: '1' }), /publication succeeded/);
  assert.notDeepEqual(fs.readFileSync(path.join(f.artifactDir, 'review-comment.md')), Buffer.from(f.body));
  assert.deepEqual(fs.readFileSync(f.posted), Buffer.from(f.body));
});

test('Issue #41 rejects a rerun after successful publication', () => {
  const f = fixture();
  assert.match(runPublisher(f), /publication succeeded/);
  assert.throws(() => runPublisher(f));
  assert.equal(callCount(f), 5, 'the retained artifact lock rejects rerun before another gh call');
});

test('Issue #41 permits at most one concurrent invocation', async () => {
  const f = fixture();
  const results = await Promise.all([
    runPublisherAsync(f, { GH_AUTH_DELAY: '0.2' }),
    runPublisherAsync(f, { GH_AUTH_DELAY: '0.2' }),
  ]);
  assert.equal(results.filter((result) => !result.error).length, 1);
  assert.equal(results.filter((result) => result.error).length, 1);
  assert.equal(callCount(f), 5);
  assert.deepEqual(fs.readFileSync(f.posted), Buffer.from(f.body));
});

test('Issue #41 signal termination cannot resume after releasing the lock', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  const lock = path.join(f.artifactDir, '.pi-review-publication-lock');
  let child;
  const interrupted = runPublisherAsync(f, { GH_AUTH_DELAY: '5' }, (spawned) => { child = spawned; });
  const deadline = Date.now() + 5000;
  while ((!fs.existsSync(lock) || callCount(f) < 1) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(lock), 'first publisher must hold the artifact lock before interruption');
  assert.equal(callCount(f), 1, 'first publisher must enter the delayed auth call before interruption');
  child.kill('SIGHUP');
  const first = await interrupted;
  assert.ok(first.error, 'interrupted publisher must terminate nonzero');
  assert.equal(fs.existsSync(f.posted), false);
  assert.match(runPublisher(f), /publication succeeded/);
  assert.equal(callCount(f), 6, 'interrupted auth plus one complete successful publication are expected');
});

test('Issue #41 uses the macOS shasum fallback when sha256sum fails', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.bin, 'sha256sum'), '#!/usr/bin/env bash\nexit 127\n', { mode: 0o700 });
  fs.writeFileSync(path.join(f.bin, 'shasum'), '#!/usr/bin/env bash\nexec /usr/bin/shasum "$@"\n', { mode: 0o700 });
  assert.match(runPublisher(f), /publication succeeded/);
  assert.deepEqual(fs.readFileSync(f.posted), Buffer.from(f.body));
});

test('Issue #41 treats a nonzero POST as terminal and never retries', () => {
  const f = fixture();
  assert.throws(() => runPublisher(f, { GH_POST_RC: '1' }));
  assert.equal(callCount(f), 5);
  assert.deepEqual(fs.readFileSync(f.posted), Buffer.from(f.body));
});

test('Issue #41 rejects malformed or wrong-target POST output without retry', () => {
  for (const output of ['not-a-comment-url', 'https://github.com/other/repo/pull/9#issuecomment-99']) {
    const f = fixture();
    assert.throws(() => runPublisher(f, { GH_POST_OUTPUT: output }));
    assert.equal(callCount(f), 5);
    assert.deepEqual(fs.readFileSync(f.posted), Buffer.from(f.body));
  }
});

test('Issue #41 preserves the validated comment URL when receipt creation fails', () => {
  const f = fixture();
  const scriptPath = path.join(f.artifactDir, 'publish-review.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const receiptCommand = 'receipt="$(mktemp "$SCRIPT_DIR/review-publication-receipt.XXXXXX")"';
  assert.equal(script.split(receiptCommand).length - 1, 1);
  fs.writeFileSync(scriptPath, script.replace(receiptCommand, 'receipt="$(false)"'), { mode: 0o600 });
  let error;
  try {
    runPublisher(f);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'receipt failure must return nonzero');
  const combined = `${error.stdout || ''}\n${error.stderr || ''}`;
  assert.match(combined, /comment_url: https:\/\/github\.com\/tetsuh\/pi-tidd-agents\/pull\/41#issuecomment-99/);
  assert.match(combined, /do not retry automatically/);
  assert.equal(callCount(f), 5);
});
