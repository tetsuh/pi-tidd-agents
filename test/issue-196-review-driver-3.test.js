'use strict';

// Part 3 of 7 of issue-196-review-driver.test.js, split so the suite runs its parts side by side (Issue #231). Every test is
// moved as it was; the fixtures they share are in issue-196-review-driver.fixtures.js. These tests drive the packaged
// review-only driver (CL-D93, #196).
const { test, assert, fs, os, path, crypto, execFileSync, spawnSync, repoPath, readText, DRIVER_DIR, DRIVER, temp, git, makeTarget, fakeGh, env, drive, nextRequest, fakeGate, setup, state, setFixture, throughGates, thread, publishable, solConfirming, prComment } = require("./issue-196-review-driver.fixtures.js");

test('Issue #196 an open finding stops review-only WAITING_FOR_OWNER with the finding named', () => {
  const t = setup();
  const r0 = drive(t.start, t.e);
  assert.equal(r0.status, 0, r0.stderr);
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX' })], t.e);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'WAITING_FOR_OWNER');
  assert.match(s.reason, /CONV-7-X/);
});

test('Issue #196 new evidence at final readiness reruns convergence instead of declaring MERGE_READY', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  throughGates(t, 2);
  setFixture(t, { prComments: [{ id: 9, html_url: 'u', user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', body: 'a new finding' }] });
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(nextRequest(r.stdout)?.agent, 'tidd-convergence-reviewer', 'convergence runs again on the new evidence');
  assert.equal(state(t.runDir).invocations.convergence, 2);
});

test('Issue #196 a dirty checkout stops BLOCKED before validation', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.target.root, 'a.js'), 'module.exports = 99;\n');
  const r = drive(t.start, t.e);
  assert.notEqual(r.status, 0);
  const s = state(t.runDir);
  assert.equal(s.state, 'BLOCKED');
  assert.match(s.reason, /checkout is not clean/);
  assert.equal(s.log.some((e) => e.operation === 'validation_run'), false);
});

test('Issue #196 an issue specification edited between gates stops the next launch', () => {
  const t = setup();
  assert.equal(drive(t.start, t.e).status, 0);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.issue.body += '\n- AC2: another criterion.\n'; fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  assert.notEqual(r.status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /issue_spec/);
});

// CONV-199-CLD85-MINOR-BYPASS: CL-D85's condition (a correction that changes no file) is not readable from a proposed
// disposition, so a criterion-anchored Minor stays open whatever it proposes; only reword, follow-up, and out-of-scope
// Minors are recorded.
test('Issue #196 a criterion-anchored Minor stays open whatever disposition it proposes', () => {
  for (const disposition of ['accepted-as-designed', 'deferred']) {
    const t = setup();
    assert.equal(drive(t.start, t.e).status, 0);
    const r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs, { verdict: 'FIX', severity: 'Minor', disposition })], t.e);
    assert.notEqual(r.status, 0, disposition);
    assert.equal(state(t.runDir).state, 'WAITING_FOR_OWNER', disposition);
  }
});

test('Issue #196 a .tidd.json added only at the head is not read', () => {
  // #209: with no base file and no operator configuration the run proceeds with no validation commands; the head's
  // file, which the pull request under review controls, is never one of the sources.
  const t = setup({ config: null });
  fs.writeFileSync(path.join(t.target.root, '.tidd.json'), '{"validate": [["node", "-e", "process.exit(7)"]]}\n');
  git(t.target.root, ['add', '.tidd.json']); git(t.target.root, ['commit', '-q', '-m', 'add config at head']);
  const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f));
  const r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(state(t.runDir).validationSource, 'none');
  assert.equal(fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json') && fs.readFileSync(path.join(t.runDir, f), 'utf8').includes('process.exit(7)')), false);
});

// #209 (CL-D97, owner decision in its body): base .tidd.json, then --validate or the operator configuration, then none.
test('Issue #209 review-only with no validation commands runs git diff --check only and says so', () => {
  const t = setup({ config: null });
  let r = drive(t.start, t.e);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (let i = 0; i < 3; i += 1) r = drive(['result', '--run-dir', t.runDir, '--run-id', fakeGate(t.runDir, t.runs)], t.e);
  const s = state(t.runDir);
  assert.equal(s.state, 'MERGE_READY', s.reason);
  assert.equal(s.validationSource, 'none');
  // CONV-211-AC2-ONLY-CHECK-UNASSERTED: the whitespace check is the only command run, and the summary says exactly that.
  const range = `${s.target.baseOid}...${s.target.headOid}`;
  const commands = fs.readdirSync(t.runDir).filter((f) => f.endsWith('-validation_run.request.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(t.runDir, f), 'utf8')).data.command);
  assert.deepEqual(commands, [['git', 'diff', '--check', range]]);
  assert.equal(s.validation, `source: none; no validation commands configured; git diff --check ${range}: passed`);
  assert.match(s.statusBlock, /operator_actions: "?no validation commands configured: add \.tidd\.json at the base or ~\/\.config\/tidd\/o\/r\.json/);
  assert.doesNotMatch(fs.readFileSync(s.publication.comment, 'utf8'), new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no operator home path is published');
  assert.match(fs.readFileSync(s.publication.comment, 'utf8'), /no validation commands configured/);
  // The report carries the same line, its source first (#209 AC1 and AC2, pre-push sweep).
  assert.ok(fs.readFileSync(s.publication.comment, 'utf8').includes(`Validation: ${s.validation}.`), 'the published validation line names its source');
});

test('Issue #209 validation commands resolve from the base file, then --validate or the operator configuration', () => {
  const config = temp('i209-config-');
  fs.mkdirSync(path.join(config, 'tidd', 'o'), { recursive: true });
  fs.writeFileSync(path.join(config, 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "process.exit(0)", "operator-config"]]}\n');
  // The commands a run executed, from its own validation_run request records.
  const ran = (s, marker) => fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json') && fs.readFileSync(path.join(t.runDir, f), 'utf8').includes(marker));
  // The operator configuration, read from $XDG_CONFIG_HOME/tidd/<owner>/<repo>.json when the base has no file.
  let t = setup({ config: null });
  assert.equal(drive(t.start, { ...t.e, XDG_CONFIG_HOME: config }).status, 0);
  assert.equal(state(t.runDir).validationSource, 'operator configuration');
  assert.match(state(t.runDir).validation, /^source: operator configuration; /);
  assert.ok(ran(state(t.runDir), 'operator-config'));
  // --validate, a JSON list of argv lists, in place of the operator configuration.
  t = setup({ config: null });
  assert.equal(drive([...t.start, '--validate', '[["node", "-e", "process.exit(0)", "flag"]]'], { ...t.e, XDG_CONFIG_HOME: config }).status, 0);
  assert.equal(state(t.runDir).validationSource, '--validate');
  assert.match(state(t.runDir).validation, /^source: --validate; /);
  assert.ok(ran(state(t.runDir), 'flag'));
  // The base file wins over both.
  t = setup({ config: { validate: [['node', '-e', 'process.exit(0)', 'base-file']] } });
  assert.equal(drive([...t.start, '--validate', '[["node", "-e", "process.exit(0)", "flag"]]'], { ...t.e, XDG_CONFIG_HOME: config }).status, 0);
  assert.equal(state(t.runDir).validationSource, 'base .tidd.json');
  assert.match(state(t.runDir).validation, /^source: base \.tidd\.json; /);
  assert.ok(ran(state(t.runDir), 'base-file'));
  assert.ok(!ran(state(t.runDir), 'flag') && !ran(state(t.runDir), 'operator-config'));
  // A malformed --validate stops before any gate.
  t = setup({ config: null });
  const r = drive([...t.start, '--validate', 'not json'], t.e);
  assert.notEqual(r.status, 0);
  assert.match(state(t.runDir).reason, /--validate/);
  // A malformed operator file, or a directory in its place, stops before any gate; a relative XDG_CONFIG_HOME is ignored.
  for (const [label, write] of [['not JSON', (f) => fs.writeFileSync(f, 'nope')], ['empty list', (f) => fs.writeFileSync(f, '{"validate": []}')], ['a directory', (f) => fs.mkdirSync(f)], ['a dangling link', (f) => fs.symlinkSync(path.join(path.dirname(f), 'gone.json'), f)], ['a FIFO', (f) => execFileSync('mkfifo', [f])]]) {
    const home = temp('i209-bad-'); fs.mkdirSync(path.join(home, 'tidd', 'o'), { recursive: true }); write(path.join(home, 'tidd', 'o', 'r.json'));
    t = setup({ config: null });
    assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: home }).status, 0, label);
    assert.equal(state(t.runDir).state, 'BLOCKED', label);
    assert.match(state(t.runDir).reason, /operator configuration/, label);
  }
  // ADV-211-OPERATOR-CONFIG-EACCES: only a missing file is absence; a lookup the operator's system refuses stops.
  const locked = temp('i209-locked-'); fs.mkdirSync(path.join(locked, 'tidd', 'o'), { recursive: true });
  fs.writeFileSync(path.join(locked, 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "0"]]}'); fs.chmodSync(path.join(locked, 'tidd', 'o'), 0o000);
  try {
    t = setup({ config: null });
    assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: locked }).status, 0);
    assert.equal(state(t.runDir).state, 'BLOCKED');
    assert.match(state(t.runDir).reason, /operator configuration .*EACCES/);
    assert.equal(fs.readdirSync(t.runDir).some((f) => /-(validation_run|build_gate_launch)\.request\.json$/.test(f)), false);
  } finally { fs.chmodSync(path.join(locked, 'tidd', 'o'), 0o755); }
  // CONV-211-DANGLING-PARENT-SYMLINK: a dangling link anywhere on the path, not only at the file, stops; a link that
  // resolves to a directory without the file is still absence.
  for (const [label, link] of [['XDG_CONFIG_HOME', (h) => h], ['tidd', (h) => path.join(h, 'tidd')], ['the owner folder', (h) => path.join(h, 'tidd', 'o')]]) {
    const home = path.join(temp('i211-dangling-'), 'cfg'); fs.mkdirSync(path.dirname(link(home)), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(link(home)), 'gone'), link(home));
    t = setup({ config: null });
    assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: home }).status, 0, label);
    assert.equal(state(t.runDir).state, 'BLOCKED', label);
    assert.match(state(t.runDir).reason, /operator configuration .*cannot be read/, label);
    assert.equal(fs.readdirSync(t.runDir).some((f) => /-(validation_run|build_gate_launch)\.request\.json$/.test(f)), false, label);
  }
  // Pre-push sweep: a path that resolves beyond PATH_MAX makes realpath throw; that is a refusal, not a driver failure.
  const far = temp('i211-far-'), seg = 'd'.repeat(200);
  execFileSync('bash', ['-c', `cd "$1" && mkdir deep && cd deep && for i in $(seq 25); do mkdir ${seg} && cd ${seg}; done && mkdir -p tidd/o`, '-', far]);
  fs.symlinkSync(path.join('deep', ...Array(13).fill(seg)), path.join(far, 'hop')); fs.symlinkSync(path.join('hop', ...Array(12).fill(seg)), path.join(far, 'cfg'));
  t = setup({ config: null });
  assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: path.join(far, 'cfg') }).status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /operator configuration .*cannot be read: ENAMETOOLONG/);
  // A path past the length limit whose first missing entry is its own is not an absence the kernel would report.
  t = setup({ config: null });
  assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: path.join(far, ...Array(25).fill('e'.repeat(200))) }).status, 0);
  assert.match(state(t.runDir).reason, /operator configuration .*cannot be read: ENAMETOOLONG/);
  const linked = temp('i211-linked-'); fs.mkdirSync(path.join(linked, 'real', 'tidd'), { recursive: true }); fs.symlinkSync(path.join(linked, 'real'), path.join(linked, 'cfg'));
  t = setup({ config: null });
  assert.equal(drive(t.start, { ...t.e, XDG_CONFIG_HOME: path.join(linked, 'cfg') }).status, 0);
  assert.equal(state(t.runDir).validationSource, 'none', 'a link to a folder without the file is absence');
  // CONV-211-XDG-IN-REPO: an operator configuration inside the target checkout is the pull request's own tracked file,
  // not the operator's, whether XDG_CONFIG_HOME points into the checkout directly or through a link from outside.
  const inRepo = () => {
    const u = setup({ config: null });
    fs.mkdirSync(path.join(u.target.root, '.config', 'tidd', 'o'), { recursive: true });
    fs.writeFileSync(path.join(u.target.root, '.config', 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "process.exit(0)", "in-repo"]]}');
    git(u.target.root, ['add', '.config']); git(u.target.root, ['commit', '-q', '-m', 'config at head']);
    const f = JSON.parse(fs.readFileSync(u.fixture, 'utf8')); f.pull.head.sha = git(u.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(u.fixture, JSON.stringify(f));
    return u;
  };
  t = inRepo();
  assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: path.join(t.target.root, '.config') }).status, 0);
  assert.equal(state(t.runDir).state, 'BLOCKED');
  assert.match(state(t.runDir).reason, /inside the target checkout/);
  assert.ok(!ran(state(t.runDir), 'in-repo'));
  // A folder inside the checkout whose name starts with `..` is still inside.
  t = setup({ config: null });
  fs.mkdirSync(path.join(t.target.root, '..cfg', 'tidd', 'o'), { recursive: true });
  fs.writeFileSync(path.join(t.target.root, '..cfg', 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "process.exit(0)", "in-repo"]]}');
  git(t.target.root, ['add', '..cfg']); git(t.target.root, ['commit', '-q', '-m', 'dotdot config at head']);
  { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f)); }
  assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: path.join(t.target.root, '..cfg') }).status, 0);
  assert.match(state(t.runDir).reason, /inside the target checkout/);
  t = inRepo();
  const link = path.join(temp('i209-link-'), 'cfg'); fs.symlinkSync(path.join(t.target.root, '.config'), link);
  assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: link }).status, 0);
  assert.match(state(t.runDir).reason, /inside the target checkout/);
  assert.ok(!ran(state(t.runDir), 'in-repo'));
  // ADV-211-XDG-LINK-ESCAPE: a tracked link inside the checkout that points outside still leaves the path inside, at
  // every depth, with a relative target, and when an outside link passes through the checkout and out again.
  const outside = temp('i211-outside-'); fs.mkdirSync(path.join(outside, 'cfg', 'tidd', 'o'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'cfg', 'tidd', 'o', 'r.json'), '{"validate": [["node", "-e", "process.exit(0)", "escaped"]]}');
  for (const [label, at, target, xdg] of [['cfg', 'cfg', 'cfg', 'cfg'], ['tidd', 'cfg/tidd', 'cfg/tidd', 'cfg'], ['the owner folder', 'cfg/tidd/o', 'cfg/tidd/o', 'cfg'], ['the file', 'cfg/tidd/o/r.json', 'cfg/tidd/o/r.json', 'cfg'], ['a relative target', 'cfg/tidd', null, 'cfg'], ['a chain out, in and out', 'out', 'cfg', null]]) {
    t = setup({ config: null });
    const link = path.join(t.target.root, ...at.split('/')); fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target ? path.join(outside, target) : path.relative(path.dirname(link), path.join(outside, 'cfg', 'tidd')), link);
    git(t.target.root, ['add', '-A']); git(t.target.root, ['commit', '-q', '-m', 'outward link at head']);
    { const f = JSON.parse(fs.readFileSync(t.fixture, 'utf8')); f.pull.head.sha = git(t.target.root, ['rev-parse', 'HEAD']); fs.writeFileSync(t.fixture, JSON.stringify(f)); }
    const into = path.join(temp('i211-in-'), 'cfg'); fs.symlinkSync(path.join(t.target.root, 'out'), into);
    assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: xdg ? path.join(t.target.root, xdg) : into }).status, 0, label);
    assert.match(state(t.runDir).reason, /inside the target checkout/, label);
    assert.ok(!ran(state(t.runDir), 'escaped'), label);
  }
  // ADV-211-XDG-DOTDOT-NORMALIZATION: `.` and `..` in XDG_CONFIG_HOME are the kernel's, not erased as text first. The
  // XDG values are written as strings on purpose: path.join would normalize them.
  const dots = temp('i211-dots-'); fs.writeFileSync(path.join(dots, 'plain'), 'x'); fs.symlinkSync(path.join(dots, 'gone'), path.join(dots, 'dangling'));
  for (const [xdg, reason] of [[`${dots}/plain/..`, /cannot be read: ENOTDIR/], [`${dots}/./plain/./..`, /cannot be read: ENOTDIR/], [`${dots}/${'x'.repeat(256)}/..`, /cannot be read: ENAMETOOLONG/], [`${dots}/dangling/..`, /cannot be read: a dangling link/], [`${dots}/dangling/../`, /cannot be read: a dangling link/]]) {
    t = setup({ config: null });
    assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: xdg }).status, 0, xdg);
    assert.equal(state(t.runDir).state, 'BLOCKED', xdg);
    assert.match(state(t.runDir).reason, reason, xdg);
  }
  // An outside link into a checkout folder, then `..`, lands on the checkout root as the kernel resolves it.
  t = inRepo(); fs.mkdirSync(path.join(t.target.root, 'sub'));
  fs.symlinkSync(path.join(t.target.root, 'sub'), path.join(dots, 'into'));
  assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: `${dots}/into/../.config` }).status, 0);
  assert.match(state(t.runDir).reason, /inside the target checkout/);
  assert.ok(!ran(state(t.runDir), 'in-repo'));
  // CONV-211-X1: a validation file is read as bytes and must be well-formed UTF-8 with no BOM and a bounded size before
  // JSON.parse, so an invalid byte inside a JSON string cannot silently become U+FFFD in an executed argv.
  const bad = Buffer.concat([Buffer.from('{"validate": [["node", "-e", "process.exit(0)", "x'), Buffer.from([0xff]), Buffer.from('"]]}')]);
  for (const [label, bytes] of [['an invalid byte', bad], ['a BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"validate": [["node", "-e", "0"]]}')])], ['an oversized file', Buffer.from(`{"validate": [["node", "-e", "0", "${'x'.repeat(70000)}"]]}`)]]) {
    t = setup({ config: bytes });
    assert.notEqual(drive(t.start, t.e).status, 0, `base: ${label}`);
    assert.match(state(t.runDir).reason, label === 'an oversized file' ? /\.tidd\.json at the base commit is larger than 64 KiB/ : /\.tidd\.json at the base commit is not BOM-free UTF-8/, `base: ${label}`);
    assert.equal(fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json')), false, `base: ${label}`);
    const home = temp('i209-bytes-'); fs.mkdirSync(path.join(home, 'tidd', 'o'), { recursive: true }); fs.writeFileSync(path.join(home, 'tidd', 'o', 'r.json'), bytes);
    t = setup({ config: null });
    assert.notEqual(drive(t.start, { ...t.e, XDG_CONFIG_HOME: home }).status, 0, `operator: ${label}`);
    assert.match(state(t.runDir).reason, label === 'an oversized file' ? /operator configuration .*larger than 64 KiB/ : /operator configuration .*not BOM-free UTF-8/, `operator: ${label}`);
    assert.equal(fs.readdirSync(t.runDir).some((f) => f.endsWith('-validation_run.request.json')), false, `operator: ${label}`);
  }
  // The bound is exact: 65536 bytes run, 65537 stop.
  const sized = (n) => { const head = '{"validate": [["node", "-e", "process.exit(0)", "'; const tail = '"]]}'; return Buffer.from(head + 'x'.repeat(n - head.length - tail.length) + tail); };
  t = setup({ config: sized(65536) });
  assert.equal(drive(t.start, t.e).status, 0, 'exactly 64 KiB runs');
  t = setup({ config: sized(65537) });
  assert.notEqual(drive(t.start, t.e).status, 0, 'one byte over stops');
  // --validate: a lossy-decoded argument and the --key=value spelling (pre-push sweep of the strict reader).
  t = setup({ config: null });
  assert.notEqual(drive([...t.start, '--validate', '[["node", "-e", "0", "x\uFFFD"]]'], t.e).status, 0);
  assert.match(state(t.runDir).reason, /--validate .*replacement character/);
  t = setup({ config: null });
  assert.equal(drive([...t.start, '--validate=[["node", "-e", "process.exit(0)", "eq-form"]]'], t.e).status, 0);
  assert.equal(state(t.runDir).validationSource, '--validate');
  assert.ok(ran(state(t.runDir), 'eq-form'));
  t = setup({ config: null });
  assert.equal(drive(t.start, { ...t.e, XDG_CONFIG_HOME: 'relative-config' }).status, 0);
  assert.equal(state(t.runDir).validationSource, 'none', 'a relative XDG_CONFIG_HOME is not a source');
});
