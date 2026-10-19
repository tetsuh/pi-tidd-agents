'use strict';

// CL-D122 (#306): the packaged Issue review driver. It runs one Issue's review-and-draft round:
// Sol, then Terra (CL-D121), each composed and read through the packaged helpers, and leaves the parent
// the `subagent` call it prints. It is lighter than the pull-request round by the owner's choice: the gates' required
// evidence is the Issue's own two identities, the snapshot is read once, and the round stops at the first open
// finding. It publishes nothing, and the Issue root has no publication route (CL-D123).
//
//   node issue.js start  --issue N [--repo owner/name] [--checkout DIR] [--run-dir DIR] [--language-profile P]
//   node issue.js result --run-dir DIR --run-id ID
//   node issue.js status --run-dir DIR

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Run, sha256, runDirProblem, runDirNotFresh, roleLabel, PACKAGE, LANGUAGE_PROFILE, die, parseArgs, gh, contractInput, jsonLine } = require('./run');
const { guard, readGate, trustedComments } = require('./phases');

const GATES = ['adversarial', 'decision-drift'];
const ROLE = { adversarial: 'tidd-adversarial-reviewer', 'decision-drift': 'tidd-drift-reviewer' };
const LABEL = { adversarial: 'sol', 'decision-drift': 'terra' };
const ROUND_CAP = 3; // CL-D11
const CONTRACT_INPUT_FILES = ['skills/closed-loop-issue/SKILL.md', 'skills/closed-loop-shared/references/gate-contract.md', 'skills/closed-loop-shared/references/records.md'];
const NEXT_ACTION = { BLOCKED: 'address the cause, then a fresh run', ROUND_LIMIT_REACHED: 'owner decision, then a fresh run', WAITING_FOR_OWNER: 'owner decision, then a fresh run', IMPLEMENTATION_READY: 'the owner may start implementation' };
// One line of the drafted block: a value from GitHub or a gate never breaks the line.
const one = (v) => [...String(v)].map((c) => ('\r\n\u000b\u000c\u0085\u2028\u2029'.includes(c) ? ' ' : c)).join('');
// The Acceptance criteria section by CL-D122's bounded grammar: an ATX heading of two to six `#` reading "Acceptance
// criteria" (closing `#`s allowed), outside fenced code (``` or ~~~, indented up to three spaces), up to the next ATX
// heading; its items are `-`, `*`, `+`, `N.` or `N)` lines. Any other Markdown form is outside the surface it reads.
function criteria(body) {
  const out = []; let fence = null, inSection = false;
  for (const line of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    // A backtick fence's info string holds no backtick, so a backtick run with one after it is inline code.
    const open = /^ {0,3}(`{3,}(?!`)(?![^`]*`)|~{3,})/.exec(line);
    if (fence) { if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}(`+|~+)[ \t]*$/.test(line)) fence = null; continue; }
    if (open) { fence = open[1]; continue; }
    // `s`: U+2028 and U+2029 sit inside a Markdown line.
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/s.exec(line);
    if (heading) { inSection = heading[1].length >= 2 && /^acceptance criteria$/i.test((heading[2] || '').trim()); continue; }
    // One separator then the rest, trimmed after the match, so a long whitespace line is read in linear time.
    const item = inSection && /^[ \t]*(?:[-*+]|[0-9]{1,9}[.)])[ \t](.*)/s.exec(line);
    if (item && item[1].trim()) out.push(item[1].trim());
  }
  return out;
}
function rounds(s) { return GATES.map((g) => `${LABEL[g]} ${s.invocations[g] || 0}/${ROUND_CAP}`).join(', '); }

// A run of this driver: the same directory, lock and operations as the pull-request driver's, with the Issue's own
// stop and draft. Nothing is published, so the draft carries no publication marker and no publish script.
class IssueRun extends Run {
  static open(opts) {
    const dir = path.resolve(opts['run-dir'] || die('--run-dir is required'));
    const problem = runDirProblem(dir); if (problem) die(problem);
    const run = new IssueRun(dir);
    if (run.state.workflow !== 'issue') die(`${dir} is not an Issue review run`);
    return run;
  }
  stop(state, reason) {
    Object.assign(this.state, { state, reason, pending: null });
    this.save();
    this.publish();
    process.stdout.write(`${jsonLine({ state, reason, runDir: this.dir })}\n`);
    process.exit(state === 'IMPLEMENTATION_READY' ? 0 : 1);
  }
  // The Skill's legacy status block (CL-D13) and the gates that ran, drafted for the operator; a local root it spells is
  // replaced by a placeholder, as the pull-request draft does (#221).
  publish() {
    const s = this.state, t = s.target; if (!t) return;
    const roots = [[this.dir, '{run-dir}'], [PACKAGE, '{package}'], [process.env.HOME, '~'], [os.tmpdir(), '{tmp}']].filter(([p]) => p && p.startsWith('/') && p !== '/').sort((a, b) => b[0].length - a[0].length);
    const local = (text) => roots.reduce((out, [p, name]) => out.split(p).join(name), one(text));
    const findings = (s.findings || []).map((f) => `  ${one(f.findingId)}: ${one(f.disposition)}`);
    const block = ['```tidd-status', `target: ${t.repository}#${t.number}`, `state: ${s.state}`, `active_gate: ${LABEL[s.activeGate] || 'none'}`, `issue_spec: ${s.fingerprints?.issue_spec || 'not computed'}`,
      `rounds: ${rounds(s)}`, `resolved: ${one((s.resolved || []).join('; ') || 'none')}`, findings.length ? `findings:\n${findings.join('\n')}` : 'findings: none',
      `pending_decisions: ${one((s.pendingDecisions || []).join(', ') || 'none')}`, 'publication_grant: not-applicable', `invalidated_evidence: ${local(s.invalidated || 'none')}`, `next_action: ${local(s.nextAction || NEXT_ACTION[s.state] || 'owner decision')}`, '```'].join('\n');
    const gates = (s.gateLog || []).map((g) => `- ${LABEL[g.gate]} ${g.invocation}: ${one(g.verdict)}${g.findings ? `; ${one(g.findings)}` : ''}`).join('\n') || '- none';
    const body = [`# Issue review state: ${s.state}`, '', `Issue: https://github.com/${t.repository}/issues/${t.number}`, `Reviewed issue_spec: \`${s.fingerprints?.issue_spec || 'not computed'}\``, '',
      `Reason: ${local(s.reason || s.state)}.`, '', '## Gates', gates, '', block, ''].join('\n');
    const dir = fs.mkdtempSync(path.join(this.dir, 'draft.'));
    const file = path.join(dir, 'issue-review.md');
    fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
    s.statusBlock = block; s.draft = file; this.save();
    process.stdout.write(`FINISHED comment=${file}\nThe draft is local and nothing was published; the Issue root posts nothing (CL-D123).\n${block}\n`);
  }
}

// The repository GitHub names for an Issue record: its canonical `owner/name`, or undefined.
function repositoryOf(issue) { return /\/repos\/([^/]+\/[^/]+)$/.exec(String(issue.repository_url || ''))?.[1]; }
// One identity check for the first read and every re-read (CL-D7, CL-D27): the record is this number's Issue in this
// repository, the name compared without case; a redirect to anything else is another target.
function otherRecord(issue, repository, number) { return issue.number !== number || Boolean(issue.pull_request) || repositoryOf(issue)?.toLowerCase() !== repository.toLowerCase(); }
// The Issue and every comment as they are now, its identity checked; issue_spec through its packaged operation (the helper
// keeps the CL-D9 authoritative subset).
function readTarget(run, first) {
  const s = run.state, t = s.target;
  const issue = first || gh(['api', `repos/${t.repository}/issues/${t.number}`], s.checkout);
  // A moved or transferred Issue answers with another record; only this Issue is the target (CL-D7).
  if (otherRecord(issue, t.repository, t.number)) run.stop('BLOCKED', `the target moved: ${t.repository}#${t.number} now answers with another record`);
  const comments = gh(['api', '--paginate', '--slurp', `repos/${t.repository}/issues/${t.number}/comments?per_page=100`], s.checkout).flat();
  const spec = run.op('fingerprint_issue_spec', { body: issue.body || '', comments }).data.fingerprint;
  return { issue, comments, spec };
}
// Before Terra and at readiness: the Issue is still open and its issue_spec unchanged, or the round stops (CL-D27).
function revalidate(run) {
  const s = run.state, { issue, spec } = readTarget(run);
  if (issue.state !== 'open') run.stop('BLOCKED', `the target moved: the Issue is ${issue.state}`);
  if (spec !== s.fingerprints.issue_spec) { s.invalidated = 'every gate verdict: the Issue changed'; run.stop('BLOCKED', 'the target moved: issue_spec changed'); }
}

function start(opts) {
  if (typeof opts.issue !== 'string' || !/^[1-9][0-9]*$/.test(opts.issue)) die('--issue must be an Issue number');
  if ('repo' in opts && (typeof opts.repo !== 'string' || !opts.repo)) die('--repo must be owner/name');
  const number = Number(opts.issue);
  const checkout = path.resolve(opts.checkout || process.cwd());
  const problem = runDirProblem(opts['run-dir'] ? path.resolve(opts['run-dir']) : os.tmpdir()) || (opts['run-dir'] && runDirNotFresh(path.resolve(opts['run-dir']))); if (problem) die(problem);
  let repository, issue;
  try {
    repository = opts.repo || gh(['repo', 'view', '--json', 'nameWithOwner'], checkout).nameWithOwner;
    issue = gh(['api', `repos/${repository}/issues/${number}`], checkout);
  } catch (error) { die(`cannot read Issue ${repository || ''}#${number}: ${String(error.message).split('\n')[0]}`); }
  // GitHub numbers Issues and pull requests in one sequence (CL-D7); only an open Issue is a target.
  if (issue.pull_request) die(`${repository}#${number} is a pull request; use /tidd-pr`);
  if (otherRecord(issue, repository, number)) die(`${repository}#${number} answers with another record (other number, kind or repository); the Issue moved`);
  if (issue.state !== 'open') die(`Issue ${repository}#${number} is ${issue.state}; only an open Issue is reviewed`);
  const canonical = repositoryOf(issue);
  const runDir = opts['run-dir'] ? path.resolve(opts['run-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), `tidd-issue${number}-review.`));
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const run = new IssueRun(runDir), s = run.state;
  Object.assign(s, { workflow: 'issue', mode: 'review-and-draft', checkout, startedAt: new Date().toISOString(), target: { repository: canonical, number }, invocations: {}, verdicts: {}, findings: [], resolved: [], gateLog: [], languageProfile: opts['language-profile'] || LANGUAGE_PROFILE });
  s.contractInput = contractInput(CONTRACT_INPUT_FILES);
  run.save();
  guard(run);
  const { issue: read, comments, spec } = readTarget(run, issue);
  run.file('issue.json', read); run.file('issue-comments.json', comments);
  // The snapshot is one read (CL-D122): the SHA-256 of a fixed projection of the Issue's state and every comment, bots
  // included, in comment-id order, computed here as the pull-request driver computes its body identity, because the
  // packaged snapshot shape is the pull request's.
  const text = (v) => String(v ?? '').replace(/\r\n?/g, '\n');
  const snapshot = { issue: { state: text(read.state), title: text(read.title), body: text(read.body), updatedAt: text(read.updated_at), labels: (read.labels || []).map((l) => text(typeof l === 'string' ? l : l?.name)).sort() },
    comments: comments.map((c) => ({ id: text(c.id), updatedAt: text(c.updated_at), author: text(c.user?.login), authorType: text(c.user?.type), authorAssociation: text(c.author_association), body: text(c.body) })).sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  s.fingerprints = { issue_spec: spec, snapshot: sha256(Buffer.from(JSON.stringify(snapshot), 'utf8')) };
  s.body = read.body || '';
  s.acceptanceCriteria = criteria(s.body);
  // AC-TDD: an Issue that states no acceptance contract is not ready, and no gate can judge it.
  if (!s.acceptanceCriteria.length) { s.nextAction = 'the owner adds an Acceptance criteria section to the Issue, then a fresh run'; run.stop('WAITING_FOR_OWNER', `issue #${number} has no Acceptance criteria section with at least one criterion`); }
  s.requiredEvidence = [{ source: `github:issue:${number}:spec`, kind: 'github', identity: s.fingerprints.issue_spec }, { source: `snapshot:issue:${number}`, kind: 'snapshot', identity: s.fingerprints.snapshot }];
  run.save();
  launch(run, 'adversarial');
}

function launch(run, gate) {
  const s = run.state, t = s.target;
  if (gate !== GATES[0]) revalidate(run);
  if ((s.invocations[gate] || 0) >= ROUND_CAP) run.stop('ROUND_LIMIT_REACHED', `${LABEL[gate]} reached its ${ROUND_CAP}-round cap`);
  s.invocations[gate] = (s.invocations[gate] || 0) + 1;
  const invocation = s.invocations[gate];
  const correlation = { repository: t.repository, number: t.number, lifecycle: 'open', gate, invocation, contractInput: s.contractInput, snapshotFingerprint: s.fingerprints.snapshot, issueSpec: s.fingerprints.issue_spec };
  const expectation = run.op('build_gate_expectation', { workflow: 'issue', correlation, assignedFindings: [], requiredEvidence: s.requiredEvidence }).data;
  const expectationPath = run.file(`expectation-${gate}-${invocation}.json`, expectation.expected);
  const volatile = { target: { repository: t.repository, number: t.number, mode: 'review-only', gate }, fingerprints: s.fingerprints, body: s.body, languageProfile: s.languageProfile, acceptanceCriteria: s.acceptanceCriteria,
    history: { unresolved: [], reopened: [], settled: [] } };
  if (gate === 'adversarial') { volatile.decisions = []; volatile.comments = trustedComments(run); }
  const built = run.op('build_gate_launch', { expectation, expectationPath, volatile }).data;
  Object.assign(s, { activeGate: gate, state: 'GATE_LAUNCH_PENDING', pending: { gate, invocation, expectationPath, launch: run.file(`launch-${gate}-${invocation}.json`, built.request) } });
  run.save();
  run.next(built.request, `${__filename} result`);
}

function result(opts) {
  const run = IssueRun.open(opts), s = run.state, p = s.pending;
  if (!p) die('no gate is pending in this run');
  guard(run);
  s.nextAction = null;
  // Each run id is read and consumed once, a refused read included (CL-D120). A run still in progress prints WAIT and exits
  // inside readGate before anything is consumed, so its id stays readable; a read or a relaunch then consumes every id seen
  // for this gate, so an id seen on WAIT expires with the relaunch.
  const runId = opts['run-id'] || die('--run-id is required');
  if ((s.consumedRunIds || []).includes(runId)) run.stop('BLOCKED', `run id ${runId} was already read; a relaunch expires it`);
  p.seenRunIds = [...new Set([...(p.seenRunIds || []), runId])]; run.save();
  const read = readGate(run, runId, __filename, { before: () => { if (p.gate !== GATES[0]) revalidate(run); } });
  s.consumedRunIds = [...new Set([...(s.consumedRunIds || []), ...p.seenRunIds])]; run.save();
  if (!read) return;
  const envelope = read.envelope, gate = p.gate, findings = envelope.findings || [];
  const status = read.statusPath ? JSON.parse(fs.readFileSync(read.statusPath, 'utf8')) : {}, step = (status.steps || []).at(-1) || {};
  s.resolved = [...s.resolved.filter((x) => !x.startsWith(`${ROLE[gate]} `)), roleLabel(ROLE[gate], step.model, step.thinking)];
  s.verdicts[gate] = envelope.verdict; s.pending = null;
  s.gateLog.push({ gate, invocation: p.invocation, verdict: envelope.verdict, findings: findings.map((x) => `${x.findingId} (${x.severity})`).join(', ') });
  // A MERGE result's findings are the ones the validator already resolved; any other verdict leaves them open.
  const merged = envelope.verdict === 'MERGE';
  for (const x of findings) s.findings = [...s.findings.filter((f) => f.findingId !== x.findingId), { findingId: x.findingId, gate, disposition: merged ? `${x.proposedDisposition} (resolved by ${LABEL[gate]})` : `${x.proposedDisposition} (proposed; revision pending)` }];
  const decisions = (envelope.decisions || []).filter((d) => d.status === 'pending').map((d) => d.decisionId);
  if (envelope.verdict === 'NEEDS DECISION' || decisions.length) { s.pendingDecisions = decisions; s.nextAction = 'the owner records the decision, then a fresh run'; run.stop('WAITING_FOR_OWNER', `${LABEL[gate]} returned NEEDS DECISION`); }
  // The round advances only on MERGE; any other result stops it, and the owner revises the Issue before a fresh run. CL-D85's
  // recorded Minors are the pull-request root's: on the Issue a reword changes the specification under review (CL-D122).
  if (!merged) { s.nextAction = 'the owner revises the Issue, then a fresh run'; s.invalidated = 'every gate verdict once the Issue is revised'; run.stop('WAITING_FOR_OWNER', `${LABEL[gate]} returned ${envelope.verdict} with open finding(s): ${findings.map((x) => x.findingId).join(', ') || 'none named'}`); }
  const next = GATES[GATES.indexOf(gate) + 1];
  if (next) return launch(run, next);
  // Readiness: both gates returned MERGE against the issue_spec the Issue still has (the Skill's readiness rule).
  revalidate(run);
  s.activeGate = 'none';
  run.stop('IMPLEMENTATION_READY', 'Sol and Terra returned MERGE on the unchanged issue_spec');
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0];
  if (command === 'start') start(opts);
  else if (command === 'result') result(opts);
  else if (command === 'status') process.stdout.write(`${JSON.stringify(IssueRun.open(opts).state, null, 2)}\n`);
  else die('usage: issue.js start|result|status');
} catch (error) {
  if (process.listenerCount('uncaughtException')) throw error;
  die(error.stack || String(error));
}
