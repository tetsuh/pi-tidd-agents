'use strict';

// Issue #64 item 1 (CL-D72). The focused validation the parent used to run through its own shell and
// read by eye, packaged as one spawn that classifies its own outcome: `passed` (the command exited 0),
// `validation_failed` (it ran and exited nonzero by itself; code `validation_failed`, phase `validation`),
// or `harness_failed` (it could not run or did not finish — a spawn error, a signal, or the timeout; code
// `harness_failed`, phase `spawn`). Each is terminal for the caller under CL-D39. The command is an argv,
// never a shell string; the cwd is a Git toplevel; the environment is the package's sanitized one. The
// operation interprets nothing about the output: it reports bytes, a digest, and a bounded tail of each
// stream. This is the package's only spawn of anything but git and gh (CL-D37, the issue-59 model).

const path = require('node:path');
const crypto = require('node:crypto');
const { createResult, createError } = require('./protocol');
const { run, gitArgs } = require('./process');

const DEFAULT_TIMEOUT_MS = 600000, MAX_TIMEOUT_MS = 3600000, TAIL_BYTES = 4096;

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message, phase, details) { throw Object.assign(new Error(message), { code, phase, details }); }
function stream(buffer) {
  return { bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), tail: buffer.subarray(Math.max(0, buffer.length - TAIL_BYTES)).toString('utf8') };
}

async function validationRun(data) {
  const operation = 'validation_run';
  try {
    if (!plain(data)) fail('invalid_request', 'request data must be a plain object', 'request');
    if (typeof data.cwd !== 'string' || data.cwd.length === 0 || !path.isAbsolute(data.cwd)) fail('invalid_request', 'cwd must be an absolute path', 'request');
    if (!Array.isArray(data.command) || data.command.length === 0 || data.command.some((argument) => typeof argument !== 'string' || argument.length === 0)) fail('invalid_request', 'command must be an argv array of non-empty strings', 'request');
    if (Object.hasOwn(data, 'timeoutMs') && !(Number.isInteger(data.timeoutMs) && data.timeoutMs > 0 && data.timeoutMs <= MAX_TIMEOUT_MS)) fail('invalid_request', `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`, 'request');
    // The cwd is the toplevel of a work tree — the operator checkout or the run's workspace — and nothing
    // below it; a bare repository also answers an empty prefix, so the work tree is asked for as well
    // (ADV-124-BARE-REPOSITORY-ACCEPTED-AS-CHECKOUT).
    let answer;
    try { answer = (await run('git', gitArgs(['rev-parse', '--is-inside-work-tree', '--show-prefix']), { cwd: data.cwd, phase: 'cwd' })).stdout.toString('utf8').split('\n'); }
    catch (error) { fail('invalid_request', `cwd is not inside a Git checkout: ${error.message}`, 'cwd', { cwd: data.cwd }); }
    if (answer[0] !== 'true' || (answer[1] ?? '') !== '') fail('invalid_request', 'cwd must be the toplevel of a Git work tree', 'cwd', { cwd: data.cwd, insideWorkTree: answer[0], prefix: answer[1] ?? '' });
    const [program, ...args] = data.command;
    const started = Date.now();
    let result;
    try {
      result = await run(program, args, { cwd: data.cwd, kind: 'validation', timeout: data.timeoutMs ?? DEFAULT_TIMEOUT_MS, acceptAnyExit: true, phase: 'spawn' });
    } catch (error) {
      const reason = error.code === 'command_timeout' ? 'timeout' : error.signal ? `signal:${error.signal}` : error.spawnError || 'spawn';
      // The same stream evidence as every other outcome: what each stream held when the command stopped
      // (CONV-124-HARNESS-EVIDENCE).
      const streams = error.streams ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      return createError(operation, 'harness_failed', `the validation command could not run or did not finish: ${reason}`, 'spawn',
        { command: data.command, cwd: data.cwd, reason, exitCode: null, signal: error.signal ?? null, durationMs: Date.now() - started, stdout: stream(streams.stdout), stderr: stream(streams.stderr) });
    }
    const evidence = { command: data.command, cwd: data.cwd, exitCode: result.exitCode, signal: null, durationMs: Date.now() - started, stdout: stream(result.stdout), stderr: stream(result.stderr) };
    if (result.exitCode !== 0) return createError(operation, 'validation_failed', `the validation command ran and exited ${result.exitCode}`, 'validation', evidence);
    return createResult(operation, { outcome: 'passed', ...evidence });
  } catch (error) {
    return createError(operation, error.code || 'validation_run_failed', error.message, error.phase || operation, error.details);
  }
}

module.exports = { validationRun };
