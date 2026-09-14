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
function spawnCalls(source) { return namedCalls(source, ['run', 'runSync', 'execFile', 'execFileSync']); }
function namedCalls(source, names) {
  const calls = [];
  const opener = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'g');
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

// Helper source with every comment and string literal blanked to spaces, newlines kept, so positions line up with
// the original and nothing inside a string, a template's text, a regular expression, or a comment reads as code.
// A regular-expression literal is recognised by the character or keyword before its slash.
function codeOnly(source) {
  const out = source.split('');
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const regexAllowed = (i) => {
    let k = i - 1; while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(source[k])) return true;
    const word = source.slice(Math.max(0, k - 10), k + 1).match(/[A-Za-z_$][\w$]*$/);
    return Boolean(word && ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do'].includes(word[0]));
  };
  function scanCode(i, stopAtBrace) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i], n = source[i + 1];
      if (c === '/' && n === '/') { const end = source.indexOf('\n', i); const stop = end === -1 ? source.length : end; blank(i, stop); i = stop; continue; }
      if (c === '/' && n === '*') { const end = source.indexOf('*/', i + 2); const stop = end === -1 ? source.length : end + 2; blank(i, stop); i = stop; continue; }
      if (c === "'" || c === '"') { let k = i + 1; while (k < source.length && source[k] !== c && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1; blank(i + 1, k); i = k + 1; continue; }
      if (c === '`') { i = scanTemplate(i + 1); continue; }
      if (c === '/' && regexAllowed(i)) {
        let k = i + 1, inClass = false;
        while (k < source.length && source[k] !== '\n') { if (source[k] === '\\') { k += 2; continue; } if (source[k] === '[') inClass = true; else if (source[k] === ']') inClass = false; else if (source[k] === '/' && !inClass) break; k += 1; }
        blank(i + 1, k); i = k + 1; continue;
      }
      if (c === '{') depth += 1;
      if (c === '}') { if (stopAtBrace && depth === 0) return i; depth -= 1; }
      i += 1;
    }
    return i;
  }
  function scanTemplate(i) {
    let start = i;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { blank(start, i); return i + 1; }
      if (source[i] === '$' && source[i + 1] === '{') { blank(start, i); i = scanCode(i + 2, true) + 1; start = i; continue; }
      i += 1;
    }
    blank(start, source.length); return source.length;
  }
  scanCode(0, false);
  return out.join('');
}

// The bound CL-D72 records for the static spawn guard (ADV-124-SPAWN-SCANNER-ALIAS-BYPASS): a spawn primitive reaches a
// program only through a direct call. With strings and comments removed, `run`, `runSync`, `execFile`, and
// `execFileSync` may appear only as a direct call, as a definition or the export list in process.js, or inside a
// destructured import from ./process or node:child_process that lists plain names without renaming them; the text
// `child_process` appears only in process.js's one import, for execFile and execFileSync; a module that defines a
// forwarding `defaultTransport` calls its injected `transport` only with the literal program 'gh'; and eval, the
// Function constructor, and process bindings are refused as references of any form: `eval`, `Function`, `constructor`,
// `global`, and `globalThis` appear nowhere in code, and `process` appears only as a member access other than
// `binding`, `_linkedBinding`, `dlopen`, and `execve`, or as `bind(process)` (ADV-124-DYNAMIC-EXECUTION-GUARD-BYPASS).
// The guard is a structural check of reviewed source bounded to these forms, not a JavaScript evaluator.
const SPAWN_PRIMITIVES = ['run', 'runSync', 'execFile', 'execFileSync'];
function spawnReferenceProblems(file, source) {
  const problems = [];
  const code = codeOnly(source);
  const base = file.split('/').pop();
  const spans = [];
  for (const match of source.matchAll(/const\s*\{[^}]*\}\s*=\s*require\(\s*'(\.\/process|node:child_process)'\s*\);/g)) spans.push([match.index, match.index + match[0].length, match[1]]);
  if (base === 'process.js') { const match = source.match(/module\.exports\s*=\s*\{[^}]*\};/); if (match) spans.push([match.index, match.index + match[0].length, 'exports']); }
  const inSpan = (index) => spans.some(([from, to]) => index >= from && index < to);
  for (const [from, to] of spans.filter(([, , target]) => target !== 'exports')) {
    if (!/^const\s*\{\s*[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*,?\s*\}/.test(source.slice(from, to))) problems.push(`a destructured import of the spawn modules renames a name: ${file}`);
  }
  for (const match of code.matchAll(/(?<![\w$])(run|runSync|execFile|execFileSync)(?![\w$])/g)) {
    if (inSpan(match.index)) continue;
    const before = code.slice(Math.max(0, match.index - 40), match.index), after = code.slice(match.index + match[1].length, match.index + match[1].length + 20);
    const property = /\.\s*$/.test(before), called = /^\s*\(/.test(after), defined = /\bfunction\s+$/.test(before);
    if (!property && called && (!defined || base === 'process.js')) continue;
    problems.push(`spawn primitive referenced outside a direct call: ${file}:${match[1]}`);
  }
  // The raw text, strings and comments included, so a dynamic load spelled as a string is counted too.
  const childMentions = [...source.matchAll(/child_process/g)];
  const childImports = spans.filter(([, , target]) => target === 'node:child_process');
  const exact = base === 'process.js' && childMentions.length === 1 && childImports.length === 1
    && childMentions[0].index >= childImports[0][0] && childMentions[0].index < childImports[0][1]
    && /^const\s*\{\s*execFile,\s*execFileSync\s*\}/.test(source.slice(childImports[0][0], childImports[0][1]));
  if (childMentions.length > 0 && !exact) problems.push(`node:child_process is used outside process.js's execFile and execFileSync import: ${file}`);
  if (/\bfunction\s+defaultTransport\s*\(/.test(code)) for (const call of namedCalls(source, ['transport'])) if (call.args[0] !== "'gh'") problems.push(`transport call passes a program other than 'gh': ${file}`);
  if (/(?<![\w$])(?:eval|Function|constructor|global|globalThis)(?![\w$])/.test(code)) problems.push(`dynamic code execution is forbidden: ${file}`);
  const processBinding = [...code.matchAll(/(?<![\w$.])process(?![\w$])/g)].some((match) => {
    const after = code.slice(match.index + 7, match.index + 48), before = code.slice(Math.max(0, match.index - 8), match.index);
    const member = after.match(/^\s*\??\.\s*([A-Za-z_$][\w$]*)/);
    if (member) return ['binding', '_linkedBinding', 'dlopen', 'execve'].includes(member[1]);
    return !(/bind\(\s*$/.test(before) && /^\s*\)/.test(after));
  });
  if (processBinding) problems.push(`process bindings are forbidden: ${file}`);
  return problems;
}

module.exports = { repoRoot, repoPath, readText, readJson, exists, parseFrontmatter, lineCount, AUTHORITY_FILES, sectionOf, cliSchemas, spawnCalls, spawnReferenceProblems, SPAWN_PRIMITIVES };
