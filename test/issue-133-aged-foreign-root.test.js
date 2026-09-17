'use strict';

// Issue #133. The isolation-root removal of Issue #130 must never remove a root another process is using, and must not
// sweep by prefix or by age. A removal that also swept sibling `pi-tidd-pr-helper-*` roots older than a minute passed
// the Issue #130 regression and the whole suite: that regression's foreign root is created moments before the
// invocation, so no age-based sweep reached it. That same sweep, run once against the real temporary directory,
// removed 20,973 roots.
//
// Two things make this case behavioural rather than a check on source text. The live owner's root is aged before the
// invocation, so a sweep keyed on its modification time reaches it. And a sweep keyed on anything else — change or
// birth time, which no process can move, or a name that merely sorts first — still has to list the parent before it
// can remove a sibling. So the invocation runs with every listing and removal primitive of `fs` recorded, and the
// case asserts that every path it listed or removed was its own root or inside it. The primitives are wrapped on the module object, so a call reaches
// the recorder however its name is spelled or however `fs` was loaded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const PROCESS = path.join(repoRoot, 'skills', 'closed-loop-pr', 'helpers', 'process.js');
const MESSAGE = `feat: s (#133)${String.fromCharCode(10)}`;
const HOUR = 60 * 60 * 1000;
const LISTING = ['readdirSync', 'readdir', 'opendirSync', 'opendir', 'globSync', 'glob'];
const REMOVAL = ['rmSync', 'rm', 'rmdirSync', 'rmdir', 'unlinkSync', 'unlink'];

// Preloaded into the invocation. It observes and never changes a result: each wrapped call is recorded, one line per
// call, through the original append, and then made exactly as it would have been.
const RECORDER = `'use strict';
const fs = require('node:fs');
const log = process.env.ISSUE_133_LOG;
const append = fs.appendFileSync;
const wrap = (target, names) => { for (const name of names) { const original = target[name]; if (typeof original !== 'function') continue;
  target[name] = function (first, ...rest) { try { append(log, JSON.stringify([name, String(first)]) + '\\n'); } catch { /* observing only */ } return original.call(this, first, ...rest); }; } };
wrap(fs, ${JSON.stringify([...LISTING, ...REMOVAL])});
wrap(fs.promises, ${JSON.stringify(['readdir', 'opendir', 'glob', 'rm', 'rmdir', 'unlink'])});
`;

// A repository holding one commit, so the invocation reaches the Git spawn that builds its own isolation root.
function fixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-133-repo-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  });
  git('init', '-q', '-b', 'main', '.');
  const file = path.join(root, 'message.txt');
  fs.writeFileSync(file, Buffer.from(MESSAGE, 'utf8'));
  git('commit', '-q', '--allow-empty', '-F', file, '--cleanup=whitespace');
  return root;
}

test('Issue #133 an invocation beside a live owner\'s aged root touches nothing outside its own root', { timeout: 30000 }, async () => {
  const repository = fixtureRepository();
  // The recorder and its log live outside the parent, so they are not themselves siblings of any root.
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-133-observer-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-133-parent-'));
  const recorder = path.join(observer, 'recorder.js');
  const log = path.join(observer, 'calls.jsonl');
  fs.writeFileSync(recorder, RECORDER);
  fs.writeFileSync(log, '');
  const owner = spawn(process.execPath, ['-e', ([
    "const m = require(process.argv[1]);",
    "process.stdout.write(`${m.isolationPaths().root}\n`);",
    "process.stdin.resume();",
    "process.stdin.on('end', () => process.exit(0));",
  ].join('')), PROCESS], {
    env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const foreign = await new Promise((resolve, reject) => {
      let buffered = '';
      owner.stdout.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        const end = buffered.indexOf(String.fromCharCode(10));
        if (end >= 0) resolve(buffered.slice(0, end));
      });
      owner.on('error', reject);
      owner.on('exit', (code) => reject(new Error(`the owning process ended before it reported its root (${code})`)));
    });
    // `isolationPaths()` has written everything it writes before it returns, so this age is final.
    const twoHoursAgo = (Date.now() - 2 * HOUR) / 1000;
    fs.utimesSync(foreign, twoHoursAgo, twoHoursAgo);
    assert.ok(Date.now() - fs.statSync(foreign).mtimeMs > HOUR, 'the foreign root reads as old');

    const run = spawnSync(process.execPath, ['-r', recorder, CLI], {
      input: JSON.stringify({ version: 1, operation: 'message_verify', data: { cwd: repository, expected: MESSAGE } }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent, ISSUE_133_LOG: log },
    });
    // Asserted first: an invocation that never reached Git would build no root and remove nothing, and everything
    // below would then be true for a reason unrelated to the removal.
    assert.equal(JSON.parse(run.stdout).ok, true, `${run.stdout}${run.stderr}`);

    const calls = fs.readFileSync(log, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line));
    // What the invocation may touch is its own root and what is inside it — and nothing else. How it removes that
    // tree is the runtime's business: Node 24 removes it in one native call, while Node 22 removes it in JavaScript
    // through the same public primitives, listing and unlinking inside it. A sweep of siblings, whatever it keys on,
    // has to list the parent or reach a sibling, and either is outside the one root it owns.
    const targets = calls.map(([, target]) => target);
    const topLevel = [...new Set(targets.filter((target) => path.dirname(target) === parent))];
    assert.equal(topLevel.length, 1, `the invocation touched exactly one path directly in its temporary parent: ${JSON.stringify(calls)}`);
    const own = topLevel[0];
    assert.ok(calls.some(([name, target]) => REMOVAL.includes(name) && target === own), 'that path is one it removed');
    assert.match(path.basename(own), /^pi-tidd-pr-helper-/, 'the path it removed is an isolation root');
    assert.notEqual(own, foreign, 'the path it removed is not the root the live process owns');
    const outside = calls.filter(([, target]) => target !== own && !target.startsWith(`${own}${path.sep}`));
    assert.deepEqual(outside, [], 'every listing and removal it made was of its own root or inside it');
    assert.equal(fs.existsSync(own), false, 'and its own root is gone');
    assert.equal(fs.existsSync(foreign), true, 'the aged root the live process owns is still there');

    // The owner is signalled with 0 rather than read from `exitCode`: the invocation blocked this loop, so an exit that
    // happened meanwhile may not have been processed yet.
    assert.doesNotThrow(() => owner.kill(0), 'the owning process was still alive across the invocation');
  } finally {
    if (owner.exitCode === null) owner.kill();
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(observer, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
