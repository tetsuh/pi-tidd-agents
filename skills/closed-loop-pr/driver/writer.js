'use strict';

// CL-D96 (#196): whether the runner records this batch's writer as finished, split from autofix.js under the per-file
// alarm. The writer is async, so its batch is judged only on the runner's own record of the autofix worker's run: the
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

module.exports = { writerFinished };
