'use strict';

// Issue #64 item 1 (CL-D72) — the packaged validation run separates "the command could not run" from
// "the command ran and reported failure", both terminal, with distinct codes and phases.
//
// TDD provenance: behavioral RED against a helper surface with no `validation_run` — the fixture repository
// and the child commands below ran before validation.js existed. The map, README, record, and manifest
// scenarios are compile/contract RED against absent prose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, sectionOf, cliSchemas, spawnCalls, spawnReferenceProblems } = require('./helpers');

const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const NODE = process.execPath;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function cli(operation, data) {
  const run = spawnSync(NODE, [CLI], { input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8' });
  return { ...JSON.parse(run.stdout), status: run.status };
}
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-repo-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 64 Test']);
  git(root, ['config', 'user.email', 'issue64@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'test: base']);
  return { root, head: git(root, ['rev-parse', 'HEAD']) };
}
const script = (code) => [NODE, '-e', code || '0'];
// Subdirectories whose names begin with a newline, created on demand where the file system allows them.
function newlineDirectories(root) {
  if (process.platform === 'win32') return [];
  const LF = String.fromCharCode(10);
  return [`${LF}sub`, LF].map((name) => { fs.mkdirSync(path.join(root, name), { recursive: true }); return [`a subdirectory named ${JSON.stringify(name)}`, path.join(root, name)]; });
}

test('Issue #64 validation_run reports passed, validation_failed, and harness_failed as distinct outcomes', async () => {
  const repo = repository();
  try {
    const passed = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write("ok\\n"); process.stderr.write("note\\n")') });
    assert.equal(passed.ok, true, JSON.stringify(passed.error));
    assert.equal(passed.data.outcome, 'passed');
    assert.equal(passed.data.exitCode, 0);
    assert.deepEqual(passed.data.stdout, { bytes: 3, sha256: sha256('ok\n'), tail: 'ok\n' }, 'stdout is reported by bytes, digest, and tail');
    assert.deepEqual(passed.data.stderr, { bytes: 5, sha256: sha256('note\n'), tail: 'note\n' });
    assert.equal(typeof passed.data.durationMs, 'number');
    assert.deepEqual(passed.data.command, script('process.stdout.write("ok\\n"); process.stderr.write("note\\n")'), 'the argv is echoed as run');

    const failed = await helpers.validationRun({ cwd: repo.root, command: script('process.stderr.write("bad\\n"); process.exit(3)') });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'validation_failed', JSON.stringify(failed.error));
    assert.equal(failed.error.phase, 'validation');
    assert.equal(failed.error.details.exitCode, 3);
    assert.equal(failed.error.details.stderr.tail, 'bad\n');
    assert.equal(failed.error.details.stderr.sha256, sha256('bad\n'), 'the failure carries the same evidence as a pass');

    // CONV-124-HARNESS-EVIDENCE: a harness failure carries the same stream evidence as every other outcome —
    // bytes, digest, and tail of whatever each stream held when the command stopped.
    const streams = (details) => { for (const name of ['stdout', 'stderr']) assert.deepEqual(Object.keys(details[name]).sort(), ['bytes', 'sha256', 'tail'], `${name} carries the stream evidence shape`); };
    const missing = await helpers.validationRun({ cwd: repo.root, command: [path.join(repo.root, 'no-such-validator')] });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'harness_failed', JSON.stringify(missing.error));
    assert.equal(missing.error.phase, 'spawn');
    assert.equal(missing.error.details.reason, 'ENOENT');
    assert.equal(missing.error.details.exitCode, null);
    streams(missing.error.details);
    assert.deepEqual(missing.error.details.stdout, { bytes: 0, sha256: sha256(''), tail: '' }, 'a program that never ran wrote nothing');
    // Pre-push adversarial review of 18eecdc (ADV-124-SYNC-SPAWN-ERROR-REASON-LOST): Node throws most spawn errors at once
    // instead of reporting them to the callback; each is still harness_failed at spawn, naming the system's own code, with
    // the stream evidence.
    if (process.platform !== 'win32') {
      const spawnErrors = [['a program path longer than the system allows', [`/${'p'.repeat(5000)}`], 'ENAMETOOLONG'], ['a program below a regular file', [path.join(repo.root, 'tracked.txt', 'validator')], 'ENOTDIR']];
      if (process.platform === 'linux') spawnErrors.push(['an argument longer than the kernel accepts', [...script(''), 'x'.repeat(200 * 1024)], 'E2BIG']);
      for (const [label, command, reason] of spawnErrors) {
        const thrown = await helpers.validationRun({ cwd: repo.root, command });
        assert.equal(thrown.ok, false, label);
        assert.deepEqual([thrown.error.code, thrown.error.phase, thrown.error.details.reason], ['harness_failed', 'spawn', reason], `${label}: ${JSON.stringify(thrown.error)}`);
        streams(thrown.error.details);
      }
    }

    const slow = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write("partial\\n"); process.stderr.write("still\\n"); setTimeout(() => {}, 5000)'), timeoutMs: 1500 });
    assert.equal(slow.error.code, 'harness_failed', JSON.stringify(slow.error));
    assert.equal(slow.error.phase, 'spawn');
    assert.equal(slow.error.details.reason, 'timeout');
    streams(slow.error.details);
    assert.deepEqual(slow.error.details.stdout, { bytes: 8, sha256: sha256('partial\n'), tail: 'partial\n' }, 'what the command wrote before the timeout is kept');
    assert.deepEqual(slow.error.details.stderr, { bytes: 6, sha256: sha256('still\n'), tail: 'still\n' });

    if (process.platform !== 'win32') {
      const killed = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write("before\\n", () => process.kill(process.pid, "SIGTERM")); setTimeout(() => {}, 2000)') });
      assert.equal(killed.error.code, 'harness_failed', JSON.stringify(killed.error));
      assert.equal(killed.error.details.reason, 'signal:SIGTERM');
      streams(killed.error.details);
      assert.deepEqual(killed.error.details.stdout, { bytes: 7, sha256: sha256('before\n'), tail: 'before\n' }, 'what the command wrote before the signal is kept');
    }
    // The two failure classes differ in code and in phase, as the acceptance criterion requires.
    assert.notEqual(failed.error.code, missing.error.code);
    assert.notEqual(failed.error.phase, missing.error.phase);
    // Pre-push adversarial review of 1b9328e: the harness's own bound decides, never the exit a killed command reports,
    // and the bound is enforced rather than advisory.
    if (process.platform !== 'win32') {
      for (const [label, code] of [
        ['a command that traps SIGTERM and exits 0 later', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 3000)'],
        ['a command that traps SIGTERM and exits 2 later', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(2), 3000)'],
        ['a command whose SIGTERM handler exits 130 at once', 'process.on("SIGTERM", () => process.exit(130)); setTimeout(() => {}, 3000)'],
      ]) {
        const started = Date.now();
        const bounded = await helpers.validationRun({ cwd: repo.root, command: script(code), timeoutMs: 500 });
        assert.equal(bounded.ok, false, `${label}: ${JSON.stringify(bounded)}`);
        assert.equal(bounded.error.code, 'harness_failed', `${label}: ${JSON.stringify(bounded.error)}`);
        assert.equal(bounded.error.details.reason, 'timeout', label);
        assert.ok(Date.now() - started < 2500, `${label}: the bound is enforced, not advisory (${Date.now() - started} ms)`);
      }
    }
    const flood = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write(Buffer.alloc(20 * 1024 * 1024, 97))') });
    assert.equal(flood.ok, false);
    assert.equal(flood.error.code, 'harness_failed', JSON.stringify(flood.error));
    assert.equal(flood.error.details.reason, 'output_limit', 'a stream beyond the capture bound is named as such');
    assert.ok(flood.error.details.stdout.bytes <= 16 * 1024 * 1024, 'the captured bytes stay within the bound');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('Issue #64 validation_run takes an argv, never a shell, and runs only at a Git toplevel', async () => {
  const repo = repository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-outside-'));
  // ADV-124-BARE-REPOSITORY-ACCEPTED-AS-CHECKOUT: an empty prefix is also what a bare repository answers.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-bare-'));
  git(bare, ['init', '-q', '--bare']);
  try {
    // No shell: a metacharacter argument reaches the program as text.
    const literal = await helpers.validationRun({ cwd: repo.root, command: [...script('process.stdout.write(process.argv[1])'), '$(echo expanded); `echo expanded`'] });
    assert.equal(literal.ok, true, JSON.stringify(literal.error));
    assert.equal(literal.data.stdout.tail, '$(echo expanded); `echo expanded`');
    // The environment is the validation allowlist: no terminal prompts from Git, and a real HOME for toolchains.
    const env = await helpers.validationRun({ cwd: repo.root, command: script('process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT}|${typeof process.env.HOME}|${process.env.LC_ALL}`)') });
    assert.equal(env.data.stdout.tail, '0|string|C');
    // ADV-124-VALIDATION-ENVIRONMENT-INHERITANCE: the validation child receives an explicit allowlist, never the inherited
    // environment, so an interpreter or loader hook, a credential, an agent socket, a command-resolution control, or any
    // other secret the parent inherited does not reach it; names match exactly off Windows.
    const VALIDATION_ENV_EXPECTED = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'USERNAME', 'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
    // Node propagates NODE_V8_COVERAGE from its own environment unless the child carries the name, so the hostile set
    // includes it and the directory it names must stay empty (pre-push review of 64f6fff).
    const coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-coverage-'));
    const hostile = { NODE_V8_COVERAGE: coverageDir, NODE_OPTIONS: '--max-old-space-size=4097', NODE_PATH: '/hostile/node', PYTHONPATH: '/hostile/py', PYTHONSTARTUP: '/hostile/start.py', PERL5LIB: '/hostile/perl', RUBYOPT: '-rhostile', JAVA_TOOL_OPTIONS: '-Dhostile', LD_PRELOAD: '/hostile/none.so', LD_LIBRARY_PATH: '/hostile/lib', DYLD_INSERT_LIBRARIES: '/hostile/x.dylib', GH_TOKEN: 'hostile', GITHUB_TOKEN: 'hostile', NPM_TOKEN: 'hostile', AWS_SECRET_ACCESS_KEY: 'hostile', SSH_AUTH_SOCK: '/hostile/agent.sock', GPG_AGENT_INFO: '/hostile/gpg', BASH_ENV: '/hostile/bashenv', ENV: '/hostile/env', CDPATH: '/hostile', npm_config_script_shell: '/hostile/sh', HOSTILE_SECRET: 'hostile', ...(process.platform === 'win32' ? {} : { path: '/hostile/bin', Node_Options: '--hostile' }) };
    const saved = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
    const probeEnv = [...script('const e = process.env; process.stdout.write(JSON.stringify({ keys: Object.keys(e).sort(), fixed: [e.LC_ALL, e.LANG, e.GIT_TERMINAL_PROMPT], samePath: e.PATH === process.argv[1], sameHome: e.HOME === process.argv[2] }))'), process.env.PATH ?? '', process.env.HOME ?? ''];
    Object.assign(process.env, hostile);
    let inherited;
    try { inherited = await helpers.validationRun({ cwd: repo.root, command: probeEnv }); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    assert.equal(inherited.ok, true, JSON.stringify(inherited.error));
    const seen = JSON.parse(inherited.data.stdout.tail);
    assert.deepEqual(Object.keys(hostile).filter((key) => seen.keys.includes(key)), [], 'no inherited hook, credential, socket, resolution control, or secret reaches the validation child');
    const allowedKeys = new Set([...VALIDATION_ENV_EXPECTED, 'GIT_TERMINAL_PROMPT', 'LC_ALL', 'LANG', ...(process.platform === 'win32' ? ['PATHEXT', 'ComSpec', 'LOGONSERVER', 'USERDOMAIN'] : [])]);
    assert.deepEqual(seen.keys.filter((key) => !allowedKeys.has(key)), [], 'the child environment holds only the allowlist and the fixed values');
    assert.deepEqual([seen.fixed, seen.samePath, seen.sameHome], [['C', 'C', '0'], true, true], "the locale is fixed, and PATH and HOME are the parent's");
    assert.deepEqual(fs.readdirSync(coverageDir), [], 'the inherited coverage hook wrote nothing');
    fs.rmSync(coverageDir, { recursive: true, force: true });
    assert.deepEqual(Object.keys(hostile).filter((key) => process.env[key] !== saved[key]), [], 'the fixture restored the parent environment');
    const overrides = require('../skills/closed-loop-pr/helpers/process').sanitizedEnv({ LC_ALL: 'tr_TR.UTF-8', LANG: 'tr_TR.UTF-8', GIT_TERMINAL_PROMPT: '1', NODE_V8_COVERAGE: '/hostile/coverage' }, 'validation');
    assert.deepEqual([overrides.LC_ALL, overrides.LANG, overrides.GIT_TERMINAL_PROMPT, Object.hasOwn(overrides, 'NODE_V8_COVERAGE'), overrides.NODE_V8_COVERAGE], ['C', 'C', '0', true, undefined], 'a caller extra cannot override the fixed values, and the coverage name stays present and undefined');
    // The Windows pinning is behaviour, not only source text: the environment builder takes the platform, so the branch
    // is exercised from any host (pre-push review of 30ce19a, surviving mutation M2b).
    const backslash = String.fromCharCode(92);
    const hostileWindows = { SystemRoot: 'C:/Windows', PATHEXT: '.HOSTILE', ComSpec: '/hostile/cmd.exe' };
    const windows = require('../skills/closed-loop-pr/helpers/process').validationEnv(hostileWindows, 'win32');
    assert.deepEqual([windows.PATHEXT, windows.ComSpec], ['.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC', ['C:', 'Windows', 'System32', 'cmd.exe'].join(backslash)], 'Windows pins the command-resolution controls to the system defaults');
    const withoutSystemRoot = require('../skills/closed-loop-pr/helpers/process').validationEnv({ PATHEXT: '.HOSTILE', ComSpec: '/hostile/cmd.exe' }, 'win32');
    assert.deepEqual([withoutSystemRoot.PATHEXT, Object.hasOwn(withoutSystemRoot, 'ComSpec')], ['.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC', false], 'without a system root there is no command shell to derive, and neither control is inherited');
    const posix = require('../skills/closed-loop-pr/helpers/process').validationEnv({ SystemRoot: 'C:/Windows', PATHEXT: '.HOSTILE' }, 'linux');
    assert.deepEqual([Object.hasOwn(posix, 'PATHEXT'), Object.hasOwn(posix, 'ComSpec'), posix.SystemRoot], [false, false, 'C:/Windows'], 'off Windows neither control exists and nothing is pinned');
    const processSource = readText('skills/closed-loop-pr/helpers/process.js');
    assert.ok(processSource.includes('env.NODE_V8_COVERAGE = undefined;'), 'the coverage name is carried as undefined, which is what stops Node propagating it');
    assert.ok(processSource.includes('env.PATHEXT = WINDOWS_PATHEXT;') && processSource.includes("env.ComSpec = path.win32.join(systemRoot, 'System32', 'cmd.exe');"), 'Windows pins the command-resolution controls instead of inheriting them');
    const extras = require('../skills/closed-loop-pr/helpers/process').sanitizedEnv({ NODE_OPTIONS: '--hostile', HOSTILE_SECRET: 'hostile', PATH: '/extra/bin' }, 'validation');
    assert.deepEqual([Object.keys(extras).filter((key) => !allowedKeys.has(key) && key !== 'NODE_V8_COVERAGE'), extras.PATH, Object.hasOwn(extras, 'NODE_V8_COVERAGE'), extras.NODE_V8_COVERAGE], [[], '/extra/bin', true, undefined], 'a caller extra passes the same allowlist, and the coverage name stays present and undefined');
    assert.ok(readText('skills/closed-loop-pr/helpers/process.js').includes(`const VALIDATION_ENV = [${VALIDATION_ENV_EXPECTED.map((name) => `'${name}'`).join(', ')}];`), 'the allowlist is the one the record names');
    // ADV-124-ARGV-EMPTY-ARGUMENT: an empty string after the program is an argument like any other, and it reaches the
    // child exactly as written, however many there are and wherever they stand.
    const echoArgv = script('process.stdout.write(JSON.stringify(process.argv.slice(1)))');
    const astral = String.fromCodePoint(0x1f600);
    const empties = await helpers.validationRun({ cwd: repo.root, command: [...echoArgv, '', 'a', '', '', astral] });
    assert.equal(empties.ok, true, JSON.stringify(empties.error));
    assert.equal(empties.data.stdout.tail, JSON.stringify(['', 'a', '', '', astral]), 'the child receives every empty argument, and a well-formed astral character, as written');
    assert.deepEqual(empties.data.command, [...echoArgv, '', 'a', '', '', astral], 'the evidence names the argv as run');
    // A well-formed astral character is a string like any other in every position (the review's surviving mutation M24b,
    // a surrogate check that refused paired surrogates too).
    const astralProgram = await helpers.validationRun({ cwd: repo.root, command: [`${NODE}${astral}`, '-e', '0'] });
    assert.deepEqual([astralProgram.error?.code, astralProgram.error?.phase], ['harness_failed', 'spawn'], `an astral program reaches the spawn: ${JSON.stringify(astralProgram.error)}`);
    const astralCwd = await helpers.validationRun({ cwd: `${repo.root}${astral}`, command: script('') });
    assert.deepEqual([astralCwd.error?.code, astralCwd.error?.phase], ['invalid_request', 'cwd'], `an astral cwd reaches the toplevel check: ${JSON.stringify(astralCwd.error)}`);
    const emptyViaCli = cli('validation_run', { cwd: repo.root, command: [...echoArgv, ''] });
    assert.equal(emptyViaCli.ok, true, JSON.stringify(emptyViaCli.error)); assert.equal(emptyViaCli.data.stdout.tail, '[""]');
    // Pre-push sweep of the request check: each field is read once and the command runs as that copy, so what the check
    // read, what the child receives, and what the evidence names are one argv, whatever the caller's array does.
    const NUL = String.fromCharCode(0), lone = String.fromCharCode(0xd800);
    let reads = 0;
    const flipping = [...echoArgv];
    Object.defineProperty(flipping, 3, { enumerable: true, get: () => (reads++ === 0 ? 'first' : `second${NUL}`) });
    const iterated = [...echoArgv, 'validated'];
    iterated[Symbol.iterator] = function* iterate() { yield* [...echoArgv, 'iterated']; };
    for (const [label, command, expected] of [['an argument getter that changes after its first read', flipping, 'first'], ['an argv whose own iterator yields other arguments', iterated, 'validated']]) {
      const once = await helpers.validationRun({ cwd: repo.root, command });
      assert.equal(once.ok, true, `${label}: ${JSON.stringify(once.error)}`);
      assert.deepEqual(JSON.parse(once.data.stdout.tail), [expected], `${label}: the child ran the argument the check read`);
      assert.deepEqual(once.data.command.slice(echoArgv.length), [expected], `${label}: the evidence names that argument`);
    }
    let cwdReads = 0;
    const movingCwd = { command: script('process.stdout.write(process.cwd())') };
    Object.defineProperty(movingCwd, 'cwd', { enumerable: true, get: () => (cwdReads++ === 0 ? repo.root : outside) });
    const cwdOnce = await helpers.validationRun(movingCwd);
    assert.equal(cwdOnce.ok, true, JSON.stringify(cwdOnce.error));
    assert.deepEqual([fs.realpathSync.native(cwdOnce.data.stdout.tail), cwdOnce.data.cwd], [fs.realpathSync.native(repo.root), repo.root], 'the cwd the check read is the one the child runs in and the evidence names');
    // Pre-push adversarial review of 18eecdc (ADV-124-INHERITED-TIMEOUT-UNVALIDATED): only the request's own fields count, so
    // an inherited value is neither validated nor used.
    const inheritedTimeout = await helpers.validationRun(Object.assign(Object.create({ timeoutMs: 300 }), { cwd: repo.root, command: script('setTimeout(() => {}, 1000)') }));
    assert.equal(inheritedTimeout.ok, true, `an inherited timeout is not the request's: ${JSON.stringify(inheritedTimeout.error)}`);
    const inheritedCwd = await helpers.validationRun(Object.assign(Object.create({ cwd: repo.root }), { command: script('') }));
    assert.deepEqual([inheritedCwd.ok, inheritedCwd.error?.code, inheritedCwd.error?.phase], [false, 'invalid_request', 'request'], "an inherited cwd is not the request's");
    const inheritedCommand = await helpers.validationRun(Object.assign(Object.create({ command: script('') }), { cwd: repo.root }));
    assert.deepEqual([inheritedCommand.ok, inheritedCommand.error?.code, inheritedCommand.error?.phase], [false, 'invalid_request', 'request'], "an inherited command is not the request's");
    // Pre-push adversarial review of 71934ff (ADV-124-TIMEOUT-OWNERSHIP-ASKED-TWICE): each field's ownership is asked once, so
    // a request cannot report a field absent to the check and present to the spawn; and an own field left undefined is
    // absent, as an optional field.
    const asks = {};
    const count = (kind, key) => { asks[`${kind}:${String(key)}`] = (asks[`${kind}:${String(key)}`] ?? 0) + 1; };
    const flippingOwnership = new Proxy({ cwd: repo.root, command: script('setTimeout(() => {}, 300)'), timeoutMs: 'bogus' }, {
      getOwnPropertyDescriptor: (target, key) => { count('own', key); return key === 'timeoutMs' && asks['own:timeoutMs'] === 1 ? undefined : Reflect.getOwnPropertyDescriptor(target, key); },
      get: (target, key, receiver) => { count('get', key); return Reflect.get(target, key, receiver); },
    });
    const ownedOnce = await helpers.validationRun(flippingOwnership);
    assert.equal(ownedOnce.ok, true, `a field reported absent is absent for the whole request: ${JSON.stringify(ownedOnce.error)}`);
    assert.ok(Object.values(asks).every((times) => times === 1), `each field is asked for and read at most once: ${JSON.stringify(asks)}`);
    const undefinedTimeout = await helpers.validationRun({ cwd: repo.root, command: script(''), timeoutMs: undefined });
    assert.equal(undefinedTimeout.ok, true, `an own timeoutMs left undefined is absent: ${JSON.stringify(undefinedTimeout.error)}`);
    // ADV-124-HOSTILE-ARGV-OBJECT-NOT-REFUSED-AT-REQUEST: a request that throws while it is read, or claims more arguments
    // than the bound, is refused at the request with an envelope.
    const throwing = { cwd: repo.root };
    Object.defineProperty(throwing, 'command', { enumerable: true, get: () => { throw new Error(''); } });
    const claimsHuge = new Proxy([NODE], { get: (target, key) => (key === 'length' ? 2 ** 32 : target[key]) });
    const claimsTooMany = new Proxy([NODE], { get: (target, key) => (key === 'length' ? 65537 : NODE) });
    const claimsTextLength = new Proxy([NODE, '-e', '0'], { get: (target, key) => (key === 'length' ? '3' : target[key]) });
    const claimsFractionalLength = new Proxy([NODE, '-e', '0'], { get: (target, key) => (key === 'length' ? 2.5 : target[key]) });
    for (const [label, data] of [['a field that throws while it is read', throwing], ['an argv claiming 2^32 elements', { cwd: repo.root, command: claimsHuge }], ['an argv of 65,537 elements', { cwd: repo.root, command: claimsTooMany }], ['an argv whose length is text', { cwd: repo.root, command: claimsTextLength }], ['an argv whose length is fractional', { cwd: repo.root, command: claimsFractionalLength }]]) {
      const hostile = await helpers.validationRun(data);
      assert.deepEqual([hostile.ok, hostile.error?.code, hostile.error?.phase], [false, 'invalid_request', 'request'], `${label}: ${JSON.stringify(hostile.error)}`);
    }
    if (process.platform === 'linux') {
      const atBound = await helpers.validationRun({ cwd: repo.root, command: [...script(''), ...Array.from({ length: 65536 - 3 }, () => '')] });
      assert.equal(atBound.ok, true, `an argv of exactly 65,536 elements runs: ${JSON.stringify(atBound.error)}`);
    }
    // The copy decides every outcome, not only a pass: the evidence of a spawn failure and of a nonzero exit names the
    // argument the check read, and the timeout the check read is the one enforced.
    for (const [label, prefix, code] of [['a program that does not exist', [path.join(repo.root, 'no-such-validator')], 'harness_failed'], ['a command that exits 3', script('process.exit(3)'), 'validation_failed']]) {
      let seen = 0;
      const moving = [...prefix];
      Object.defineProperty(moving, prefix.length, { enumerable: true, get: () => (seen++ === 0 ? 'first' : 'second') });
      const failedOnce = await helpers.validationRun({ cwd: repo.root, command: moving });
      assert.equal(failedOnce.error?.code, code, `${label}: ${JSON.stringify(failedOnce)}`);
      assert.deepEqual(failedOnce.error.details.command.slice(prefix.length), ['first'], `${label}: the evidence names the argument the check read`);
    }
    let timeoutReads = 0;
    const movingTimeout = { cwd: repo.root, command: script('setTimeout(() => {}, 3000)') };
    Object.defineProperty(movingTimeout, 'timeoutMs', { enumerable: true, get: () => (timeoutReads++ === 0 ? 500 : 600000) });
    const timeoutOnce = await helpers.validationRun(movingTimeout);
    assert.equal(timeoutOnce.error?.details?.reason, 'timeout', `the timeout the check read is the one enforced: ${JSON.stringify(timeoutOnce)}`);
    const holes = [...echoArgv]; holes[4] = 'after a hole';
    for (const [label, data] of [
      ['a shell string', { cwd: repo.root, command: 'npm test' }],
      ['an empty argv', { cwd: repo.root, command: [] }],
      ['an empty program', { cwd: repo.root, command: ['', '-e', '0'] }],
      ['a non-string argument', { cwd: repo.root, command: [NODE, 7] }],
      ['a hole in the argv', { cwd: repo.root, command: holes }],
      ['an argv whose own some() hides a non-string argument', { cwd: repo.root, command: Object.assign([NODE, '-e', '0', 7], { some: () => false }) }],
      ['a NUL inside an argument', { cwd: repo.root, command: [NODE, '-e', '0', 'a\u0000b'] }],
      ['a NUL inside the program', { cwd: repo.root, command: [`${NODE}${NUL}`, '-e', '0'] }],
      ['an argument that is not well-formed Unicode', { cwd: repo.root, command: [NODE, '-e', '0', `a${lone}`] }],
      ['a program that is not well-formed Unicode', { cwd: repo.root, command: [`${NODE}${lone}`, '-e', '0'] }],
      ['a NUL inside the cwd', { cwd: `${repo.root}${NUL}x`, command: script('') }],
      ['a cwd that is not well-formed Unicode', { cwd: `${repo.root}${lone}`, command: script('') }],
      ['a relative cwd', { cwd: 'sub', command: script('') }],
      ['a zero timeout', { cwd: repo.root, command: script(''), timeoutMs: 0 }],
      ['a timeout above the cap', { cwd: repo.root, command: script(''), timeoutMs: 3600001 }],
    ]) {
      const refused = await helpers.validationRun(data);
      assert.equal(refused.ok, false, `${label} must be refused`);
      assert.equal(refused.error.code, 'invalid_request', `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(refused.error.phase, 'request', label);
    }
    // Pre-push adversarial review of 18eecdc (ADV-124-CWD-NEWLINE-SUBDIR-ACCEPTED): a subdirectory whose name begins with a
    // newline answered an empty prefix line and passed as the toplevel.
    for (const [label, cwd] of [['a subdirectory of the checkout', path.join(repo.root, 'sub')], ['a directory outside any checkout', outside], ['a missing directory', path.join(repo.root, 'absent')], ['a bare repository', bare], ...newlineDirectories(repo.root)]) {
      const refused = await helpers.validationRun({ cwd, command: script('') });
      assert.equal(refused.ok, false, `${label} must be refused`);
      assert.equal(refused.error.code, 'invalid_request', `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(refused.error.phase, 'cwd', label);
    }
    // The refusal carries Git's whole answer, and a spawn error Node throws at once while the cwd is checked names its code.
    const belowTop = await helpers.validationRun({ cwd: path.join(repo.root, 'sub'), command: script('') });
    assert.equal(belowTop.error.details.answer, `true${String.fromCharCode(10)}sub/${String.fromCharCode(10)}`, 'the refusal carries the answer it compared');
    if (process.platform !== 'win32') {
      const underFile = await helpers.validationRun({ cwd: path.join(repo.root, 'tracked.txt', 'below'), command: script('') });
      assert.deepEqual([underFile.error.code, underFile.error.phase], ['invalid_request', 'cwd'], JSON.stringify(underFile.error));
      assert.match(underFile.error.message, /ENOTDIR/, 'the cwd refusal names the system code of a synchronous spawn error');
    }
    // Through the CLI, with exactly the declared request fields.
    assert.deepEqual(cliSchemas().validation_run, ['cwd', 'command'], 'the required request fields');
    assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /validation_run: \{ required: \['cwd', 'command'\], optional: \['timeoutMs'\] \}/, 'the timeout is the only optional field');
    const viaCli = cli('validation_run', { cwd: repo.root, command: script('process.exit(2)') });
    assert.equal(viaCli.ok, false); assert.equal(viaCli.error.code, 'validation_failed'); assert.equal(viaCli.status, 1);
    const viaCliPassed = cli('validation_run', { cwd: repo.root, command: script('') });
    assert.equal(viaCliPassed.ok, true, JSON.stringify(viaCliPassed.error)); assert.equal(viaCliPassed.status, 0);
    assert.equal(cli('validation_run', { cwd: repo.root, command: script(''), shell: true }).error.message, 'unknown request field: shell');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(bare, { recursive: true, force: true }); }
});

test('Issue #64 the map, the README, the recovery key, and the record name the packaged validation run', () => {
  const autofix = readText('skills/closed-loop-pr/references/autofix.md');
  const map = sectionOf(autofix, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map.includes("| The focused validation, in review-only's validation step and after the writer's edit (CL-D39, CL-D72) | `validation_run` | `cwd` (a Git toplevel), `command` (an argv, never a shell string), `timeoutMs` (optional) |"), 'the map offers validation_run with its fields');
  assert.ok(autofix.includes('| validation harness could not run (`validation_run` reports `harness_failed`) | `validation_run@focused_validation` | none | terminal | post-writer; all evidence stands |'), 'the recovery row names the packaged operation');
  assert.equal(autofix.includes('validation_harness@focused_validation'), false, 'the old key is gone');
  assert.match(readText('README.md'), /`validation_run` spawns the target's validation command as an argv at a Git toplevel under an explicit environment allowlist/);
  // ADV-124-REVIEW-ONLY-OPERATIONS-UNREACHABLE: each route's own authority names the operations it uses.
  assert.ok(readText('skills/closed-loop-pr/references/review-only.md').includes("Review-only's validation step runs each of the target's validation commands through packaged `validation_run`"), 'review-only names validation_run');
  assert.ok(readText('skills/closed-loop-shared/references/gate-contract.md').includes('On the PR root, the set itself is derived through packaged `required_evidence_set`'), 'the shared transport section names required_evidence_set');
  assert.ok(autofix.includes('The guarded focused validation runs through packaged `validation_run` (CL-D72).'), 'autofix names validation_run at the guarded step');
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D72 — The focused validation is packaged and the alarm is reset for it');
  for (const phrase of ['https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5654184082', 'https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5654208805', 'Option A on all three', "exactly one spawn site whose program is neither `git` nor the gh transports' literal `'gh'`, in `validation.js`", 'resets from 220,000 to 240,000 bytes', 'https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5662628859', 'the owner chose the step name', 'https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5663434628', 'a changed symlink or submodule pointer is excluded and named with its mode', 'https://github.com/tetsuh/pi-tidd-agents/issues/64#issuecomment-5670651510', 'a form outside this bound is not a finding against the guard', 'are refused as references of any form', "read from the syntax tree that Node's own bundled parser builds", 'A changed path whose bytes are not valid UTF-8 fails closed as `path_encoding`', 'a literal name counts as a reference wherever it is written', 'The timeout is enforced by SIGKILL and decides the outcome', 'a read beyond its bound fails closed as `output_limit` naming it', "the child's error stream goes to a file of its own in the package's isolation root, measured after the read and refused beyond 64 KiB", 'a threshold on what a read may carry rather than a cap on what Git may write', 'a read whose warnings pass that bound fails closed naming the error stream', 'the process spawner forwards a few Windows system variables of its own', '`absent` names only a file the head does not carry', "Each of the request's own fields is read once and the command runs as that copy", 'the argv holds at most 65,536 elements', 'a request that throws while it is read is refused at the request', 'an own field left undefined is absent', 'the child runs under an explicit environment allowlist rather than the inherited environment', 'whether an interpreter or loader hook, a credential, an agent socket, or a command-resolution control, is dropped', "while `git` and `gh` keep the package's sanitized environment", 'the validation environment carries the name itself and undefined', 'pinned to the system defaults rather than inherited', 'a subdirectory whose name begins with a newline is not mistaken for the toplevel', "a spawn error Node throws at once still carries the system's own code as its reason", 'every later argument is any string, the empty string included', 'which could not reach the child as written, is refused at the request']) assert.ok(record.includes(phrase), `CL-D72 record: ${phrase}`);
  const manifest = JSON.parse(readText('test/contract-clauses.json'));
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D72').map((clause) => clause.id), ['CL-D72-map', 'CL-D72-record', 'CL-D72-tests', 'CL-D72-route-review-only', 'CL-D72-route-shared', 'CL-D72-route-autofix']);
  // The structural rule the record states, read from the complete spawn call surface rather than a marker
  // (ADV-124-SPAWN-SITE-CHECK-MARKER-ONLY): every run/runSync call whose program is not the literal 'git' is
  // one of the two gh transports or the single validation site, and no site spawns through a shell.
  // Read at the source level, so a call split across lines is the same call (CONV-124-SPAWN-SCAN-MULTILINE-GAP).
  const helpersDir = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers');
  const sites = [];
  for (const file of fs.readdirSync(helpersDir).filter((name) => name.endsWith('.js')).sort()) {
    const source = fs.readFileSync(path.join(helpersDir, file), 'utf8');
    for (const call of spawnCalls(source)) {
      if (call.callee.startsWith('run') && call.args[0] !== "'git'") sites.push(`${file}|${call.args[0]}|${/kind: '([a-z]+)'/.exec(call.args[2] || '')?.[1] ?? 'inferred'}`);
    }
    assert.equal(/shell:\s*true/.test(source), false, `${file} never spawns through a shell`);
  }
  assert.deepEqual(sites, ["snapshot.js|'gh'|inferred", 'validation.js|program|validation', "writability.js|'gh'|inferred"], 'the two gh transports spawning only gh, and the one validation site, labelled as such');
  assert.deepEqual(spawnCalls("run(\n  'npm',\n  ['test'],\n  { kind: 'git' }\n);\nfunction run(a) {}\n// run('x', [])\n"), [{ callee: 'run', args: ["'npm'", "['test']", "{ kind: 'git' }"] }], 'the scanner reads a multiline call and ignores a definition and a comment');
  // ADV-124-SPAWN-SCANNER-ALIAS-BYPASS: the bound the record states. Every helper references a spawn primitive only by
  // direct call, and each shape that reached a program around the call surface is refused.
  for (const file of fs.readdirSync(helpersDir).filter((name) => name.endsWith('.js'))) assert.deepEqual(spawnReferenceProblems(file, fs.readFileSync(path.join(helpersDir, file), 'utf8')), [], `${file} references spawn primitives only by direct call`);
  for (const [label, file, source] of [
    ['an alias of run', 'launch.js', "const invoke = run;\ninvoke('npm', ['test'], { kind: 'validation' });\n"],
    ['an alias of execFileSync', 'process.js', "const direct = execFileSync;\n"],
    ['spawn destructured from child_process', 'process.js', "const { execFile, execFileSync, spawn } = require('node:child_process');\nspawn('npm', ['test']);\n"],
    ['a property call on child_process', 'launch.js', "require('node:child_process').spawnSync('npm', ['test']);\n"],
    ['run passed as a value', 'launch.js', "[run].forEach((f) => f('npm', ['test']));\n"],
    ['run.call', 'launch.js', "run.call(null, 'npm', ['test']);\n"],
    ['a transport call with another program', 'snapshot.js', "function defaultTransport(command, args) { return run(command, args); }\ntransport('npm', []);\n"],
    ['eval', 'launch.js', "eval(\"run('npm', [])\");\n"],
    ['a rename inside a destructured import', 'launch.js', "const { run: r } = require('./process');\nr('npm', ['test']);\n"],
    ['a dynamic load of child_process', 'launch.js', "module.constructor._load('node:child_process').spawnSync('npm', ['test']);\n"],
    ['a process binding', 'launch.js', "process.binding('spawn_sync').spawn({ file: 'npm' });\n"],
    // ADV-124-DYNAMIC-EXECUTION-GUARD-BYPASS: eval, the Function constructor, and process bindings are refused as
    // references of any form, not only as call syntax.
    ['global.Function', 'launch.js', "global.Function('return 1')();\n"],
    ['Function.call', 'launch.js', "Function.call(null, 'return 1')();\n"],
    ['eval.call', 'launch.js', "eval.call(null, '1');\n"],
    ['an indirect eval', 'launch.js', "(0, eval)('1');\n"],
    ['globalThis bracket eval', 'launch.js', "globalThis['eval']('1');\n"],
    ['the constructor of a function', 'launch.js', "(() => {}).constructor('return 1')();\n"],
    ['a bracketed process binding', 'launch.js', "process['binding']('spawn_sync');\n"],
    ['an alias of process', 'launch.js', "const p = process;\np.binding('spawn_sync');\n"],
    ['a binding destructured from process', 'launch.js', "const { binding } = process;\nbinding('spawn_sync');\n"],
    ['process.execve', 'launch.js', "process.execve('/bin/sh', ['sh']);\n"],
    // Pre-push adversarial review of 1b9328e: static literal references and module loaders.
    ['a computed string key on module.exports', 'process.js', "module.exports['run']('npm', ['test']);\n"],
    ['a computed template key on module.exports', 'process.js', "module.exports[`run`]('npm', ['test']);\n"],
    ['a computed key in a destructured import', 'guards.js', "const { ['run']: spawnProgram, gitArgs } = require('./process');\nspawnProgram('npm', ['test']);\n"],
    ['a rest element in a destructured import', 'guards.js', "const { gitArgs, ...rest } = require('./process');\nrest['run']('npm', []);\n"],
    ['getBuiltinModule with an escaped child_process', 'launch.js', "process.getBuiltinModule('node:child\\u005fprocess').spawnSync('npm', ['test']);\n"],
    ['getBuiltinModule for vm', 'launch.js', "process.getBuiltinModule('node:vm').runInThisContext('1');\n"],
    ['a binding reached through getBuiltinModule', 'launch.js', "process.getBuiltinModule('node:process').binding('spawn_sync');\n"],
    ['a computed binding call', 'launch.js', "someModule['execve']('/bin/sh', ['sh']);\n"],
    ['process.mainModule', 'launch.js', "process.mainModule.require('x');\n"],
    ['an escaped child_process require', 'launch.js', "require('node:child\\u005fprocess');\n"],
    ['a transport call beside a function-expression wrapper', 'snapshot.js', "const courier = function (command, args) { return run(command, args); };\ntransport('npm', []);\n"],
    // The second pre-push review of 5dfaee3.
    ['the GitHub forwarder called by its own name', 'snapshot.js', "defaultTransport('npm', ['x'], {});\n"],
    ['a spawn primitive named in a reflection call', 'process.js', "Reflect.get(module.exports, 'run')('npm', ['test']);\n"],
    ['a spawn primitive named in a property descriptor', 'process.js', "Object.getOwnPropertyDescriptor(module.exports, 'run').value('npm', []);\n"],
    ['the Function constructor named in a reflection call', 'launch.js', "Reflect.get(Object.getPrototypeOf((x) => x), 'constructor')('return 1')();\n"],
    ['require through call', 'launch.js', "require.call(null, 'node:vm');\n"],
    ['require through Reflect.apply', 'launch.js', "Reflect.apply(require, null, ['node:vm']);\n"],
  ]) assert.ok(spawnReferenceProblems(file, source).length > 0, `${label} is refused`);
  assert.deepEqual(spawnReferenceProblems('launch.js', "// run it later\nconst note = 'run the thing';\nconst pattern = /run\\(/;\nconst text = `run ${'x'}`;\n"), [], 'a comment, a string, a regular expression, and template text are not code');
  // ADV-124-SPAWN-SCANNER-ALIAS-BYPASS reopened: every context in which a slash was guessed is read by the grammar.
  for (const [label, source] of [
    ['a postfix increment before a division', "let x = 1, y = 2, invoke;\nx++ / (invoke = run) / y;\ninvoke('npm', ['test']);\n"],
    ['a postfix decrement before a division', "let x = 1, y = 2, invoke;\nx-- / (invoke = run) / y;\ninvoke('npm', ['test']);\n"],
    ['a regular expression after await', "async function f() { await /'/; const invoke = run; /'/; invoke('npm'); }\n"],
    ['a regular expression after yield', "function* f() { yield /'/; const invoke = run; /'/; invoke('npm'); }\n"],
    ['a regular expression after an if header', "if (a) /'/.test(b);\nconst invoke = run;\n/'/.test(c);\ninvoke('npm');\n"],
    ['a regular expression after a block', "{ }\n/'/.test(b);\nconst invoke = run;\n/'/.test(c);\ninvoke('npm');\n"],
    ['a regular expression after a comment', "x = /* c */ /'/;\nconst invoke = run;\n/'/;\ninvoke('npm');\n"],
    ['a template nested in a template expression', "const s = `${`${run}`}`;\n"],
  ]) assert.ok(spawnReferenceProblems('launch.js', source).some((problem) => problem.startsWith('spawn primitive referenced outside a direct call')), `${label} is refused`);
  assert.match(spawnReferenceProblems('launch.js', 'const = ;\n')[0], /^helper source does not parse: launch\.js: /, 'a source that does not parse is reported, never skipped');
});

// CL-D72, third choice: the gate's required-evidence set is derived, not assembled by hand — the paths the change
// touches that exist at the head, the two authority files, each identified by the SHA-256 of its blob at the head,
// plus the identity records the parent holds, unchanged.
function evidenceRepository({ authority = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-evidence-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 64 Test']);
  git(root, ['config', 'user.email', 'issue64@example.invalid']);
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
  if (authority) { write('CONTRACT.md', 'contract one\n'); write('README.md', 'readme\n'); }
  write('a.txt', 'a one\n'); write('deleted.txt', 'gone\n'); write('dir/b.txt', 'b\n');
  git(root, ['add', '.']); git(root, ['commit', '-q', '-m', 'test: base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  write('a.txt', 'a two\n'); if (authority) write('CONTRACT.md', 'contract two\n');
  write('new file.txt', 'new\n'); write('bin.dat', Buffer.from([0, 255, 1, 2, 10, 13]));
  // CONV-124-REQUIRED-EVIDENCE-SYMLINK-MISMATCH: a changed entry that is not a regular file.
  if (process.platform !== 'win32') fs.symlinkSync('a.txt', path.join(root, 'link'));
  // CONV-124-TAB-PATH-EVIDENCE-OMISSION: a legal name carrying a tab, which the NUL-delimited tree record
  // separates from its mode by a tab as well.
  if (process.platform !== 'win32') write('tab\there.txt', 'tabbed\n');
  fs.rmSync(path.join(root, 'deleted.txt'));
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'test: head']);
  return { root, base, head: git(root, ['rev-parse', 'HEAD']) };
}
const blobSha = (root, file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

test('Issue #64 required_evidence_set derives the set from the change and the authority files', () => {
  const repo = evidenceRepository();
  const bare = evidenceRepository({ authority: false });
  try {
    const identities = [
      { source: 'git:pr_base', kind: 'git', identity: repo.base }, { source: 'git:pr_head', kind: 'git', identity: repo.head },
      { source: 'github:pr:64:body', kind: 'github', identity: 'f'.repeat(64) }, { source: 'git:snapshot', kind: 'snapshot', identity: 'e'.repeat(64) },
    ];
    const derived = helpers.requiredEvidenceSet({ cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities });
    assert.equal(derived.ok, true, JSON.stringify(derived.error));
    const file = (source) => ({ source, kind: 'file', identity: blobSha(repo.root, source) });
    const tabbed = process.platform === 'win32' ? [] : [file('tab\there.txt')];
    assert.deepEqual(derived.data.requiredEvidence, [file('CONTRACT.md'), file('README.md'), file('a.txt'), file('bin.dat'), file('new file.txt'), ...tabbed, ...identities],
      'changed paths existing at the head, in byte order, then the authority files that did not change, then the identities as given; the deleted path and the untouched path are absent; a tab in a name is part of the name');
    assert.deepEqual(derived.data.authority, { included: ['CONTRACT.md', 'README.md'], absent: [], excluded: [] });
    // Owner option A (CL-D72): the derived set carries only what the checker can verify — regular blobs — and
    // names every changed entry it left out, with its mode.
    const link = process.platform === 'win32' ? [] : [{ source: 'link', mode: '120000' }];
    assert.deepEqual(derived.data.excluded, link, 'a changed symlink is excluded and named with its mode');
    assert.deepEqual([derived.data.changed, derived.data.files], [5 + link.length + tabbed.length, 5 + tabbed.length], 'the changed count includes the excluded entry; the file count does not');
    assert.deepEqual(helpers.requiredEvidenceSet({ cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities }), derived, 'the derivation is deterministic');
    // The derived set passes the packaged checks downstream exactly as a hand-assembled one would.
    assert.equal(helpers.requiredEvidenceCheck({ cwd: repo.root, requiredEvidence: derived.data.requiredEvidence }).ok, true);
    const expectation = helpers.buildGateExpectation({ workflow: 'pr', correlation: { repository: 'o/r', number: 64, baseOid: repo.base, headRepository: 'o/r', headBranch: 'b', headOid: repo.head, lifecycle: 'open', draft: false, gate: 'adversarial', invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'e'.repeat(64) }, assignedFindings: [], requiredEvidence: derived.data.requiredEvidence });
    assert.equal(expectation.ok, true, JSON.stringify(expectation.error));
    // A target without the authority files: reported as absent, not refused.
    const bareSet = helpers.requiredEvidenceSet({ cwd: bare.root, baseOid: bare.base, headOid: bare.head, identities: [] });
    assert.equal(bareSet.ok, true, JSON.stringify(bareSet.error));
    assert.deepEqual(bareSet.data.authority, { included: [], absent: ['CONTRACT.md', 'README.md'], excluded: [] });
    assert.deepEqual(bareSet.data.requiredEvidence.map((entry) => entry.source), ['a.txt', 'bin.dat', 'new file.txt', ...tabbed.map((entry) => entry.source)]);
    for (const [label, data, subcheck] of [
      ['a file-kind identity', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'a.txt', kind: 'file', identity: 'f'.repeat(64) }] }, 'identities_shape'],
      ['an unknown kind', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'x', kind: 'web', identity: 'f'.repeat(64) }] }, 'identities_shape'],
      ['an identity record with an extra key', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'x', kind: 'git', identity: repo.head, note: 'n' }] }, 'identities_shape'],
      ['a base that is not a commit here', { cwd: repo.root, baseOid: 'f'.repeat(40), headOid: repo.head, identities: [] }, 'commit_presence'],
      ['a head that is not an OID', { cwd: repo.root, baseOid: repo.base, headOid: 'main', identities: [] }, 'request_shape'],
      ['a cwd below the toplevel', { cwd: path.join(repo.root, 'dir'), baseOid: repo.base, headOid: repo.head, identities: [] }, 'cwd_toplevel'],
      ...newlineDirectories(repo.root).map(([label, cwd]) => [label, { cwd, baseOid: repo.base, headOid: repo.head, identities: [] }, 'cwd_toplevel']),
      ['a relative cwd', { cwd: 'relative/dir', baseOid: repo.base, headOid: repo.head, identities: [] }, 'request_shape'],
      ['a cwd carrying a NUL', { cwd: `${repo.root}\u0000x`, baseOid: repo.base, headOid: repo.head, identities: [] }, 'request_shape'],
      ['a head identity of another kind', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_head', kind: 'github', identity: repo.head }] }, 'identity_correlation'],
      ['two identities of one source', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_head', kind: 'git', identity: repo.head }, { source: 'git:pr_head', kind: 'git', identity: repo.head + '' }] }, 'required_evidence_shape'],
      // An identity the request repeats agrees with the argument it repeats, or the request is refused.
      ['a head identity disagreeing with headOid', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_head', kind: 'git', identity: repo.base }] }, 'identity_correlation'],
      ['a base identity disagreeing with baseOid', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities: [{ source: 'git:pr_base', kind: 'git', identity: repo.head }] }, 'identity_correlation'],
    ]) {
      const refused = helpers.requiredEvidenceSet(data);
      assert.equal(refused.ok, false, `${label} must be refused`);
      assert.equal(refused.error.code, 'invalid_request', `${label}: ${JSON.stringify(refused.error)}`);
      assert.equal(refused.error.details.subcheck, subcheck, `${label}: ${JSON.stringify(refused.error)}`);
    }
    if (process.platform === 'linux') {
      // ADV-124-NONUTF8-EVIDENCE-PATH-OMISSION: evidence names a path as text, so a changed path whose bytes are not
      // valid UTF-8 cannot be named losslessly; it fails closed by name, and two such names that decode alike never
      // stand in for each other.
      const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-nonutf8-'));
      try {
        git(odd, ['init', '-q', '-b', 'main']); git(odd, ['config', 'user.name', 'Issue 64 Test']); git(odd, ['config', 'user.email', 'issue64@example.invalid']);
        fs.writeFileSync(path.join(odd, 'a.txt'), 'a\n'); git(odd, ['add', '.']); git(odd, ['commit', '-q', '-m', 'test: base']);
        const oddBase = git(odd, ['rev-parse', 'HEAD']);
        const named = (byte) => Buffer.concat([Buffer.from(`${odd}/`), Buffer.from([0x66, byte, 0x2e, 0x74, 0x78, 0x74])]);
        fs.writeFileSync(named(0xfe), 'regular\n'); fs.symlinkSync('a.txt', named(0xff));
        git(odd, ['add', '-A']); git(odd, ['commit', '-q', '-m', 'test: head']);
        const refused = helpers.requiredEvidenceSet({ cwd: odd, baseOid: oddBase, headOid: git(odd, ['rev-parse', 'HEAD']), identities: [] });
        assert.equal(refused.ok, false, 'a changed path that is not valid UTF-8 is refused');
        assert.equal(refused.error.code, 'invalid_request', JSON.stringify(refused.error));
        assert.equal(refused.error.details.subcheck, 'path_encoding', JSON.stringify(refused.error));
        assert.match(refused.error.details.observed, /^66fe2e747874$/, 'the first such path is named by its bytes');
      } finally { fs.rmSync(odd, { recursive: true, force: true }); }
    }
    // Pre-push adversarial review of 1b9328e: the reads carry their own bounds rather than the 16 MiB process default,
    // and a present authority entry that is not a regular file is excluded with its mode, never reported absent.
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-bounds-'));
    try {
      git(big, ['init', '-q', '-b', 'main']); git(big, ['config', 'user.name', 'Issue 64 Test']); git(big, ['config', 'user.email', 'issue64@example.invalid']);
      fs.writeFileSync(path.join(big, 'small.txt'), 'small\n');
      // A listing beyond 16 MiB: thousands of paths three thousand bytes long, recorded straight into the index.
      const blob = execFileSync('git', ['hash-object', '-w', 'small.txt'], { cwd: big, encoding: 'utf8' }).trim();
      const deep = Array.from({ length: 15 }, (_, index) => `${String(index).padStart(2, '0')}${'d'.repeat(198)}`).join('/');
      const lines = Array.from({ length: 6000 }, (_, index) => `100644 ${blob}\t${deep}/f${index}\n`).join('');
      execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: big, input: lines });
      git(big, ['add', 'small.txt']); git(big, ['commit', '-q', '-m', 'test: base']);
      const bigBase = git(big, ['rev-parse', 'HEAD']);
      assert.ok(execFileSync('git', ['ls-tree', '-r', '-z', bigBase], { cwd: big, maxBuffer: 64 * 1024 * 1024 }).length > 16 * 1024 * 1024, 'the fixture listing exceeds 16 MiB');
      const large = Buffer.alloc(17 * 1024 * 1024, 120);
      fs.writeFileSync(path.join(big, 'large.bin'), large);
      if (process.platform !== 'win32') { fs.symlinkSync('small.txt', path.join(big, 'CONTRACT.md')); fs.mkdirSync(path.join(big, 'README.md')); fs.writeFileSync(path.join(big, 'README.md', 'inner.txt'), 'inner\n'); }
      git(big, ['add', 'large.bin', ...(process.platform !== 'win32' ? ['CONTRACT.md', 'README.md'] : [])]); git(big, ['commit', '-q', '-m', 'test: head']);
      const bounded = helpers.requiredEvidenceSet({ cwd: big, baseOid: bigBase, headOid: git(big, ['rev-parse', 'HEAD']), identities: [] });
      assert.equal(bounded.ok, true, JSON.stringify(bounded.error));
      assert.ok(bounded.data.requiredEvidence.some((entry) => entry.source === 'large.bin' && entry.identity === crypto.createHash('sha256').update(large).digest('hex')), 'a 17 MiB changed blob is derived with its digest');
      if (process.platform !== 'win32') assert.deepEqual(bounded.data.authority, { included: [], absent: [], excluded: [{ source: 'CONTRACT.md', mode: '120000' }, { source: 'README.md', mode: '040000' }] }, 'present authority entries that are not regular files are excluded with their modes');
    } finally { fs.rmSync(big, { recursive: true, force: true }); }
    // CONV-124-AUTHORITY-LISTING-UNBOUNDED, swept across the component: every Git read of the derivation goes through its
    // bounded reader, so none falls back to the process default and every overflow fails closed as output_limit.
    const guardsSource = readText('skills/closed-loop-pr/helpers/guards.js');
    const derivation = guardsSource.slice(guardsSource.indexOf('function requiredEvidenceSet('), guardsSource.indexOf('\nmodule.exports', guardsSource.indexOf('function requiredEvidenceSet(')));
    assert.deepEqual([...derivation.matchAll(/\bgit(?:Bytes|Text)\s*\(/g)].length, 1, 'the only direct Git read is the one inside the bounded reader');
    assert.deepEqual([...derivation.matchAll(/\bbounded\(\[/g)].map((match) => derivation.slice(match.index, derivation.indexOf(',', match.index + 9))), ["bounded(['rev-parse'", "bounded(['cat-file'", "bounded(['diff'", "bounded(['ls-tree'", "bounded(['ls-tree'", "bounded(['cat-file'", "bounded(['cat-file'"], 'the work-tree check, the commit checks, both listings, the size, and the blob are all bounded');
    // Pre-push adversarial review of 468ad1f: routing through the reader is not enough, so each read's own limit, the
    // constants, and the reader's hand-off to the spawn are pinned too.
    const readLimit = (at) => { let depth = 0, k = at + 'bounded('.length; do { if (derivation[k] === '[') depth += 1; else if (derivation[k] === ']') depth -= 1; k += 1; } while (depth > 0); return `${derivation.slice(at + 10, derivation.indexOf("'", at + 10))} ${derivation.slice(k).match(/^,\s*([^,]+),/)[1].trim()}`; };
    assert.deepEqual([...derivation.matchAll(/\bbounded\(\[/g)].map((match) => readLimit(match.index)), ['rev-parse SMALL_MAX_BYTES', 'cat-file SMALL_MAX_BYTES', 'diff LISTING_MAX_BYTES', 'ls-tree LISTING_MAX_BYTES', 'ls-tree LISTING_MAX_BYTES', 'cat-file SMALL_MAX_BYTES', 'cat-file BLOB_MAX_BYTES'], 'each read carries the bound the record names for it');
    assert.ok(guardsSource.includes('const LISTING_MAX_BYTES = 256 * 1024 * 1024, BLOB_MAX_BYTES = 256 * 1024 * 1024, SMALL_MAX_BYTES = 64 * 1024, WARNING_MAX_BYTES = 64 * 1024;'), 'the payload bounds are 256 MiB, 256 MiB, and 64 KiB, and Git\'s error stream is bounded at 64 KiB');
    assert.ok(derivation.includes('read = gitBytes(data.cwd, args, phase, acceptExitCodes, limit, noiseFd);') && derivation.includes('if (noise > WARNING_MAX_BYTES) { fs.truncateSync(noisePath, 0); fail(') && derivation.includes('const noisePath = isolationPaths().gitStderr;' + String.fromCharCode(10) + '      const noiseFd = fs.openSync(noisePath, ' + JSON.stringify(String.fromCharCode(39) + 'w' + String.fromCharCode(39)).slice(1, -1) + ');') && guardsSource.includes("runSync('git', gitArgs(args), { cwd, phase, encoding: 'buffer', acceptExitCodes, maxBuffer, stderrFd })"), 'the reader hands its limit to the spawn');
    // ADV-124-BLOB-BOUND-TRIPPED-BY-STDERR: a ref named after the head's hex makes Git warn on stderr, and a spawn's bound
    // applies to each of its streams, so a blob read bounded by the blob's own size failed as output_limit.
    const ambiguous = repository();
    try {
      fs.writeFileSync(path.join(ambiguous.root, 'tracked.txt'), 'changed\n'); git(ambiguous.root, ['commit', '-q', '-am', 'test: head']);
      const ambiguousHead = git(ambiguous.root, ['rev-parse', 'HEAD']);
      for (const ref of ['refs/tags/', 'refs/heads/', 'refs/remotes/', 'refs/']) {
        git(ambiguous.root, ['update-ref', `${ref}${ambiguousHead}`, ambiguousHead]);
        const warned = helpers.requiredEvidenceSet({ cwd: ambiguous.root, baseOid: ambiguous.head, headOid: ambiguousHead, identities: [] });
        assert.equal(warned.ok, true, `${ref}<head hex>: ${JSON.stringify(warned.error)}`);
        assert.deepEqual(warned.data.requiredEvidence.find((entry) => entry.source === 'tracked.txt'), { source: 'tracked.txt', kind: 'file', identity: sha256('changed\n') }, `${ref}<head hex>: the blob is derived with its digest`);
        git(ambiguous.root, ['update-ref', '-d', `${ref}${ambiguousHead}`]);
      }
    } finally { fs.rmSync(ambiguous.root, { recursive: true, force: true }); }
    assert.deepEqual(cliSchemas().required_evidence_set, ['cwd', 'baseOid', 'headOid', 'identities']);
    const viaCli = cli('required_evidence_set', { cwd: repo.root, baseOid: repo.base, headOid: repo.head, identities });
    assert.equal(viaCli.ok, true, JSON.stringify(viaCli.error)); assert.deepEqual(viaCli.data.requiredEvidence, derived.data.requiredEvidence);
    const map = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### Packaged helper invocation map (CL-D30, Issue #47)');
    assert.ok(map.includes("| Before `required_evidence_check`, deriving the gate's required-evidence set from the change and the authority files (CL-D72) | `required_evidence_set` | `cwd` (a Git toplevel), `baseOid`, `headOid`, `identities` (the git, GitHub, and snapshot records) |"), 'the map offers required_evidence_set with its fields');
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); fs.rmSync(bare.root, { recursive: true, force: true }); }
});

test('Issue #64 required_evidence_set fails closed as output_limit exactly beyond each bound', () => {
  // Pre-push adversarial review of 468ad1f: every overflow is observed, not only inferred from the reader's shape. The
  // trees are written object by object, so no index or checkout carries the long names.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-overflow-'));
  const MiB = 1024 * 1024;
  const feed = (args, input) => execFileSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * MiB }).trim();
  try {
    git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'Issue 64 Test']); git(root, ['config', 'user.email', 'issue64@example.invalid']);
    const blob = (content) => feed(['hash-object', '-w', '--stdin'], content);
    const tree = (entries) => feed(['mktree', '-z'], entries.map(([mode, type, oid, name]) => `${mode} ${type} ${oid}\t${name}\0`).join(''));
    const commit = (entries, parent) => feed(['commit-tree', tree(entries), ...(parent ? ['-p', parent] : []), '-m', 'test']);
    // Eleven thousand names under a hundred directories of 250 bytes each list at about 276 MB, beyond 256 MiB.
    const leaf = blob('x\n');
    let deep = tree(Array.from({ length: 11000 }, (_, index) => ['100644', 'blob', leaf, `f${index}`]));
    for (let level = 99; level >= 0; level -= 1) deep = tree([['040000', 'tree', deep, `${String(level).padStart(3, '0')}${'d'.repeat(247)}`]]);
    const small = (content) => ['100644', 'blob', blob(content), 'small.txt'];
    const shallow = commit([small('one\n')]);
    const wide = commit([['040000', 'tree', deep, 'deep'], small('one\n')], shallow);
    const wideHead = commit([['040000', 'tree', deep, 'deep'], small('two\n')], wide);
    git(root, ['update-ref', 'HEAD', shallow]);
    const overflow = (baseOid, headOid, observed, message) => {
      const result = helpers.requiredEvidenceSet({ cwd: root, baseOid, headOid, identities: [] });
      assert.equal(result.ok, false, `${observed}: ${JSON.stringify(result.data)}`);
      assert.deepEqual([result.error.code, result.error.details.subcheck, result.error.details.observed, result.error.message], ['output_limit', 'output_limit', observed, `output_limit: ${message}`]);
    };
    overflow(wide, wideHead, 'the tree listing', 'the tree listing exceeds 268435456 bytes');
    overflow(shallow, wideHead, 'the changed-path listing', 'the changed-path listing exceeds 268435456 bytes');
    // A blob of exactly 256 MiB is derived with its digest; one byte more fails before it is read.
    const exactBytes = Buffer.alloc(256 * MiB, 120);
    const exact = feed(['hash-object', '-w', '--stdin'], exactBytes);
    const over = feed(['hash-object', '-w', '--stdin'], Buffer.alloc(256 * MiB + 1, 120));
    const withExact = commit([small('one\n'), ['100644', 'blob', exact, 'exact.bin']], shallow);
    const withOver = commit([small('one\n'), ['100644', 'blob', exact, 'exact.bin'], ['100644', 'blob', over, 'over.bin']], withExact);
    // Pre-push review of 64f6fff: the synchronous read counts both streams against one bound, so Git's own warning
    // could turn a blob that is exactly at the bound into an overflow. A ref named after the head makes Git warn.
    git(root, ['update-ref', `refs/tags/${withExact}`, withExact]);
    const derived = helpers.requiredEvidenceSet({ cwd: root, baseOid: shallow, headOid: withExact, identities: [] });
    assert.equal(derived.ok, true, JSON.stringify(derived.error));
    assert.deepEqual(derived.data.requiredEvidence, [{ source: 'exact.bin', kind: 'file', identity: crypto.createHash('sha256').update(exactBytes).digest('hex') }], 'a blob at the bound is derived');
    overflow(withExact, withOver, 'over.bin', 'a changed file exceeds 268435456 bytes');
    // Pre-push review of the warning bound (ADV7-1): an adverse repository can make Git write far more than the bound on
    // stderr while the payload stays small, and the refusal must name that rather than the payload.
    const noisy = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-64-noisy-'));
    try {
      git(noisy, ['init', '-q', '-b', 'main']); git(noisy, ['config', 'user.name', 'Issue 64 Test']); git(noisy, ['config', 'user.email', 'issue64@example.invalid']);
      fs.writeFileSync(path.join(noisy, 'tracked.txt'), 'base' + String.fromCharCode(10)); git(noisy, ['add', 'tracked.txt']); git(noisy, ['commit', '-q', '-m', 'test: base']);
      const noisyBase = git(noisy, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(noisy, 'tracked.txt'), 'head' + String.fromCharCode(10)); git(noisy, ['commit', '-q', '-am', 'test: head']);
      // Each unreadable alternate makes Git print the whole path on every object read, and it still exits 0.
      fs.writeFileSync(path.join(noisy, '.git', 'objects', 'info', 'alternates'), Array.from({ length: 100 }, (_, index) => `/nonexistent/${index}/${'x'.repeat(3000)}`).join(String.fromCharCode(10)) + String.fromCharCode(10));
      const noisyHead = git(noisy, ['rev-parse', 'HEAD']);
      const noise = (count) => { fs.writeFileSync(path.join(noisy, '.git', 'objects', 'info', 'alternates'), Array.from({ length: count }, (_, index) => `/nonexistent/${index}/${'x'.repeat(3000)}`).join(String.fromCharCode(10)) + String.fromCharCode(10)); return spawnSync('git', ['cat-file', '-t', noisyHead], { cwd: noisy, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' } }).stderr.length; };
      // Under the warning bound the read still succeeds, and the warnings are neither counted against the payload nor
      // silently buffered beyond the bound.
      const quiet = noise(10);
      assert.ok(quiet > 0 && quiet < 65536, `the quiet fixture writes warnings within the bound: ${quiet}`);
      const accepted = helpers.requiredEvidenceSet({ cwd: noisy, baseOid: noisyBase, headOid: noisyHead, identities: [] });
      assert.equal(accepted.ok, true, `warnings within the bound do not refuse the read: ${JSON.stringify(accepted.error)}`);
      const loud = noise(40);
      assert.ok(loud > 65536, `the loud fixture writes warnings beyond the bound: ${loud}`);
      // Unreadable alternates of equal length cost equal warning bytes, so the fixture can land on the bound itself: at
      // 65,536 bytes the read is accepted, and one byte more refuses it. Git truncates a path beyond the system limit,
      // so the tuning adds lines and adjusts only the remainder on the last one.
      const alternates = (paths) => { fs.writeFileSync(path.join(noisy, '.git', 'objects', 'info', 'alternates'), paths.join(String.fromCharCode(10)) + String.fromCharCode(10)); return spawnSync('git', ['cat-file', '-t', noisyHead], { cwd: noisy, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' } }).stderr.length; };
      const alternate = (index, pad) => `/nonexistent/${String(index).padStart(4, '0')}/${'x'.repeat(pad)}`;
      const perLine = alternates([alternate(0, 500)]);
      assert.ok(perLine > 500 && perLine < 2000, `one unreadable alternate writes one warning: ${perLine}`);
      const lines = Math.floor(65536 / perLine);
      const paths = Array.from({ length: lines }, (_, index) => alternate(index, 500));
      const remainder = 65536 - lines * perLine;
      paths[lines - 1] = alternate(lines - 1, 500 + remainder);
      assert.equal(alternates(paths), 65536, 'the fixture writes exactly the bound');
      const atBound = helpers.requiredEvidenceSet({ cwd: noisy, baseOid: noisyBase, headOid: noisyHead, identities: [] });
      assert.equal(atBound.ok, true, `warnings exactly at the bound are accepted: ${JSON.stringify(atBound.error)}`);
      paths[lines - 1] = alternate(lines - 1, 500 + remainder + 1);
      assert.equal(alternates(paths), 65537, 'one byte more than the bound');
      const overBound = helpers.requiredEvidenceSet({ cwd: noisy, baseOid: noisyBase, headOid: noisyHead, identities: [] });
      assert.deepEqual([overBound.ok, overBound.error?.code], [false, 'output_limit'], `one byte past the bound refuses: ${JSON.stringify(overBound)}`);
      alternates(Array.from({ length: 40 }, (_, index) => alternate(index, 3000)));
      const drowned = helpers.requiredEvidenceSet({ cwd: noisy, baseOid: noisyBase, headOid: noisyHead, identities: [] });
      assert.equal(drowned.ok, false, 'a read drowned in Git warnings fails closed');
      assert.deepEqual([drowned.error.code, drowned.error.details.subcheck], ['output_limit', 'output_limit'], JSON.stringify(drowned.error));
        assert.match(drowned.error.message, /Git wrote [0-9]+ bytes on its error stream while reading baseOid, beyond the 65536 bytes allowed/, `the refusal names the stream that overflowed and what it was reading: ${drowned.error.message}`);
    } finally { fs.rmSync(noisy, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Issue #64 the isolation root validates its error-stream file like every other entry', () => {
  const processHelper = require('../skills/closed-loop-pr/helpers/process');
  const isolation = processHelper.isolationPaths();
  assert.equal(isolation.gitStderr, path.join(isolation.root, 'git-stderr'), 'the error-stream file belongs to the isolation root');
  const plants = [
    ['a directory', () => { fs.rmSync(isolation.gitStderr, { force: true }); fs.mkdirSync(isolation.gitStderr); }],
    ['an absent file', () => { fs.rmSync(isolation.gitStderr, { force: true }); }],
    ...(process.platform === 'win32' ? [] : [['a symlink', () => { fs.rmSync(isolation.gitStderr, { force: true }); fs.symlinkSync(path.join(isolation.root, 'home'), isolation.gitStderr); }]]),
  ];
  for (const [label, plant] of plants) {
    plant();
    try {
      assert.throws(() => processHelper.isolationPaths(), (error) => error.code === 'isolation_cache_invalid', `${label} at the error-stream path must be refused`);
    } finally {
      fs.rmSync(isolation.gitStderr, { recursive: true, force: true });
      fs.writeFileSync(isolation.gitStderr, '', { mode: 0o600 });
    }
  }
  assert.equal(processHelper.isolationPaths().gitStderr, isolation.gitStderr, 'the restored cache validates again');
});
