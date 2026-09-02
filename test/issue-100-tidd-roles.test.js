'use strict';

// Issue #100 PR 1 (CL-D59) — agent identities describe workflow responsibilities; provider,
// model, and thinking level are deployment configuration. The package ships exactly four
// roles, each carrying its old model-derived name as a transitional alias, and no skill or
// prompt names a model-derived agent any more. pi-subagents 0.63.0 looks `agentOverrides` up
// by the canonical agent name only (src/agents/agents.ts: `overrides[agent.name]`), so an
// override keyed by an alias does not apply; the README says so.
//
// TDD provenance: recorded with the focused command below at 0 passes, all compile/contract
// RED against the model-derived agent files, prose, and the missing record. No behavioral
// RED is claimed: no packaged operation changes in this PR (gate identities are PR 2).
//   node --test test/issue-100-tidd-roles.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { readText, readJson, repoPath, parseFrontmatter, sectionOf } = require('./helpers');

const ROLES = {
  'tidd-adversarial-reviewer': { alias: 'sol-reviewer', model: 'gpt-5.6-sol', writer: false },
  'tidd-drift-reviewer': { alias: 'terra-oracle', model: 'gpt-5.6-terra', writer: false },
  'tidd-safety-reviewer': { alias: 'terra-reviewer', model: 'gpt-5.6-terra', writer: false },
  'tidd-autofix-worker': { alias: 'luna-worker', model: 'gpt-5.6-luna', writer: true },
};
const LEGACY = /sol-reviewer|terra-reviewer|terra-oracle|luna-worker|glm-worker|terra-worker/;
const REVIEWER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'];
const WORKER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'contact_supervisor'];

test('Issue #100 the package ships exactly the four role agents, each aliasing its old name', () => {
  const files = fs.readdirSync(repoPath('agents')).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(ROLES).map((name) => `${name}.md`).sort());
  for (const [role, expected] of Object.entries(ROLES)) {
    const text = readText(`agents/${role}.md`);
    const frontmatter = parseFrontmatter(text);
    assert.equal(frontmatter.name, role);
    assert.equal(frontmatter.aliases, expected.alias, `${role} must alias its old name`);
    assert.equal(frontmatter.model, expected.model, `${role} default model is deployment default, unchanged`);
    assert.equal(String(frontmatter.thinking).replace(/"/g, ''), 'high');
    assert.equal(String(frontmatter.inheritSkills), 'false');
    assert.deepEqual(frontmatter.tools.split(',').map((tool) => tool.trim()), expected.writer ? WORKER_TOOLS : REVIEWER_TOOLS);
    // The role description names the responsibility, never the model that serves it.
    assert.doesNotMatch(frontmatter.description, /gpt|glm|powered by|\bsol\b|\bterra\b|\bluna\b/i, `${role} description names a model`);
    // The body does not assert which model is running it either.
    const body = text.replace(/^---[\s\S]*?\n---\n/, '');
    assert.doesNotMatch(body, /GPT-5\.6|gpt-5\.6|glm-5/i, `${role} body names a model`);
  }
});

test('Issue #100 skills and prompts name roles, never model-derived agents', () => {
  const walk = (dir) => fs.readdirSync(repoPath(dir), { recursive: true }).filter((file) => file.endsWith('.md')).map((file) => `${dir}/${file}`);
  for (const file of [...walk('skills'), ...walk('prompts')]) {
    assert.doesNotMatch(readText(file), LEGACY, `${file} still names a model-derived agent`);
  }
  const issue = sectionOf(readText('skills/closed-loop-issue/SKILL.md'), '## Preflight (CL-D22, CL-D5)');
  assert.match(issue, /`tidd-adversarial-reviewer` and `tidd-drift-reviewer`/);
  const pr = sectionOf(readText('skills/closed-loop-pr/SKILL.md'), '## Preflight (CL-D22, CL-D5)');
  assert.match(pr, /`tidd-adversarial-reviewer`, `tidd-safety-reviewer`, and, conditionally for autofix mode, `tidd-autofix-worker`/);
  const writer = sectionOf(readText('skills/closed-loop-pr/references/autofix.md'), '### The writer (CL-D3)');
  assert.match(writer, /`tidd-autofix-worker` is mandatory/);
  assert.match(writer, /The package ships no other worker/);
});

test('Issue #100 the shared resolution section separates role from deployment and fails closed on capability', () => {
  const shared = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '## Name-level agent resolution (CL-D22, CL-D5, CL-D59)');
  assert.ok(shared, 'the resolution section must carry the CL-D59 marker');
  assert.match(shared, /Refer to agents \*\*by role name\*\* only, \*\*never by model ID\*\*/);
  assert.match(shared, /`tidd-adversarial-reviewer`, `tidd-drift-reviewer`, `tidd-safety-reviewer`, and `tidd-autofix-worker`/);
  assert.match(shared, /which provider, model, and thinking level serve a role is deployment configuration, never role semantics/);
  assert.match(shared, /the old model-derived names resolve only as transitional aliases for one release/);
  assert.match(shared, /If a required role is missing, disabled, unresolved, or lacks its required capability — a reviewer role resolves without `edit` or `write` and returns the CL-D36 envelope; the writer role resolves with `edit` and `write` — stop and report `BLOCKED`, naming the role and the override path/);
});

test('Issue #100 the README documents the roles, the alias transition, and override keying', () => {
  const readme = readText('README.md');
  for (const [role, expected] of Object.entries(ROLES)) {
    assert.ok(readme.includes(`| \`${expected.alias}\` | \`${role}\` |`), `README alias table lacks ${expected.alias} → ${role}`);
    assert.ok(readme.includes(`\`${role}\``));
  }
  assert.match(readme, /An `agentOverrides` entry keyed by an old name does not apply to the role: pi-subagents looks overrides up by the canonical agent name only/);
  assert.match(readme, /`subagents\.agentOverrides\.tidd-adversarial-reviewer\.model`/);
  assert.match(readme, /an exact configured name always resolves before an alias/);
  assert.doesNotMatch(readme, /`glm-worker` is not used by the closed-loop workflow/);
});

test('Issue #100 CL-D59 records the role split, the agents/ widening, and the removals', () => {
  const contract = readText('CONTRACT.md');
  const record = sectionOf(contract, '## CL-D59 — Agent identities name workflow roles; models are deployment configuration');
  assert.ok(record, 'CL-D59 must exist');
  assert.match(record, /\*Owner choice:\* Option A\./);
  assert.match(record, /issues\/100#issuecomment-5509800274/);
  assert.match(record, /`glm-worker` and `terra-worker` are removed/);
  assert.match(record, /widens the CL-D1 `agents\/` freeze exactly once more/);
  assert.match(record, /overrides\[agent\.name\]/);
  // SOL-104-ALIAS-COLLISION: resolveAgentName returns a unique exact configured name before it
  // ever consults aliases, so a leftover legacy definition bypasses the role; it is no collision.
  assert.match(record, /a unique exact configured name resolves before any alias is consulted/);
  assert.match(record, /a leftover legacy definition would silently bypass the role/);
  assert.doesNotMatch(record, /registry collision/);
  const cl1 = sectionOf(contract, '## CL-D1 — Gate verdicts are supplied by the caller, not by agent files');
  assert.match(cl1, /CL-D59 later renamed the agent files to role identities under its own widening/);
  const cl3 = sectionOf(contract, '## CL-D3 — Writer selection');
  assert.match(cl3, /For exact PR `autofix`, `tidd-autofix-worker` is the mandatory and sole correction writer\/publisher/);
  const cl22 = sectionOf(contract, '## CL-D22 — Closed-loop model requirements and preflight');
  assert.match(cl22, /`tidd-adversarial-reviewer` \(default `gpt-5.6-sol`\)/);
  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D59').map((clause) => clause.id).sort(), ['CL-D59-resolution', 'CL-D59-tests']);
  // CL-D35's rule still holds: no clause pins an agent file.
  assert.deepEqual(manifest.clauses.filter((clause) => clause.files.some((file) => file.startsWith('agents/'))), []);
});
