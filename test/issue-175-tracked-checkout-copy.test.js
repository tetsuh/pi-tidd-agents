'use strict';

// Issue #175 — test/issue-164-map-split.test.js copied the whole checkout with a filter that excluded only `.git`
// and `node_modules`, so a review-only run's validation read the contents of pi's runtime roots `.pi/` and
// `.pi-subagents/`, which review-only classifies no-follow and excludes from evidence. A gpt-6-luna parent
// noticed and stopped BLOCKED on PR #173. A test that needs the checkout copies tracked content only.
//
// TDD provenance: RED is compile/contract for the first case — the shared helper does not exist before the
// change, so it cannot be called — and contract for the second. The first case also pins the old filter's
// second defect: `/.git` matched `/.github` and `/.gitignore`, and both are tracked content that must be copied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = require('./helpers');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
}
function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function listFiles(root) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return found.sort();
}

test('Issue #175 copying the checkout copies tracked content and nothing else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-175-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-175-dst-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'skills/a.md', 'tracked\n');
    write(root, '.github/workflows/ci.yml', 'tracked\n');
    write(root, '.gitignore', 'ignored.log\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'base']);
    // What a reviewed checkout carries besides its tracked content.
    write(root, '.pi/session/secret.json', '{"private":true}\n');
    write(root, '.pi-subagents/run/output.log', 'child output\n');
    write(root, 'ignored.log', 'ignored\n');
    write(root, 'scratch.txt', 'untracked\n');

    helpers.copyTrackedCheckout(root, path.join(dest, 'copy'));

    assert.deepEqual(listFiles(path.join(dest, 'copy')), ['.github/workflows/ci.yml', '.gitignore', 'skills/a.md'],
      'the runtime roots, ignored files, and untracked files are never read into the copy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('Issue #175 the map-split test copies through the shared helper', () => {
  const source = helpers.readText('test/issue-164-map-split.test.js');
  assert.match(source, /copyTrackedCheckout\(repoPath\('\.'\), copy\)/);
  assert.equal(source.includes("fs.cpSync(repoPath('.')"), false, 'no test copies the whole checkout recursively');
  for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js') && name !== path.basename(__filename))) {
    assert.equal(helpers.readText(`test/${file}`).includes("cpSync(repoPath('.')"), false, `${file} copies the whole checkout`);
  }
});
