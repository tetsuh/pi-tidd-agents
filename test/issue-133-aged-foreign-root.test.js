'use strict';

// Issue #133. The isolation-root removal of Issue #130 must never remove a root another process is using, and must not
// sweep by prefix or by age. A removal that also swept sibling `pi-tidd-pr-helper-*` roots older than a minute passed
// the Issue #130 regression and the whole suite: that regression's foreign root is created moments before the
// invocation, so no age-based sweep reached it. That same sweep, run once against the real temporary directory,
// removed 20,973 roots.
//
// Three things make this case behavioural rather than a check on source text. The live owner's root is aged before
// the invocation, so a sweep keyed on its modification time reaches it. A sweep keyed on anything else — change or
// birth time, which no process can move, or a name that merely sorts first — still has to list the parent or reach a
// sibling, so the invocation runs with every listing and removal primitive of `fs` and `fs.promises` recorded, each
// call by the path it names, resolved the way the kernel resolves it, and the case asserts that every such call was
// on its own root or inside it. And a listing or removal run by another program escapes those wrappers, so every
// program the invocation starts is recorded as well and must be Git. The wrappers sit on the module objects, so a call
// reaches them however a name is spelled, however `fs` was loaded, and from a worker thread too, which preloads them.
//
// A program recorded as Git can still run other programs, through an alias for instance, so the live owner's root is
// also checked for continuity. Its owner writes a token into it before the invocation; afterwards the root must still
// hold that token, and every entry in it must keep the identity and change time it had before, which a removal and
// re-creation, a copy back, a move aside and back, or damage inside the root does not. And the owner must answer a line
// afterwards with the token it reads from its root, so it is known to be alive and still using that root.
//
// What this does not observe, by the owner's decision on where this hardening stops (Issue #133): a removal delayed
// until after the invocation returns, which no single check made afterwards can see; a call made through the runtime's
// internal bindings rather than the public modules, refused by the Issue #59 structural boundary; and a listing or
// removal Git's children make that leaves the owner's root untouched, bounded by the Git command allowlist and the
// process isolation every packaged spawn runs under.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

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
const path = require('node:path');
const childProcess = require('node:child_process');
const { fileURLToPath } = require('node:url');
const log = process.env.ISSUE_133_LOG;
const append = fs.appendFileSync;
// A path is recorded by what it names, resolved the way the kernel resolves it: the longest leading part that exists is
// taken through realpath as spelled, so a symbolic link is followed before any '..' after it applies, and only the
// part that does not exist yet is appended. A byte path that is not valid UTF-8 cannot be named faithfully as text,
// so it is recorded as unnameable, which lies outside every root.
const spelled = (value) => (value instanceof URL ? fileURLToPath(value) : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value));
const identity = (value) => {
  if (value instanceof Uint8Array && !Buffer.from(spelled(value), 'utf8').equals(Buffer.from(value))) return '<undecodable>';
  let existing = spelled(value);
  if (!path.isAbsolute(existing)) existing = process.cwd() + path.sep + existing;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(existing), ...rest); } catch { /* not there yet: step up */ }
    const cut = existing.lastIndexOf(path.sep);
    if (cut <= 0) return '<unresolvable>';
    rest.unshift(existing.slice(cut + 1));
    existing = existing.slice(0, cut);
  }
};
const record = (entry) => { try { append(log, JSON.stringify(entry) + '\\n'); } catch { /* observing only */ } };
const wrap = (target, names) => { for (const name of names) { const original = target[name]; if (typeof original !== 'function') continue;
  target[name] = function (first, ...rest) { let where; try { where = identity(first); } catch { where = '<unresolvable>'; } record([name, where, spelled(first)]); return original.call(this, first, ...rest); }; } };
wrap(fs, ${JSON.stringify([...LISTING, ...REMOVAL])});
wrap(fs.promises, ${JSON.stringify(['readdir', 'opendir', 'glob', 'rm', 'rmdir', 'unlink'])});
// A listing or removal can also run in another process, which no wrapper in this one sees; so every program this
// process starts is recorded too, by the file it runs or, for a shell command, by the command line.
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) { const original = childProcess[name]; if (typeof original !== 'function') continue;
  childProcess[name] = function (file, ...rest) { record(['spawn', name, String(file)]); return original.call(this, file, ...rest); }; }
`;

// A repository holding one commit, so the invocation reaches the Git spawn that builds its own isolation root.
// Lines from a child, in order, with the stream decoded as UTF-8: a chunk boundary can fall inside a character, and
// decoding each chunk on its own replaces that character on both sides of the split, so the line read is not the line
// written (Issue #138).
function lineReader(child) {
  const lines = [];
  const waiting = [];
  let buffered = '';
  const decoder = new StringDecoder('utf8');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (let end = buffered.indexOf(String.fromCharCode(10)); end >= 0; end = buffered.indexOf(String.fromCharCode(10))) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const waiter = waiting.shift();
      if (waiter) waiter(line); else lines.push(line);
    }
  });
  const ended = new Promise((resolve) => child.on('close', (code, signal) => resolve(signal ?? code)));
  const nextLine = (what) => Promise.race([
    new Promise((resolve) => (lines.length > 0 ? resolve(lines.shift()) : waiting.push(resolve))),
    ended.then((end) => { throw new Error(`the child ended before ${what} (${end})`); }),
  ]);
  return { nextLine, ended };
}


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

test('Issue #138 a line split inside a character is read as it was written', { timeout: 30000 }, async () => {
  // The owner reports a path, and a path can carry any character the filesystem allows. Deliver the UTF-8 bytes through
  // a controlled stream one at a time: every multi-byte character is then split across data events, which is what
  // decoding each chunk on its own gets wrong. The decoder is deliberately applied by lineReader, as stream decoding is
  // applied by a real child stdout; the controlled stream keeps the split deterministic instead of relying on a pipe.
  const written = `/tmp/日本語-π-${String.fromCharCode(0xd83d, 0xde00)}/pi-tidd-pr-helper-Sm1i8J`;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  const { nextLine } = lineReader(child);
  const line = Buffer.from(written + String.fromCharCode(10), 'utf8');
  for (let at = 0; at < line.length; at += 1) child.stdout.emit('data', line.subarray(at, at + 1));
  child.emit('close', 0, null);
  assert.equal(await nextLine('it reported the line'), written, 'the line read is the line written');
});

test('Issue #133 an invocation beside a live owner\'s aged root touches nothing outside its own root', { timeout: 30000 }, async () => {
  const repository = fixtureRepository();
  // The recorder and its log live outside the parent, so they are not themselves siblings of any root.
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-133-observer-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-133-日本語-parent-'));
  const recorder = path.join(observer, 'recorder.js');
  const log = path.join(observer, 'calls.jsonl');
  fs.writeFileSync(recorder, RECORDER);
  fs.writeFileSync(log, '');
  const owner = spawn(process.execPath, ['-e', ([
    "const m = require(process.argv[1]); const fs = require('node:fs'); const path = require('node:path');",
    "const root = m.isolationPaths().root; const token = require('node:crypto').randomBytes(16).toString('hex');",
    "fs.writeFileSync(path.join(root, 'owner-sentinel'), token);",
    "const report = Buffer.from(`${root}\t${token}\n`); let at = 0; const writeReport = () => { if (at < report.length) { process.stdout.write(report.subarray(at, at + 1)); at += 1; setTimeout(writeReport, 1); } }; writeReport();",
    "process.stdin.setEncoding('utf8'); process.stdin.on('data', () => process.stdout.write(`${fs.readFileSync(path.join(root, 'owner-sentinel'), 'utf8')}\n`));",
    "process.stdin.on('end', () => process.exit(0));",
  ].join('')), PROCESS], {
    env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const { nextLine } = lineReader(owner);
    const [foreign, token] = (await nextLine('it reported its root')).split(String.fromCharCode(9));
    // `isolationPaths()` has written everything it writes before it returns, so this age is final.
    const twoHoursAgo = (Date.now() - 2 * HOUR) / 1000;
    fs.utimesSync(foreign, twoHoursAgo, twoHoursAgo);
    assert.ok(Date.now() - fs.statSync(foreign).mtimeMs > HOUR, 'the foreign root reads as old');
    // Taken before the invocation: a sweep that removed either would otherwise surface as a failed realpath rather
    // than as the assertion that names what it did.
    const parentIdentity = fs.realpathSync.native(parent);
    const foreignIdentity = fs.realpathSync.native(foreign);
    // Every entry of the owner's root, by identity and change time, taken after the ageing. A root removed and copied
    // back, moved aside and returned, or damaged inside can keep its token; it cannot keep all of this.
    const snapshot = () => {
      const describe = (rel, full) => { const s = fs.lstatSync(full, { bigint: true }); return [rel, s.dev, s.ino, s.ctimeNs, s.mtimeNs, s.size, s.mode].map(String); };
      const entries = [describe('.', foreign)];
      const walk = (dir, rel) => { for (const name of fs.readdirSync(dir).sort()) { const full = path.join(dir, name); entries.push(describe(path.join(rel, name), full)); if (fs.lstatSync(full).isDirectory()) walk(full, path.join(rel, name)); } };
      walk(foreign, '');
      return entries;
    };
    const before = snapshot();

    const run = spawnSync(process.execPath, ['-r', recorder, CLI], {
      input: JSON.stringify({ version: 1, operation: 'message_verify', data: { cwd: repository, expected: MESSAGE } }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent, ISSUE_133_LOG: log },
      // A blocking call keeps the test's own timeout from ever firing, so the invocation carries one of its own.
      timeout: 20000,
    });
    // Asserted first: an invocation that never reached Git would build no root and remove nothing, and everything
    // below would then be true for a reason unrelated to the removal.
    assert.equal(JSON.parse(run.stdout).ok, true, `${run.stdout}${run.stderr}`);

    const entries = fs.readFileSync(log, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line));
    const spawned = entries.filter(([kind]) => kind === 'spawn');
    const calls = entries.filter(([kind]) => kind !== 'spawn');
    // Every program the invocation starts is Git: a listing or removal run by any other program would escape the
    // wrappers above, so starting one is itself outside what the removal may do.
    assert.deepEqual(spawned.filter(([, , file]) => path.basename(file) !== 'git'), [], 'every program the invocation started was git');
    assert.ok(spawned.length > 0, 'the invocation did start Git, so the program record was live');
    // What the invocation may touch is its own root and what is inside it — and nothing else. How it removes that
    // tree is the runtime's business: Node 24 removes it in one native call, while Node 22 removes it in JavaScript
    // through the same public primitives, listing and unlinking inside it. A sweep of siblings, whatever it keys on,
    // has to list the parent or reach a sibling, and either is outside the one root it owns.
    const targets = calls.map(([, target]) => target);
    const topLevel = [...new Set(targets.filter((target) => path.dirname(target) === parentIdentity))];
    assert.equal(topLevel.length, 1, `the invocation touched exactly one path directly in its temporary parent: ${JSON.stringify(calls)}`);
    const own = topLevel[0];
    assert.ok(calls.some(([name, target]) => REMOVAL.includes(name) && target === own), 'that path is one it removed');
    assert.match(path.basename(own), /^pi-tidd-pr-helper-/, 'the path it removed is an isolation root');
    assert.notEqual(own, foreignIdentity, 'the path it removed is not the root the live process owns');
    const outside = calls.filter(([, target]) => target !== own && !target.startsWith(`${own}${path.sep}`));
    assert.deepEqual(outside, [], 'every listing and removal it made was of its own root or inside it');
    assert.equal(fs.existsSync(own), false, 'and its own root is gone');
    assert.equal(fs.existsSync(foreign), true, 'the aged root the live process owns is still there');
    // A path that still exists proves nothing about the directory behind it: a child of the Git the invocation starts
    // can remove the root and make a new one at the same name, and the freed inode is often reused at once. The owner
    // wrote a token into its root before the invocation; the root must still hold it.
    const sentinel = path.join(foreign, 'owner-sentinel');
    assert.equal(fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : null, token, 'the root still holds what its owner wrote before the invocation');
    assert.deepEqual(fs.existsSync(foreign) ? snapshot() : null, before, 'the owner\'s root is the same directory, every entry unchanged since before the invocation');

    // Alive, and still reading its own root: sent a line, the owner answers with the token that root holds. Signal 0
    // cannot show this: a child that has died but not been reaped still answers it, and afterwards the call only
    // returns false.
    owner.stdin.write(`still there${String.fromCharCode(10)}`);
    assert.equal(await nextLine('it answered after the invocation'), token, 'the owning process answered after the invocation with the token its root holds');
  } finally {
    if (owner.exitCode === null) owner.kill();
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(observer, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
