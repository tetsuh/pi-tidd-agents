'use strict';

// Issue #264 (follow-up to #263): a reviewed checkout's own `.git/config` could still change the diff and commit-log
// bytes the gates review. The owner's direction: a repository's settings are its own, so the package does not refuse
// them; it pins its own reads per invocation (`-c`), leaving the repository's configuration untouched. Attributes
// (`.gitattributes`, `.git/info/attributes`) are the repository's intent and are not overridden; nothing else is claimed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { git } = require('../skills/closed-loop-pr/driver/run');

// Each key changes the driver's bytes on this fixture before the pin (measured with Git 2.43): the algorithm and the
// indent heuristic only on contents chosen for them.
const LOCAL = [['diff.context', '0'], ['diff.interHunkContext', '8'], ['diff.suppressBlankEmpty', 'true'], ['core.quotePath', 'false'], ['core.abbrev', '12'],
  ['diff.algorithm', 'patience'], ['diff.algorithm', 'histogram'], ['diff.indentHeuristic', 'false'], ['diff.orderFile', '.git/order'], ['i18n.logOutputEncoding', 'ISO-8859-1']];

test('Issue #264 the driver diff and commit log keep the package form whatever the checkout sets for the remaining keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i264-'));
  try {
    const raw = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const put = (name, text) => fs.writeFileSync(path.join(root, name), text);
    raw(['init', '-q', '-b', 'main']); raw(['config', 'user.name', 'i264']); raw(['config', 'user.email', 'i264@example.invalid']);
    put('n.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n'); put('b.txt', 'x\n\n\ny\n'); put('日本.txt', 'base\n'); put('z.txt', 'z\n');
    put('alg.txt', '\nif (a)\n{\n}\n}\nreturn 0;\n{\nx\n{\n}\nif (a)\n'); put('ind.txt', 'y\nb();\n}\nb();\ny\nif (a)\n');
    raw(['add', '.']); raw(['commit', '-q', '-m', 'base']);
    const base = raw(['rev-parse', 'HEAD']);
    put('n.txt', '1\nTWO\n3\n4\n5\n6\n7\n8\n9\nTEN\n11\n12\n'); put('b.txt', 'x\n\nq\n\ny\n'); put('日本.txt', 'new\n'); put('z.txt', 'zz\n');
    put('alg.txt', 'x\n{\n\n\n}\nif (a)\nif (a)\n{\n}\n}\nreturn 0;\n{\nif (a)\nx\n{\n}\nif (a)\n'); put('ind.txt', 'y\n}\nreturn 0;\n\ny\nb();\n}\nb();\ny\nif (a)\n');
    raw(['add', '-A']); raw(['commit', '-q', '-m', 'ünïcode']);
    const head = raw(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(root, '.git', 'order'), 'z.txt\n');
    const read = () => [git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `${base}...${head}`], 'buffer').toString('utf8'), git(root, ['log', '-z', '--reverse', '--format=%H%n%B', `${base}..${head}`])];
    const plain = read();
    for (const [setting, value] of LOCAL) {
      raw(['config', setting, value]);
      try { assert.deepEqual(read(), plain, `${setting}=${value} in the checkout changes nothing`); } finally { raw(['config', '--unset', setting]); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The repository's settings stay its own: the pins ride on the package's command lines only, so the checkout's file
// keeps what the repository set.
test('Issue #264 the pins never write the checkout configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i264-own-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'diff.context', '0'], { cwd: root });
    const before = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    git(root, ['status', '--porcelain']);
    assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
