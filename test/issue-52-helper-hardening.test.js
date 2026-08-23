'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const processHelper = require('../skills/closed-loop-pr/helpers/process');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function gitVersionWithTrace(file, options = {}) {
  return processHelper.runSync('git', processHelper.gitArgs(['--version']), {
    phase: 'issue_52_trace_regression',
    ...options,
  });
}

test('Issue #52 sanitized environments remove inherited Git trace controls case-insensitively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue52-trace-env-'));
  const variants = [
    'GIT_TRACE',
    'GIT_TRACE2',
    'GIT_TRACE_PACKET',
    'Git_Trace',
    'git_trace2',
    'gIt_TrAcE_PeRfOrMaNcE',
    'GIT_trace2_event',
  ];
  try {
    for (const key of variants) {
      const previous = process.env[key];
      try {
        process.env[key] = path.join(root, `${key}.log`);
        for (const kind of ['git', 'gh']) {
          const env = processHelper.sanitizedEnv({}, kind);
          assert.deepEqual(
            Object.keys(env).filter((candidate) => /^git_trace/i.test(candidate)),
            [],
            `${kind} preserved inherited ${key}`,
          );
        }
      } finally {
        restoreEnv(key, previous);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #52 caller extras cannot reintroduce Git trace or mixed-case Git controls', () => {
  const env = processHelper.sanitizedEnv({
    GIT_TRACE: '/outside/trace',
    Git_Trace2_Event: '/outside/trace2',
    Git_Dir: '/outside/repository',
    Git_Config_Count: '1',
    SAFE_VALUE: 'preserved',
  }, 'git');
  assert.equal(env.SAFE_VALUE, 'preserved');
  assert.deepEqual(Object.keys(env).filter((key) => /^git_trace/i.test(key)), []);
  assert.deepEqual(Object.keys(env).filter((key) => /^git_dir$/i.test(key)), []);
  assert.equal(Object.hasOwn(env, 'Git_Config_Count'), false);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1', 'helper-owned safe config isolation remains present');
});

test('Issue #52 packaged Git execution cannot append to inherited or caller-supplied trace paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue52-trace-sentinel-'));
  const control = path.join(root, 'control.log');
  const inherited = path.join(root, 'inherited.log');
  const reinjected = path.join(root, 'reinjected.log');
  const initial = 'sentinel\n';
  const previous = process.env.GIT_TRACE;
  try {
    fs.writeFileSync(control, initial);
    execFileSync('git', ['--version'], {
      env: { ...process.env, GIT_TRACE: control, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'ignore',
    });
    assert.notEqual(fs.readFileSync(control, 'utf8'), initial, 'control must prove Git appends to GIT_TRACE');

    fs.writeFileSync(inherited, initial);
    process.env.GIT_TRACE = inherited;
    gitVersionWithTrace(inherited);
    assert.equal(fs.readFileSync(inherited, 'utf8'), initial, 'inherited trace destination must remain byte-identical');

    fs.writeFileSync(reinjected, initial);
    gitVersionWithTrace(reinjected, { env: { GIT_TRACE: reinjected } });
    assert.equal(fs.readFileSync(reinjected, 'utf8'), initial, 'caller extra env must not reintroduce a trace destination');
  } finally {
    restoreEnv('GIT_TRACE', previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
