'use strict';

const path = require('node:path');
const { runSync, gitArgs, assertSafeRepositoryConfig } = require('./process');
const { classifyRuntimeRoots, normalizeCheckoutPath, lstatKind } = require('./paths');
const { createResult, createError } = require('./protocol');

const RUNTIME_ROOTS = ['.pi', '.pi-subagents'];
const IDENTITY_FIELDS = ['repository', 'prNumber', 'lifecycle', 'baseOid', 'publicHead', 'headRepository', 'headBranch', 'originFetch', 'originPush'];
function repositoryFromRemote(remote) {
  if (typeof remote !== 'string') return null;
  const normalized = remote.replace(/\\/g, '/').replace(/\.git\/?$/, '').replace(/\/$/, '');
  const match = normalized.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return match ? match[1].toLowerCase() : null;
}

function nulRecords(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records = [];
  let start = 0;
  try {
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0) {
        if (index > start) records.push(decoder.decode(bytes.subarray(start, index)));
        start = index + 1;
      }
    }
  } catch {
    const error = new Error('Git path inventory contains non-UTF-8 bytes');
    error.code = 'non_utf8_path';
    throw error;
  }
  if (start < bytes.length) throw new Error('unterminated NUL-delimited Git output');
  return records;
}
function byteSort(values) { return values.slice().sort((a, b) => Buffer.from(a).compare(Buffer.from(b))); }
function requestOptions(input) { return typeof input === 'string' ? { cwd: input } : (input || {}); }
function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error('complete target identity is required');
  for (const field of IDENTITY_FIELDS) {
    if (!(field in identity) || identity[field] === null || identity[field] === '') throw new Error(`missing target identity field: ${field}`);
  }
  if (!Number.isSafeInteger(identity.prNumber) || identity.prNumber <= 0) throw new Error('invalid PR number');
  if (!['OPEN', 'open'].includes(identity.lifecycle)) throw new Error('target PR must be open');
  for (const field of ['repository', 'baseOid', 'publicHead', 'headRepository', 'headBranch', 'originFetch', 'originPush']) {
    if (typeof identity[field] !== 'string') throw new Error(`invalid target identity field: ${field}`);
  }
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}
function gitBuffer(cwd, args, phase = 'operator_capture') {
  return runSync('git', gitArgs(args), { cwd, phase, encoding: 'buffer' });
}
function gitText(cwd, args, options = {}) {
  return runSync('git', gitArgs(args), { cwd, phase: options.phase || 'operator_capture', acceptExitCodes: options.acceptExitCodes }).trim();
}
function remoteUrls(top) {
  const fetch = gitText(top, ['remote', 'get-url', 'origin']);
  let push;
  try { push = gitText(top, ['remote', 'get-url', '--push', 'origin']); } catch { push = fetch; }
  return { originFetch: fetch, originPush: push };
}
function tracking(top) {
  const branch = gitText(top, ['symbolic-ref', '-q', 'HEAD'], { acceptExitCodes: [1] }) || null;
  const upstream = branch ? gitText(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { acceptExitCodes: [128] }) || null : null;
  const trackingRef = upstream ? gitText(top, ['rev-parse', upstream]) : null;
  return { branch, upstream, trackingRef };
}
function runtimeTrackedEntries(top, source) {
  const args = source === 'head'
    ? ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...RUNTIME_ROOTS]
    : ['ls-files', '-z', '--', ...RUNTIME_ROOTS];
  return byteSort(nulRecords(gitBuffer(top, args)));
}
function inventory(top) {
  const collect = (args) => gitBuffer(top, args);
  const ignored1 = collect(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  const untracked1 = collect(['ls-files', '--others', '--exclude-standard', '-z']);
  const ignored2 = collect(['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  const untracked2 = collect(['ls-files', '--others', '--exclude-standard', '-z']);
  if (!Buffer.from(ignored1).equals(Buffer.from(ignored2)) || !Buffer.from(untracked1).equals(Buffer.from(untracked2))) {
    const error = new Error('ignored or untracked inventory changed during discrete enumeration');
    error.code = 'inventory_unstable';
    throw error;
  }
  const normalize = (entry) => normalizeCheckoutPath(entry, top);
  const untrackedPaths = byteSort(nulRecords(untracked1).map(normalize));
  const ignoredPaths = byteSort(nulRecords(ignored1).map(normalize));
  const describe = (entry) => ({ path: entry, kind: lstatKind(path.join(top, ...entry.split('/'))), followed: false });
  const ignoredInventory = ignoredPaths
    .filter((entry) => !RUNTIME_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`))).map(describe);
  const runtimeInventory = untrackedPaths
    .filter((entry) => RUNTIME_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`))).map(describe);
  return { untrackedPaths, ignoredInventory, runtimeInventory };
}
function captureOperatorCheckout(input = process.cwd()) {
  const options = requestOptions(input);
  const cwd = options.cwd || process.cwd();
  try {
    const identity = safeIdentity(options.identity);
    const top = path.resolve(gitText(cwd, ['rev-parse', '--show-toplevel']));
    const configDigest = assertSafeRepositoryConfig(top);
    const head = gitText(top, ['rev-parse', 'HEAD']);
    const { branch, upstream, trackingRef } = tracking(top);
    const { originFetch, originPush } = remoteUrls(top);
    const expectedBranch = `refs/heads/${identity.headBranch}`;
    if (head !== identity.publicHead) throw Object.assign(new Error('operator HEAD does not equal public PR head'), { code: 'target_identity_mismatch' });
    if (branch !== expectedBranch) throw Object.assign(new Error('operator branch does not equal PR head branch'), { code: 'target_identity_mismatch' });
    if (identity.repository.toLowerCase() !== identity.headRepository.toLowerCase()) throw Object.assign(new Error('autofix head repository differs from checkout repository'), { code: 'target_identity_mismatch' });
    if (originFetch !== identity.originFetch || originPush !== identity.originPush) throw Object.assign(new Error('origin URLs differ from verified target binding'), { code: 'target_identity_mismatch' });
    const fetchRepository = repositoryFromRemote(originFetch);
    const pushRepository = repositoryFromRemote(originPush);
    if ((fetchRepository && fetchRepository !== identity.repository.toLowerCase()) || (pushRepository && pushRepository !== identity.repository.toLowerCase())) throw Object.assign(new Error('origin repository differs from target repository'), { code: 'target_identity_mismatch' });
    const worktreeChanges = nulRecords(gitBuffer(top, ['diff', '--name-status', '--no-renames', '-z']));
    const indexChanges = nulRecords(gitBuffer(top, ['diff', '--cached', '--name-status', '--no-renames', '-z']));
    const inventoryReader = typeof options.inventoryFn === 'function' ? options.inventoryFn : inventory;
    const { untrackedPaths, ignoredInventory, runtimeInventory } = inventoryReader(top);
    const runtimeHeadEntries = runtimeTrackedEntries(top, 'head');
    const runtimeIndexEntries = runtimeTrackedEntries(top, 'index');
    const runtimeRoots = classifyRuntimeRoots(top);
    const unexpectedUntrackedPaths = untrackedPaths.filter((entry) => !RUNTIME_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`)));
    const unsafeRuntimeRoots = Object.entries(runtimeRoots).filter(([, descriptor]) => !descriptor.safe).map(([root]) => root);
    if (runtimeHeadEntries.length || runtimeIndexEntries.length) throw Object.assign(new Error('runtime root is present in HEAD or index'), { code: 'runtime_root_tracked' });
    if (unsafeRuntimeRoots.length) throw Object.assign(new Error(`unsafe runtime root: ${unsafeRuntimeRoots.join(', ')}`), { code: 'unsafe_runtime_root' });
    return createResult('operator_capture', {
      root: top, head, branch, originFetch, originPush, upstream, trackingRef,
      worktreeChanges, trackedChanges: worktreeChanges, indexChanges, untrackedPaths, unexpectedUntrackedPaths,
      ignoredInventory, runtimeInventory, runtimeHeadEntries, runtimeIndexEntries, runtimeRoots, unsafeRuntimeRoots, identity, configDigest,
      clean: worktreeChanges.length === 0 && indexChanges.length === 0 && unexpectedUntrackedPaths.length === 0 && unsafeRuntimeRoots.length === 0,
    });
  } catch (error) {
    return createError('operator_capture', error.code || 'capture_failed', error.message, error.phase || 'operator_capture');
  }
}
function immutableOperatorBaseline(data) {
  if (!data || typeof data !== 'object') return null;
  const fields = [
    'root', 'head', 'branch', 'originFetch', 'originPush', 'upstream', 'trackingRef',
    'worktreeChanges', 'trackedChanges', 'indexChanges', 'unexpectedUntrackedPaths',
    'ignoredInventory', 'identity', 'configDigest', 'clean',
  ];
  return Object.fromEntries(fields.map((field) => [field, data[field]]));
}
function revalidateOperatorCheckout(captured, input = process.cwd()) {
  const options = typeof input === 'string' ? { cwd: input } : { ...input };
  const postPushHead = options.postPushHead;
  delete options.postPushHead;
  const current = captureOperatorCheckout({ ...options, identity: captured?.data?.identity });
  if (!current.ok) return current;
  const expected = immutableOperatorBaseline(captured?.data);
  if (postPushHead !== undefined) {
    if (typeof postPushHead !== 'string' || !/^[0-9a-f]{40}$/.test(postPushHead)
      || captured?.data?.trackingRef !== captured?.data?.head) {
      return createError('operator_revalidate', 'operator_changed', 'invalid post-push tracking transition', 'operator_revalidate');
    }
    let commit;
    try { commit = gitText(current.data.root, ['--no-replace-objects', 'cat-file', 'commit', postPushHead], { phase: 'operator_revalidate' }); }
    catch { return createError('operator_revalidate', 'operator_changed', 'post-push head is unavailable', 'operator_revalidate'); }
    const header = commit.split('\n\n', 1)[0];
    const parents = header.split('\n').filter((line) => line.startsWith('parent '));
    if (parents.length !== 1 || parents[0] !== `parent ${captured.data.head}`) {
      return createError('operator_revalidate', 'operator_changed', 'post-push head is not the sole child of the operator baseline', 'operator_revalidate');
    }
    expected.trackingRef = postPushHead;
  }
  return JSON.stringify(immutableOperatorBaseline(current.data)) === JSON.stringify(expected)
    ? current
    : createError('operator_revalidate', 'operator_changed', 'operator checkout differs from captured baseline', 'operator_revalidate');
}

module.exports = { captureOperatorCheckout, revalidateOperatorCheckout, immutableOperatorBaseline, RUNTIME_ROOTS, nulRecords, byteSort, runtimeTrackedEntries };
