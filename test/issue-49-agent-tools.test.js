'use strict';

// Issue #49 / CL-D35: `tools` is a strict allowlist, not a loader — pi-subagents
// docs/agents.md: "An allowlisted name does not load the extension that registers
// it", and generic `intercom` is "external or provider-supplied only". The unloaded
// `intercom` tool therefore failed child runs after the agent's own work completed.
// CL-D35 narrows the CL-D1 agents/** freeze just far enough to remove it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readText, readJson, parseFrontmatter } = require('./helpers');

const REVIEWERS = ['sol-reviewer', 'terra-reviewer', 'terra-oracle'];
const WORKERS = ['luna-worker', 'glm-worker', 'terra-worker'];
const AGENTS = [...REVIEWERS, ...WORKERS];
const REVIEWER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash'];
const WORKER_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write', 'contact_supervisor'];

const toolsOf = (name) => parseFrontmatter(readText(`agents/${name}.md`)).tools.split(',').map((tool) => tool.trim());

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

test('Issue #49 no agent requests the unloaded intercom tool', () => {
  for (const name of AGENTS) {
    assert.ok(!toolsOf(name).includes('intercom'), `agents/${name}.md still allowlists the unloaded intercom tool`);
  }
});

test('Issue #49 reviewer and oracle read-only tool sets are otherwise unchanged', () => {
  for (const name of REVIEWERS) assert.deepEqual(toolsOf(name), REVIEWER_TOOLS, `agents/${name}.md tool set changed beyond the intercom removal`);
});

test('Issue #49 workers keep contact_supervisor and their write tools', () => {
  for (const name of WORKERS) assert.deepEqual(toolsOf(name), WORKER_TOOLS, `agents/${name}.md tool set changed beyond the intercom removal`);
});

test('Issue #49 no agent prompt keeps a generic intercom fallback', () => {
  for (const name of AGENTS) {
    assert.doesNotMatch(readText(`agents/${name}.md`), /intercom/i, `agents/${name}.md still mentions intercom`);
  }
});

test('Issue #49 every agent keeps its native supervisor coordination guidance', () => {
  // pi-subagents auto-adds `contact_supervisor` to a child allowlist when the intercom
  // bridge is active (docs/configuration.md, `intercomBridge`, default mode `always`):
  // "Native supervisor messaging does not require an external pi-intercom installation or
  // per-agent extension allowlists." So the reviewers keep this guidance without listing
  // the tool, and only the provider-supplied `intercom` name had to go.
  for (const name of AGENTS) {
    const text = readText(`agents/${name}.md`);
    assert.match(text, /`contact_supervisor`/, `agents/${name}.md must keep the native supervisor channel`);
    assert.match(text, /runtime bridge instructions/, `agents/${name}.md must keep its supervisor-target guidance`);
  }
  // The removal is capability-reducing only: reviewers gain nothing in exchange.
  for (const name of REVIEWERS) assert.ok(!toolsOf(name).includes('contact_supervisor'), `agents/${name}.md must not add a tool the bridge already supplies`);
});

test('Issue #49 CL-D35 narrows the agents/** freeze without reopening it', () => {
  const contract = readText('CONTRACT.md');
  const section = sectionOf(contract, '## CL-D35 — One-time removal of the unloaded intercom tool from the six agent allowlists');
  assert.ok(section, 'CL-D35 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D35-freeze, CL-D35-readme$/m);
  assert.match(section, /^\*Decision ID:\* CL-D35$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#49/);
  assert.match(section, /strict allowlist; it does not load extension code/);
  assert.match(section, /Adopt CL-D35 as a single approved change, not a standing rule/);
  assert.match(section, /name, model, role, verdict contract, and every remaining tool stay frozen/);
  assert.match(section, /no agent gains a tool, an authority, or a verdict contract/);
  // The exception is one-time: it must not read as a general permission.
  assert.match(section, /authorizes no other removal and creates no general permission to drop a runtime-unprovided tool; a later removal requires its own owner decision/);
  assert.match(section, /It expires on merge of that change and authorizes nothing further/);
  for (const name of AGENTS) assert.ok(section.includes(`\`${name}\``), `CL-D35 must name agents/${name}.md explicitly`);

  const cl1 = sectionOf(contract, '## CL-D1 — Gate verdicts are supplied by the caller, not by agent files');
  assert.match(cl1, /CL-D35 approves one capability-reducing removal for Issue #49[^.]*grants no further permission/);
  const dec23 = sectionOf(contract, '## DEC-I23-PAYLOAD-COMPACTION-001 — Option A payload history compaction');
  assert.match(dec23, /CL-D35 records the owner decision this clause requires for the Issue #49 tool-allowlist removal/);

  const shared = sectionOf(readText('skills/closed-loop-shared/references/gate-contract.md'), '## Gate verdicts (CL-D1)');
  assert.match(shared, /\*\*Do not modify any file under `agents\/`\*\*/, 'the CL-D1 freeze literal must survive');
  assert.match(shared, /CL-D35 is a single approved exception for the Issue #49 `intercom` removal, not a standing permission/);
  assert.match(shared, /every other agent-file change, and every addition, still requires its own owner decision/);

  const manifest = readJson('test/contract-clauses.json');
  assert.deepEqual(manifest.clauses.filter((clause) => clause.marker === 'CL-D35').map((clause) => clause.id).sort(), ['CL-D35-freeze', 'CL-D35-readme']);
  // No clause pins an agent file: stamping a CL-D35 marker into one would itself be an
  // addition the freeze forbids, so the allowlists above are pinned by exact comparison.
  assert.deepEqual(manifest.clauses.filter((clause) => clause.files.some((file) => file.startsWith('agents/'))), []);
  assert.match(section, /stamping a `CL-D35` marker into an agent file would itself be an addition the freeze forbids/);
  assert.match(readText('README.md'), /CL-D35 approves one removal of an unloaded tool for Issue #49 and grants no standing permission/);
});
