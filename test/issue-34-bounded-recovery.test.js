'use strict';

// Issue #34 / CL-D39: exact PR autofix gains one bounded recovery for a deterministic local
// tooling failure before any Luna task exists. Two properties matter and are pinned here:
// the recovery is confined to the pre-writer region, and it is expressed only in the mode
// reference that already owns retry behaviour, so no shared prose forks and no shared
// sentence gains a mode exception.

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readAutofixProcedure, readText, readContract, sectionOf, cliSchemas, repoPath, readManifest } = require('./helpers');

const CL_D39 = 'contract/CL-D39.md';
const AUTOFIX_DRIVER = 'skills/closed-loop-pr/driver/autofix.js';
const PR_AUTOFIX_ADDENDUM = 'skills/closed-loop-pr/references/autofix-addendum.md';
const GATE_CONTRACT = 'skills/closed-loop-shared/references/gate-contract.md';
const RECORDS = 'skills/closed-loop-shared/references/records.md';
const REVIEW_DRIVER_PHASES = 'skills/closed-loop-pr/driver/phases.js';
const ISSUE_SKILL = 'skills/closed-loop-issue/SKILL.md';
const CLI = 'skills/closed-loop-pr/helpers/cli.js';


test('Issue #34 the recovery is bounded to the pre-writer region', () => {
  // #249 B3 (CL-D114): the rule is read in its record and in the driver that applies it. The base reference's recovery
  // table is retired with the prose path: the packaged driver recovers only CL-D51's key, once per run and never after
  // the writer, and stops every other refusal, a narrowing CL-D39 records and does not close.
  const record = readText(CL_D39);
  assert.match(record, /One recovery is permitted per operation and phase for a deterministic local parsing, rendering, schema-access, or report-verification failure/);
  assert.match(record, /no Luna task, commit, push, or reply exists/);
  assert.match(record, /process-isolation root `pi-tidd-pr-helper-\*` with its `home`, `hooks`, `global.gitconfig`, `system.gitconfig`, and `git-stderr`/);
  assert.match(record, /one canonical `operation@phase` key that its replacement retains, so a replacement failure is the second failure of that key and is terminal/);
  assert.match(record, /invalidating only the failed operation's own output/);
  assert.match(record, /grants no resume, no second writer, no repeated provider mutation/);
  assert.match(record, /The packaged autofix driver recovers only CL-D51's key, with the output CL-D107 adds, once per run and never after the writer launch; a running gate waits, and every other helper refusal stops `BLOCKED`/);
  const driver = readText(AUTOFIX_DRIVER);
  assert.ok(driver.includes("codes: new Set(['designated_output_absent', 'designated_output_empty', 'result_names_no_run']), may: () => !s.relaunched && !s.writerLaunched,"), 'the driver relaunches only its CL-D51 codes, once per run, never after the writer');
  assert.match(driver, /CL-D51's key \(CL-D39\): only an absent or empty output/);
});

// DEC-PR65-CLD39-PROCESS-ISOLATION-002: the exemption is pinned against what the helper
// actually writes, not against the names it declares. isolationPaths() runs in a fresh child
// under a private temp parent, the created tree is walked without following links, and the
// exact relative tree must equal the prose-derived exemption. A nested write such as
// home/helper-extra changes the tree and fails here even though no declared name changed.
const PROCESS_HELPER = 'skills/closed-loop-pr/helpers/process.js';
function exemptedIsolationNames() {
  // #249 B3 (CL-D114): the exemption is parsed from the record, which states it verbatim.
  const clause = readText(CL_D39).match(/process-isolation root `([^`]+)\*` with its ((?:`[^`]+`(?:, and | and |, )?)+)/);
  assert.ok(clause, 'the exemption must name the isolation root prefix and its writes');
  return { prefix: clause[1], names: [...clause[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort() };
}
// Division of labour, kept deliberately simple:
//  - this guard proves the exemption equals what isolationPaths() creates, by running it in a
//    fresh child under a private temp parent and walking that whole parent without following
//    links. The walk is syntax-independent, so a direct, computed, aliased, or promise-based
//    write inside the parent is seen the same way, and no hand-maintained API list exists here.
//  - a helper write outside the parent is a new filesystem callsite in the helpers, which the
//    CL-D37 structural boundary (test/issue-59-helper-surface.test.js) rejects regardless of
//    destination. That guard is the primary defence; this one checks the exemption text.
function observedIsolation() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'issue34-isolation-'));
  try {
    const script = `
      const fs = require('node:fs'); const path = require('node:path');
      const parent = ${JSON.stringify(parent)};
      const { isolationPaths } = require(${JSON.stringify(repoPath(PROCESS_HELPER))});
      const iso = isolationPaths();
      const entries = [];
      (function walk(dir, rel) {
        for (const name of fs.readdirSync(dir).sort()) {
          const full = path.join(dir, name); const st = fs.lstatSync(full);
          const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
          entries.push({ rel: rel ? rel + '/' + name : name, type });
          if (type === 'dir') walk(full, rel ? rel + '/' + name : name);
        }
      })(parent, '');
      process.stdout.write(JSON.stringify({ root: path.basename(iso.root), rootDir: path.dirname(iso.root), parent, entries }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent } });
    assert.equal(result.status, 0, `isolationPaths child failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  } finally {
    // Remove only the exact parent this call created; nothing else under os.tmpdir().
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test('Issue #34 the whole private temp parent holds exactly one isolation root with exactly the exempted tree', () => {
  const { prefix, names } = exemptedIsolationNames();
  const o = observedIsolation();
  assert.equal(path.resolve(o.rootDir), path.resolve(o.parent), 'the isolation root must be created directly under the supplied temp parent');
  assert.ok(o.root.startsWith(prefix), `isolation root ${o.root} must carry the exempted prefix ${prefix}`);
  const topLevel = o.entries.filter((e) => !e.rel.includes('/'));
  assert.deepEqual(topLevel.map((e) => e.rel), [o.root], 'nothing may be written beside the isolation root inside the temp parent');
  const inside = o.entries.filter((e) => e.rel.startsWith(o.root + '/')).map((e) => ({ rel: e.rel.slice(o.root.length + 1), type: e.type }));
  assert.deepEqual(inside.filter((e) => e.type === 'symlink'), [], 'the isolation tree must contain no symlink');
  assert.deepEqual(inside.map((e) => e.rel).sort(), names, 'the created tree must equal the exempted names exactly — nothing nested, nothing extra, nothing missing');
  const types = Object.fromEntries(inside.map((e) => [e.rel, e.type]));
  assert.equal(types.home, 'dir'); assert.equal(types.hooks, 'dir');
  assert.equal(types['global.gitconfig'], 'file'); assert.equal(types['system.gitconfig'], 'file');
  // SOL-65-TEST-TEMP-CLEANUP: the test owns its parent and removes exactly it.
  assert.equal(fs.existsSync(o.parent), false, 'the test must remove the temp parent it created');
});

test('Issue #34 writes outside the temp parent are the CL-D37 boundary\'s job, and that guard is present', () => {
  // This guard does not try to enumerate filesystem APIs. A helper write to any destination is
  // a new callsite, and the merged CL-D37 structural boundary rejects unapproved callsites.
  const cl37 = readText('test/issue-59-helper-surface.test.js');
  assert.match(cl37, /APPROVED_FS_SITES/, 'the CL-D37 callsite allowlist must exist');
  assert.match(cl37, /filesystem access callsites/, 'the CL-D37 guard must reject unapproved filesystem callsites');
  assert.match(readContract(), /^## CL-D37 — /m, 'CL-D37 must be a recorded decision');
});

test('Issue #34 the stop rule keeps its wording and names its exceptions', () => {
  const text = (readAutofixProcedure() + '\n' + readText(PR_AUTOFIX_ADDENDUM));
  assert.match(text, /Tool\/startup\/API\/timeout\/stale-target\/malformed-output\/correlation failures are not verdicts, consume no counter, are not retried, and stop, except for the CL-D39 recovery defined above, the CL-D51 zero-output relaunch, and the CL-D86 recomposition after a push\./);
  // The invocation-map sentence must not contradict the recovery it now defers to.
  assert.match(text, /no retry beyond the CL-D39 recovery defined above/);
  // The recovery section really is above the stop rule.
  assert.ok(text.indexOf('### Bounded pre-writer recovery (CL-D39)') < text.indexOf('except for the CL-D39 recovery defined above'));
});

test('Issue #34 no shared prose forks and no shared sentence gains a mode exception', () => {
  // The shared layer already delegates retry behaviour, so the mode reference can own the
  // recovery outright. These pins fail if a future change instead conditionalises shared text.
  const shared = readText(GATE_CONTRACT);
  assert.match(shared, /Ordinary workflow-specific retry and fail-stop behavior belongs to the selected owning workflow or mode reference; shared policy does not grant a retry, publication, or mutation\./,
    'the shared delegation is what makes the mode-local rule possible');
  assert.match(shared, /Workflow-specific candidate, retry, extension, and resume boundaries remain authoritative in their owning files\./);
  assert.match(shared, /Tool, provider, startup, stale-target, and unparsable-verdict failures \*\*do not consume a round\*\*\./,
    'shared round accounting must stay compatible with a counter-free recovery');

  for (const file of [GATE_CONTRACT, RECORDS]) {
    const text = readText(file);
    assert.doesNotMatch(text, /CL-D39/, `${file} must not carry the mode-specific recovery decision`);
    assert.doesNotMatch(text, /exact autofix[^.]*recover/i, `${file} must not gain an autofix exception`);
  }
  // The other two modes keep their own rule, untouched and unqualified (#249 B2, CL-D113: review-only's is the driver's relaunch).
  const issue = readText(ISSUE_SKILL);
  assert.match(issue, /retry the invocation once, and if it fails again report `BLOCKED`/, `${ISSUE_SKILL} must keep its existing single retry`);
  assert.doesNotMatch(issue, /CL-D39/, `${ISSUE_SKILL} must not be conditionalised by the autofix decision`);
  const phases = readText(REVIEW_DRIVER_PHASES);
  assert.match(phases, /is relaunched once without spending a round/, `${REVIEW_DRIVER_PHASES} must keep its single relaunch`);
  assert.doesNotMatch(phases, /CL-D39/, `${REVIEW_DRIVER_PHASES} must not be conditionalised by the autofix decision`);
});

test('Issue #34 CL-D39 records the recovery and the no-fork basis', () => {
  const section = sectionOf(readContract(), '## CL-D39 — Exact autofix gains one bounded pre-writer recovery');
  assert.ok(section, 'CL-D39 decision is missing');
  assert.match(section, /^\*\*Clauses:\*\* CL-D39-stop, CL-D39-recovery, CL-D39-driver, CL-D39-baseline$/m);
  assert.match(section, /^\*Decision ID:\* CL-D39$/m);
  assert.match(section, /tetsuh\/pi-tidd-agents#34/);
  assert.match(section, /Option B for exact PR `autofix`/);
  assert.match(section, /Issue and PR review-only keep their existing single malformed-verdict retry unchanged/);
  assert.match(section, /No shared prose changes, and no shared sentence gains a mode exception/);
  assert.match(section, /Removing the mode-ownership statement from the shared gate contract invalidates the no-fork basis recorded here/);
  // The corrected evidence stays recorded: the narrowing is partial, not closing.
  assert.match(section, /rejects unknown fields without preventing selection of the wrong known field/);
  // CL-D42 narrowed this cited hole rather than removing it; the record must say which part
  // survives, so the citation stays checkable instead of drifting into a stale absolute.
  assert.match(section, /all accept an `oid`, so a same-typed cross-domain mix-up was reachable when this was decided/);
  assert.match(section, /CL-D42 later labelled every fingerprint domain inside one versioned envelope/);
  assert.match(section, /leaves only a value retyped by hand into a well-formed record/);
  // The retired invariant and the funded baseline are both recorded.
  assert.match(section, /`CLEAN@H` is not used because Issue #42 retired it/);
  assert.equal((section.match(/CLEAN@H/g) || []).length, 1, 'CLEAN@H may appear only in the sentence retiring it');
  assert.match(section, /`OPERATOR_CHECKOUT_UNCHANGED@O` and `AUTOFIX_WORKSPACE@H` are freshly re-proved/);
  assert.match(section, /that row is terminal here and its structural removal stays with #64/);
  assert.match(section, /raises the six-file authority baseline from 112,000 to 116,000 bytes/);
  assert.match(section, /the shortfall is funded by the raise rather than by a trim/);
  // The recorded measurement is revision-qualified so it cannot read as a running total.
  assert.match(section, /measured 112,720 bytes at `f7f3ff9`, when the raise was decided/);

  const manifest = readManifest();
  assert.deepEqual(
    manifest.clauses.filter((clause) => clause.marker === 'CL-D39').map((clause) => clause.id).sort(),
    ['CL-D39-baseline', 'CL-D39-driver', 'CL-D39-recovery', 'CL-D39-stop'],
  );
});

test('Issue #34 user-facing and CL-D30 summaries acknowledge the bounded exception', () => {
  assert.match(readText('README.md'), /apart from the one bounded pre-writer recovery CL-D39 defines, it has no retry, resume/);
  assert.match(sectionOf(readContract(), '## CL-D30 — Exact PR autofix publishes one bounded correction per public head'), /CL-D39 later adds one bounded pre-writer recovery and nothing else/);
});

test('Issue #34 the partial-narrowing evidence in the record still matches the code', () => {
  // CL-D39 cites these as reasons the case is not closed; if the code changes, the record
  // must be revisited rather than silently drifting.
  const sharingOid = Object.entries(cliSchemas()).filter(([name, fields]) => name.startsWith('fingerprint_') && fields.length === 1 && fields[0] === 'oid').map(([name]) => name).sort();
  assert.deepEqual(sharingOid, ['fingerprint_pr_base', 'fingerprint_pr_head', 'fingerprint_pr_tree'],
    'the record cites these three as sharing an oid input; a change here invalidates that rationale');
  assert.match((readAutofixProcedure() + '\n' + readText(PR_AUTOFIX_ADDENDUM)), /Do not regenerate this logic as run-time shell, `jq`, Python, or GraphQL/);
});

// #249 B3 (CL-D114) retired the executable decision model that stood here, the Issue #82 zero-output cases with it: it
// parsed the base reference's CL-D39 table into a model of the parent's decision, which the packaged driver does not
// make. The driver's one relaunch is tested by behaviour in test/issue-196-autofix-driver-5, -6 and -7 and
// test/issue-254-placeholder-relaunch.test.js, and test/issue-82-zero-output-relaunch.test.js pins its record.
