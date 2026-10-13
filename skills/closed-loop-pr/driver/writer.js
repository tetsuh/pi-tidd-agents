'use strict';

// CL-D96 (#196): the writer's batch — its task and commit message, and whether the runner records it finished — split
// from autofix.js under the per-file alarm. The writer is async, so its batch is judged only on the runner's own record of the autofix worker's run: the
// run id given (a UUID), not an earlier batch's, run in this workspace and started after this launch, in a terminal
// state (CONV-208-WRITER-RUN-STATUS-FAIL-CLOSED, ADV-208-WRITER-BATCH-RUN-BINDING). Anything else is not finished.

const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = ['complete', 'completed', 'failed', 'partial', 'paused', 'rejected', 'stopped'];
function writerFinished(runsRoot, id, s) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('--run-id must be the runner run id (a UUID)');
  let status; try { status = JSON.parse(fs.readFileSync(path.join(runsRoot, id, 'status.json'), 'utf8')); } catch { return false; }
  return Boolean(status) && status.runId === id && status.cwd === s.workspace && Number.isFinite(status.startedAt) && status.startedAt >= s.batch.launchedAt
    && !s.resolved.includes(`tidd-autofix-worker run ${id}`) && TERMINAL.includes(status.state) && (status.steps || []).at(-1)?.agent === 'tidd-autofix-worker';
}

// One line per correction and for the validation, folded so no gate or configured text starts a line another reader takes as a dispatch line (#224, CL-D116).
const line = (x) => String(x).split(/[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/u).join(' ').trim();
const bullets = (open) => open.map((e) => `- ${e.findingId}: ${line(e.record.correction).slice(0, 300)}`).join('\n');
// The approved commit message: the parent's checked subject and the issue number, one bullet per correction, and one
// naming the validation the batch runs (CL-D25, CL-D116).
function writerMessage(s, open, subject) {
  return `${subject} (#${s.issueNumber})\n\n${bullets(open)}\n`
    + `- Validation before this commit, in the run-owned workspace: ${line([...s.validationCommands, ['git', 'diff', '--check', 'HEAD']].map((c) => c.join(' ')).join('; '))}\n`;
}
// The writer's task: the guarded steps it runs itself, the paths it may edit, and the corrections as the gate gave them (CL-D30).
function writerTask(s, open, paths, self, runDir) {
  const t = s.target;
  return [
    `You are the sole writer for one exact-autofix correction batch on ${t.repository}#${t.number} (branch ${t.headBranch}, head ${t.headOid}).`,
    `Your working directory is the run-owned workspace ${s.workspace}. Work only there.`, '',
    'Do these steps in order. Stop at the first failure and report it; never retry, repair the tooling, or improvise a step.',
    `1. Run: node ${self} pre-edit --run-dir ${runDir}   It must print PRE_EDIT_OK.`,
    '2. Apply the corrections below, and nothing else. Edit only these paths (you may leave any of them untouched):',
    ...paths.map((p) => `   - ${p}`),
    '   Keep each change minimal. Where a correction asks for a regression test, add it to a test file in the list. Copy any literal a correction pins verbatim.',
    `3. Do not run the validation commands or the project's tests yourself: an ignored path they change (a cache, a build directory) stops the batch, which runs them itself: ${s.validationCommands.map((c) => c.join(' ')).join('; ')}.`,
    `4. Run: node ${self} batch --run-dir ${runDir}   It validates, stages, commits with the approved message, and pushes. It must print BATCH_OK.`,
    '   Never run git add, git commit, git push, or any other Git write yourself. Never touch the operator checkout.',
    '5. End with one line: BATCH_OK <commit> or FAILED <step>: <reason>.', '',
    'Corrections (each finding exactly as the gate reported it):',
    ...open.map((e) => `\n### ${e.findingId} (${e.record.severity}, ${e.record.gate})\nEvidence: ${e.record.evidence}\nImpact: ${e.record.impact}\nCorrection: ${e.record.correction}`),
  ].join('\n');
}

// This run's unremoved workspace roots and their count, after any earlier operator action (ADV-208-RETAINED-ROOT-REPORT).
function retain(s, root) {
  if (root && !(s.retained ||= []).includes(root)) s.retained.push(root);
  if (!s.retained?.length) return;
  const prior = s.operatorActions && !/^none\b/.test(s.operatorActions) ? String(s.operatorActions).replace(/(; )?inspect, then remove this run's retained workspace roots .*$/, '') : '';
  s.operatorActions = `${prior ? `${prior}; ` : ''}inspect, then remove this run's retained workspace roots (${s.retained.length}): ${s.retained.join(', ')}`;
}

module.exports = { writerFinished, writerMessage, writerTask, retain, bullets };
