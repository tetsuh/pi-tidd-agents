'use strict';

// Issue #332: the ignored-path inventory both drivers freeze after validation records each path's presence and type,
// never its content, as CL-D38 defines the validation sandbox delta (CL-D129). A gate or a writer that rewrites an
// ignored file, such as a test run's log, no longer stops the run; a new, removed or retyped ignored path still does.
const R = require('./issue-196-review-driver.fixtures.js');
const A = require('./issue-196-autofix-driver.fixtures.js');
const { test, assert, fs, path, readText, temp, git } = R;
const { readContract, sectionOf } = require('./helpers');

const BUILD = "const fs = require('fs'); fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/x', 'from validation');";

test('Issue #332 AC1 ignoredInventory records each path and its type alone', () => {
  const { ignoredInventory } = require('../skills/closed-loop-pr/driver/run');
  const root = temp('i332-inventory-');
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'scratch/\n');
  fs.mkdirSync(path.join(root, 'scratch', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scratch', 'x'), 'one');
  fs.writeFileSync(path.join(root, 'scratch', 'deep', 'y'), 'two');
  fs.symlinkSync('x', path.join(root, 'scratch', 'link'));
  assert.deepEqual(ignoredInventory(root), ['scratch/deep/y:file', 'scratch/deep:dir', 'scratch/link:symlink', 'scratch/x:file', 'scratch:dir']);
  const run = readText('skills/closed-loop-pr/driver/run.js');
  assert.ok(run.includes('// The ignored paths outside the runtime roots and every descendant of an ignored directory, each with its type judged\n// without following a link, never its content (CL-D38, CL-D129).'), 'the comment states it');
  assert.equal(/sha256\(fs\.readFileSync\(abs\)\)|readlinkSync\(abs\)/.test(run), false, 'no hash and no link target');
  const frozen = ignoredInventory(root);
  fs.writeFileSync(path.join(root, 'scratch', 'x'), 'rewritten'); fs.rmSync(path.join(root, 'scratch', 'link')); fs.symlinkSync('deep', path.join(root, 'scratch', 'link'));
  assert.deepEqual(ignoredInventory(root), frozen, 'a rewritten file and a retargeted link');
  fs.rmSync(path.join(root, 'scratch', 'link')); fs.writeFileSync(path.join(root, 'scratch', 'link'), 'now a file');
  assert.notDeepEqual(ignoredInventory(root), frozen, 'a link turned file');
});

// The review-only driver: the checkout holds an ignored file before the run, as a build directory does.
function reviewOnly() {
  const t = R.setup();
  fs.appendFileSync(path.join(t.target.root, '.git', 'info', 'exclude'), 'build/\n');
  fs.mkdirSync(path.join(t.target.root, 'build')); fs.writeFileSync(path.join(t.target.root, 'build', 'x'), 'before');
  assert.equal(R.drive(t.start, t.e).status, 0);
  return t;
}
const reviewNext = (t) => R.drive(['result', '--run-dir', t.runDir, '--run-id', R.fakeGate(t.runDir, t.runs)], t.e);

test('Issue #332 AC2 a rewritten ignored file does not stop the review-only driver', () => {
  const t = reviewOnly();
  fs.writeFileSync(path.join(t.target.root, 'build', 'x'), 'rewritten by a gate\'s test run');
  const r = reviewNext(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(R.nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', 'the next gate is launched');
});

test('Issue #332 AC3 a new, removed or retyped ignored path still stops the review-only driver', () => {
  const changes = {
    new: (root) => fs.writeFileSync(path.join(root, 'build', 'y'), 'new'),
    removed: (root) => fs.rmSync(path.join(root, 'build', 'x')),
    retyped: (root) => { fs.rmSync(path.join(root, 'build', 'x')); fs.mkdirSync(path.join(root, 'build', 'x')); },
    'a file turned link': (root) => { fs.rmSync(path.join(root, 'build', 'x')); fs.symlinkSync('y', path.join(root, 'build', 'x')); },
  };
  for (const [label, change] of Object.entries(changes)) {
    const t = reviewOnly();
    change(t.target.root);
    const r = reviewNext(t);
    assert.notEqual(r.status, 0, label);
    assert.equal(R.state(t.runDir).state, 'BLOCKED', label);
    assert.match(R.state(t.runDir).reason, /^the checkout's ignored paths changed after validation: /, label);
  }
});

// The autofix driver: its validation writes the ignored file into the run-owned workspace.
function autofix() {
  const t = A.setup({ files: { '.gitignore': 'build/\n' }, config: { validate: [['node', '-e', BUILD]] } });
  const r = A.drive(t.start, t.env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { t, ws: A.state(t.runDir).workspace };
}
const rewrite = (ws) => fs.writeFileSync(path.join(ws, 'build', 'x'), 'rewritten');
const retype = (ws) => { fs.rmSync(path.join(ws, 'build', 'x')); fs.mkdirSync(path.join(ws, 'build', 'x')); };
const added = (ws) => fs.writeFileSync(path.join(ws, 'build', 'y'), 'new');
const removed = (ws) => fs.rmSync(path.join(ws, 'build', 'x'));
const linked = (ws) => { fs.rmSync(path.join(ws, 'build', 'x')); fs.symlinkSync('y', path.join(ws, 'build', 'x')); };

test('Issue #332 AC4 the autofix driver ignores a rewrite before a gate and stops on a new, removed or retyped path', () => {
  let { t, ws } = autofix();
  rewrite(ws);
  let r = A.result(t);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(A.nextRequest(r.stdout)?.agent, 'tidd-adversarial-reviewer', 'the next gate is launched');
  for (const [label, change] of Object.entries({ added, removed, retype, linked })) {
    ({ t, ws } = autofix());
    change(ws);
    r = A.result(t);
    assert.equal(A.nextRequest(r.stdout), null, label);
    assert.equal(A.state(t.runDir).state, 'BLOCKED', label);
    assert.match(A.state(t.runDir).reason, /^the workspace's ignored paths changed after validation: /, label);
  }
});

function writerReady() {
  const { t, ws } = autofix();
  const r = A.drive(['result', '--run-dir', t.runDir, '--run-id', A.fakeGate(t.runDir, t.runs, { fresh: true })], t.env);
  assert.equal(A.nextRequest(r.stdout)?.agent, 'tidd-autofix-worker', r.stderr + r.stdout);
  assert.match(A.drive(['pre-edit', '--run-dir', t.runDir], t.env, ws).stdout, /^PRE_EDIT_OK$/m);
  fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 3;\n');
  return { t, ws };
}

test('Issue #332 AC4 the writer batch ignores a rewrite and fails ignored_drift on a new, removed or retyped path', () => {
  let { t, ws } = writerReady();
  rewrite(ws);
  let b = A.drive(['batch', '--run-dir', t.runDir], t.env, ws);
  assert.match(b.stdout, /^BATCH_OK [0-9a-f]{40}$/m, b.stderr + b.stdout);
  for (const [label, change] of Object.entries({ added, removed, retype, linked })) {
    ({ t, ws } = writerReady());
    change(ws);
    b = A.drive(['batch', '--run-dir', t.runDir], t.env, ws);
    assert.match(b.stdout, /^FAILED ignored_drift: the writer changed ignored paths: /m, label);
  }
  // The writer's task states what still stops the batch.
  assert.ok(readText('skills/closed-loop-pr/driver/writer.js').includes("yourself: an ignored path they add, remove or retype (a cache, a build directory) stops the batch, which runs them itself"));
});

test('Issue #332 AC5 CL-D129 records the choice, and CL-D38, CL-D93 and CL-D119 point forward to it', () => {
  const record = sectionOf(readContract(), '## CL-D129 — The ignored-path inventory records presence and type only, as CL-D38 defines');
  assert.ok(record, 'CL-D129 is in the contract');
  assert.match(record, /tetsuh\/pi-tidd-agents#332/);
  assert.match(record, /each entry records its path and its type \(`dir`, `file`, `symlink`, `other` or `absent`\), never a file's hash or a link's target/);
  assert.match(record, /closes the divergence CL-D119 recorded/);
  assert.ok(readText('CONTRACT.md').includes('- [contract/CL-D129.md](contract/CL-D129.md) — The ignored-path inventory records presence and type only, as CL-D38 defines'));
  const forward = 'CL-D129 later closed it: the inventory records presence and type only (#332).';
  for (const file of ['contract/CL-D38.md', 'contract/CL-D119.md']) {
    const text = readText(file);
    assert.ok(text.includes(forward), `${file} points forward`);
    assert.equal(text.includes('recorded and not closed (#249, CL-D119)'), false, `${file} no longer records it as open`);
  }
  assert.ok(readText('contract/CL-D93.md').includes('CL-D129 later dropped the ignored inventory\'s content: it records presence and type only (#332).'));
});
