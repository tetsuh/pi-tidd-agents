'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { repoRoot, repoPath, readJson, readText } = require('./helpers');
const { createWorkspace } = require('../skills/closed-loop-pr/helpers/workspace');

const HELPER_DIR = 'skills/closed-loop-pr/helpers';
const HELPER_FILES = [
  'builders.js', 'cli.js', 'composition.js', 'evidence.js', 'fingerprints.js', 'gate-result.js', 'guards.js', 'index.js', 'operator.js', 'paths.js',
  'process.js', 'protocol.js', 'reply.js', 'snapshot.js', 'workspace.js', 'writability.js',
].map((name) => `${HELPER_DIR}/${name}`);
const ALLOWED_OPERATIONS = [
  'build_fingerprint_snapshot', 'build_gate_expectation', 'build_operator_revalidate', 'build_workspace_cleanup',
  'build_workspace_verify', 'evidence_verify', 'guard_before_edit', 'manifest_compare', 'overlay_compare', 'overlay_freeze', 'fingerprint_issue_spec', 'fingerprint_pr_base', 'fingerprint_pr_commits', 'fingerprint_pr_diff',
  'fingerprint_pr_head', 'fingerprint_pr_tree', 'fingerprint_snapshot', 'gate_result_validate',
  'marker_create', 'marker_reconcile',
  'operator_capture', 'operator_revalidate', 'snapshot', 'workspace_cleanup', 'workspace_create',
  'workspace_verify', 'writability',
].sort();
const FORBIDDEN_OPERATION = /(?:^|_)(?:commit|push|merge|reply|approve|thread_resolve|schedule|state_write)(?:_|$)/;
const SCHEDULING_OR_STATE = /\b(?:setInterval|setTimeout|setImmediate|queueMicrotask|scheduler|node-schedule|cron|node:timers|node:sqlite|sqlite3|level|lmdb|globalThis)\b/;
const APPROVED_FS_SITES = [
  "skills/closed-loop-pr/helpers/cli.js|const fs = require('node:fs');",
  'skills/closed-loop-pr/helpers/cli.js|const input = fs.readFileSync(0);',
  "skills/closed-loop-pr/helpers/paths.js|const fs = require('node:fs');",
  'skills/closed-loop-pr/helpers/paths.js|const stat = fs.lstatSync(file);',
  'skills/closed-loop-pr/helpers/paths.js|if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`symlink path component rejected: ${current}`);',
  "skills/closed-loop-pr/helpers/process.js|const fs = require('node:fs');",
  'skills/closed-loop-pr/helpers/process.js|const stat = fs.lstatSync(current);',
  'skills/closed-loop-pr/helpers/process.js|const stat = fs.lstatSync(requested);',
  'skills/closed-loop-pr/helpers/process.js|try { canonical = fs.realpathSync.native(requested); } catch (error) {',
  'skills/closed-loop-pr/helpers/process.js|try { markerStat = fs.lstatSync(marker); } catch (error) {',
  'skills/closed-loop-pr/helpers/process.js|const stat = fs.lstatSync(file);',
  "skills/closed-loop-pr/helpers/process.js|try { root = fs.mkdtempSync(path.join(temporaryParent, 'pi-tidd-pr-helper-')); }",
  'skills/closed-loop-pr/helpers/process.js|fs.mkdirSync(home, { mode: 0o700 });',
  'skills/closed-loop-pr/helpers/process.js|fs.mkdirSync(hooks, { mode: 0o700 });',
  "skills/closed-loop-pr/helpers/process.js|fs.writeFileSync(emptyGlobal, '', { mode: 0o600 });",
  "skills/closed-loop-pr/helpers/process.js|fs.writeFileSync(emptySystem, '', { mode: 0o600 });",
  "skills/closed-loop-pr/helpers/workspace.js|const fs = require('node:fs');",
  "skills/closed-loop-pr/helpers/workspace.js|fs.writeFileSync(target, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });",
  "skills/closed-loop-pr/helpers/workspace.js|return JSON.parse(fs.readFileSync(target, 'utf8'));",
  'skills/closed-loop-pr/helpers/workspace.js|function canon(file) { return fs.realpathSync.native(file); }',
  "skills/closed-loop-pr/helpers/workspace.js|try { root = fs.mkdtempSync(path.join(canonicalParent, 'pi-autofix-helper-')); }",
  'skills/closed-loop-pr/helpers/workspace.js|try { fs.mkdirSync(root, { recursive: false, mode: 0o700 }); }',
  'skills/closed-loop-pr/helpers/workspace.js|if (!fs.existsSync(worktrees)) return [];',
  'skills/closed-loop-pr/helpers/workspace.js|return fs.readdirSync(worktrees).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((name) => ({ name, kind: lstatKind(path.join(worktrees, name)) }));',
  "skills/closed-loop-pr/helpers/workspace.js|} catch (error) { return createError('workspace', 'clone_fallback_failed', error.message, 'workspace_clone', { retainedPath: fs.existsSync(clonePath) ? clonePath : null }); }",
  "skills/closed-loop-pr/helpers/workspace.js|if (fs.existsSync(actual.path) || parseWorktrees(repositoryCwd).some((item) => item.worktree === actual.path)) return createError('workspace_cleanup', 'cleanup_incomplete', 'workspace removal was incomplete', 'workspace_cleanup');",
  'skills/closed-loop-pr/helpers/workspace.js|fs.unlinkSync(receipt.storedPath);',
].sort();
const EXPECTED_REQUIRE_COUNTS = {
  './builders': 1, './composition': 2, './evidence': 1, './fingerprints': 2, './gate-result': 2, './guards': 1, './index': 1, './operator': 2,
  './paths': 3, './process': 5, './protocol': 12, './reply': 1, './snapshot': 1, './workspace': 2, './writability': 1,
  'node:child_process': 1, 'node:crypto': 6, 'node:fs': 4, 'node:os': 2, 'node:path': 4,
};
const ALLOWED_GIT_COMMANDS = new Set(['cat-file', 'checkout', 'clone', 'config', 'diff', 'ls-files', 'ls-tree', 'remote', 'rev-parse', 'status', 'symbolic-ref', 'worktree']);
const PROVENANCE_ANCHORS = [
  [`${HELPER_DIR}/process.js`, 'const temporaryParent = validateTemporaryParent();'],
  [`${HELPER_DIR}/process.js`, "const home = path.join(root, 'home');"],
  [`${HELPER_DIR}/process.js`, "const hooks = path.join(root, 'hooks');"],
  [`${HELPER_DIR}/process.js`, "const emptyGlobal = path.join(root, 'global.gitconfig');"],
  [`${HELPER_DIR}/process.js`, "const emptySystem = path.join(root, 'system.gitconfig');"],
  [`${HELPER_DIR}/workspace.js`, "function receiptPath(root) { return path.join(root, '.cleanup-receipt.json'); }"],
  [`${HELPER_DIR}/workspace.js`, 'const target = receiptPath(root);', 2],
  [`${HELPER_DIR}/workspace.js`, 'const root = allocateRoot(runRoot, repository);'],
];
const ROOT_GUARDS = [
  [
    `${HELPER_DIR}/process.js`,
    "if (markerStat) throw isolationError('isolation_temp_inside_checkout', 'OS temporary directory is inside a Git checkout or worktree');",
  ],
  [`${HELPER_DIR}/workspace.js`, "if (isInside(canonical, repository)) runRootError('workspace_inside_repository', 'run root must be external');"],
  [`${HELPER_DIR}/workspace.js`, "if (isInside(canonicalParent, repository)) runRootError('workspace_inside_repository', 'run root must be external');"],
  [`${HELPER_DIR}/workspace.js`, "if (isInside(requested, repository)) runRootError('workspace_inside_repository', 'run root must be external');"],
  [`${HELPER_DIR}/workspace.js`, "if (isInside(root, repository)) runRootError('workspace_inside_repository', 'run root must be external');"],
];
const AGGREGATE_SMOKE_ALARM = 200000; // CL-D57 planned-growth reset from 160,000 (CL-D53) for the guard family
const PER_FILE_SMOKE_ALARM = 30000;

function normalizedLine(line) { return line.trim().replace(/\s+/g, ' '); }
function parseOperations(cliSource) {
  const block = cliSource.match(/const SCHEMAS = Object\.freeze\(\{([\s\S]*?)^\}\);/m);
  if (!block) return [];
  return [...block[1].matchAll(/^\s{2}([a-z][a-z0-9_]*):\s*\{/gm)].map((match) => match[1]).sort();
}
function sourceFsSites(sources) {
  const sites = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const line of source.split(/\r?\n/)) if (/\bfs\b/.test(line)) sites.push(`${file}|${normalizedLine(line)}`);
  }
  return sites.sort();
}
function requireInventory(sources) {
  const counts = {};
  let calls = 0;
  let literals = 0;
  for (const source of Object.values(sources)) {
    calls += (source.match(/\brequire\s*\(/g) || []).length;
    for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      literals += 1;
      counts[match[1]] = (counts[match[1]] || 0) + 1;
    }
  }
  return { calls, literals, counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) };
}
function gitCommands(sources) {
  const commands = [];
  const pattern = /\b(?:git|gitRaw|gitText|gitBuffer|collect|gitArgs)\s*\([^[]*?\[([^\]]*)\]/gs;
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(pattern)) {
      const args = [...match[1].matchAll(/['"]([^'"]*)['"]/g)].map((entry) => entry[1]);
      let index = 0;
      while (index < args.length) {
        if (args[index] === '-c') { index += 2; continue; }
        if (args[index] === '--no-replace-objects' || args[index] === '--no-pager') { index += 1; continue; }
        break;
      }
      if (args[index]) commands.push({ file, command: args[index] });
    }
  }
  return commands;
}
function validateBoundary(model) {
  const errors = [];
  for (const field of ['main', 'bin', 'exports']) if (model.manifest[field] !== undefined) errors.push(`package ${field} is forbidden`);
  if (model.manifest.pi?.extensions !== undefined) errors.push('pi.extensions is forbidden');

  const operations = parseOperations(model.sources[`${HELPER_DIR}/cli.js`]);
  if (JSON.stringify(operations) !== JSON.stringify(ALLOWED_OPERATIONS)) errors.push('CLI operation table differs from the verification-only allowlist');
  for (const operation of operations) if (FORBIDDEN_OPERATION.test(operation)) errors.push(`provider/writer operation is forbidden: ${operation}`);

  const sites = sourceFsSites(model.sources);
  if (JSON.stringify(sites) !== JSON.stringify(APPROVED_FS_SITES)) errors.push('filesystem access callsites differ from the reviewed allowlist');
  const required = requireInventory(model.sources);
  if (required.calls !== required.literals || JSON.stringify(required.counts) !== JSON.stringify(EXPECTED_REQUIRE_COUNTS)) errors.push('module import callsites differ from the reviewed allowlist');
  for (const [file, source] of Object.entries(model.sources)) {
    if (SCHEDULING_OR_STATE.test(source) || /\bimport\s*\(/.test(source)) errors.push(`scheduling or durable-state primitive is forbidden: ${file}`);
    if (/\breceipt\s*\.\s*(?:storedPath|root)\s*=|\b(?:Object\.assign|Reflect\.set)\s*\(\s*receipt\b|\bdelete\s+receipt\s*\./.test(source)) errors.push(`workspace receipt provenance mutation is forbidden: ${file}`);
  }
  for (const { file, command } of gitCommands(model.sources)) if (!ALLOWED_GIT_COMMANDS.has(command)) errors.push(`Git command is outside the reviewed verification/lifecycle allowlist: ${file}:${command}`);
  for (const [file, anchor, expectedCount = 1] of PROVENANCE_ANCHORS) {
    const count = model.sources[file].split(anchor).length - 1;
    if (count !== expectedCount) errors.push(`write-root provenance anchor is absent or duplicated: ${file}:${anchor}`);
  }
  for (const [file, guard] of ROOT_GUARDS) if (!model.sources[file].includes(guard)) errors.push(`operative external-root guard is absent: ${file}:${guard}`);

  const aggregate = Object.values(model.fileSizes).reduce((total, size) => total + size, 0);
  if (aggregate >= AGGREGATE_SMOKE_ALARM) errors.push(`aggregate helper smoke alarm exceeded: ${aggregate}`);
  for (const [file, size] of Object.entries(model.fileSizes)) if (size >= PER_FILE_SMOKE_ALARM) errors.push(`per-file helper smoke alarm exceeded: ${file}:${size}`);

  const packedCode = model.packedEntries.map((entry) => entry.path).filter((file) => /\.(?:js|mjs|cjs|ts)$/.test(file)).sort();
  if (JSON.stringify(packedCode) !== JSON.stringify(HELPER_FILES.slice().sort())) errors.push('packed JavaScript differs from the helper allowlist');
  if (model.packedEntries.some((entry) => entry.path.startsWith('test/') || /(?:controller|extension)/i.test(entry.path))) errors.push('test/controller/extension is packaged');
  if (model.packedEntries.some((entry) => Number(entry.mode) & 0o111)) errors.push('executable-mode package entry is forbidden');
  return errors;
}
function actualModel() {
  const sources = Object.fromEntries(HELPER_FILES.map((file) => [file, readText(file)]));
  const fileSizes = Object.fromEntries(HELPER_FILES.map((file) => [file, fs.statSync(repoPath(file)).size]));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const stdout = execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const report = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1))[0];
  const packedEntries = report.files.map((entry) => ({ ...entry, path: entry.path.replace(/\\/g, '/') }));
  return { manifest: readJson('package.json'), sources, fileSizes, packedEntries };
}
function mutate(model, change) { const copy = structuredClone(model); change(copy); return copy; }
function rejectsMutation(model, name, change, expected) {
  const errors = validateBoundary(mutate(model, change));
  assert.ok(errors.some((error) => error.includes(expected)), `${name} mutation was not rejected: ${errors.join('; ')}`);
}
function git(cwd, args, env = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Issue 59', GIT_AUTHOR_EMAIL: 'issue59@example.invalid', GIT_COMMITTER_NAME: 'Issue 59', GIT_COMMITTER_EMAIL: 'issue59@example.invalid', ...env },
  }).trim();
}

test('Issue #59 defines the structural helper boundary and smoke alarms', () => {
  const contract = readText('CONTRACT.md');
  const section = contract.match(/## CL-D37 — Bounded helper surface is structural[\s\S]*?(?=\n## |$)/)?.[0] || '';
  for (const required of [
    '*Owner choice:* Option B',
    'no package `main`, `bin`, `exports`, or `pi.extensions`',
    'no commit, push, merge, reply, approval, or thread-resolution CLI operation',
    'no durable workflow state or scheduling',
    '140,000-byte aggregate smoke alarm',
    'CL-D53 later reset the aggregate smoke alarm to 160,000 bytes',
    '30,000-byte per-file smoke alarm',
    'not a size budget',
  ]) assert.ok(section.includes(required), `CL-D37 is missing ${JSON.stringify(required)}`);
  assert.deepEqual(validateBoundary(actualModel()), []);
});

test('Issue #59 structural assertions are non-vacuous under source-derived mutations', () => {
  const model = actualModel();
  rejectsMutation(model, 'main', (copy) => { copy.manifest.main = 'skills/closed-loop-pr/helpers/cli.js'; }, 'package main');
  rejectsMutation(model, 'bin', (copy) => { copy.manifest.bin = { tidd: 'skills/closed-loop-pr/helpers/cli.js' }; }, 'package bin');
  rejectsMutation(model, 'exports', (copy) => { copy.manifest.exports = './skills/closed-loop-pr/helpers/cli.js'; }, 'package exports');
  rejectsMutation(model, 'extension', (copy) => { copy.manifest.pi.extensions = ['./extension.js']; }, 'pi.extensions');
  for (const operation of ['commit', 'push', 'merge', 'reply', 'approve', 'thread_resolve', 'schedule', 'state_write']) {
    rejectsMutation(model, `${operation} operation`, (copy) => {
      copy.sources[`${HELPER_DIR}/cli.js`] = copy.sources[`${HELPER_DIR}/cli.js`].replace('  operator_capture:', `  ${operation}: { required: [], optional: [] },\n  operator_capture:`);
    }, 'operation table');
  }
  rejectsMutation(model, 'direct write', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nfs.writeFileSync("state", "x");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'async write', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nfs.promises.writeFile("state", "x");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'import alias', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nconst { writeFile: persist } = require("node:fs/promises");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'canonical fs alias', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nconst { writeFileSync: persist } = fs; persist("state", "x");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'canonical fs promises alias', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nconst storage = fs.promises; storage.writeFile("state", "x");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'renamed filesystem import', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nconst storage = require("node:fs");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'builtin filesystem import', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nprocess.getBuiltinModule("fs");\n'; }, 'filesystem access callsites');
  rejectsMutation(model, 'timer', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nsetInterval(() => {}, 1000);\n'; }, 'scheduling or durable-state primitive');
  rejectsMutation(model, 'timer module alias', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nconst timers = require("node:timers/promises"); const wait = timers["set" + "Timeout"]; wait(1000);\n'; }, 'module import callsites');
  rejectsMutation(model, 'state module', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += '\nrequire("node:sqlite");\n'; }, 'module import callsites');
  rejectsMutation(model, 'Git push', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += "\ngitArgs(['push', 'origin', 'HEAD']);\n"; }, 'Git command');
  rejectsMutation(model, 'Git wrapper push', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += "\ngit(root, ['push', 'origin', 'HEAD'], 'workspace_create');\n"; }, 'Git command');
  rejectsMutation(model, 'Git -c prefixed push', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += "\ngit(root, ['-c', 'safe.directory=*', 'push', 'origin', 'HEAD'], 'workspace_create');\n"; }, 'Git command');
  rejectsMutation(model, 'Git no-replace prefixed push', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] += "\ngit(root, ['--no-replace-objects', 'push', 'origin', 'HEAD'], 'workspace_create');\n"; }, 'Git command');
  rejectsMutation(model, 'receipt reassignment', (copy) => { copy.sources[`${HELPER_DIR}/workspace.js`] = copy.sources[`${HELPER_DIR}/workspace.js`].replace('    fs.unlinkSync(receipt.storedPath);', '    receipt.storedPath = "/tmp/outside";\n    fs.unlinkSync(receipt.storedPath);'); }, 'receipt provenance mutation');
  for (const [file, anchor] of PROVENANCE_ANCHORS) rejectsMutation(model, `write provenance ${anchor}`, (copy) => { copy.sources[file] = copy.sources[file].replace(anchor, '/* provenance removed */'); }, 'write-root provenance anchor');
  for (const [file, guard] of ROOT_GUARDS) rejectsMutation(model, `operative guard ${guard}`, (copy) => { copy.sources[file] = copy.sources[file].replace(guard, guard.replace('if (', 'if (false && ')); }, 'operative external-root guard');
  rejectsMutation(model, 'aggregate size', (copy) => { copy.fileSizes[`${HELPER_DIR}/cli.js`] += AGGREGATE_SMOKE_ALARM; }, 'aggregate helper smoke alarm');
  rejectsMutation(model, 'per-file size', (copy) => { copy.fileSizes[`${HELPER_DIR}/cli.js`] = PER_FILE_SMOKE_ALARM; }, 'per-file helper smoke alarm');
  rejectsMutation(model, 'packed code', (copy) => { copy.packedEntries.push({ path: 'controller.js', mode: 0o644 }); }, 'packed JavaScript');
  rejectsMutation(model, 'packed test', (copy) => { copy.packedEntries.push({ path: 'test/fixture.md', mode: 0o644 }); }, 'test/controller/extension');
  rejectsMutation(model, 'packed controller', (copy) => { copy.packedEntries.push({ path: 'controller.md', mode: 0o644 }); }, 'test/controller/extension');
  rejectsMutation(model, 'executable mode', (copy) => { copy.packedEntries.find((entry) => entry.path === HELPER_FILES[0]).mode = 0o755; }, 'executable-mode');
});

test('Issue #59 behaviorally rejects a repository-contained run root before writing it', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue59-'));
  const bare = path.join(parent, 'origin.git');
  const root = path.join(parent, 'repo');
  try {
    execFileSync('git', ['init', '--bare', '-q', bare]);
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    git(root, ['remote', 'add', 'origin', bare]);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-qm', 'base']);
    git(root, ['push', '-qu', 'origin', 'HEAD']);
    const head = git(root, ['rev-parse', 'HEAD']);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    const forbidden = path.join(root, 'forbidden-run-root');
    const result = createWorkspace({ cwd: root, head, tree, runRoot: forbidden, allowCloneFallback: false });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'workspace_inside_repository');
    assert.equal(fs.existsSync(forbidden), false, 'the rejected root must not be created');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
