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

// The measured authority set. The CL-D24/CL-D34/CL-D36 byte ceiling and the Issue #58
// duplication guard must measure exactly the same files, so both import this one list.
const AUTHORITY_FILES = [
  'skills/closed-loop-issue/SKILL.md',
  'skills/closed-loop-pr/SKILL.md',
  'skills/closed-loop-pr/references/review-only.md',
  'skills/closed-loop-pr/references/autofix.md',
  'skills/closed-loop-pr/references/autofix-addendum.md',
  'skills/closed-loop-shared/references/gate-contract.md',
  'skills/closed-loop-shared/references/records.md',
];

/**
 * Returns the lines from `heading` up to the next heading of the same or shallower depth,
 * or null when the heading is absent. Shared by every contract test that scopes an
 * assertion to one section.
 */
function sectionOf(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const depth = heading.match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const match = lines[end].match(/^(#+)\s/);
    if (match && match[1].length <= depth) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Parses the frozen SCHEMAS table out of helpers/cli.js source. `cli.js` runs its own main on
 * require and blocks on stdin, so the operation surface is read from source, and reading the
 * shipped table rather than a second copy keeps every caller bound to the real CLI.
 * Returns { operation: [requiredField, ...] }.
 */
function cliSchemas() {
  const source = readText('skills/closed-loop-pr/helpers/cli.js');
  const table = source.match(/const SCHEMAS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  if (!table) throw new Error('could not locate the SCHEMAS table in helpers/cli.js');
  const schemas = {};
  for (const [, operation, required] of table[1].matchAll(/^\s*([a-z][a-z0-9_]*):\s*\{\s*required:\s*\[([^\]]*)\]/gm)) {
    schemas[operation] = (required.match(/'([^']+)'/g) || []).map((field) => field.slice(1, -1));
  }
  if (Object.keys(schemas).length === 0) throw new Error('parsed no operations from the CLI schema table');
  return schemas;
}

// Every executable-spawn call in a helper source, read at the source level rather than line by line: each
// `run(`, `runSync(`, `execFile(`, or `execFileSync(` call, its parentheses balanced across lines and
// string literals, split into its top-level arguments with whitespace collapsed (CL-D72,
// CONV-124-SPAWN-SCAN-MULTILINE-GAP). A definition (`function run(`) and a call inside a line comment are
// not calls.
function spawnCalls(source) {
  const calls = [];
  const opener = /\b(run|runSync|execFile|execFileSync)\s*\(/g;
  for (const match of source.matchAll(opener)) {
    const before = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
    if (/\bfunction\s+$/.test(before) || /\/\//.test(before) || /[.\w$]$/.test(before)) continue;
    let depth = 1, index = match.index + match[0].length, quote = null, argStart = index;
    const args = [];
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = null; }
      else if (char === "'" || char === '"' || char === '`') quote = char;
      else if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) { depth -= 1; if (depth === 0) { args.push(source.slice(argStart, index)); break; } }
      else if (char === ',' && depth === 1) { args.push(source.slice(argStart, index)); argStart = index + 1; }
      index += 1;
    }
    if (depth !== 0) throw new Error(`unbalanced spawn call at offset ${match.index}`);
    calls.push({ callee: match[1], args: args.map((argument) => argument.trim().replace(/\s+/g, ' ')).filter((argument) => argument.length > 0) });
  }
  return calls;
}

module.exports = { repoRoot, repoPath, readText, readJson, exists, parseFrontmatter, lineCount, AUTHORITY_FILES, sectionOf, cliSchemas, spawnCalls };
