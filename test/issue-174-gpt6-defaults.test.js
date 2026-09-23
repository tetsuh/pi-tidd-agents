'use strict';

// Issue #174 (CL-D87) — the package ships gpt-6-sol for the three reviewer roles that were Sol and Terra, and
// gpt-6-luna for the convergence reviewer and the writer. Thinking stays `high` everywhere. The two Terra roles
// now run the Sol model, so the formal gates of each root no longer differ by model family; CL-D87 records that
// as the owner's choice. Records of past runs keep the models those runs used.
//
// TDD provenance: compile/contract RED — every assertion reads artifact text.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson, sectionOf, parseFrontmatter } = require('./helpers');

const SHIPPED = {
  'tidd-adversarial-reviewer': 'gpt-6-sol',
  'tidd-safety-reviewer': 'gpt-6-sol',
  'tidd-drift-reviewer': 'gpt-6-sol',
  'tidd-convergence-reviewer': 'gpt-6-luna',
  'tidd-autofix-worker': 'gpt-6-luna',
};

test('Issue #174 every agent definition ships the decided model at high', () => {
  for (const [agent, model] of Object.entries(SHIPPED)) {
    const frontmatter = parseFrontmatter(readText(`agents/${agent}.md`));
    assert.equal(frontmatter.model, model, `${agent} ships ${model}`);
    assert.equal(String(frontmatter.thinking).replace(/"/g, ''), 'high', `${agent} keeps thinking high`);
  }
});

test('Issue #174 every live surface names the shipped defaults', () => {
  const readme = readText('README.md');
  for (const [agent, model] of Object.entries(SHIPPED)) {
    assert.match(readme, new RegExp(`\\| \`${agent}\` \\| \`${model.replace('.', '\\.')}\` \\|`), `README role row for ${agent}`);
  }
  assert.match(readme, /ships with the `gpt-6-luna` default/);
  const roles = readJson('test/records/workflow-vocabulary.json').roles;
  for (const role of roles) assert.equal(role.model, SHIPPED[role.name], `workflow vocabulary declares ${role.name}`);
  const cl22 = sectionOf(readText('CONTRACT.md'), '## CL-D22 — Closed-loop model requirements and preflight');
  assert.match(cl22, /`tidd-adversarial-reviewer` \(default `gpt-6-sol`\), `tidd-drift-reviewer` \(default `gpt-6-sol`\), `tidd-safety-reviewer` \(default `gpt-6-sol`\), and conditional `tidd-autofix-worker` \(default `gpt-6-luna`\)/);
  assert.equal(/gpt-5\.6-/.test(cl22), false, 'CL-D22 states current defaults only, the convergence role included');
  for (const file of ['README.md', 'test/records/workflow-vocabulary.json']) {
    assert.equal(/gpt-5\.6-(sol|luna|terra)/.test(readText(file)), false, `${file} names no superseded default`);
  }
});

test('Issue #174 records of past runs keep the models those runs used', () => {
  const provenance = readText('test/records/issue-23-real-run-provenance.json');
  assert.match(provenance, /gpt-5\.6-sol/, 'the Issue #23 run record still names the model it ran on');
  assert.match(readText('test/closed-loop-regressions.test.js'), /openai-codex\/gpt-5\.6-sol:high/);
});

test('Issue #174 CL-D87 records the choice and what it changes about model families', () => {
  const record = sectionOf(readText('CONTRACT.md'), '## CL-D87 — The package ships gpt-6-sol and gpt-6-luna');
  assert.ok(record, 'CL-D87 must exist');
  for (const field of ['*Decision ID:* CL-D87', '*Kind:* contract', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(record.includes(field), `CL-D87 must carry ${field}`);
  }
  assert.match(record, /issues\/174#issuecomment-5788195445/, 'the record cites the revised owner choice');
  assert.match(record, /the formal gates of each root no longer differ by model family/);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D3 — Writer selection'), /CL-D87 later moved the Terra roles to `gpt-6-sol` and the writer to `gpt-6-luna`; no gate runs on the writer's model, so the self-grading exclusion still holds\./);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D29 — Sol attempts adversarial falsification of absolute claims'), /CL-D87 later placed the Sol and Terra roles on one model/);
  assert.match(sectionOf(readText('CONTRACT.md'), '## CL-D62 — A non-authoritative convergence stage runs before the adversarial gate') || readText('CONTRACT.md'), /CL-D87 later moved the shipped convergence default to `gpt-6-luna`/);
});
