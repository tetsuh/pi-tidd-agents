'use strict';

const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DROP_ENV = /^(?:GIT_TRACE.*|GIT_CONFIG_|GIT_DIR$|GIT_COMMON_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_ALLOW_PROTOCOL$|GIT_ASKPASS$|SSH_ASKPASS$|GIT_SSH$|GIT_SSH_COMMAND$|GIT_SSH_VARIANT$|GIT_PROXY_COMMAND$|GIT_EXTERNAL_DIFF$|GIT_DIFF_OPTS$|GIT_PAGER$|PAGER$|GIT_EDITOR$|GIT_SEQUENCE_EDITOR$|GIT_EXEC_PATH$|GIT_CEILING_DIRECTORIES$|GIT_OPTIONAL_LOCKS$|GIT_CONFIG_NOSYSTEM$|GIT_CONFIG_GLOBAL$|GIT_CONFIG_SYSTEM$)/i;
const SAFE_GIT_CONFIG = [
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.hooksPath=',
  'credential.helper=',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'diff.external=',
  'color.ui=false',
];

let isolation;
function isolationError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.phase = 'process_isolation';
  if (cause) error.cause = cause;
  return error;
}
function samePath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function noFollowPath(target) {
  let absolute;
  try {
    if (typeof target !== 'string' || target.length === 0 || target.includes('\\0') || !path.isAbsolute(target)) throw new Error('invalid path');
    absolute = path.resolve(target);
  } catch (error) {
    throw isolationError('isolation_temp_invalid', 'temporary isolation path is invalid', error);
  }
  const root = path.parse(absolute).root;
  let current = absolute;
  try {
    while (true) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw isolationError('isolation_temp_unsafe_path', 'temporary isolation path contains a symbolic link');
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (error) {
    if (error.code?.startsWith('isolation_temp_')) throw error;
    throw isolationError('isolation_temp_invalid', 'temporary isolation path could not be validated', error);
  }
  return absolute;
}
function validateTemporaryParent() {
  let configured;
  try { configured = os.tmpdir(); } catch (error) {
    throw isolationError('isolation_temp_invalid', 'OS temporary directory could not be read', error);
  }
  const requested = noFollowPath(configured);
  let kind;
  try {
    const stat = fs.lstatSync(requested);
    kind = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other';
  } catch (error) {
    throw isolationError('isolation_temp_invalid', 'OS temporary directory could not be inspected', error);
  }
  if (kind !== 'directory') throw isolationError('isolation_temp_invalid', 'OS temporary directory must be an existing directory');

  let canonical;
  try { canonical = fs.realpathSync.native(requested); } catch (error) {
    throw isolationError('isolation_temp_invalid', 'OS temporary directory could not be canonicalized', error);
  }
  if (typeof canonical !== 'string' || !path.isAbsolute(canonical)) throw isolationError('isolation_temp_invalid', 'canonical OS temporary directory is not absolute');

  // A .git directory identifies a checkout, while a .git file identifies a
  // linked worktree. lstat is intentional: a hostile .git symlink is unsafe,
  // and must never be followed while proving that the parent is external.
  let current = canonical;
  while (true) {
    const marker = path.join(current, '.git');
    let markerStat;
    try { markerStat = fs.lstatSync(marker); } catch (error) {
      if (error.code !== 'ENOENT') throw isolationError('isolation_temp_unsafe_marker', 'Git checkout marker could not be safely inspected', error);
    }
    if (markerStat) throw isolationError('isolation_temp_inside_checkout', 'OS temporary directory is inside a Git checkout or worktree');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return canonical;
}
function validateCachedIsolation(value, temporaryParent) {
  if (!value || typeof value.root !== 'string' || !path.isAbsolute(value.root)) {
    throw isolationError('isolation_cache_invalid', 'cached process isolation paths are invalid');
  }
  const expected = {
    root: path.join(temporaryParent, path.basename(value.root)),
    home: path.join(value.root, 'home'),
    hooks: path.join(value.root, 'hooks'),
    emptyGlobal: path.join(value.root, 'global.gitconfig'),
    emptySystem: path.join(value.root, 'system.gitconfig'),
  };
  if (Object.values(expected).some((entry) => typeof entry !== 'string')
      || typeof value.home !== 'string' || typeof value.hooks !== 'string'
      || typeof value.emptyGlobal !== 'string' || typeof value.emptySystem !== 'string'
      || !samePath(value.root, expected.root)
      || !samePath(value.home, expected.home) || !samePath(value.hooks, expected.hooks)
      || !samePath(value.emptyGlobal, expected.emptyGlobal) || !samePath(value.emptySystem, expected.emptySystem)
      || !path.basename(value.root).startsWith('pi-tidd-pr-helper-')) {
    throw isolationError('isolation_cache_invalid', 'cached process isolation paths are invalid');
  }
  try {
    for (const [file, directory] of [[value.root, true], [value.home, true], [value.hooks, true], [value.emptyGlobal, false], [value.emptySystem, false]]) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('unexpected cached isolation entry');
    }
  } catch (error) {
    if (error.code === 'isolation_cache_invalid') throw error;
    throw isolationError('isolation_cache_invalid', 'cached process isolation paths could not be validated', error);
  }
  return value;
}
function isolationPaths() {
  const temporaryParent = validateTemporaryParent();
  if (isolation) return validateCachedIsolation(isolation, temporaryParent);

  let root;
  try { root = fs.mkdtempSync(path.join(temporaryParent, 'pi-tidd-pr-helper-')); }
  catch (error) { throw isolationError('isolation_create_failed', 'process isolation directory could not be created', error); }
  try {
    const home = path.join(root, 'home');
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(hooks, { mode: 0o700 });
    const emptyGlobal = path.join(root, 'global.gitconfig');
    const emptySystem = path.join(root, 'system.gitconfig');
    fs.writeFileSync(emptyGlobal, '', { mode: 0o600 });
    fs.writeFileSync(emptySystem, '', { mode: 0o600 });
    isolation = { root, home, hooks, emptyGlobal, emptySystem };
    return validateCachedIsolation(isolation, temporaryParent);
  } catch (error) {
    if (error.code?.startsWith('isolation_')) throw error;
    throw isolationError('isolation_create_failed', 'process isolation files could not be created', error);
  }
}

function sanitizedEnv(extra = {}, kind = 'git') {
  const env = {};
  for (const source of [process.env, extra]) {
    for (const [key, value] of Object.entries(source)) {
      if (!DROP_ENV.test(key)) env[key] = value;
    }
  }
  if (kind === 'git') {
    const iso = isolationPaths();
    env.HOME = iso.home;
    env.USERPROFILE = iso.home;
    env.XDG_CONFIG_HOME = iso.home;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = iso.emptyGlobal;
    env.GIT_CONFIG_SYSTEM = iso.emptySystem;
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_PAGER = 'cat';
    env.PAGER = 'cat';
  } else {
    // gh may use its normal authentication store, but inherited Git placement and
    // execution variables stay removed. The helper never prints auth material.
    env.GIT_TERMINAL_PROMPT = '0';
  }
  env.LC_ALL = 'C';
  env.LANG = 'C';
  return env;
}

function gitArgs(args, options = {}) {
  if (!Array.isArray(args)) throw new TypeError('git args must be an array');
  const hooks = options.hooksPath || isolationPaths().hooks;
  const config = SAFE_GIT_CONFIG.map((entry) => entry === 'core.hooksPath=' ? `core.hooksPath=${hooks}` : entry)
    .flatMap((entry) => ['-c', entry]);
  return [...config, '--no-pager', ...args];
}

function commandOptions(options, kind) {
  return {
    cwd: options.cwd,
    env: sanitizedEnv(options.env, kind),
    shell: false,
    timeout: options.timeout ?? 30000,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    encoding: options.encoding ?? 'utf8',
  };
}

function redact(text) {
  return String(text || '')
    .replace(/(authorization:\s*(?:bearer|token)\s+)[^\s]+/ig, '$1<redacted>')
    .replace(/([?&](?:access_token|token)=)[^&\s]+/ig, '$1<redacted>')
    .slice(0, 4096);
}

function safeError(error, command, options, stdout = '', stderr = '') {
  const safe = new Error(`command_failed:${path.basename(command)}:${error.code || error.signal || 'nonzero'}`);
  safe.code = error.code === 'ETIMEDOUT' || error.killed ? 'command_timeout' : 'command_failed';
  safe.phase = options.phase || 'process';
  safe.exitCode = Number.isInteger(error.status) ? error.status : null;
  safe.signal = error.signal || null;
  safe.stdout = redact(stdout);
  safe.stderr = redact(stderr);
  return safe;
}

function validateInvocation(command, args) {
  if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('command and string args are required');
  }
}

function run(command, args, options = {}) {
  try { validateInvocation(command, args); } catch (error) { return Promise.reject(error); }
  const kind = options.kind || (path.basename(command).toLowerCase().startsWith('gh') ? 'gh' : 'git');
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...commandOptions(options, kind), encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error && !(options.acceptExitCodes || []).includes(error.code)) {
        reject(safeError(error, command, options, stdout, stderr));
        return;
      }
      resolve({ stdout: Buffer.from(stdout || ''), stderr: Buffer.from(stderr || ''), exitCode: error?.code || 0 });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function runSync(command, args, options = {}) {
  validateInvocation(command, args);
  const kind = options.kind || (path.basename(command).toLowerCase().startsWith('gh') ? 'gh' : 'git');
  try {
    return execFileSync(command, args, {
      ...commandOptions(options, kind),
      encoding: options.encoding ?? 'utf8',
      input: options.stdin,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if ((options.acceptExitCodes || []).includes(error.status)) {
      return options.encoding === 'buffer' || options.encoding === null ? Buffer.from(error.stdout || '') : String(error.stdout || '');
    }
    throw safeError(error, command, options, error.stdout, error.stderr);
  }
}

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.phase = 'git_config_preflight';
  return error;
}
function parseNulConfig(output, scope) {
  const bytes = Buffer.from(output);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = [];
  let start = 0;
  try {
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0) continue;
      const record = bytes.subarray(start, index);
      if (record.length === 0) throw configError('malformed_git_config', `empty ${scope} Git configuration record`);
      const separator = record.indexOf(0x0a);
      if (separator <= 0) throw configError('malformed_git_config', `malformed ${scope} Git configuration record`);
      const key = decoder.decode(record.subarray(0, separator));
      const value = decoder.decode(record.subarray(separator + 1));
      if (!key.includes('.') || /[\u0000\n]/u.test(key)) {
        throw configError('malformed_git_config', `malformed ${scope} Git configuration key`);
      }
      entries.push({ key, value });
      start = index + 1;
    }
  } catch (error) {
    if (error.code === 'malformed_git_config') throw error;
    throw configError('non_utf8_git_config', `${scope} Git configuration contains non-UTF-8 bytes`);
  }
  if (start !== bytes.length) throw configError('malformed_git_config', `unterminated ${scope} Git configuration output`);
  return entries;
}
function worktreeConfigEnabled(entries) {
  const values = entries.filter(({ key }) => key.toLowerCase() === 'extensions.worktreeconfig').map(({ value }) => value);
  if (!values.length) return false;
  const value = values.at(-1).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0', ''].includes(value)) return false;
  throw configError('malformed_git_config', 'invalid extensions.worktreeConfig value');
}
function observeRepositoryConfig(cwd) {
  const localBytes = runSync('git', gitArgs(['config', '--local', '--null', '--list']), {
    cwd,
    phase: 'git_config_preflight',
    encoding: 'buffer',
  });
  const local = parseNulConfig(localBytes, 'local');
  const worktreeEnabled = worktreeConfigEnabled(local);
  const worktreeBytes = worktreeEnabled ? runSync('git', gitArgs(['config', '--worktree', '--null', '--list']), {
    cwd,
    phase: 'git_config_preflight',
    encoding: 'buffer',
  }) : Buffer.alloc(0);
  const worktree = worktreeEnabled ? parseNulConfig(worktreeBytes, 'worktree') : [];
  return { localBytes: Buffer.from(localBytes), worktreeBytes: Buffer.from(worktreeBytes), local, worktree };
}
function unsafeConfigKeys(entries) {
  return entries.map(({ key }) => key).filter((key) => /^(?:include(?:if)?\.|filter\.|credential\.|gpg\.|remote\..*\.(?:uploadpack|receivepack)|diff\..*\.(?:command|textconv))/i.test(key)
      || /^(?:core\.(?:fsmonitor|hooksPath|sshCommand)|commit\.gpgsign|tag\.gpgsign)$/i.test(key));
}
// CL-D52: branch-scoped configuration for branches other than the checked-out one is invisible
// to the stability digest. The reviewed run never reads a foreign branch's configuration — it
// pushes with explicit refspecs under sanitized environment — while ordinary linked-worktree
// development (push -u, checkout -b auto-tracking) writes exactly such entries into the shared
// config and was killing live reviews. Branch names may contain dots, so the subsection is
// everything between `branch.` and the final component. With a detached HEAD no branch is
// current and every branch section is ignored. The unsafe-key scan and the raw-byte
// double-read are deliberately not normalized.
function foreignBranchKey(key, currentBranch) {
  if (!/^branch\./i.test(key)) return false;
  const lastDot = key.lastIndexOf('.');
  if (lastDot <= 'branch.'.length - 1) return false;
  const name = key.slice('branch.'.length, lastDot);
  return currentBranch === null || name !== currentBranch;
}
function currentBranchName(cwd) {
  const ref = runSync('git', gitArgs(['symbolic-ref', '--quiet', 'HEAD']), {
    cwd,
    phase: 'git_config_preflight',
    acceptExitCodes: [1],
  }).trim();
  if (!ref) return null;
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    throw configError('malformed_branch_ref', 'checked-out branch symbolic ref is not a refs/heads/ name');
  }
  return ref.slice(prefix.length);
}
function frameConfigParts(observation, currentBranch = null) {
  const parts = [];
  const frame = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    parts.push(Buffer.from(`${bytes.length}:`, 'ascii'), bytes);
  };
  for (const [scope, entries] of [['local', observation.local], ['worktree', observation.worktree]]) {
    frame(scope);
    for (const { key, value } of entries) {
      if (foreignBranchKey(key, currentBranch)) continue;
      frame(key); frame(value);
    }
  }
  return Buffer.concat(parts);
}
function assertSafeRepositoryConfig(cwd) {
  const first = observeRepositoryConfig(cwd);
  const second = observeRepositoryConfig(cwd);
  const unsafe = [...unsafeConfigKeys(first.local), ...unsafeConfigKeys(first.worktree), ...unsafeConfigKeys(second.local), ...unsafeConfigKeys(second.worktree)];
  if (unsafe.length) {
    throw configError('unsafe_git_config', `unsafe repository Git configuration: ${[...new Set(unsafe)].sort().join(', ')}`);
  }
  if (!first.localBytes.equals(second.localBytes) || !first.worktreeBytes.equals(second.worktreeBytes)) {
    throw configError('git_config_unstable', 'repository Git configuration changed during preflight');
  }
  return crypto.createHash('sha256').update(frameConfigParts(first, currentBranchName(cwd))).digest('hex');
}

module.exports = { sanitizedEnv, run, runSync, gitArgs, isolationPaths, assertSafeRepositoryConfig };
