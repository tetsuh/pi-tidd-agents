'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { repoRoot, repoPath, readText, readJson, exists, parseFrontmatter, lineCount } = require('./helpers');

const manifest = readJson('package.json');

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

const PROMPTS = {
  'prompts/tidd-issue.md': { hint: '<issue-ref>', skill: 'closed-loop-issue' },
  'prompts/tidd-pr.md': { hint: '<pr-ref> [autofix]', skill: 'closed-loop-pr' },
};

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

test('both prompt templates expose accurate argument hints', () => {
  for (const [file, expected] of Object.entries(PROMPTS)) {
    assert.ok(exists(file), `missing prompt template: ${file}`);
    const frontmatter = parseFrontmatter(readText(file));
    assert.ok(frontmatter, `${file} has no frontmatter`);
    assert.ok(frontmatter.description, `${file} has no description`);
    assert.equal(frontmatter['argument-hint'], expected.hint, `${file} has the wrong argument hint`);
  }
});

test('prompt templates delegate to their skill instead of duplicating the contract', () => {
  for (const [file, expected] of Object.entries(PROMPTS)) {
    const text = readText(file);
    assert.ok(
      text.includes(expected.skill),
      `${file} does not name the ${expected.skill} skill it must load`,
    );
    assert.ok(
      lineCount(text) <= 45,
      `${file} is ${lineCount(text)} lines; prompt templates must stay thin so the skill remains the single source of truth`,
    );
  }
});

test('no skill or prompt hard-codes a model ID', () => {
  const files = [...Object.values(SKILLS), ...Object.keys(PROMPTS)];
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
  const allowed = /^(?:LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|package\.json|(?:agents|skills|prompts)\/[A-Za-z0-9._/-]+\.md)$/;
  for (const entry of entries) {
    assert.match(entry.path, allowed, `unexpected non-prose package payload: ${entry.path}`);
    assert.equal(Number(entry.mode) & 0o111, 0, `packed entry must not be executable: ${entry.path}`);
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
    'prompts/tidd-issue.md',
    'prompts/tidd-pr.md',
    'README.md',
  ];
  for (const entry of required) {
    assert.ok(files.includes(entry), `packed tarball is missing ${entry}\npacked: ${files.join(', ')}`);
  }
});

test('the packed tarball excludes the authoritative development record', () => {
  const files = packFileList();
  assert.ok(
    !files.includes('CONTRACT.md'),
    `CONTRACT.md is a development record and must not be package payload: ${files.join(', ')}`,
  );
});

test('the packed tarball ships no executable code and no tests', () => {
  const files = packFileList();
  const code = files.filter((file) => /\.(ts|js|mjs|cjs)$/.test(file));
  assert.deepEqual(code, [], `the MVP must not ship executable code: ${code.join(', ')}`);
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

// CL-D30 packaging characterization for Issue #17.
test('Issue #17 npm pack excludes repository-root .pi runtime artifacts from dry-run and actual tarball', () => {
  // Retrospective behavioral characterization: package.json already has an allowlist,
  // so this is expected to pass before the Issue #17 prose change, not RED evidence.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue17-pack-'));
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tidd-issue17-dest-'));
  const copy = (entry) => fs.cpSync(repoPath(entry), path.join(tempRoot, entry), { recursive: true });
  try {
    fs.copyFileSync(repoPath('package.json'), path.join(tempRoot, 'package.json'));
    for (const entry of ['agents', 'skills', 'prompts', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) copy(entry);
    const probe = path.join(tempRoot, '.pi', 'tasks', 'issue-17-probe', 'deep.txt');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'Pi runtime probe\\n');
    const parseReport = (stdout) => {
      const start = stdout.indexOf('[');
      const end = stdout.lastIndexOf(']');
      assert.ok(start >= 0 && end > start, `could not parse npm pack report:\\n${stdout}`);
      return JSON.parse(stdout.slice(start, end + 1))[0];
    };
    const reportPaths = (report) => report.files.map((entry) => entry.path.replace(/\\/g, '/'));
    const assertNoPi = (entries, label) => {
      for (const entry of entries) assert.ok(entry !== '.pi' && !entry.startsWith('.pi/'), `${label} leaked .pi entry: ${entry}`);
    };
    const pack = (args) => execFileSync('npm', ['pack', ...args], { cwd: tempRoot, encoding: 'utf8' });
    const dryReport = parseReport(pack(['--dry-run', '--json']));
    assertNoPi(reportPaths(dryReport), 'dry-run report');
    const actualReport = parseReport(pack(['--json', '--pack-destination', destination]));
    assertNoPi(reportPaths(actualReport), 'actual report');
    const archive = path.join(destination, actualReport.filename);
    const archiveEntries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^package\//, '').replace(/\\/g, '/'));
    assertNoPi(archiveEntries, 'actual tarball');
    assert.ok(fs.existsSync(probe), 'packaging must not clean the runtime probe');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
