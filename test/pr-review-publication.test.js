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
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$GH_REPOSITORY" "$GH_PR_NUMBER" "$GH_STATE" "$current_head" "$GH_PR_URL"
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
    ...extra,
  };
  return execFileSync(BASH, [gitBashPath(path.join(fixture.artifactDir, 'publish-review.sh'))], {
    cwd: fixture.root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPublisherAsync(fixture, extra = {}) {
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
    execFile(BASH, [gitBashPath(path.join(fixture.artifactDir, 'publish-review.sh'))], {
      cwd: fixture.root, env, encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
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
