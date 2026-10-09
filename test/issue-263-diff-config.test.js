'use strict';

// Issue #263: the drivers read the pull request's diff and commits through the helpers' safe Git configuration, which
// blocked global and system config but left the checkout's own `.git/config` in force. `diff.noprefix` dropped the `a/`
// and `b/` prefixes the payload's diff index parses (#261), `color.diff=always` (not overridden by `color.ui=false`)
// filled the diff with escape codes, `diff.renames=false` turned a rename into a deletion and an addition, and
// `log.showSignature=true` put "No signature" ahead of the commit records. The safe configuration pins those keys.
// Nothing else is claimed: keys such as `diff.context` or `core.quotePath` still change the bytes, not the index.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { git } = require('../skills/closed-loop-pr/driver/run');

// diff.srcPrefix and diff.dstPrefix exist from Git 2.45; an older Git ignores them, so those cases prove the pin only there.
const LOCAL = [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.diff', 'always'], ['color.ui', 'always'], ['diff.srcPrefix', 's/'], ['diff.dstPrefix', 'd/'], ['diff.renames', 'false'], ['log.showSignature', 'true']];

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i263-'));
  const raw = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const put = (name, text) => fs.writeFileSync(path.join(root, name), text);
  raw(['init', '-q', '-b', 'main']); raw(['config', 'user.name', 'i263']); raw(['config', 'user.email', 'i263@example.invalid']);
  return { root, raw, put };
}

test('Issue #263 the driver diff and commit log keep the pinned form whatever the checkout sets for those keys', () => {
  const { root, raw, put } = repo();
  try {
    put('e', ''); put('f.txt', 'one\n'); put('old.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n');
    raw(['add', '.']); raw(['commit', '-q', '-m', 'base']);
    const base = raw(['rev-parse', 'HEAD']);
    put('f.txt', 'two\n'); fs.rmSync(path.join(root, 'e')); raw(['mv', 'old.txt', 'new.txt']);
    raw(['add', '-A']); raw(['commit', '-q', '-m', 'head']);
    // A signed commit, so log.showSignature has something to show.
    const key = path.join(root, '.key');
    if (spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status === 0) {
      put('f.txt', 'three\n'); raw(['add', '-A']);
      raw(['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '-q', '-S', '-m', 'signed']);
    }
    const head = raw(['rev-parse', 'HEAD']);
    const read = () => [git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `${base}...${head}`], 'buffer').toString('utf8'), git(root, ['log', '-z', '--reverse', '--format=%H%n%B', `${base}..${head}`])];
    const plain = read();
    assert.match(plain[0], /^diff --git a\/e b\/e$/m, 'the baseline carries the a/ and b/ prefixes');
    assert.match(plain[0], /^rename to new\.txt$/m, 'the baseline detects the rename');
    for (const [setting, value] of LOCAL) {
      raw(['config', setting, value]);
      try { assert.deepEqual(read(), plain, `${setting}=${value} in the checkout changes nothing`); } finally { raw(['config', '--unset', setting]); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
