'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

function readText(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(repoPath(relativePath));
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

/**
 * Parses the small YAML subset used by agent, skill, and prompt frontmatter:
 * flat `key: value` pairs, optionally quoted. Returns null when the file has
 * no frontmatter block.
 */
function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return null;

  const block = normalized.slice(4, end);
  const fields = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function lineCount(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

module.exports = { repoRoot, repoPath, readText, readJson, exists, parseFrontmatter, lineCount };
