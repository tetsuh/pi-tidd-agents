'use strict';

// Issue #290 (CL-D55): a batch-sequence guard refusal stops the packaged autofix driver with a reason that names the
// refusal's subcheck and its observed value, and a guard refusal that names no subcheck is reported as a
// guard-implementation defect. The per-operation result files keep the details; the stop reason now carries them too.
const { test, assert, fs, path, drive, setup, state, originHead, writerDone, fakeGate } = require('./issue-196-autofix-driver.fixtures.js');
const { refusalReason } = require('../skills/closed-loop-pr/driver/writer');

// The details of the run's one refusal of `operation`, read from its own result file in the run directory.
function refusedDetails(runDir, operation) {
  const files = fs.readdirSync(runDir).filter((f) => f.endsWith(`-${operation}.result.json`));
  const refused = files.map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'))).filter((r) => r.ok === false);
  assert.equal(refused.length, 1, `one refused ${operation}: ${files.join(', ')}`);
  return refused[0].error.details;
}
function writerReady() {
  const t = setup();
  assert.equal(drive(t.start, t.env).status, 0);
  drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { fresh: true })], t.env);
  return { t, ws: state(t.runDir).workspace };
}

test('Issue #290 an overlay_freeze refusal stops the run naming its subcheck and observed value', () => {
  const { t, ws } = writerReady();
  assert.match(drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /PRE_EDIT_OK/);
  fs.writeFileSync(path.join(ws, 'b.js'), 'module.exports = 0;\n');
  const b = drive(['batch', '--run-dir', t.runDir], t.env, ws);
  const details = refusedDetails(t.runDir, 'overlay_freeze');
  assert.deepEqual(details, { subcheck: 'authorized_subset', observed: 'b.js' }, 'the guard named its condition');
  const reason = 'guard_failed subcheck authorized_subset, observed b.js: changed path is outside the authorized maximum set: b.js';
  assert.ok(b.stdout.includes(`FAILED overlay_freeze: ${reason}\n`), b.stdout);
  assert.equal(originHead(t), t.target.head, 'nothing was pushed');
  assert.notEqual(writerDone(t).status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.equal(state(t.runDir).reason, `guard_failed at overlay_freeze: ${reason}`);
});

test('Issue #290 a guard_before_edit refusal stops the run naming its subcheck and observed value', () => {
  const { t, ws } = writerReady();
  fs.writeFileSync(path.join(ws, '.pi'), 'not a directory\n');
  const p = drive(['pre-edit', '--run-dir', t.runDir], t.env, ws);
  assert.notEqual(p.status, 0);
  const details = refusedDetails(t.runDir, 'guard_before_edit');
  assert.deepEqual(details, { subcheck: 'workspace_identity', observed: 'workspace contains an unsafe runtime root' }, 'the guard named its condition');
  const reason = 'unsafe_runtime_root subcheck workspace_identity, observed workspace contains an unsafe runtime root';
  assert.ok(p.stdout.includes(`FAILED guard_before_edit: ${reason}\n`), p.stdout);
  assert.notEqual(writerDone(t).status, 0);
  assert.equal(state(t.runDir).reason, `guard_failed at guard_before_edit: ${reason}`);
});

test('Issue #290 a guard refusal naming no subcheck is a guard-implementation defect, and other refusals keep their text', () => {
  for (const operation of ['guard_before_edit', 'overlay_freeze', 'overlay_compare', 'manifest_compare']) {
    assert.equal(refusalReason(operation, { ok: false, error: { code: 'guard_failed', message: 'exit 1' } }), `guard_implementation_defect: ${operation} named no subcheck (guard_failed exit 1)`);
    assert.equal(refusalReason(operation, { ok: false, error: { code: 'guard_failed', message: 'm', details: { observed: 'x' } } }), `guard_implementation_defect: ${operation} named no subcheck (guard_failed m)`);
  }
  // An unparsable CLI line for a guard is an unnamed failure too.
  assert.equal(refusalReason('overlay_compare', { ok: false, error: { code: 'cli_unparsable', message: '' } }), 'guard_implementation_defect: overlay_compare named no subcheck (cli_unparsable)');
  // Any refusal that does name its subcheck says so, guard or not, with its message less a leading subcheck prefix; one
  // that does not keeps the code and message.
  assert.equal(refusalReason('message_verify', { ok: false, error: { code: 'guard_failed', message: 'message_bytes: differs', details: { subcheck: 'message_bytes', observed: 'stored 3 bytes, approved 4 bytes' } } }), 'guard_failed subcheck message_bytes, observed stored 3 bytes, approved 4 bytes: differs');
  assert.equal(refusalReason('commit_create', { ok: false, error: { code: 'commit_failed', message: 'no identity' } }), 'commit_failed no identity');
  assert.equal(refusalReason('build_manifest_capture', { ok: true, data: { ok: false, code: 'input_shape_mismatch' } }), 'input_shape_mismatch');
  // The prefix comes off only where it leads, a message that only repeats the observed value is not repeated, an empty
  // observed value is said to be empty, and a structured one is shown as JSON.
  assert.equal(refusalReason('overlay_compare', { ok: false, error: { code: 'guard_failed', message: 'pre s: post', details: { subcheck: 's', observed: 'o' } } }), 'guard_failed subcheck s, observed o: pre s: post');
  assert.equal(refusalReason('overlay_compare', { ok: false, error: { code: 'guard_failed', message: 's: m', details: { subcheck: 's', observed: '' } } }), 'guard_failed subcheck s, observed (empty): m');
  assert.equal(refusalReason('overlay_freeze', { ok: false, error: { code: 'guard_failed', message: 'overlay_nonempty: clean', details: { subcheck: 'overlay_nonempty', observed: 'clean' } } }), 'guard_failed subcheck overlay_nonempty, observed clean');
  assert.equal(refusalReason('overlay_freeze', { ok: false, error: { code: 'guard_failed', message: 'm', details: { subcheck: 'porcelain_grammar', observed: { status: '??' } } } }), 'guard_failed subcheck porcelain_grammar, observed {"status":"??"}: m');
  // Nothing is cut: a cut value could end inside a local path that the publication withholds only when it sees it whole.
  const home = `${'x'.repeat(290)} fatal: cannot read /home/someone/.gitconfig`;
  const reason = refusalReason('guard_before_edit', { ok: false, error: { code: 'guard_failed', message: home, details: { subcheck: 'process_failure', observed: home } } });
  assert.equal(reason, `guard_failed subcheck process_failure, observed ${home}`);
});
