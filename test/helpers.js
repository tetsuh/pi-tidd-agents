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

// Helper source read through the parser Node itself bundles, so strings, templates, regular expressions, comments,
// and division are told apart by the grammar rather than guessed from characters (CL-D72). The character tokenizer
// this replaces misread a slash after a postfix operator, `await`, or `yield` as a regular expression and blanked
// the code behind it (ADV-124-SPAWN-SCANNER-ALIAS-BYPASS, reopened). The parser runs in a child process started with
// --expose-internals, the one way to reach Node's bundled acorn without a dependency; a source that does not parse
// is reported, never skipped. Facts are cached by source text, so a mutated model reparses only the file it changed.
const PARSE_FACTS_SCRIPT = String.raw`
const acorn = require('internal/deps/acorn/acorn/dist/acorn');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const PRIMS = new Set(['run', 'runSync', 'execFile', 'execFileSync']);
const DYNAMIC = new Set(['eval', 'Function', 'constructor', 'global', 'globalThis']);
const BINDINGS = new Set(['binding', '_linkedBinding', 'dlopen', 'execve']);
const LOADERS = new Set(['getBuiltinModule', 'mainModule']);
const GIT_ARG_CALLEES = new Set(['git', 'gitRaw', 'gitText', 'gitBytes', 'gitBuffer', 'collect', 'gitArgs']);
// A name written as a string or a template without substitutions is the same name.
const literalName = (node) => node && node.type === 'Literal' && typeof node.value === 'string' ? node.value
  : node && node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
function visit(node, ancestors, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === 'string') visit(item, ancestors, fn); }
    else if (value && typeof value.type === 'string') visit(value, ancestors, fn);
  }
  ancestors.pop();
}
const out = {};
for (const [id, source] of Object.entries(input)) {
  let ast;
  try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); }
  catch (error) { out[id] = { parseError: error.message }; continue; }
  const text = (node) => source.slice(node.start, node.end).trim().replace(/\s+/g, ' ');
  const requireOf = (node) => node && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
    && node.arguments.length === 1 && node.arguments[0].type === 'Literal' ? node.arguments[0].value : null;
  const facts = { calls: [], transportCalls: [], references: [], dynamic: [], processUses: [], loaders: [], childLiterals: 0, childImportNames: null, namedLiterals: [], requireUses: [], gitArgLists: [] };
  const NAMED = new Set([...PRIMS, ...DYNAMIC, ...LOADERS]);
  visit(ast, [], (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1], grand = ancestors[ancestors.length - 2], great = ancestors[ancestors.length - 3];
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      if (PRIMS.has(node.callee.name)) facts.calls.push({ callee: node.callee.name, args: node.arguments.map(text) });
      if (node.callee.name === 'transport' || node.callee.name === 'defaultTransport') facts.transportCalls.push(node.arguments.map(text));
      if (GIT_ARG_CALLEES.has(node.callee.name) || (PRIMS.has(node.callee.name) && literalName(node.arguments[0]) === 'git')) {
        const list = node.arguments.find((argument) => argument.type === 'ArrayExpression');
        if (list) facts.gitArgLists.push(list.elements.map((element) => literalName(element)));
      }
    }
    if (node.type === 'ImportExpression') facts.dynamic.push('import()');
    if ((node.type === 'Literal' || node.type === 'TemplateLiteral') && NAMED.has(literalName(node))) facts.namedLiterals.push(literalName(node));
    if ((node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('child_process')) || (node.type === 'TemplateElement' && String(node.value.cooked).includes('child_process'))) facts.childLiterals += 1;
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && requireOf(node.init) === 'node:child_process') facts.childImportNames = node.id.properties.map((property) => property.type === 'Property' && !property.computed && property.shorthand && property.key.type === 'Identifier' ? property.key.name : '?');
    if (node.type === 'RestElement' && parent && parent.type === 'ObjectPattern' && grand && grand.type === 'VariableDeclarator' && grand.id === parent && ['./process', 'node:child_process'].includes(requireOf(grand.init))) facts.references.push({ name: '...', context: 'rest' });
    if (node.type === 'Property' && node.computed && parent && parent.type === 'ObjectPattern' && PRIMS.has(literalName(node.key))) facts.references.push({ name: literalName(node.key), context: 'rename' });
    if (node.type === 'MemberExpression' && node.computed) {
      const name = literalName(node.property);
      if (DYNAMIC.has(name)) facts.dynamic.push(name);
      if (PRIMS.has(name)) facts.references.push({ name, context: 'property' });
      if (LOADERS.has(name)) facts.loaders.push(name);
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && BINDINGS.has(node.callee.computed ? literalName(node.callee.property) : node.callee.property.name)) facts.processUses.push('binding');
    if (node.type !== 'Identifier') return;
    // A property name after a dot, and a key in an object, are names rather than references.
    if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
      if (DYNAMIC.has(node.name)) facts.dynamic.push(node.name);
      if (PRIMS.has(node.name)) facts.references.push({ name: node.name, context: 'property' });
      if (LOADERS.has(node.name)) facts.loaders.push(node.name);
      return;
    }
    if (parent && (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed) {
      if (PRIMS.has(node.name) && parent.type === 'Property' && grand && grand.type === 'ObjectPattern' && !parent.shorthand) facts.references.push({ name: node.name, context: 'rename' });
      return;
    }
    if (DYNAMIC.has(node.name)) facts.dynamic.push(node.name);
    if (LOADERS.has(node.name)) facts.loaders.push(node.name);
    if (node.name === 'require' && !(parent && parent.type === 'CallExpression' && parent.callee === node)) facts.requireUses.push(parent ? parent.type : 'none');
    if (node.name === 'process') {
      if (parent && parent.type === 'MemberExpression' && parent.object === node) facts.processUses.push(!parent.computed && !BINDINGS.has(parent.property.name) ? 'member' : 'binding');
      else if (parent && parent.type === 'CallExpression' && parent.arguments.includes(node) && parent.callee.type === 'MemberExpression' && !parent.callee.computed && parent.callee.property.name === 'bind') facts.processUses.push('bind');
      else facts.processUses.push('other');
      return;
    }
    if (!PRIMS.has(node.name)) return;
    let context = 'other';
    if (parent && parent.type === 'CallExpression' && parent.callee === node) context = 'call';
    else if (parent && parent.type === 'FunctionDeclaration' && parent.id === node) context = 'definition';
    else if (parent && parent.type === 'Property' && parent.value === node && parent.shorthand && grand && grand.type === 'ObjectPattern' && great && great.type === 'VariableDeclarator' && great.id === grand && ['./process', 'node:child_process'].includes(requireOf(great.init))) context = 'import';
    else if (parent && parent.type === 'Property' && parent.value === node && parent.shorthand && grand && grand.type === 'ObjectExpression' && great && great.type === 'AssignmentExpression' && great.right === grand
      && great.left.type === 'MemberExpression' && !great.left.computed && great.left.object.type === 'Identifier' && great.left.object.name === 'module' && great.left.property.name === 'exports') context = 'export';
    facts.references.push({ name: node.name, context });
  });
  out[id] = facts;
}
process.stdout.write(JSON.stringify(out));
`;
const parsedFacts = new Map();
function parseFacts(sources) {
  const missing = [...new Set(sources.filter((source) => !parsedFacts.has(source)))];
  if (missing.length > 0) {
    const child = require('node:child_process').spawnSync(process.execPath, ['--expose-internals', '-e', PARSE_FACTS_SCRIPT], { input: JSON.stringify(Object.fromEntries(missing.map((source, index) => [index, source]))), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`Node's bundled parser could not run: ${child.stderr || child.error}`);
    const output = JSON.parse(child.stdout);
    missing.forEach((source, index) => parsedFacts.set(source, output[index]));
  }
  return sources.map((source) => parsedFacts.get(source));
}

// Every executable-spawn call in a helper source, from the syntax tree: each call of `run`, `runSync`, `execFile`,
// or `execFileSync` by name, with its arguments as written and whitespace collapsed (CL-D72,
// CONV-124-SPAWN-SCAN-MULTILINE-GAP). A definition and a comment are not calls; a source that does not parse has none.
function spawnCalls(source) { const facts = parseFacts([source])[0]; return facts.parseError ? [] : facts.calls; }
// Every literal argument list passed to a Git helper or to a direct `run('git', ...)`, from the syntax tree: each element
// is its literal value whatever its quoting, or null when it is not a literal.
function gitArgLists(source) { const facts = parseFacts([source])[0]; return facts.parseError ? [] : facts.gitArgLists; }

// The bound CL-D72 records for the static spawn guard (owner option A), read from the syntax tree: `run`, `runSync`,
// `execFile`, and `execFileSync` appear only as a direct call, as a definition or the export list in process.js, or in a
// destructured import from ./process or node:child_process that lists plain names; a literal name counts as a reference
// wherever it is written, so a computed member or key, or a string argument, naming one is refused, as is a rest element
// gathering an import, and `require` appears only as a direct call;
// the text `child_process`, and any string literal whose value names it, appears only in process.js's one import, for
// execFile and execFileSync; every call of `transport` or `defaultTransport` passes the literal 'gh'; eval, the Function constructor, and
// process bindings are refused as references of any form (`eval`, `Function`, `constructor`, `global`, `globalThis`, and
// `import()` nowhere; `process` only as a member access other than its bindings, or as `bind(process)`; no member named
// `binding`, `_linkedBinding`, `dlopen`, or `execve` is called); and a module loader other than `require`,
// `getBuiltinModule` or `mainModule`, appears nowhere. The guard is a structural check of reviewed source bounded to
// these forms, not a JavaScript evaluator.
const SPAWN_PRIMITIVES = ['run', 'runSync', 'execFile', 'execFileSync'];
function spawnReferenceProblems(file, source) {
  const facts = parseFacts([source])[0];
  if (facts.parseError) return [`helper source does not parse: ${file}: ${facts.parseError}`];
  const problems = [];
  const base = file.split('/').pop();
  for (const { name, context } of facts.references) {
    if (context === 'call' || context === 'import') continue;
    if ((context === 'definition' || context === 'export') && base === 'process.js') continue;
    problems.push(context === 'rename' ? `a destructured import of the spawn modules renames a name: ${file}`
      : context === 'rest' ? `a destructured import of the spawn modules gathers names into a rest element: ${file}`
      : `spawn primitive referenced outside a direct call: ${file}:${name}`);
  }
  // The raw text catches a comment or a plain string; the cooked literal values catch an escaped spelling.
  const childMentions = (source.match(/child_process/g) || []).length;
  const exact = base === 'process.js' && childMentions === 1 && facts.childLiterals === 1 && JSON.stringify(facts.childImportNames) === '["execFile","execFileSync"]';
  if ((childMentions > 0 || facts.childLiterals > 0) && !exact) problems.push(`node:child_process is used outside process.js's execFile and execFileSync import: ${file}`);
  for (const args of facts.transportCalls) if (args[0] !== "'gh'") problems.push(`transport call passes a program other than 'gh': ${file}`);
  if (facts.dynamic.length > 0) problems.push(`dynamic code execution is forbidden: ${file}`);
  if (facts.loaders.length > 0) problems.push(`a module loader outside require is forbidden: ${file}`);
  if (facts.namedLiterals.length > 0) problems.push(`a spawn, dynamic-execution, or loader name written as a string is forbidden: ${file}`);
  if (facts.requireUses.length > 0) problems.push(`require is referenced outside a direct call: ${file}`);
  if (facts.processUses.some((use) => use !== 'member' && use !== 'bind')) problems.push(`process bindings are forbidden: ${file}`);
  return problems;
}
// Parse every source of a model in one child process before the per-file checks read the cache.
function primeSpawnFacts(sources) { parseFacts(sources); }

module.exports = { repoRoot, repoPath, readText, readJson, exists, parseFrontmatter, lineCount, AUTHORITY_FILES, sectionOf, cliSchemas, spawnCalls, gitArgLists, spawnReferenceProblems, primeSpawnFacts, SPAWN_PRIMITIVES };
