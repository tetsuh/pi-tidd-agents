'use strict';

const fs = require('node:fs');
const path = require('node:path');

function windowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/\//.test(value);
}

function normalizeCheckoutPath(value, checkoutRoot) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError('path must be a non-empty string without NUL');
  }
  const win = windowsAbsolute(value) || (checkoutRoot && windowsAbsolute(checkoutRoot));
  const api = win ? path.win32 : path.posix;
  const input = win ? value.replace(/[\\/]+/g, api.sep) : value.replace(/\/+/g, api.sep);
  if (!checkoutRoot) {
    if (api.isAbsolute(input) || windowsAbsolute(input)) throw new Error('absolute or UNC path rejected');
    const normalized = input.split(api.sep);
    if (!normalized.length || normalized.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(normalized.includes('..') ? 'path escapes checkout' : 'empty or dot path rejected');
    }
    return normalized.join('/');
  }

  const root = api.resolve(String(checkoutRoot));
  if (!api.isAbsolute(input)) {
    const normalized = input.split(api.sep);
    if (!normalized.length || normalized.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(normalized.includes('..') ? 'path escapes checkout' : 'empty or dot path rejected');
    }
    return normalized.join('/');
  }
  const candidate = api.resolve(input);
  if (win && api.parse(candidate).root.toLowerCase() !== api.parse(root).root.toLowerCase()) throw new Error('cross-drive or UNC path rejected');
  const relative = api.relative(root, candidate);
  if (!relative || api.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${api.sep}`)) {
    throw new Error(relative ? 'path is outside checkout' : 'checkout root itself is not an inventory path');
  }
  const parts = relative.split(api.sep);
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('path escapes checkout');
  return parts.join('/');
}

function lstatKind(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) return 'directory';
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isFile()) return 'file';
    if (stat.isFIFO()) return 'fifo';
    if (stat.isSocket()) return 'socket';
    if (stat.isCharacterDevice() || stat.isBlockDevice()) return 'device';
    return 'unknown';
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

function classifyRuntimeRoots(checkoutRoot, roots = ['.pi', '.pi-subagents']) {
  const result = {};
  for (const root of roots) {
    if (!['.pi', '.pi-subagents'].includes(root)) throw new Error(`unsafe runtime root: ${root}`);
    const kind = lstatKind(path.join(checkoutRoot, root));
    result[root] = { kind, followed: false, safe: kind === 'absent' || kind === 'directory' };
  }
  return result;
}

function assertSymlinkFreePath(target, stopAt) {
  const absolute = path.resolve(target);
  const stop = stopAt ? path.resolve(stopAt) : path.parse(absolute).root;
  let current = absolute;
  while (current !== stop && current !== path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`symlink path component rejected: ${current}`);
    current = path.dirname(current);
  }
  return absolute;
}

module.exports = { normalizeCheckoutPath, lstatKind, classifyRuntimeRoots, assertSymlinkFreePath };
