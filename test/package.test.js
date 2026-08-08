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

const REPOSITORY_SPECIFIC_SKILL_PROSE = [
  /npm pack/,
  /reference fixtures/,
  /clause and artifact assertions/,
  /Issue 13 validation/,
];

const PROMPTS = {
  'prompts/tidd-issue.md': { hint: '<issue-ref>', skill: 'closed-loop-issue' },
  'prompts/tidd-pr.md': { hint: '<pr-ref> [autofix]', skill: 'closed-loop-pr' },
};

const FALSIFICATION_ARTIFACTS = [...Object.values(SKILLS), ...Object.keys(PROMPTS)];
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

test('shipped skills omit repository-specific test-suite commentary', () => {
  for (const file of Object.values(SKILLS)) {
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
    assert.match(readPacked('prompts/tidd-issue.md'), /CL-D32 combined scope-freeze approval/);
    assert.match(readPacked('README.md'), /#### Combined scope-freeze approval/);
    assert.deepEqual(files.slice().sort(), reportedFiles.slice().sort(), 'the generated archive must match its same-invocation npm report');
    assert.ok(!files.some((file) => /(?:controller|extension)/i.test(file)));
    assert.ok(!files.some((file) => /\.(?:js|mjs|cjs|ts)$/.test(file)));
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

    assert.equal(files.length, 14, `packed file count changed: ${files.join(', ')}`);
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
