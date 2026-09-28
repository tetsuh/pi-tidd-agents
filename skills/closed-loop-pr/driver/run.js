'use strict';

// CL-D93 (#196): the shared half of the packaged driver. A run is a directory holding state.json and every packaged
// operation's request and result, numbered. Operations go through the package's own helper CLI, so each request is
// normalized and shape-checked exactly as any caller's would be; the driver composes, the helpers decide.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const PACKAGE = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(PACKAGE, 'skills', 'closed-loop-pr', 'helpers', 'cli.js');
const LANGUAGE_PROFILE = 'conversation=Japanese; github.issue=en; github.pull_request=en; external_sites={}';
const ROLE = { convergence: 'tidd-convergence-reviewer', adversarial: 'tidd-adversarial-reviewer', safety: 'tidd-safety-reviewer' };

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function die(message) { process.stderr.write(`tidd-driver: ${message}\n`); process.exit(2); }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[a.slice(2)] = value; } else out._.push(a);
  }
  return out;
}
function git(cwd, list, encoding = 'utf8') {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '--no-pager', ...list], { cwd, encoding, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } });
}
function gh(list, cwd) {
  const r = spawnSync('gh', list, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GH_PAGER: 'cat' } });
  if (r.status !== 0) throw new Error(`gh ${list.slice(0, 3).join(' ')} failed: ${(r.stderr || '').slice(0, 500)}`);
  return JSON.parse(r.stdout);
}
// The bytes a gate's contractInput hashes: the authority files of this package that the gate reads, in order.
function contractInput(files) {
  return sha256(Buffer.from(files.map((file) => `${file}\n${fs.readFileSync(path.join(PACKAGE, file), 'utf8').replace(/\r\n?/g, '\n')}`).join('\n'), 'utf8'));
}
// Acceptance criteria are the bullets of the issue's `Acceptance criteria` section; none is a stop, not a guess.
function acceptanceCriteria(body) {
  const section = (String(body || '').replace(/\r\n?/g, '\n').split(/\n##+\s*Acceptance criteria\s*\n/i)[1] || '').split(/\n##+ /)[0];
  return section.split('\n').filter((line) => /^\s*[-*]\s+/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, '').trim());
}
// Validation commands come from `.tidd.json` at the base commit, so the change under review cannot choose them.
function validationCommands(cwd, baseOid) {
  let text;
  try { text = git(cwd, ['show', `${baseOid}:.tidd.json`]); } catch { return { problem: 'the base commit carries no .tidd.json naming the validation commands' }; }
  let config;
  try { config = JSON.parse(text); } catch { return { problem: '.tidd.json at the base commit is not JSON' }; }
  const ok = config && Array.isArray(config.validate) && config.validate.length > 0 && config.validate.every((c) => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string' && a.length > 0));
  return ok ? { commands: config.validate } : { problem: '.tidd.json must carry validate: a nonempty list of nonempty argv lists' };
}

// The six head fingerprints (CL-D9), each through its packaged operation, so a value and its record are the helper's
// own answer (CONV-199-CLI-FINGERPRINT-BOUNDARY). Returns the values and the evidence records keyed by domain.
function headFingerprints(run, { cwd, baseOid, headOid, issue, comments }) {
  const diff = git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `${baseOid}...${headOid}`], 'buffer');
  const commits = git(cwd, ['log', '--reverse', '--format=%H%x00%B%x01', `${baseOid}..${headOid}`]).split('\u0001').filter((x) => x.trim())
    .map((record) => { const [oid, message] = record.replace(/^\n/, '').split('\u0000'); return { oid, message }; });
  const requests = {
    issue_spec: ['fingerprint_issue_spec', { body: issue.body || '', comments }],
    pr_base: ['fingerprint_pr_base', { oid: baseOid }],
    pr_tree: ['fingerprint_pr_tree', { oid: git(cwd, ['rev-parse', `${headOid}^{tree}`]).trim() }],
    pr_diff: ['fingerprint_pr_diff', { base64: diff.toString('base64') }],
    pr_commits: ['fingerprint_pr_commits', { commits }],
    pr_head: ['fingerprint_pr_head', { oid: headOid }],
  };
  const values = {}, records = {};
  for (const [domain, [operation, payload]] of Object.entries(requests)) { const d = run.op(operation, payload).data; values[domain] = d.fingerprint; records[domain] = d.record; }
  return { values, records, diff };
}
function snapshotFingerprint(run, snapshot) {
  const d = run.op('fingerprint_snapshot', run.op('build_fingerprint_snapshot', { snapshot }).data.request.data).data;
  return { value: d.fingerprint, record: d.record };
}

class Run {
  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : { seq: 0, log: [] };
  }
  static open(opts) { return new Run(path.resolve(opts['run-dir'] || die('--run-dir is required'))); }
  save() { fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 }); }
  file(name, value) {
    const p = path.join(this.dir, name);
    fs.writeFileSync(p, Buffer.isBuffer(value) || typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return p;
  }
  // One packaged operation through the helper CLI, recorded. A refusal ends the run with `status` unless `allowFail`.
  op(operation, data, { status = 'BLOCKED', allowFail = false } = {}) {
    const n = String(++this.state.seq).padStart(3, '0');
    const request = { version: 1, operation, data };
    this.file(`${n}-${operation}.request.json`, request);
    const r = spawnSync(process.execPath, [CLI], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, cwd: os.tmpdir() });
    let result;
    try { result = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { result = { ok: false, operation, error: { code: 'cli_unparsable', message: String(r.stderr || r.stdout).slice(0, 2000) } }; }
    this.file(`${n}-${operation}.result.json`, result);
    const ok = result.ok === true && result.data?.ok !== false;
    this.state.log.push({ n, operation, ok, ...(ok ? {} : { code: result.error?.code || result.data?.code }) });
    this.save();
    if (!ok && !allowFail) this.stop(status, `${operation} refused: ${result.error?.code || result.data?.code} ${result.error?.message || ''}`.trim());
    return result;
  }
  stop(state, reason) {
    Object.assign(this.state, { state, reason, pending: null });
    this.save();
    this.publish();
    process.stdout.write(`${JSON.stringify({ state, reason, runDir: this.dir })}\n`);
    process.exit(state === 'MERGE_READY' ? 0 : 1);
  }
  // Status block and publication artifacts: the CL-D33 template and the CL-D45 marker, with a real observation time.
  publish() {
    const s = this.state, t = s.target; if (!t) return;
    const fp = s.fingerprints || {};
    const block = ['```tidd-status', `target: ${t.repository}#${t.number}`, `head_branch: ${t.headBranch}`, `mode: ${s.mode}`, `state: ${s.state}`, `active_gate: ${s.activeGate || 'none'}`,
      `fingerprints: issue_spec ${fp.issue_spec} base ${fp.pr_base} tree ${fp.pr_tree} diff ${fp.pr_diff} commits ${fp.pr_commits} head ${fp.pr_head} snapshot ${fp.snapshot}`,
      `rounds: ${s.rounds || 'none'}`, `resolved: ${(s.resolved || []).join('; ') || 'none'}`, `findings: ${(s.findings || []).map((f) => `${f.findingId}: ${f.disposition}`).join('; ') || 'none'}`,
      'review_misses: none', `pending_decisions: ${(s.pendingDecisions || []).join(', ') || 'none'}`, `publication_grant: ${s.grant || 'review-only not-applicable'}`,
      `external_observation: head ${t.headOid} observed_from ${s.observedFrom}, this run only`, `operator_actions: ${s.operatorActions || 'none'}`, `invalidated_evidence: ${s.invalidated || 'none'}`, `next_action: ${s.nextAction || 'owner decision'}`, '```'].join('\n');
    const gates = (s.gateLog || []).map((g) => `- ${g.gate} ${g.invocation} on \`${g.head.slice(0, 12)}\`: ${g.verdict}${g.findings ? `; ${g.findings}` : ''}`).join('\n') || '- none';
    const visible = [`# Review state: ${s.state}`, '', `Pull request: https://github.com/${t.repository}/pull/${t.number}`, `Reviewed public head: \`${t.headOid}\``,
      `External observation for this run: head \`${t.headOid}\` observed at ${s.observedFrom}; ${s.external || 'no snapshot'}.`, '',
      `Reason: ${s.reason || s.state}.`, '', '## Gates', gates, '', `Validation: ${s.validation || 'not run'}.`, '', block, ''].join('\n');
    const marker = `<!-- pi-tidd-agents:review-publication:v1 repo=${t.repository} pr=${t.number} head=${t.headOid} visibleSha256=${sha256(visible)} -->`;
    const body = `${visible}${marker}\n`;
    const pub = fs.mkdtempSync(path.join(os.tmpdir(), `tidd-pr${t.number}-publish.`));
    fs.writeFileSync(path.join(pub, 'review-comment.md'), body, { mode: 0o600 });
    const template = fs.readFileSync(path.join(PACKAGE, 'skills', 'closed-loop-pr', 'references', 'publish-review.sh'), 'utf8');
    const script = template.replaceAll('__PI_REVIEW_REPOSITORY__', t.repository).replaceAll('__PI_REVIEW_PR_NUMBER__', String(t.number)).replaceAll('__PI_REVIEW_HEAD__', t.headOid)
      .replaceAll('__PI_REVIEW_PR_URL__', `https://github.com/${t.repository}/pull/${t.number}`).replaceAll('__PI_REVIEW_BODY_SHA256__', sha256(body)).replaceAll('__PI_REVIEW_MARKER__', marker);
    fs.writeFileSync(path.join(pub, 'publish-review.sh'), script, { mode: 0o600 });
    fs.writeFileSync(path.join(this.dir, 'status-block.md'), `${block}\n`, { mode: 0o600 });
    s.publication = { comment: path.join(pub, 'review-comment.md'), script: path.join(pub, 'publish-review.sh') };
    this.save();
    process.stdout.write(`FINISHED comment=${s.publication.comment}\nPUBLISH=${s.publication.script}\n`);
  }
  // Print the one call the parent makes, and the command that reads its result.
  next(request, command) {
    process.stdout.write(`NEXT: make exactly this subagent call, then run: node ${command} --run-dir ${this.dir} --run-id <runId>\n${JSON.stringify(request)}\n`);
  }
}

module.exports = { Run, headFingerprints, snapshotFingerprint, PACKAGE, ROLE, LANGUAGE_PROFILE, sha256, die, parseArgs, git, gh, contractInput, acceptanceCriteria, validationCommands };
