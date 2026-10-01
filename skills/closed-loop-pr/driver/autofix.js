'use strict';

// CL-D96 (#196): the packaged exact-autofix driver. It sequences a run from the package's helpers; the parent makes
// only the `subagent` calls it prints; gates judge; the writer edits and then runs `pre-edit` and `batch`, so its own
// process makes the one commit and the one non-force push (CL-D89 unchanged). The mechanised judgments are the owner's
// (https://github.com/tetsuh/pi-tidd-agents/issues/191#issuecomment-5857263114): authorizedPaths, the commit message,
// and the correctable class.
//
//   node autofix.js start       --pr N [--repo owner/name] [--issue N] [--checkout DIR] [--run-dir DIR] [--convergence disabled]
//   node autofix.js result      --run-dir DIR --run-id ID     (after a gate run completes)
//   node autofix.js pre-edit    --run-dir DIR                 (the writer, before editing)
//   node autofix.js batch       --run-dir DIR                 (the writer, after editing)
//   node autofix.js writer-done --run-dir DIR --run-id ID     (after the writer run completes)
//   node autofix.js status      --run-dir DIR

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { Run, headFingerprints, targetMoved, roleLabel, ROLE, LANGUAGE_PROFILE, die, parseArgs, git, gh, contractInput, acceptanceCriteria, validationCommands } = require('./run');
const { bindTarget, guard, readIssue, trustedComments, isRecorded, readGate, collectSnapshotEvidence, sameSpec, finalPolicy } = require('./phases');
const { runSync, gitArgs } = require('../helpers/process');
const { runsRoot } = require('../helpers/launch');
const { namedPaths } = require('./paths');
const { writerFinished } = require('./writer');

const GATES = ['convergence', 'adversarial', 'safety'];
const CAP = { gates: 15, conv: 5, pushes: 5, noProgress: 3 };
const CONTRACT_INPUT_FILES = ['skills/closed-loop-pr/SKILL.md', 'skills/closed-loop-pr/references/autofix.md', 'skills/closed-loop-pr/references/autofix-addendum.md', 'skills/closed-loop-pr/references/helper-map.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
const SELF = __filename;

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function data(result) { return result.data; }
// Where a restarted sequence begins: convergence within its cap, else Sol (CL-D62), so no formal gate is skipped.
function restartAt(s) { return s.counters.conv < CAP.conv && !s.convergenceDisabled ? 'convergence' : 'adversarial'; }
function rounds(s) { return `${s.convergenceDisabled ? 'convergence disabled' : `convergence ${s.counters.conv}/${CAP.conv}`}, gates ${s.counters.gates}/${CAP.gates}, pushes ${s.counters.pushes}/${CAP.pushes}`; }

// Every stop: the terminal operator recheck is recorded, the linked workspace is removed unless the run is BLOCKED
// (kept for inspection), and the ledger becomes the published findings.
function end(run, state, reason) {
  const s = run.state;
  if (s.captured && !run.ended) {
    run.ended = true;
    // A failed terminal recheck is an operator change (autofix.md), so the stop is BLOCKED and the workspace kept.
    const recheck = revalidate(run, { allowFail: true });
    if (!recheck.ok && state !== 'BLOCKED') { reason = `operator_changed at the terminal recheck: ${recheck.error?.code || recheck.data?.code} (the run was stopping ${state}: ${reason})`; state = 'BLOCKED'; }
    if (state !== 'BLOCKED' && s.created) {
      // A refused cleanup leaves a workspace behind (ADV-208-TERMINAL-CLEANUP).
      const c = run.op('workspace_cleanup_created', { created: s.created }, { allowFail: true });
      if (!c.ok || c.data?.ok === false) { reason = `workspace_cleanup refused: ${c.error?.code || c.data?.code} (the run was stopping ${state}: ${reason})`; state = 'BLOCKED'; }
    }
  }
  s.rounds = rounds(s);
  s.findings = (s.ledger || []).map((e) => ({ findingId: e.findingId, disposition: e.status === 'settled' ? e.disposition : e.status === 'confirmed' ? 'confirmed, awaiting Sol' : 'open' }));
  Run.prototype.stop.call(run, state, reason);
}
// A helper refusal ends the run through `end`, so every stop takes the terminal recheck and cleanup.
function bind(run) { run.stop = (state, reason) => end(run, state, reason); return run; }
function openRun(opts) { return bind(Run.open(opts)); }
function revalidate(run, opts = {}) {
  const s = run.state;
  const built = run.op('build_operator_revalidate', { captured: s.captured, cwd: s.checkout, ...(s.pushes.length ? { pushes: s.pushes } : {}) }, opts);
  return built.ok ? run.op('operator_revalidate', built.data.request.data, opts) : built;
}
function transition(s) { return s.prevHead ? { from: s.prevHead, to: s.target.headOid } : undefined; }
function verifyWorkspace(run) {
  const s = run.state, t = transition(s);
  const built = data(run.op('build_workspace_verify', { created: s.created, ...(t ? { transition: t } : {}) }));
  run.op('workspace_verify', built.request.data);
}
function snapshotOf(run) {
  const s = run.state, [owner, repo] = s.target.repository.split('/');
  return data(run.op('snapshot', { owner, repo, number: s.target.number, cwd: s.checkout }));
}

function start(opts) {
  // CL-D62: a convergence role the role preflight found disabled is skipped, as in review.js.
  if (opts.convergence !== undefined && opts.convergence !== 'disabled') die('--convergence takes only the value disabled');
  const { checkout, runDir, pull, target } = bindTarget(opts, 'autofix');
  const run = bind(new Run(runDir)), s = run.state;
  const { repository, number } = target, [owner, repo] = repository.split('/');
  run.file('pr-before.json', pull);
  Object.assign(s, { mode: 'autofix', target, checkout, startedAt: new Date().toISOString(), body: pull.body || '', counters: { gates: 0, conv: 0, pushes: 0 }, pushes: [], pushHistory: [], ledger: [], gateLog: [], resolved: [], invocations: {},
    grant: `autofix run ${path.basename(runDir)}: one commit and one non-force push per batch, at most ${CAP.pushes} pushes` });
  s.contractInput = contractInput(CONTRACT_INPUT_FILES);
  if (opts.convergence === 'disabled') Object.assign(s, { convergenceDisabled: true, resolved: ['convergence: disabled'] });
  run.save();
  guard(run);
  if (pull.state !== 'open' || pull.draft) end(run, 'BLOCKED', `the pull request is ${pull.state}${pull.draft ? ' (draft)' : ''}`);
  const closes = opts.issue ? [null, String(opts.issue)] : /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(s.body);
  if (!closes) end(run, 'BLOCKED', 'the PR body names no `Closes #N` issue and no --issue was given');
  s.issueNumber = Number(closes[1]);
  const { issue, comments } = readIssue(run);
  run.file('issue.json', issue); run.file('issue-comments.json', comments);
  s.issueBody = issue.body || '';
  s.acceptanceCriteria = acceptanceCriteria(issue.body);
  if (!s.acceptanceCriteria.length) end(run, 'BLOCKED', `issue #${s.issueNumber} has no Acceptance criteria section with at least one criterion`);
  const validation = validationCommands(checkout, target.baseOid);
  if (validation.problem) end(run, 'BLOCKED', validation.problem);
  s.validationCommands = validation.commands;
  // Preflight: the operator capture (identity and commit identity), writability, and the run-owned workspace.
  const identity = { repository, prNumber: number, lifecycle: 'open', baseOid: target.baseOid, publicHead: target.headOid, headRepository: target.headRepository, headBranch: target.headBranch,
    originFetch: git(checkout, ['remote', 'get-url', 'origin']).trim(), originPush: git(checkout, ['remote', 'get-url', '--push', 'origin']).trim() };
  s.captured = run.op('operator_capture', { cwd: checkout, identity });
  run.save();
  run.op('writability', { owner, repo, branchRef: `refs/heads/${target.headBranch}`, cwd: checkout, enterprisePolicyComplete: true, enterpriseRulesets: [] });
  s.created = data(run.op('workspace_create', { cwd: checkout, head: target.headOid, tree: git(checkout, ['rev-parse', `${target.headOid}^{tree}`]).trim() }));
  s.workspace = s.created.path;
  run.save();
  const results = [];
  for (const command of [...s.validationCommands, ['git', 'diff', '--check', `${target.baseOid}...${target.headOid}`]]) {
    const v = run.op('validation_run', { cwd: s.workspace, command, timeoutMs: 1800000 }, { allowFail: true });
    results.push(`${command.join(' ')}: ${v.data?.outcome || v.error?.code}`);
    if (v.data?.outcome !== 'passed') { s.validation = results.join('; '); end(run, 'BLOCKED', `validation_failed on the starting head: ${command.join(' ')}`); }
  }
  s.validation = results.join('; ');
  arm(run, restartAt(s));
}

// Before every gate and at final readiness: the target, the operator capture, the workspace, the body, and the issue
// spec (review-only.md "Revalidate the target and its evidence before each gate"). The head-bound fingerprints are the
// workspace's own, rebound after each push; on an unchanged head every one must match.
function recheck(run) {
  const s = run.state, t = s.target;
  const pull = gh(['api', `repos/${t.repository}/pulls/${t.number}`], s.checkout);
  const moved = targetMoved(t, pull); if (moved) end(run, 'BLOCKED', moved);
  revalidate(run);
  verifyWorkspace(run);
  let now;
  if (s.fingerprints) now = sameSpec(run, pull, s.workspace, s.fingerprintHead === t.headOid ? undefined : ['issue_spec']);
  else {
    // What the run read at start, or nothing (ADV-208-GATE-EVIDENCE).
    const spec = readIssue(run);
    if ((spec.issue.body || '') !== s.issueBody) end(run, 'BLOCKED', 'issue_spec changed after the run read its acceptance criteria');
    if ((pull.body || '') !== s.body) end(run, 'BLOCKED', 'the body changed after the run read it');
    if (JSON.stringify(spec.comments) !== JSON.stringify(JSON.parse(fs.readFileSync(path.join(run.dir, 'issue-comments.json'), 'utf8')))) end(run, 'BLOCKED', 'issue comments changed after the run read them');
    now = headFingerprints(run, { cwd: s.workspace, baseOid: t.baseOid, headOid: t.headOid, ...spec });
  }
  // The last snapshot's fingerprint is kept, so the next snapshot is compared with it.
  Object.assign(s, { fingerprints: { ...now.values, snapshot: s.fingerprints?.snapshot }, records: { ...now.records, snapshot: s.records?.snapshot }, fingerprintHead: t.headOid });
  return now;
}

// One gate on the current head: identity, operator, workspace, evidence, expectation, launch.
function arm(run, gate) {
  const s = run.state, t = s.target;
  if (gate !== 'convergence' && s.counters.gates >= CAP.gates) end(run, 'ROUND_LIMIT_REACHED', 'gate_limit');
  const evidence = recheck(run);
  if (!isUtf8(Buffer.from(evidence.diff))) end(run, 'BLOCKED', 'the diff is not valid UTF-8, so no gate can receive it exactly');
  // New external evidence restarts the sequence (ADV-208-SNAPSHOT-CAP).
  if (collectSnapshotEvidence(run, s.workspace).fresh && GATES.indexOf(gate) > GATES.indexOf(restartAt(s))) { s.invalidated = 'every gate verdict: the external snapshot changed before a later gate'; return arm(run, restartAt(s)); }
  const requiredEvidence = s.requiredEvidence, fp = s.fingerprints;
  run.op('required_evidence_check', { cwd: s.workspace, requiredEvidence });
  s.invocations[gate] = (s.invocations[gate] || 0) + 1;
  const invocation = s.invocations[gate];
  const open = s.ledger.filter((e) => e.status !== 'settled'); // confirmed fixes stay assigned until Sol
  const correlation = { repository: t.repository, number: t.number, baseOid: t.baseOid, headRepository: t.headRepository, headBranch: t.headBranch, headOid: t.headOid, lifecycle: 'open', draft: false, gate, invocation, contractInput: s.contractInput, snapshotFingerprint: fp.snapshot };
  const expectation = data(run.op('build_gate_expectation', { workflow: 'pr', correlation, assignedFindings: open.map((e) => ({ findingId: e.findingId, blockerKey: e.blockerKey })), requiredEvidence }));
  const expectationPath = run.file(`expectation-${gate}-${invocation}.json`, expectation.expected);
  const history = { unresolved: open.map((e) => ({ ...e.record, blockerKey: e.blockerKey })), reopened: [],
    settled: s.ledger.filter((e) => e.status === 'settled').map((e) => ({ findingId: e.findingId, sourceGate: e.gate, disposition: e.disposition, status: 'settled', summary: e.summary })) };
  const volatile = { target: { repository: t.repository, number: t.number, headRepository: t.headRepository, headBranch: t.headBranch, baseOid: t.baseOid, headOid: t.headOid, mode: 'autofix', gate },
    fingerprints: fp, body: s.body, diff: evidence.diff.toString('utf8'), languageProfile: LANGUAGE_PROFILE, acceptanceCriteria: s.acceptanceCriteria, history };
  if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = trustedComments(run); }
  const built = data(run.op('build_gate_launch', { expectation, expectationPath, volatile, created: s.created }));
  Object.assign(s, { activeGate: gate, state: 'GATE_LAUNCH_PENDING', pending: { kind: 'gate', gate, invocation, expectationPath, head: t.headOid, launch: run.file(`launch-${gate}-${invocation}.json`, built.request) }, rounds: rounds(s) });
  run.save();
  run.next(built.request, `${SELF} result`);
  process.exit(0);
}

// CL-D85's recorded findings advance (isRecorded); the correctable class is corrected; anything else is the owner's.
// Only a formal gate's own finding is corrected (#196).
function correctable(x) { return x.workflowRecord?.sourceKind === 'gate' && x.anchoring === 'criterion-anchored' && ['Major', 'Minor'].includes(x.severity) && ['fixed', 'deferred'].includes(x.proposedDisposition) && x.outOfScope !== true; }

function result(opts) {
  const run = openRun(opts), s = run.state, p = s.pending;
  if (!p || p.kind !== 'gate') die('no gate is pending in this run');
  guard(run);
  // CL-D51's key (autofix.md): only an absent or empty output, once per run, never after a writer, freshly rechecked.
  const read = readGate(run, opts['run-id'], SELF, { codes: new Set(['designated_output_absent', 'designated_output_empty']), may: () => !s.relaunched && !s.writerLaunched, before: () => { s.relaunched = true; recheck(run); } });
  if (!read) return undefined;
  const envelope = read.envelope, gate = p.gate, findings = envelope.findings || [];
  if (gate === 'convergence') s.counters.conv += 1; else s.counters.gates += 1;
  const status = read.statusPath ? JSON.parse(fs.readFileSync(read.statusPath, 'utf8')) : {};
  s.resolved = [...s.resolved.filter((x) => !x.startsWith(`${ROLE[gate]} `)), roleLabel(ROLE[gate], ((status.steps || []).at(-1) || {}).model, ((status.steps || []).at(-1) || {}).thinking)];
  s.gateLog.push({ gate, invocation: p.invocation, head: p.head, verdict: envelope.verdict, findings: findings.map((x) => `${x.findingId} (${x.severity}${x.origin === 'assigned' ? ', assigned' : ''})`).join(', ') });
  s.pending = null;
  // An assigned fix Sol confirms settles; an earlier gate's confirmation routes it to Sol; otherwise one more observation.
  const confirmations = new Map((envelope.confirmations || []).map((c) => [c.findingId, c]));
  for (const x of findings.filter((y) => y.origin === 'assigned')) {
    const entry = s.ledger.find((e) => e.findingId === x.findingId);
    // Sol's counterexample against the fix leaves it unresolved, confirmed or not (gate-result.js).
    const countered = (envelope.adversarialResults || []).some((r) => r.findingId === x.findingId);
    // CONV-208-SETTLE-ONLY-AFTER-SOL
    if (!countered && confirmations.get(x.findingId)?.confirmation === 'confirmed' && x.proposedDisposition === 'fixed') { Object.assign(entry, gate === 'adversarial' ? { status: 'settled', disposition: 'fixed', confirmedBy: gate } : { status: 'confirmed', confirmedBy: gate, record: x }); continue; }
    if (isRecorded(x)) { Object.assign(entry, { status: 'settled', disposition: `${x.proposedDisposition} (recorded under CL-D85)`, record: x }); continue; }
    entry.noProgress = (entry.noProgress || 0) + 1; entry.record = x; entry.status = 'open';
    if (entry.noProgress >= CAP.noProgress) end(run, 'ROUND_LIMIT_REACHED', `no_progress: ${x.findingId} observed unresolved ${entry.noProgress} times`);
  }
  const decisions = (envelope.decisions || []).filter((d) => d.status === 'pending').map((d) => d.decisionId);
  if (envelope.verdict === 'NEEDS DECISION' || decisions.length || findings.some((x) => x.proposedDisposition === 'needs-owner-decision')) { s.pendingDecisions = decisions; s.nextAction = 'the owner records the decision, then a fresh run'; end(run, 'WAITING_FOR_OWNER', `owner_decision_required: ${gate} returned ${envelope.verdict}`); }
  const fresh = findings.filter((x) => x.origin !== 'assigned');
  // Assigned findings are classified too (ADV-208-ASSIGNED-CLASS).
  const owner = [...fresh.filter((x) => !isRecorded(x)), ...s.ledger.filter((e) => e.status === 'open').map((e) => e.record)].filter((x) => !correctable(x));
  if (owner.length) { s.nextAction = 'the owner decides the findings the driver may not correct'; end(run, 'WAITING_FOR_OWNER', `owner_decision_required: ${owner.map((x) => `${x.findingId} (${x.severity}, ${x.anchoring || 'out of scope'}, ${x.proposedDisposition})`).join(', ')} is outside the mechanised correction class`); }
  const keys = fresh.length ? data(run.op('build_gate_assignments', { findings: fresh, settledKeys: s.ledger.filter((e) => e.status === 'settled').map((e) => e.blockerKey) })).assignedFindings : [];
  for (const x of fresh) {
    const blockerKey = keys.find((k) => k.findingId === x.findingId).blockerKey, summary = String(x.correction).slice(0, 200);
    if (isRecorded(x)) s.ledger.push({ findingId: x.findingId, blockerKey, gate, status: 'settled', disposition: `${x.proposedDisposition} (recorded under CL-D85)`, summary });
    else s.ledger.push({ findingId: x.findingId, blockerKey, gate, status: 'open', record: x, noProgress: 0, summary });
  }
  run.save();
  const open = s.ledger.filter((e) => e.status === 'open');
  if (!open.length) { const next = GATES[GATES.indexOf(gate) + 1]; if (!next && s.ledger.some((e) => e.status === 'confirmed')) return arm(run, 'adversarial'); return next ? arm(run, next) : finish(run); }
  if (gate === 'convergence' && s.counters.conv >= CAP.conv) return arm(run, 'adversarial');
  if (s.counters.pushes >= CAP.pushes) end(run, 'ROUND_LIMIT_REACHED', 'push_limit');
  return launchWriter(run, open);
}

// authorizedPaths: tracked paths the findings name (a basename counts when exactly one tracked file carries it), plus
// the pull request's changed files; the names are matched in driver/paths.js.
function authorizedPaths(run, open) {
  const s = run.state, ws = s.workspace;
  const tracked = git(ws, ['ls-files', '-z']).split('\0').filter(Boolean), named = new Set();
  for (const e of open) {
    const w = e.record.workflowRecord || {};
    for (const p of namedPaths([e.record.evidence, e.record.correction, e.record.impact, w.path, w.sourceId, w.correctiveChange].filter(Boolean).join('\n'), tracked)) named.add(p);
  }
  if (!named.size) end(run, 'WAITING_FOR_OWNER', `owner_decision_required: no finding names a tracked path (${open.map((e) => e.findingId).join(', ')})`);
  const changed = git(ws, ['diff', '--name-only', '-z', `${s.target.baseOid}...${s.target.headOid}`]).split('\0').filter(Boolean);
  return [...new Set([...named, ...changed])].sort();
}
function launchWriter(run, open) {
  recheck(run);
  // ...and before any mutation (CONV-208-SNAPSHOT-STALE-WRITER).
  if (collectSnapshotEvidence(run, run.state.workspace).fresh) { run.state.invalidated = 'every gate verdict: the external snapshot changed before the writer'; return arm(run, restartAt(run.state)); }
  const s = run.state, t = s.target, paths = authorizedPaths(run, open), ids = open.map((e) => e.findingId);
  const message = `fix: ${ids.join(', ')} (#${s.issueNumber})\n\n${open.map((e) => `- ${e.findingId}: ${String(e.record.correction).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}\n\n`
    + `Test provenance: ${[...s.validationCommands, ['git', 'diff', '--check', 'HEAD']].map((c) => c.join(' ')).join('; ')} passed in the run-owned workspace before this commit.\n`;
  const task = [
    `You are the sole writer for one exact-autofix correction batch on ${t.repository}#${t.number} (branch ${t.headBranch}, head ${t.headOid}).`,
    `Your working directory is the run-owned workspace ${s.workspace}. Work only there.`, '',
    'Do these steps in order. Stop at the first failure and report it; never retry, repair the tooling, or improvise a step.',
    `1. Run: node ${SELF} pre-edit --run-dir ${run.dir}   It must print PRE_EDIT_OK.`,
    '2. Apply the corrections below, and nothing else. Edit only these paths (you may leave any of them untouched):',
    ...paths.map((p) => `   - ${p}`),
    '   Keep each change minimal. Where a correction asks for a regression test, add it to a test file in the list. Copy any literal a correction pins verbatim.',
    `3. You may run the validation commands to iterate: ${s.validationCommands.map((c) => c.join(' ')).join('; ')}.`,
    `4. Run: node ${SELF} batch --run-dir ${run.dir}   It validates, stages, commits with the approved message, and pushes. It must print BATCH_OK.`,
    '   Never run git add, git commit, git push, or any other Git write yourself. Never touch the operator checkout.',
    '5. End with one line: BATCH_OK <commit> or FAILED <step>: <reason>.', '',
    'Corrections (each finding exactly as the gate reported it):',
    ...open.map((e) => `\n### ${e.findingId} (${e.record.severity}, ${e.record.gate})\nEvidence: ${e.record.evidence}\nImpact: ${e.record.impact}\nCorrection: ${e.record.correction}`),
  ].join('\n');
  s.batch = { findings: ids, authorizedPaths: paths, message, parentHead: t.headOid, preEdit: false, done: false, launchedAt: Date.now() };
  s.writerLaunched = true;
  const built = data(run.op('build_writer_launch', { created: s.created, task }));
  Object.assign(s, { pending: { kind: 'writer', head: t.headOid }, activeGate: 'writer', state: 'WRITER_LAUNCH_PENDING' });
  run.save();
  run.file(`writer-${s.counters.pushes + 1}.json`, built.request);
  run.next(built.request, `${SELF} writer-done`);
  process.exit(0);
}
function preEdit(opts) {
  const run = openRun(opts), s = run.state;
  if (s.pending?.kind !== 'writer' || !s.batch || s.batch.preEdit) die('no writer batch is waiting for its pre-edit guard');
  const t = transition(s);
  const r = run.op('guard_before_edit', { cwd: s.workspace, expected: s.created, authorizedPaths: s.batch.authorizedPaths, ...(t ? { transition: t } : {}) }, { allowFail: true });
  if (!r.ok) batchFail(run, 'guard_before_edit', r.error?.code);
  s.batch.preEdit = true; run.save();
  process.stdout.write('PRE_EDIT_OK\n');
}
function batchFail(run, step, reason) {
  run.state.batch.failed = { step, reason: String(reason) }; run.save();
  process.stdout.write(`FAILED ${step}: ${reason}\n`); process.exit(1);
}
// The guarded chain, in order; the first refusal ends the batch, and nothing after it runs.
function batch(opts) {
  const run = openRun(opts), s = run.state, b = s.batch, ws = s.workspace;
  if (s.pending?.kind !== 'writer' || !b || !b.preEdit || b.done || b.failed) die('no writer batch is ready for its guarded chain');
  const step = (operation, payload) => { const r = run.op(operation, payload, { allowFail: true }); if (!r.ok || r.data?.ok === false) batchFail(run, operation, `${r.error?.code || r.data?.code} ${r.error?.message || ''}`.trim()); return r.data; };
  const overlay = step('overlay_freeze', { cwd: ws, authorizedPaths: b.authorizedPaths });
  for (const command of [...s.validationCommands, ['git', 'diff', '--check', 'HEAD']]) {
    const v = run.op('validation_run', { cwd: ws, command, timeoutMs: 1800000 }, { allowFail: true });
    if (v.data?.outcome !== 'passed') batchFail(run, 'validation_run', `validation_failed: ${command.join(' ')}`);
  }
  step('overlay_compare', { cwd: ws, overlay }); // AFTER_VALIDATION
  step('overlay_compare', { cwd: ws, overlay }); // BEFORE_STAGING
  try { runSync('git', gitArgs(['add', '--', ...overlay.entries.map((e) => e.path)]), { cwd: ws, phase: 'stage' }); } catch (error) { batchFail(run, 'stage', error.message); }
  const manifest = step('manifest_compare', step('build_manifest_capture', { overlay, cwd: ws }).request.data); // AFTER_STAGING
  if (overlay.entries.map((e) => e.path).sort().join('\n') !== manifest.entries.map((e) => e.path).sort().join('\n')) batchFail(run, 'overlay_manifest_equality', 'the staged manifest is not the frozen overlay');
  step('manifest_compare', step('build_manifest_compare', { captured: manifest, cwd: ws }).request.data); // BEFORE_COMMIT
  const commit = step('commit_create', { created: s.created, captured: s.captured, message: b.message }).commit;
  step('message_verify', { cwd: ws, expected: b.message });
  for (let i = 0; i < 2; i += 1) step('workspace_verify', step('build_workspace_verify', { created: s.created, transition: { from: b.parentHead, to: commit } }).request.data); // AFTER_COMMIT, BEFORE_PUSH
  b.commit = commit; run.save();
  // The whole target, last: a plain push fast-forwards over a rewind (ADV-208-MUTATION-IDENTITY).
  let pull; try { pull = gh(['api', `repos/${s.target.repository}/pulls/${s.target.number}`], s.checkout); } catch (error) { batchFail(run, 'remote_head', error.message); }
  const moved = targetMoved({ ...s.target, headOid: b.parentHead }, pull);
  if (moved) batchFail(run, 'remote_head', `target_moved: ${moved}`);
  const operator = revalidate(run, { allowFail: true });
  if (!operator.ok || operator.data?.ok === false) batchFail(run, 'operator_revalidate', operator.error?.code || operator.data?.code);
  const pushed = run.op('push_publish', { created: s.created, captured: s.captured }, { allowFail: true });
  if (!pushed.ok) batchFail(run, 'push_publish', `${pushed.error?.code} ${pushed.error?.message || ''}`.trim());
  b.done = true; run.save();
  process.stdout.write(`BATCH_OK ${commit}\n`);
}
function writerDone(opts) {
  const run = openRun(opts), s = run.state, b = s.batch;
  if (s.pending?.kind !== 'writer' || !b) die('no writer is pending in this run');
  // The writer is async: its batch is judged only once the runner records it finished (driver/writer.js).
  const id = String(opts['run-id'] || die('--run-id is required'));
  let done; try { done = writerFinished(runsRoot(), id, s); } catch (error) { die(error.message); }
  if (!done) { process.stdout.write(`WAIT: the writer run has no terminal record yet; when it completes, run: node ${SELF} writer-done --run-dir ${run.dir} --run-id ${opts['run-id']}\n`); process.exit(3); }
  guard(run);
  s.resolved.push(`tidd-autofix-worker run ${id}`);
  if (b.failed) {
    if (b.failed.step === 'push_publish') { const snap = snapshotOf(run); end(run, 'BLOCKED', `${snap.after.head === s.target.headOid ? 'local_commit_unpushed' : 'push_outcome_unknown'}: ${b.failed.reason}`); }
    end(run, 'BLOCKED', `${b.failed.step === 'validation_run' ? 'validation_failed' : `guard_failed at ${b.failed.step}`}: ${b.failed.reason}`);
  }
  if (!b.preEdit) end(run, 'BLOCKED', 'the writer ended without running the pre-edit guard');
  if (!b.done) end(run, 'BLOCKED', 'the writer ended without a completed batch');
  // The public head is the batch's commit; a short wait for GitHub to reflect the push, not a poll of reviews.
  let snap;
  for (let i = 0; i < 6; i += 1) { snap = snapshotOf(run); if (snap.after.head === b.commit) break; sleep(5000); }
  if (snap.after.head !== b.commit) end(run, 'BLOCKED', `push_outcome_unknown: public head ${snap.after.head}, pushed ${b.commit}`);
  s.pushes.push(snap); s.counters.pushes += 1;
  s.pushHistory.push({ commit: b.commit, findings: b.findings });
  s.prevHead = s.target.headOid; s.target.headOid = b.commit;
  // A new head starts a new observation origin and resets the quiet period (review-only.md), so its first snapshot is
  // not a change of the old head's.
  s.origin = null; s.changedAt = null; s.fingerprints.snapshot = null;
  s.invalidated = `every gate verdict before ${b.commit.slice(0, 12)}`;
  s.batch = null; s.pending = null; run.save();
  verifyWorkspace(run);
  revalidate(run);
  arm(run, restartAt(s));
}

// Final readiness from a fresh snapshot on the same head: new external evidence reruns convergence within its cap, then
// the review driver's final policy.
function finish(run) {
  const s = run.state;
  recheck(run);
  const { snapshot, fresh } = collectSnapshotEvidence(run, s.workspace);
  s.activeGate = 'external';
  if (fresh) { s.invalidated = 'every gate verdict: the external snapshot changed at final readiness'; return arm(run, restartAt(s)); }
  finalPolicy(run, snapshot, 'wait for checks and external review on this head, then a fresh run');
  end(run, 'MERGE_READY', `${s.convergenceDisabled ? 'convergence was disabled; Sol and Terra' : 'convergence, Sol and Terra'} returned MERGE on ${s.target.headOid.slice(0, 12)} after ${s.counters.pushes} correction push(es); the final policy passes`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  if (command === 'start') start(opts);
  else if (command === 'result') result(opts);
  else if (command === 'pre-edit') preEdit(opts);
  else if (command === 'batch') batch(opts);
  else if (command === 'writer-done') writerDone(opts);
  else if (command === 'status') process.stdout.write(`${JSON.stringify(Run.open(opts).state, null, 2)}\n`);
  else die('usage: autofix.js start|result|pre-edit|batch|writer-done|status');
} catch (error) {
  // A run with a directory ends through its guard, with a token and a status block; before that, a plain failure.
  if (process.listenerCount('uncaughtException')) throw error;
  die(error.stack || String(error));
}
