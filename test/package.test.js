'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { repoRoot, repoPath, readText, readJson, exists, parseFrontmatter } = require('./helpers');

const manifest = readJson('package.json');
const contractManifest = readJson('test/contract-clauses.json');

const EXPECTED_AGENTS = {
  'glm-worker': 'glm-5.2',
  'luna-worker': 'gpt-5.6-luna',
  'sol-reviewer': 'gpt-5.6-sol',
  'terra-oracle': 'gpt-5.6-terra',
  'terra-reviewer': 'gpt-5.6-terra',
  'terra-worker': 'gpt-5.6-terra',
};

const SKILLS = {
  'closed-loop-issue': 'skills/closed-loop-issue/SKILL.md',
  'closed-loop-pr': 'skills/closed-loop-pr/SKILL.md',
};

const PR_MODE_REFERENCES = {
  'review-only': 'skills/closed-loop-pr/references/review-only.md',
  autofix: 'skills/closed-loop-pr/references/autofix.md',
};
const PR_PUBLICATION_TEMPLATE = 'skills/closed-loop-pr/references/publish-review.sh';
const PR_HELPER_DIR = 'skills/closed-loop-pr/helpers';
const PR_HELPER_FILES = ['cli.js', 'fingerprints.js', 'gate-result.js', 'index.js', 'operator.js', 'paths.js', 'process.js', 'protocol.js', 'snapshot.js', 'writability.js', 'workspace.js'].map((file) => `${PR_HELPER_DIR}/${file}`);
const PR_SKILL_PRE_SPLIT_BYTES = 57160;
const SHARED_REFERENCES = {
  'gate-contract': 'skills/closed-loop-shared/references/gate-contract.md',
  records: 'skills/closed-loop-shared/references/records.md',
};
const AUTHORITY_FILES = [
  SKILLS['closed-loop-issue'],
  SKILLS['closed-loop-pr'],
  PR_MODE_REFERENCES['review-only'],
  PR_MODE_REFERENCES.autofix,
  SHARED_REFERENCES['gate-contract'],
  SHARED_REFERENCES.records,
];
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markdownLiteral = (value) => new RegExp('`' + escapeRegExp(value) + '`', 'g');

function locateInstalledPiSkillsApi() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const globalRoot = execFileSync(npmCommand, ['root', '-g'], { encoding: 'utf8' }).trim();
  const packageRoot = path.join(globalRoot, '@earendil-works', 'pi-coding-agent');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const apiPath = path.join(packageRoot, 'dist', 'core', 'skills.js');
  if (!fs.existsSync(apiPath)) throw new Error(`installed Pi package is missing its skills API: ${apiPath}`);
  const api = require(apiPath);
  if (typeof api.loadSkillsFromDir !== 'function') throw new Error('installed Pi skills API does not export loadSkillsFromDir');
  if (!/^(?:0\.(?:8[4-9]|9\d)|[1-9]\d*)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
    throw new Error(`installed Pi version is not a supported semantic version: ${packageJson.version}`);
  }
  return { api, version: packageJson.version };
}

const installedPiSkills = locateInstalledPiSkillsApi();

function validateDiscoveryDiagnostics(discovery) {
  const fields = ['errors', 'diagnostics'].filter((field) => Object.prototype.hasOwnProperty.call(discovery, field));
  assert.ok(fields.length > 0, 'installed Pi discovery must expose errors or diagnostics');
  for (const field of fields) {
    assert.ok(Array.isArray(discovery[field]), `installed Pi discovery ${field} must be an array`);
    assert.deepEqual(discovery[field], [], `installed Pi discovery ${field} must be empty`);
  }
}

const REPOSITORY_SPECIFIC_SKILL_PROSE = [
  /npm pack/,
  /reference fixtures/,
  /clause and artifact assertions/,
  /Issue 13 validation/,
];

const PROMPTS = {
  'prompts/tidd-issue.md': { hint: '<issue-ref>', skill: 'closed-loop-issue', skillFile: SKILLS['closed-loop-issue'] },
  'prompts/tidd-pr.md': { hint: '<pr-ref> [autofix]', skill: 'closed-loop-pr', skillFile: SKILLS['closed-loop-pr'] },
};
const FORBIDDEN_PROMPT_RESTATEMENTS = {
  'prompts/tidd-issue.md': [
    /Under CL-D31 and CL-D32/,
    /equivalent entrypoints/,
    /owner-gated candidate publication preview/,
    /no-retry boundaries/,
    /foreign-repository rules/,
    /IMPLEMENTATION_READY/,
  ],
  'prompts/tidd-pr.md': [
    /Mode parsing is case-sensitive/,
    /only the final exact token/,
    /do not edit any file in the repository/,
    /run-wide cap remains five successful correction pushes/,
    /one normal commit/,
    /REPLY_EXCEPTION/,
    /exact token autofix/i,
    /permit file edits/i,
  ],
};

function normalizedSentences(text) {
  return text
    .replace(/^---\r?\n/, '')
    .replace(/\r?\n---\r?\n?/, '\n')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n|(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim().replace(/\s+/g, ' '))
    .filter((sentence) => [...sentence].length >= 60);
}

const FALSIFICATION_ARTIFACTS = [...Object.values(SKILLS), ...Object.values(PR_MODE_REFERENCES), PR_PUBLICATION_TEMPLATE, ...Object.values(SHARED_REFERENCES), ...Object.keys(PROMPTS)];
const GENERIC_FALSIFICATION_EVIDENCE = 'authoritative files of the repository under review';
const ABSENT_RECORD_RULE = 'that absence is not itself a finding';

let packedEntries = null;
function packEntryList() {
  if (packedEntries) return packedEntries;
  const stdout = execSync('npm pack --dry-run --json', {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  assert.ok(start !== -1 && end > start, `could not parse npm pack output:\n${stdout}`);
  const report = JSON.parse(stdout.slice(start, end + 1));
  packedEntries = report[0].files.map((entry) => ({ ...entry, path: entry.path.replace(/\\/g, '/') }));
  return packedEntries;
}
function packFileList() {
  return packEntryList().map((entry) => entry.path);
}

test('the existing subagent registration is preserved', () => {
  assert.deepEqual(manifest.pi.subagents.agents, ['./agents']);
});

test('Issue #47 packaged helper surface is allowlisted without an entrypoint', () => {
  for (const file of PR_HELPER_FILES) assert.ok(exists(file), `missing helper: ${file}`);
  const packed = packFileList();
  for (const file of PR_HELPER_FILES) assert.ok(packed.includes(file), `helper is not packaged: ${file}`);
  const helperBytes = PR_HELPER_FILES.reduce((total, file) => total + fs.statSync(repoPath(file)).size, 0);
  assert.ok(helperBytes < 100000, `bounded Issue #47 helper surface is unexpectedly large: ${helperBytes} bytes`);
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.pi.extensions, undefined);
});

test('the package registers the closed-loop skills and prompts', () => {
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.deepEqual(manifest.pi.prompts, ['./prompts']);
});

test('the MVP introduces no extension', () => {
  assert.equal(manifest.pi.extensions, undefined, 'pi.extensions must be absent in the MVP');
  assert.equal(manifest.main, undefined, 'the package must not declare a JavaScript entry point');
  assert.equal(manifest.bin, undefined, 'the package must not declare an executable controller');
});

test('the published file set carries every closed-loop resource', () => {
  for (const entry of ['agents', 'skills', 'prompts', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(manifest.files.includes(entry), `package.json files is missing ${entry}`);
  }
});

test('Issue #41 guarded publication template is packaged without adding a package entrypoint', () => {
  assert.ok(exists('skills/closed-loop-pr/references/publish-review.sh'));
  assert.ok(packFileList().includes('skills/closed-loop-pr/references/publish-review.sh'));
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.pi.extensions, undefined);
});

test('the package runs tests without any devDependency', () => {
  assert.ok(manifest.scripts && manifest.scripts.test, 'package.json declares no test script');
  assert.equal(
    manifest.devDependencies,
    undefined,
    'pi runs npm install when installing a package, so devDependencies would be installed for every user',
  );
});

test('the six existing agents remain discoverable and unchanged in identity', () => {
  const files = fs.readdirSync(repoPath('agents')).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(EXPECTED_AGENTS).map((name) => `${name}.md`).sort());

  for (const [name, model] of Object.entries(EXPECTED_AGENTS)) {
    const frontmatter = parseFrontmatter(readText(`agents/${name}.md`));
    assert.ok(frontmatter, `agents/${name}.md has no frontmatter`);
    assert.equal(frontmatter.name, name);
    assert.equal(frontmatter.model, model);
  }
});

test('Issue #24 shared references exist and duplicate paragraphs are absent', () => {
  for (const file of Object.values(SHARED_REFERENCES)) assert.ok(exists(file), `missing shared reference: ${file}`);
  const normalize = (text) => text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const paragraphs = (root) => fs.readdirSync(repoPath(root), { recursive: true }).filter((file) => file.endsWith('.md')).flatMap((file) => normalize(readText(path.join(root, file))));
  const issue = new Set(paragraphs('skills/closed-loop-issue').filter((paragraph) => [...paragraph].length >= 200));
  const pr = new Set(paragraphs('skills/closed-loop-pr').filter((paragraph) => [...paragraph].length >= 200));
  assert.deepEqual([...issue].filter((paragraph) => pr.has(paragraph)), [], 'duplicate normalized paragraph remains across workflow trees');
});

test('Issue #24 duplicate normalization handles newline and whitespace equivalence independently', () => {
  const normalize = (text) => text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const left = normalize('  synthetic\r\nparagraph with   equivalent whitespace and blank lines  \r\n\r\nnext  block  ');
  const right = normalize('synthetic\nparagraph with equivalent whitespace and blank lines\n\nnext block');
  assert.deepEqual(left, right, 'normalization must canonicalize CRLF/CR, blank lines, trimming, and whitespace runs');
  assert.equal([...left[0]].length, 62);
});

test('Issue #24 shared references are named once and do not create a third discovered Skill', () => {
  for (const skill of Object.values(SKILLS)) {
    const text = readText(skill);
    for (const relative of ['../closed-loop-shared/references/gate-contract.md', '../closed-loop-shared/references/records.md']) {
      assert.equal((text.match(markdownLiteral(relative)) || []).length, 1, `${skill} must name ${relative} exactly once`);
    }
  }
  const discovered = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(full, 'SKILL.md'))) discovered.push(path.relative(repoRoot, full).replace(/\\/g, '/'));
      walk(full);
    }
  };
  walk(repoPath('skills'));
  assert.deepEqual(discovered.sort(), ['skills/closed-loop-issue', 'skills/closed-loop-pr']);
  for (const file of Object.values(SHARED_REFERENCES)) {
    const shared = readText(file);
    assert.doesNotMatch(shared, /SKILL\.md|^---$/m, `${file} must remain a bare documentation reference`);
    assert.doesNotMatch(shared, /references\/(?:review-only|autofix)\.md/, `${file} must not select or cross-reference a PR mode`);
  }
});

// Review-driven regression: exact Markdown-literal matching must reject malformed path lookalikes.
test('Issue #24 shared-reference literal matching rejects malformed prefixes', () => {
  const literal = '../closed-loop-shared/references/gate-contract.md';
  const metacharacters = '.*+?^${}()|[]\\';
  const metacharacterRegex = new RegExp(`^${escapeRegExp(metacharacters)}$`);
  assert.match(metacharacters, metacharacterRegex);
  assert.doesNotMatch(metacharacters + 'x', metacharacterRegex);
  const malformed = [
    '`../../closed-loop-shared/references/gate-contract.md`',
    '`../closed-loop-shared/references/gate-contractXmd`',
    '`.../closed-loop-shared/references/gate-contract.md`',
  ].join('\n');
  assert.equal(malformed.match(markdownLiteral(literal)), null, 'malformed backticked paths must not satisfy the exact relative path');
  assert.equal(('`' + literal + '`').match(markdownLiteral(literal))?.[0], '`' + literal + '`');
  assert.equal(('x' + literal).match(markdownLiteral(literal)), null, 'an unbackticked path must not satisfy the Markdown literal assertion');
});

test('Issue #24 six authority files remain below the published baseline', () => {
  // Review-driven regression: this raw-byte ceiling protects the reviewed authority graph.
  // CL-D34 raised the Issue #24 baseline to 108,000 bytes; CL-D36 raised it to 112,000 to
  // hold the shared structured-transport rule. Reducing prose duplicated between the two
  // workflow roots is tracked separately and is expected to return headroom.
  const total = AUTHORITY_FILES.reduce((sum, file) => sum + fs.statSync(repoPath(file)).size, 0);
  assert.ok(total < 112000, `six authority files total ${total} bytes, expected less than 112000`);
});

// Review-driven regression: installed Pi discovery must validate the complete runtime result.
test('Issue #24 discovery diagnostics validation is fail-closed', () => {
  assert.throws(() => validateDiscoveryDiagnostics({}), /errors or diagnostics/);
  assert.throws(() => validateDiscoveryDiagnostics({ errors: [], diagnostics: ['finding'] }), /diagnostics must be empty/);
  assert.throws(() => validateDiscoveryDiagnostics({ errors: ['finding'], diagnostics: [] }), /errors must be empty/);
  assert.doesNotThrow(() => validateDiscoveryDiagnostics({ errors: [] }));
  assert.doesNotThrow(() => validateDiscoveryDiagnostics({ diagnostics: [] }));
  assert.doesNotThrow(() => validateDiscoveryDiagnostics({ errors: [], diagnostics: [] }));
});

test('Issue #24 installed Pi discovery matches structural discovery when available', { skip: installedPiSkills ? false : 'Pi is not installed in this environment' }, () => {
  assert.match(installedPiSkills.version, /^(?:0\.(?:8[4-9]|9\d)|[1-9]\d*)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(typeof installedPiSkills.api.loadSkillsFromDir, 'function');
  const discovery = installedPiSkills.api.loadSkillsFromDir({ dir: repoPath('skills'), source: 'Issue #24 package test' });
  validateDiscoveryDiagnostics(discovery);
  const discoveredNames = discovery.skills.map((skill) => skill.name).sort();
  assert.deepEqual(discoveredNames, ['closed-loop-issue', 'closed-loop-pr']);
  const discoveredPaths = discovery.skills
    .map((skill) => path.relative(repoRoot, skill.filePath).replace(/\\/g, '/')).sort();
  assert.deepEqual(discoveredPaths, ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-pr/SKILL.md']);
});

test('both skills are valid Agent Skills definitions', () => {
  for (const [name, file] of Object.entries(SKILLS)) {
    assert.ok(exists(file), `missing skill: ${file}`);
    const frontmatter = parseFrontmatter(readText(file));
    assert.ok(frontmatter, `${file} has no frontmatter`);
    assert.equal(frontmatter.name, name, `${file} declares the wrong skill name`);
    assert.match(frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${file} has an invalid skill name`);
    assert.ok(frontmatter.name.length <= 64, `${file} skill name exceeds 64 characters`);
    assert.ok(frontmatter.description, `${file} has no description, so pi would not load it`);
    assert.ok(
      frontmatter.description.length <= 1024,
      `${file} description exceeds 1024 characters`,
    );
  }
});

test('Issue #19 PR Skill dispatches to exactly one mode-scoped reference', () => {
  const skill = readText(SKILLS['closed-loop-pr']);
  for (const file of Object.values(PR_MODE_REFERENCES)) assert.ok(exists(file), `missing mode reference: ${file}`);
  const dispatch = [
    '## Mode dispatch (CL-D19)',
    '',
    'After CL-D6 mode parsing succeeds and the shared preflight, target, evidence, language, gate, disposition, decision, and test-provenance rules above are available, load the authoritative continuation for the parsed mode:',
    '',
    '- review-only mode: read `references/review-only.md`;',
    '- exact CL-D30 `autofix` mode: read `references/autofix.md`.',
    '',
    'Read exactly one mode reference after mode parsing. Never read both. Follow the selected reference together with this shared contract; no instruction from the unselected mode applies.',
    '',
  ].join('\n');
  assert.ok(skill.endsWith(dispatch), 'mode dispatch must be the final PR SKILL.md block');
  for (const file of Object.values(PR_MODE_REFERENCES)) {
    const relative = file.replace('skills/closed-loop-pr/', '');
    assert.equal((skill.match(markdownLiteral(relative)) || []).length, 1, `dispatch must name ${relative} exactly once`);
  }
  for (const forbidden of [
    'implementation and validation\n→ one initial external-review snapshot',
    'A round is one completed gate invocation that returns a parsable verdict.',
    'a **two-minute quiet period** after the latest external event',
    'external_observation: head <sha> observed_from <timestamp>, this run only',
    '`POST_COMMIT(C, P)` :=',
    'exact-autofix writer is not replaceable',
    'successful-push counter',
    'Before every allowed reply attempt',
    'A missing or unparsable verdict is a tool-level failure: retry the invocation once',
  ]) assert.ok(!skill.includes(forbidden), `root PR Skill retains mode-only prose: ${forbidden}`);
  assert.doesNotMatch(skill, /## Gate loop \(PR review-only baseline;/);
  assert.doesNotMatch(skill, /## Exact PR `autofix` addendum \(CL-D30\)/);

  const reviewOnly = readText(PR_MODE_REFERENCES['review-only']);
  const autofix = readText(PR_MODE_REFERENCES.autofix);
  assert.match(reviewOnly, /## Review-only is the default/);
  assert.match(reviewOnly, /## Gate loop \(PR review-only baseline;/);
  assert.match(reviewOnly, /## Outcome and status block \(PR review-only baseline;/);
  assert.match(reviewOnly, /A missing or unparsable verdict is a tool-level failure: retry the invocation once, and if it fails again report `BLOCKED`\./);
  assert.doesNotMatch(reviewOnly, /Exact PR `autofix`/);
  assert.doesNotMatch(reviewOnly, /publication_grant: .*autofix/);
  assert.match(autofix, /## Autofix \(AC-AUTOFIX,/);
  assert.match(autofix, /## Exact PR `autofix` addendum \(CL-D30\)/);
  assert.match(autofix, /Exact PR `autofix` has no uncommitted candidate and may report readiness only from the CL-D30 post-reply final snapshot; its optional aggregate-summary draft never blocks readiness\./);
  assert.match(autofix, /Exact PR `autofix` never resumes: a later command is a fresh run\./);
  assert.doesNotMatch(reviewOnly, /references\/autofix\.md/);
  assert.doesNotMatch(autofix, /references\/review-only\.md/);
  assert.ok(Buffer.byteLength(skill) + Buffer.byteLength(reviewOnly) < PR_SKILL_PRE_SPLIT_BYTES, 'review-only disclosure must be smaller than the pre-split PR Skill');
  assert.ok(Buffer.byteLength(skill) + Buffer.byteLength(autofix) < PR_SKILL_PRE_SPLIT_BYTES, 'autofix disclosure must be smaller than the pre-split PR Skill');

  const reviewOnlyExclusive = [
    'Review-only never edits any repository file or creates a working-tree candidate.',
    'Review-only has no publication phase and no local commit/push window.',
    'Review-only never commits, pushes, posts, replies, or mutates external state.',
    'A missing or unparsable verdict is a tool-level failure: retry the invocation once',
  ];
  const autofixExclusive = [
    'Exact PR `autofix` submits only the published public-head OID',
    'Only the exact PR `autofix` mode token supplies a run-scoped publication grant',
    'Exact PR `autofix` never resumes: a later command is a fresh run.',
    'Exact autofix malformed or unparsable verdict stops on first failure.',
  ];
  for (const text of reviewOnlyExclusive) assert.ok(reviewOnly.includes(text), `review-only reference must own: ${text}`);
  for (const text of autofixExclusive) assert.ok(autofix.includes(text), `autofix reference must own: ${text}`);
  assert.doesNotMatch(autofix, /Review-only never edits any repository file/);
  assert.doesNotMatch(autofix, /Review-only has no publication phase/);
  assert.doesNotMatch(autofix, /Review-only never commits, pushes, posts, replies/);
  assert.doesNotMatch(reviewOnly, /Exact PR `autofix` submits only the published public-head OID/);
  assert.doesNotMatch(reviewOnly, /Only the exact PR `autofix` mode token supplies a run-scoped publication grant/);
  assert.doesNotMatch(reviewOnly, /Exact autofix malformed or unparsable verdict stops on first failure/);
});

test('shipped skills omit repository-specific test-suite commentary', () => {
  for (const file of [...Object.values(SKILLS), ...Object.values(PR_MODE_REFERENCES), ...Object.values(SHARED_REFERENCES)]) {
    const text = readText(file);
    for (const forbidden of REPOSITORY_SPECIFIC_SKILL_PROSE) {
      assert.doesNotMatch(text, forbidden, `${file} contains repository-specific test commentary: ${forbidden}`);
    }
  }
});

test('falsification guidance does not require a package-specific development record', () => {
  for (const file of FALSIFICATION_ARTIFACTS) {
    assert.doesNotMatch(
      readText(file),
      /CONTRACT\.md/,
      `${file} names an unpackaged repository-specific record as falsification evidence`,
    );
  }
  for (const file of Object.values(SKILLS)) {
    const text = readText(file);
    assert.match(text, new RegExp(GENERIC_FALSIFICATION_EVIDENCE));
    assert.match(text, new RegExp(ABSENT_RECORD_RULE, 'i'));
  }
});

test('both prompt templates expose accurate argument hints', () => {
  for (const [file, expected] of Object.entries(PROMPTS)) {
    assert.ok(exists(file), `missing prompt template: ${file}`);
    const frontmatter = parseFrontmatter(readText(file));
    assert.ok(frontmatter, `${file} has no frontmatter`);
    assert.ok(frontmatter.description, `${file} has no description`);
    assert.equal(frontmatter['argument-hint'], expected.hint, `${file} has the wrong argument hint`);
  }
});

// Provenance: pre-implementation compile/contract RED for Issue #22 Option A; the
// captured focused run failed 2/2 before implementation (not behavioral RED).
test('Issue #22 prompt templates are thin authoritative-Skill dispatchers', () => {
  for (const [file, expected] of Object.entries(PROMPTS)) {
    const text = readText(file);
    assert.ok(text.includes(expected.skill), `${file} does not name the ${expected.skill} skill it must load`);
    assert.equal((text.match(/\$@/g) || []).length, 1, `${file} must pass the complete raw $@ vector exactly once`);
    assert.match(text, /authoritative contract/, `${file} must identify its Skill as authoritative`);
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    assert.equal(body, [
      'Raw arguments (preserve this complete vector for the Skill to parse): $@',
      '',
      `Load the \`${expected.skill}\` Skill and follow it as the authoritative contract for this run. Do not reconstruct the workflow from this prompt.`,
    ].join('\n'), `${file} body must contain only raw argument capture and authoritative Skill delegation`);
    for (const forbidden of FORBIDDEN_PROMPT_RESTATEMENTS[file]) {
      assert.doesNotMatch(text, forbidden, `${file} restates workflow contract prose: ${forbidden}`);
    }

    const promptSentences = new Set(normalizedSentences(text));
    const duplicated = normalizedSentences(readText(expected.skillFile)).filter((sentence) => promptSentences.has(sentence));
    assert.deepEqual(duplicated, [], `${file} duplicates a normalized 60+ character sentence from ${expected.skillFile}`);
  }
});

// Provenance: pre-implementation compile/contract RED for Issue #22 Option A; the
// same captured focused run failed 2/2 before implementation (not runtime proof).
test('Issue #22 removed prompt clauses retain named Skill-scoped enforcement', () => {
  const clauses = new Map(contractManifest.clauses.map((clause) => [clause.id, clause]));
  for (const removed of ['CL-D6-prompt', 'AC-REVIEW-ONLY-prompt', 'CL-D31-prompt', 'CL-D32-prompt']) {
    assert.equal(clauses.has(removed), false, `${removed} must be removed under CL-D19 Option A`);
  }
  const surviving = {
    'CL-D6-skill': SKILLS['closed-loop-pr'],
    'AC-REVIEW-ONLY-skill': PR_MODE_REFERENCES['review-only'],
    'CL-D8': SKILLS['closed-loop-issue'],
    'CL-D31-authority-skill': SKILLS['closed-loop-issue'],
    'CL-D31-preview-skill': SKILLS['closed-loop-issue'],
    'CL-D31-publication-skill': SKILLS['closed-loop-issue'],
    'CL-D32-skill': SKILLS['closed-loop-issue'],
  };
  for (const [id, file] of Object.entries(surviving)) {
    assert.ok(clauses.has(id), `missing surviving Skill-scoped clause ${id}`);
    assert.ok(clauses.get(id).files.includes(file), `${id} must remain enforced against ${file}`);
  }
});

test('no skill, mode reference, or prompt hard-codes a model ID', () => {
  const files = [...Object.values(SKILLS), ...Object.values(PR_MODE_REFERENCES), ...Object.values(SHARED_REFERENCES), ...Object.keys(PROMPTS)];
  for (const file of files) {
    const text = readText(file);
    assert.doesNotMatch(
      text,
      /gpt-5\.6-|glm-5\.2/,
      `${file} hard-codes a model ID, which would defeat name-level agent overrides (CL-D22)`,
    );
  }
});

// CL-D31 packaging: the legacy package ships prose only and no executable controller.
test('Issue #13 CL-D31 legacy artifacts are packaged without a controller', () => {
  const entries = packEntryList();
  const files = entries.map((entry) => entry.path);
  for (const entry of ['skills/closed-loop-issue/SKILL.md', 'prompts/tidd-issue.md', 'README.md']) {
    assert.ok(files.includes(entry), `Issue 13 artifact missing from packed tarball: ${entry}`);
  }
  assert.ok(!files.some((file) => /(?:controller|extension)/i.test(file)));
  const allowed = /^(?:LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|package\.json|skills\/closed-loop-pr\/references\/publish-review\.sh|skills\/closed-loop-pr\/helpers\/[A-Za-z0-9._/-]+\.js|(?:agents|skills|prompts)\/[A-Za-z0-9._/-]+\.md)$/;
  for (const entry of entries) {
    assert.match(entry.path, allowed, `unexpected non-prose package payload: ${entry.path}`);
    assert.equal(Number(entry.mode) & 0o111, 0, `packed entry must not be executable: ${entry.path}`);
  }
});

// CL-D32 packaging is behavioral: execute npm pack and read the resulting packed Skill,
// prompt, and README from the tarball rather than inferring payload content from package.json. The package remains prose-only and has no executable/controller.
test('Issue #15 CL-D32 packed artifacts contain the combined transaction prose', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue-15-pack-'));
  try {
    const stdout = execSync(`npm pack --json --pack-destination ${JSON.stringify(directory)}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1));
    const tarball = path.join(directory, report[0].filename);
    const entries = report[0].files.map((entry) => ({ ...entry, path: entry.path.replace(/\\/g, '/') }));
    const reportedFiles = entries.map((entry) => entry.path);
    const archiveEntries = execSync(`tar -tvzf ${JSON.stringify(tarball)}`, {
      cwd: repoRoot, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    }).trim().split('\n').map((line) => {
      const match = line.match(/^([dl-][rwxStTs-]{9})\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/);
      assert.ok(match, `could not parse tar header: ${line}`);
      return { mode: match[1], path: match[2].replace(/^package\//, '').replace(/\/$/, '') };
    }).filter((entry) => entry.path && entry.mode[0] !== 'd');
    const files = archiveEntries.map((entry) => entry.path);
    const readPacked = (entry) => execSync(`tar -xOf ${JSON.stringify(tarball)} ${JSON.stringify(`package/${entry}`)}`, {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.match(readPacked('skills/closed-loop-issue/SKILL.md'), /Combined scope-freeze decision transaction \(CL-D32\)/);
    for (const file of Object.values(SKILLS)) {
      const text = readPacked(file);
      for (const forbidden of REPOSITORY_SPECIFIC_SKILL_PROSE) {
        assert.doesNotMatch(text, forbidden, `packed ${file} contains repository-specific test commentary: ${forbidden}`);
      }
    }
    const packedIssuePrompt = readPacked('prompts/tidd-issue.md');
    assert.match(packedIssuePrompt, /Raw arguments \(preserve this complete vector for the Skill to parse\): \$@/);
    assert.match(packedIssuePrompt, /closed-loop-issue.*authoritative contract/s);
    assert.doesNotMatch(packedIssuePrompt, /CL-D32 combined scope-freeze approval|one exact owner response/);
    assert.match(readPacked('README.md'), /#### Combined scope-freeze approval/);
    assert.deepEqual(files.slice().sort(), reportedFiles.slice().sort(), 'the generated archive must match its same-invocation npm report');
    assert.ok(!files.some((file) => /(?:controller|extension)/i.test(file)));
    assert.deepEqual(
      files.filter((file) => /\.(?:js|mjs|cjs|ts)$/.test(file)).sort(),
      PR_HELPER_FILES.slice().sort(),
      'only the bounded Issue #47 helpers may be packaged as JavaScript',
    );
    assert.ok(!files.some((file) => file.startsWith('test/')));
    assert.ok(!files.includes('CONTRACT.md'));
    for (const entry of archiveEntries) {
      assert.equal(entry.mode[0], '-', `actual CL-D32 package entry must be a regular file: ${entry.path}`);
      assert.equal(`${entry.mode[3]}${entry.mode[6]}${entry.mode[9]}`, '---', `actual CL-D32 package entry must not be executable: ${entry.path}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Issue #25 packed artifacts do not require the unpackaged development record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue-25-pack-'));
  try {
    const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1))[0];
    const tarball = path.join(directory, report.filename);
    const files = report.files.map((entry) => entry.path.replace(/\\/g, '/'));
    const readPacked = (entry) => execFileSync('tar', ['-xOf', tarball, `package/${entry}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(files.length, 30, `packed file count changed: ${files.join(', ')}`);
    assert.ok(!files.includes('CONTRACT.md'));
    for (const file of FALSIFICATION_ARTIFACTS) {
      assert.ok(files.includes(file), `packed tarball is missing ${file}`);
      assert.doesNotMatch(
        readPacked(file),
        /CONTRACT\.md/,
        `packed ${file} names an unpackaged repository-specific record as falsification evidence`,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the packed tarball contains the closed-loop resources', () => {
  const files = packFileList();
  const required = [
    'agents/sol-reviewer.md',
    'agents/terra-oracle.md',
    'agents/terra-reviewer.md',
    'agents/luna-worker.md',
    'skills/closed-loop-issue/SKILL.md',
    'skills/closed-loop-pr/SKILL.md',
    ...Object.values(PR_MODE_REFERENCES),
    ...Object.values(SHARED_REFERENCES),
    'prompts/tidd-issue.md',
    'prompts/tidd-pr.md',
    'README.md',
  ];
  for (const entry of required) {
    assert.ok(files.includes(entry), `packed tarball is missing ${entry}\npacked: ${files.join(', ')}`);
  }
});

test('Issue #24 npm pack reports and archives both shared references', () => {
  // New shared-path archive coverage is co-developed integration coverage; package inclusion itself is characterized above.
  const expected = Object.values(SHARED_REFERENCES);
  const dryRunFiles = packFileList();
  for (const file of expected) assert.ok(dryRunFiles.includes(file), `dry-run report is missing ${file}`);

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue24-pack-'));
  try {
    const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const report = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1))[0];
    const archive = path.join(destination, report.filename);
    const archiveFiles = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, '').replace(/\/$/, ''));
    for (const file of expected) assert.ok(archiveFiles.includes(file), `actual tarball is missing ${file}`);
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('Issue #19 npm pack reports and archives both PR mode references', () => {
  // Passing behavioral characterization: package.json already publishes the skills tree.
  const expected = Object.values(PR_MODE_REFERENCES);
  const dryRunFiles = packFileList();
  for (const file of expected) assert.ok(dryRunFiles.includes(file), `dry-run report is missing ${file}`);

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue19-pack-'));
  try {
    const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1))[0];
    const tarball = path.join(destination, report.filename);
    const archiveFiles = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, '').replace(/\/$/, ''));
    for (const file of expected) assert.ok(archiveFiles.includes(file), `actual tarball is missing ${file}`);
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('the packed tarball excludes the authoritative development record', () => {
  const files = packFileList();
  assert.ok(
    !files.includes('CONTRACT.md'),
    `CONTRACT.md is a development record and must not be package payload: ${files.join(', ')}`,
  );
});

test('the packed tarball ships only bounded Issue #47 helper JavaScript', () => {
  const files = packFileList();
  const code = files.filter((file) => /\.(ts|js|mjs|cjs)$/.test(file));
  assert.deepEqual(code.sort(), PR_HELPER_FILES.slice().sort(), `unexpected packaged code: ${code.join(', ')}`);
  assert.ok(!files.includes('CONTRACT.md'));
});

test('the packed tarball ships no JavaScript controller, executable-mode entry, or tests', () => {
  const entries = packEntryList();
  const files = entries.map((entry) => entry.path);
  const code = files.filter((file) => /\.(ts|js|mjs|cjs)$/.test(file));
  assert.deepEqual(code.sort(), PR_HELPER_FILES.slice().sort(), `the package ships unexpected JavaScript: ${code.join(', ')}`);
  assert.deepEqual(entries.filter((entry) => Number(entry.mode) & 0o111), [], 'packed entries must not depend on executable mode bits');
  const tests = files.filter((file) => file.startsWith('test/'));
  assert.deepEqual(tests, [], `the test seam must not be published: ${tests.join(', ')}`);
});

test('the README documents the closed-loop workflow and its requirements', () => {
  const readme = readText('README.md');
  for (const required of [
    '/tidd-issue',
    '/tidd-pr',
    'autofix',
    '/skill:closed-loop-issue',
    '/skill:closed-loop-pr',
    'sol-reviewer',
    'terra-oracle',
    'terra-reviewer',
    'luna-worker',
    'gpt-5.6-sol',
    '`glm-worker` is not used by the closed-loop workflow',
    'run-scoped',
    'no workflow is forced by default',
  ]) {
    assert.ok(readme.includes(required), `README.md is missing: ${JSON.stringify(required)}`);
  }
});

// CL-D30 packaging characterization for Issue #28.
test('Issue #28 npm pack excludes every enumerated runtime root from dry-run and actual tarball', () => {
  // Retrospective behavioral characterization: package.json already has an allowlist,
  // so this is expected to pass before the Issue #28 prose change, not RED evidence.
  const runtimeRoots = ['.pi', '.pi-subagents'];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue28-pack-'));
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue28-dest-'));
  const copy = (entry) => fs.cpSync(repoPath(entry), path.join(tempRoot, entry), { recursive: true });
  try {
    fs.copyFileSync(repoPath('package.json'), path.join(tempRoot, 'package.json'));
    for (const entry of ['agents', 'skills', 'prompts', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) copy(entry);
    const probes = runtimeRoots.map((root) => path.join(tempRoot, root, 'tasks', 'issue-28-probe', 'deep.txt'));
    for (const probe of probes) {
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      fs.writeFileSync(probe, 'Pi runtime probe\\n');
    }
    const parseReport = (stdout) => {
      const start = stdout.indexOf('[');
      const end = stdout.lastIndexOf(']');
      assert.ok(start >= 0 && end > start, `could not parse npm pack report:\\n${stdout}`);
      return JSON.parse(stdout.slice(start, end + 1))[0];
    };
    const reportPaths = (report) => report.files.map((entry) => entry.path.replace(/\\/g, '/'));
    const assertNoRuntimeRoot = (entries, label) => {
      for (const entry of entries) {
        assert.ok(!runtimeRoots.some((root) => entry === root || entry.startsWith(`${root}/`)), `${label} leaked runtime-root entry: ${entry}`);
      }
    };
    const pack = (args) => execFileSync('npm', ['pack', ...args], { cwd: tempRoot, encoding: 'utf8' });
    const dryReport = parseReport(pack(['--dry-run', '--json']));
    assertNoRuntimeRoot(reportPaths(dryReport), 'dry-run report');
    const actualReport = parseReport(pack(['--json', '--pack-destination', destination]));
    assertNoRuntimeRoot(reportPaths(actualReport), 'actual report');
    const archive = path.join(destination, actualReport.filename);
    const archiveEntries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, '').replace(/\\/g, '/'));
    assertNoRuntimeRoot(archiveEntries, 'actual tarball');
    for (const probe of probes) assert.ok(fs.existsSync(probe), 'packaging must not clean runtime probes');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
