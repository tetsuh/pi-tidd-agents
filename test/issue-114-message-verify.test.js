'use strict';

// Issue #114. The exact-autofix run was told to "run `git log -1 --format=%B` and compare the stored
// bytes/content exactly", but not how to capture that output. Shell command substitution strips every
// trailing LF, so the comparison the run is required to make cannot succeed and a correct commit stops
// as BLOCKED(reason=local_commit_unpushed). The verification is packaged here instead (CL-D74), reading
// the commit object itself so no appended LF has to be stripped and no shell is involved.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const readText = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// A refusal is a result, and the CLI reports one by exiting nonzero, so the helper reads its stdout.
function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return JSON.parse(run.stdout);
}

// A repository holding one commit whose message is exactly the approved bytes.
function fixture(approved) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-114-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  });
  git('init', '-q', '-b', 'main', '.');
  const file = path.join(root, 'message.txt');
  fs.writeFileSync(file, Buffer.from(approved, 'utf8'));
  git('commit', '-q', '--allow-empty', '-F', file);
  return { root, git };
}

test('Issue #114 the packaged verification compares the stored message bytes', () => {
  assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /message_verify: \{ required: \['cwd', 'expected'\], optional: \[\] \}/, 'the CLI offers the verification with the cwd and the approved message');

  const approved = 'feat: subject (#114)\n\nTest provenance: node --test.\n';
  const { root } = fixture(approved);
  try {
    // The message the run approved, verified as stored.
    const exact = cli('message_verify', { cwd: root, expected: approved });
    assert.equal(exact.ok, true, JSON.stringify(exact.error));

    // Git collapses trailing blank lines to one LF, so these name the same stored commit and must agree.
    for (const same of ['feat: subject (#114)\n\nTest provenance: node --test.', 'feat: subject (#114)\n\nTest provenance: node --test.\n\n\n']) {
      const normalized = cli('message_verify', { cwd: root, expected: same });
      assert.equal(normalized.ok, true, `Git stores this as the same message: ${JSON.stringify(normalized.error)}`);
    }

    // A message that differs in its content is refused, and the refusal names its subcheck.
    const different = cli('message_verify', { cwd: root, expected: 'feat: subject (#114)\n\nTest provenance: node --test!\n' });
    assert.equal(different.ok, false, JSON.stringify(different.data));
    assert.equal(different.error.details.subcheck, 'message_bytes', JSON.stringify(different.error));

    // The defect itself: the shell form the prose invited strips every trailing LF, so it disagrees with
    // the stored bytes that the packaged operation accepts.
    const substituted = execFileSync('bash', ['-c', 'printf %s "$(git log -1 --format=%B)"'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(substituted, approved, 'command substitution drops the terminal LF the commit stores');
    assert.equal(`${substituted}\n`, approved, 'and the only difference is that one byte');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #114 the approved message is put through the cleanup Git itself applies', () => {
  // `git commit -F` runs cleanup=whitespace: trailing whitespace off every line, leading and trailing blank
  // lines dropped, runs of blank lines collapsed to one. A rule that models only the trailing-LF collapse
  // rejects ordinary messages whose commit Git stored exactly as asked, which is the stop this issue removes.
  const shapes = [
    'feat: s (#114)\n\nbody.\n',
    'feat: s (#114)\n\nbody.',
    'feat: s (#114)\n\nbody.\n\n\n',
    'feat: s (#114)\n\nbody with tail.   \n',
    'feat: s (#114)   \n\nbody.\n',
    'feat: s (#114)\r\n\r\nbody.\r\n',
    '\n\nfeat: s (#114)\n\nbody.\n',
    'feat: s (#114)\n\n\nbody.\n',
    'feat: s (#114)\n\n\n\nbody.\n',
    'feat: s (#114)\n\t\nbody.\n',
    'feat: s (#114)\n\nbody.\n   \n',
  ];
  for (const approved of shapes) {
    const { root } = fixture(approved);
    try {
      const verified = cli('message_verify', { cwd: root, expected: approved });
      assert.equal(verified.ok, true, `Git stored this message as asked: ${JSON.stringify(approved)} -> ${JSON.stringify(verified.error)}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('Issue #114 a commit object beyond the read bound names the bound, not an errno', () => {
  const approved = `feat: s (#114)\n\n${'x'.repeat(70000)}\n`;
  const { root } = fixture(approved);
  try {
    const verified = cli('message_verify', { cwd: root, expected: approved });
    assert.deepEqual([verified.ok, verified.error.code], [false, 'output_limit'], JSON.stringify(verified.error));
    assert.equal(verified.error.details.subcheck, 'output_limit', JSON.stringify(verified.error));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #114 the cwd is a work tree toplevel, named when it is not', () => {
  const approved = 'feat: s (#114)\n\nbody.\n';
  const { root } = fixture(approved);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-114-bare-'));
  try {
    const sub = path.join(root, 'nested');
    fs.mkdirSync(sub);
    const inside = cli('message_verify', { cwd: sub, expected: approved });
    assert.deepEqual([inside.ok, inside.error.details.subcheck], [false, 'cwd_toplevel'], JSON.stringify(inside.error));
    execFileSync('git', ['init', '-q', '--bare', '.'], { cwd: bare, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    const bareResult = cli('message_verify', { cwd: bare, expected: approved });
    assert.deepEqual([bareResult.ok, bareResult.error.details.subcheck], [false, 'cwd_toplevel'], JSON.stringify(bareResult.error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('Issue #114 the verification reads the commit object, never the log format', () => {
  const source = readText('skills/closed-loop-pr/helpers/guards.js');
  assert.match(source, /'cat-file', 'commit'/, 'the stored bytes come from the commit object');
  assert.equal(source.includes('--format=%B'), false, 'no packaged read depends on a format that appends a byte');
  assert.equal(source.includes("'log'"), false, 'git log is outside the reviewed command allowlist');
  // The read is bounded and refuses a replaced object: nothing notices either if they are dropped.
  assert.match(source, /'--no-replace-objects', 'cat-file', 'commit'/, 'the read refuses a replaced object');
  assert.match(source, /SMALL_MAX_BYTES\)/, 'the read carries its own bound');
  assert.match(source, /stored\.equals\(approved\)/, 'the comparison is of bytes, never of decoded strings');
});
