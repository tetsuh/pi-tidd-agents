'use strict';

// Issue #96, rule 1 (CL-D57) — the batch-sequence guards Luna kept re-deriving by hand become
// packaged read-only operations whose failures name the violated subcheck and the observed
// value by construction (CL-D55 satisfied mechanically). Each operation's predicates encode
// the exact defect that killed a PR #94 run: authorized paths are a maximum set, not a
// demand; the index is compared against the immutable manifest, never against only the
// authorized changed files; and no guard may fail without naming what it saw.
//
// TDD provenance: recorded with the focused command below at 0 passes. The prose, CLI-table,
// and record fixtures are compile/contract RED; the guard round-trip fixtures are behavioral
// RED — they execute operations the packaged CLI does not yet expose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { readText, sectionOf, cliSchemas } = require('./helpers');

const AUTOFIX = readText('skills/closed-loop-pr/references/autofix.md');
const ADDENDUM = readText('skills/closed-loop-pr/references/autofix-addendum.md');
const CLI = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'helpers', 'cli.js');

function cli(operation, data) {
  const run = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify({ version: 1, operation, data }), encoding: 'utf8',
  });
  return JSON.parse(run.stdout);
}
function named(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error.details.subcheck, 'string', 'a guard failure must name its subcheck');
  assert.notEqual(result.error.details.observed, undefined, 'a guard failure must carry what it observed');
  return result;
}
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function guardRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-96-guards-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-96-origin-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Issue 96 Test']);
  git(root, ['config', 'user.email', 'issue96@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'unused.md'), 'untouched\n');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'name: test\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: guard base']);
  git(bare, ['init', '--bare']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', 'origin', 'main']);
  return { root, bare, head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

test('Issue #96 the map offers the guard family and the addendum requires it', () => {
  const map = sectionOf(AUTOFIX, '### Packaged helper invocation map (CL-D30, Issue #47)');
  assert.ok(map, 'the invocation map must exist');
  for (const declaration of [
    '| `guard_before_edit` | `cwd`, `expected` (data of `workspace_create`), `authorizedPaths` |',
    '| `overlay_freeze` | `cwd`, `authorizedPaths` |',
    '| `overlay_compare` | `cwd`, `overlay` (data of `overlay_freeze`) |',
    '| `manifest_compare` | `cwd`, `parent`, exactly one of `authorizedPaths` or `manifest` (data of `manifest_compare`) |',
  ]) assert.ok(map.includes(declaration), `map must declare ${declaration}`);
  assert.match(map, /authorized paths are a maximum set: the overlay must stay inside them and must not be empty, but no authorized path is required to change/);
  assert.match(map, /compares the index against the immutable staged manifest, never against only the authorized changed files, so an entry the parent commit already carries cannot be misclassified/);
  assert.match(ADDENDUM, /Luna obtains every guard observation in this batch sequence from the packaged guard operations and never substitutes a local re-derivation for one \(CL-D57\)/);
});

test('Issue #96 the CLI exposes exactly the four guard operations', () => {
  const schemas = cliSchemas();
  assert.deepEqual(schemas.guard_before_edit, ['cwd', 'expected', 'authorizedPaths']);
  assert.deepEqual(schemas.overlay_freeze, ['cwd', 'authorizedPaths']);
  assert.deepEqual(schemas.overlay_compare, ['cwd', 'overlay']);
  assert.deepEqual(schemas.manifest_compare, ['cwd', 'parent']);
  const cliSource = readText('skills/closed-loop-pr/helpers/cli.js');
  assert.match(cliSource, /manifest_compare: \{ required: \['cwd', 'parent'\], optional: \['authorizedPaths', 'manifest'\] \}/);
});

test('Issue #96 every guard failure names its subcheck and the observed value', async () => {
  const repository = guardRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;

    // guard_before_edit passes on the clean workspace and rejects a runtime-root path by name.
    const clean = cli('guard_before_edit', { cwd: workspace, expected: created.data, authorizedPaths: ['tracked.txt', 'extra.txt', 'unused.md'] });
    assert.equal(clean.ok, true, JSON.stringify(clean.error));
    const rooted = named(cli('guard_before_edit', { cwd: workspace, expected: created.data, authorizedPaths: ['tracked.txt', '.pi/task.json'] }));
    assert.equal(rooted.error.details.subcheck, 'runtime_root_exclusion');
    assert.match(rooted.error.message, /\.pi\/task\.json/);

    // The overlay is a subset of the authorized maximum: two of three paths change, one is
    // an untracked addition, and the untouched third is not demanded (the PR #94 killer).
    fs.appendFileSync(path.join(workspace, 'tracked.txt'), 'edited\n');
    fs.writeFileSync(path.join(workspace, 'extra.txt'), 'new file\n');
    const frozen = cli('overlay_freeze', { cwd: workspace, authorizedPaths: ['tracked.txt', 'extra.txt', 'unused.md'] });
    assert.equal(frozen.ok, true, JSON.stringify(frozen.error));
    assert.deepEqual(frozen.data.entries.map((entry) => entry.path).sort(), ['extra.txt', 'tracked.txt']);
    for (const entry of frozen.data.entries) assert.match(entry.rawDiffSha256, /^[0-9a-f]{64}$/);

    // An unauthorized edit is named, path and subcheck.
    fs.writeFileSync(path.join(workspace, 'rogue.txt'), 'rogue\n');
    const rogue = named(cli('overlay_freeze', { cwd: workspace, authorizedPaths: ['tracked.txt', 'extra.txt'] }));
    assert.equal(rogue.error.details.subcheck, 'authorized_subset');
    assert.match(rogue.error.message, /rogue\.txt/);
    fs.rmSync(path.join(workspace, 'rogue.txt'));

    // overlay_compare re-observes equality, then names the drifted path when bytes change.
    const compared = cli('overlay_compare', { cwd: workspace, overlay: frozen.data });
    assert.equal(compared.ok, true, JSON.stringify(compared.error));
    fs.appendFileSync(path.join(workspace, 'tracked.txt'), 'drift\n');
    const drifted = named(cli('overlay_compare', { cwd: workspace, overlay: frozen.data }));
    assert.equal(drifted.error.details.subcheck, 'overlay_drift');
    assert.match(drifted.error.message, /tracked\.txt/);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'base\nedited\n');
    const restored = cli('overlay_compare', { cwd: workspace, overlay: frozen.data });
    assert.equal(restored.ok, true, JSON.stringify(restored.error));

    // manifest_compare capture: the index against parent P holds exactly the staged
    // authorized entries; the HEAD-existing workflow file cannot be misclassified because
    // the comparison source is the diff against P, never the whole index.
    git(workspace, ['add', 'tracked.txt', 'extra.txt']);
    const captured = cli('manifest_compare', { cwd: workspace, parent: repository.head, authorizedPaths: ['tracked.txt', 'extra.txt', 'unused.md'] });
    assert.equal(captured.ok, true, JSON.stringify(captured.error));
    assert.deepEqual(captured.data.entries.map((entry) => entry.path).sort(), ['extra.txt', 'tracked.txt']);
    assert.equal(captured.data.entries.some((entry) => entry.path.startsWith('.github/')), false, 'a parent-carried entry never enters the manifest');

    // Compare mode re-verifies the immutable manifest, then names an unauthorized staged path.
    const recompared = cli('manifest_compare', { cwd: workspace, parent: repository.head, manifest: captured.data });
    assert.equal(recompared.ok, true, JSON.stringify(recompared.error));
    fs.writeFileSync(path.join(workspace, 'sneak.txt'), 'sneak\n');
    git(workspace, ['add', 'sneak.txt']);
    const sneaked = named(cli('manifest_compare', { cwd: workspace, parent: repository.head, manifest: captured.data }));
    assert.equal(sneaked.error.details.subcheck, 'manifest_drift');
    assert.match(sneaked.error.message, /sneak\.txt/);

    // Capture mode enforces the same maximum set: the sneaked path is named there too.
    const sneakCaptured = named(cli('manifest_compare', { cwd: workspace, parent: repository.head, authorizedPaths: ['tracked.txt', 'extra.txt', 'unused.md'] }));
    assert.equal(sneakCaptured.error.details.subcheck, 'authorized_subset');
    assert.match(sneakCaptured.error.message, /sneak\.txt/);

    // Exactly one of authorizedPaths or manifest.
    const both = named(cli('manifest_compare', { cwd: workspace, parent: repository.head, authorizedPaths: ['tracked.txt'], manifest: captured.data }));
    assert.equal(both.error.code, 'invalid_request');

    // Review-driven (SOL-99-RUNTIME-ROOT-GUARD): the roots are classified no-follow before
    // their descendant churn is excluded — a symlink or file root fails by name in both the
    // dirty and the staged phases, exactly as the runtime-root fail-stop invariant requires.
    fs.symlinkSync(os.tmpdir(), path.join(workspace, '.pi'));
    const dirtyUnsafe = named(cli('overlay_freeze', { cwd: workspace, authorizedPaths: ['tracked.txt'] }));
    assert.equal(dirtyUnsafe.error.details.subcheck, 'runtime_root_classification');
    assert.match(dirtyUnsafe.error.message, /\.pi is symlink/);
    const stagedUnsafe = named(cli('manifest_compare', { cwd: workspace, parent: repository.head, manifest: captured.data }));
    assert.equal(stagedUnsafe.error.details.subcheck, 'runtime_root_classification');
    fs.rmSync(path.join(workspace, '.pi'));
    fs.writeFileSync(path.join(workspace, '.pi-subagents'), 'not a directory\n');
    const fileRoot = named(cli('overlay_compare', { cwd: workspace, overlay: frozen.data }));
    assert.equal(fileRoot.error.details.subcheck, 'runtime_root_classification');
    assert.match(fileRoot.error.message, /\.pi-subagents is file/);
    fs.rmSync(path.join(workspace, '.pi-subagents'));

    // Review-driven (SOL-99-NAMED-OBSERVED-FAILURES): a raw process failure is normalized to
    // a named subcheck instead of escaping without one.
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-96-nonrepo-'));
    try {
      const broken = named(cli('overlay_freeze', { cwd: nonRepo, authorizedPaths: ['tracked.txt'] }));
      assert.equal(broken.error.details.subcheck, 'process_failure');
    } finally { fs.rmSync(nonRepo, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
  }
});

test('Issue #96 rename endpoints stay inside the maximum set', async () => {
  // Review-driven (SOL-99-RENAME-ENDPOINT-SCOPE): a rename mutates its source, so both
  // endpoints must be authorized; the source endpoint is retained, checked, and bound into
  // manifest equality instead of being dropped by the record parser.
  const repository = guardRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;
    git(workspace, ['mv', 'tracked.txt', 'moved.txt']);

    const dirty = named(cli('overlay_freeze', { cwd: workspace, authorizedPaths: ['moved.txt'] }));
    assert.equal(dirty.error.details.subcheck, 'authorized_subset');
    assert.match(dirty.error.message, /rename source .* tracked\.txt/);

    const staged = named(cli('manifest_compare', { cwd: workspace, parent: repository.head, authorizedPaths: ['moved.txt'] }));
    assert.equal(staged.error.details.subcheck, 'authorized_subset');
    assert.match(staged.error.message, /rename source .* tracked\.txt/);

    // Both endpoints authorized: the manifest captures the rename with its source bound.
    const captured = cli('manifest_compare', { cwd: workspace, parent: repository.head, authorizedPaths: ['tracked.txt', 'moved.txt'] });
    assert.equal(captured.ok, true, JSON.stringify(captured.error));
    const rename = captured.data.entries.find((entry) => entry.status === 'R');
    assert.equal(rename.path, 'moved.txt');
    assert.equal(rename.sourcePath, 'tracked.txt');
    const recompared = cli('manifest_compare', { cwd: workspace, parent: repository.head, manifest: captured.data });
    assert.equal(recompared.ok, true, JSON.stringify(recompared.error));
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
  }
});

test('Issue #96 the guard cross-operation fields are shape-checked before dispatch', () => {
  // Review-driven (SOL-99-GUARD-CROSS-SHAPES): the wrong producer document is rejected as
  // input_shape_mismatch before dispatch, named, never as a misleading guard diagnosis.
  const envelope = { version: 1, ok: true, operation: 'x', data: {} };
  for (const [operation, data, shape] of [
    ['guard_before_edit', { cwd: '/w', expected: envelope, authorizedPaths: ['a.txt'] }, 'data:workspace_create'],
    ['overlay_compare', { cwd: '/w', overlay: envelope }, 'data:overlay_freeze'],
    ['manifest_compare', { cwd: '/w', parent: 'a'.repeat(40), manifest: envelope }, 'data:manifest_compare'],
  ]) {
    const swapped = named(cli(operation, data));
    assert.equal(swapped.error.code, 'input_shape_mismatch');
    assert.equal(swapped.operation, operation);
    assert.ok(swapped.error.message.includes(shape), `${operation} must name ${shape}`);
  }
  // Review-driven (SOL-99-GUARD-CROSS-SHAPES, round 3): the two guard producers carry the
  // same envelope keys, so actual producer data — not just a hand-made envelope — must be
  // rejected when it is fed to the other field, in both directions.
  const overlayData = { parent: 'a'.repeat(40), entries: [{ path: 'a.txt', status: 'M', rawDiffSha256: 'b'.repeat(64) }], authorizedPaths: ['a.txt'] };
  const manifestData = { parent: 'a'.repeat(40), entries: [{ path: 'a.txt', status: 'M', srcMode: '100644', dstMode: '100644', srcOid: 'c'.repeat(40), dstOid: 'd'.repeat(40) }] };
  const crossed = named(cli('manifest_compare', { cwd: '/w', parent: 'a'.repeat(40), manifest: overlayData }));
  assert.equal(crossed.error.code, 'input_shape_mismatch');
  assert.ok(crossed.error.message.includes('data:manifest_compare'));
  const reversed = named(cli('overlay_compare', { cwd: '/w', overlay: manifestData }));
  assert.equal(reversed.error.code, 'input_shape_mismatch');
  assert.ok(reversed.error.message.includes('data:overlay_freeze'));
  // The valid compositions still pass their predicate: only the git observation fails after.
  for (const [operation, data] of [
    ['overlay_compare', { cwd: '/nonexistent-not-a-repo', overlay: overlayData }],
    ['manifest_compare', { cwd: '/nonexistent-not-a-repo', parent: 'a'.repeat(40), manifest: manifestData }],
  ]) {
    const valid = cli(operation, data);
    assert.notEqual(valid.error?.code, 'input_shape_mismatch', `${operation} must accept its own producer's data`);
  }

  // Capture mode legitimately omits the optional manifest field.
  const capture = cli('manifest_compare', { cwd: '/nonexistent-not-a-repo', parent: 'a'.repeat(40), authorizedPaths: ['a.txt'] });
  assert.notEqual(capture.error?.code, 'input_shape_mismatch', 'an omitted optional manifest must not fail shape validation');
});

test('Issue #96 unobservable authorized paths are refused by name', () => {
  // Self-audit before review: Git never reports `.git` contents as worktree or index state,
  // so an authorized path there could be written while every guard reported a clean,
  // in-bounds overlay — the same authorized-but-unobservable class as a runtime root. A
  // blank path or one carrying control characters is likewise not a path any guard can match.
  const rejected = (paths, subcheck) => {
    const result = named(cli('overlay_freeze', { cwd: '/tmp', authorizedPaths: paths }));
    assert.equal(result.error.details.subcheck, subcheck, `${JSON.stringify(paths)} must fail ${subcheck}`);
    return result;
  };
  const metadata = rejected(['tracked.txt', '.git/hooks/pre-commit'], 'repository_metadata_exclusion');
  assert.match(metadata.error.message, /\.git\/hooks\/pre-commit/);
  rejected(['sub/.git/config'], 'repository_metadata_exclusion');
  rejected(['sub/.GIT/config'], 'repository_metadata_exclusion');
  for (const blank of [' ', '\t', 'a\u0000b', 'a\nb']) rejected([blank], 'authorized_paths_shape');
});

test('Issue #96 the frozen digest covers literal content and full blob identity', () => {
  // Self-audit before review: the contract freezes the overlay by raw diff/content bytes and
  // blob identity. Without `--binary --no-abbrev` a binary change is represented only by a
  // "Binary files differ" line plus an abbreviated index line, so the digest is pinned here
  // against an independently computed patch over the exact flag set.
  const repository = guardRepository();
  try {
    const created = cli('workspace_create', { cwd: repository.root, head: repository.head, tree: repository.tree });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const workspace = created.data.path;
    fs.writeFileSync(path.join(workspace, 'payload.bin'), Buffer.from([0, 1, 2, 250, 0, 9]));

    const frozen = cli('overlay_freeze', { cwd: workspace, authorizedPaths: ['payload.bin'] });
    assert.equal(frozen.ok, true, JSON.stringify(frozen.error));
    // `git diff --no-index` exits 1 when the inputs differ, which is the expected case here.
    let patchBytes;
    try {
      patchBytes = execFileSync('git', ['diff', '--no-ext-diff', '--binary', '--no-abbrev', '--no-index', '--', '/dev/null', 'payload.bin'], {
        cwd: workspace, encoding: 'buffer',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      assert.equal(error.status, 1, 'only a difference exit is expected');
      patchBytes = error.stdout;
    }
    const patch = patchBytes.toString('utf8');
    assert.match(patch, /GIT binary patch/, 'the pinned flag set must produce a literal binary patch');
    assert.doesNotMatch(patch, /Binary files .* differ/);
    // The guard's digest is over the same bytes this patch carries: any weaker flag set here
    // changes the digest and fails.
    const digest = require('node:crypto').createHash('sha256').update(patchBytes).digest('hex');
    assert.equal(frozen.data.entries[0].rawDiffSha256, digest, 'the frozen digest must cover the literal binary patch');
  } finally {
    fs.rmSync(repository.root, { recursive: true, force: true });
    fs.rmSync(repository.bare, { recursive: true, force: true });
  }
});

test('Issue #96 the guards accept SHA-256 repository object names', () => {
  // Review-driven (SOL-99-SHA256-GUARD-OIDS): a SHA-256 repository yields 64-hex OIDs; the
  // freeze-to-compare and capture-to-compare compositions must round-trip there too.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-96-sha256-'));
  try {
    git(root, ['init', '-b', 'main', '--object-format=sha256']);
    git(root, ['config', 'user.name', 'Issue 96 Test']);
    git(root, ['config', 'user.email', 'issue96@example.invalid']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    git(root, ['add', 'tracked.txt']);
    git(root, ['commit', '-m', 'test: sha256 base']);
    const head = git(root, ['rev-parse', 'HEAD']);
    assert.equal(head.length, 64, 'the fixture repository must produce 64-hex object names');

    fs.appendFileSync(path.join(root, 'tracked.txt'), 'edited\n');
    const frozen = cli('overlay_freeze', { cwd: root, authorizedPaths: ['tracked.txt'] });
    assert.equal(frozen.ok, true, JSON.stringify(frozen.error));
    assert.equal(frozen.data.parent, head);
    const compared = cli('overlay_compare', { cwd: root, overlay: frozen.data });
    assert.equal(compared.ok, true, JSON.stringify(compared.error));

    git(root, ['add', 'tracked.txt']);
    const captured = cli('manifest_compare', { cwd: root, parent: head, authorizedPaths: ['tracked.txt'] });
    assert.equal(captured.ok, true, JSON.stringify(captured.error));
    const recompared = cli('manifest_compare', { cwd: root, parent: head, manifest: captured.data });
    assert.equal(recompared.ok, true, JSON.stringify(recompared.error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #96 a guard request that fails before dispatch is still a named failure', () => {
  // Review-driven (SOL-99-NAMED-OBSERVED-FAILURES, round 2): missing and unknown request
  // fields on a recognized guard operation must carry the guard's name, a request_shape
  // subcheck, and the offending field — never a detail-free operation:"cli" error.
  const requests = {
    guard_before_edit: { cwd: '/w', expected: {}, authorizedPaths: ['a.txt'] },
    overlay_freeze: { cwd: '/w', authorizedPaths: ['a.txt'] },
    overlay_compare: { cwd: '/w', overlay: {} },
    manifest_compare: { cwd: '/w', parent: 'a'.repeat(40) },
  };
  for (const [operation, data] of Object.entries(requests)) {
    const required = Object.keys(data)[1] || 'cwd';
    const { [required]: dropped, ...missingData } = data;
    const missing = named(cli(operation, missingData));
    assert.equal(missing.operation, operation, `${operation}: pre-dispatch failure must keep the guard name`);
    assert.equal(missing.error.details.subcheck, 'request_shape');
    assert.equal(missing.error.details.observed, required);

    const unknown = named(cli(operation, { ...data, mystery: true }));
    assert.equal(unknown.operation, operation);
    assert.equal(unknown.error.details.subcheck, 'request_shape');
    assert.equal(unknown.error.details.observed, 'mystery');
  }
});

test('Issue #96 envelope-level defects on a recognized guard are named too', () => {
  // Review-driven (SOL-99-NAMED-OBSERVED-FAILURES, round 3): an unknown top-level field,
  // an invalid version, or missing data on a recognized guard request keeps the guard's
  // name and a request_shape subcheck; unrecognized operations keep reporting as cli.
  const rawCli = (payload) => JSON.parse(spawnSync(process.execPath, [CLI], { input: JSON.stringify(payload), encoding: 'utf8' }).stdout);
  for (const operation of ['guard_before_edit', 'overlay_freeze', 'overlay_compare', 'manifest_compare']) {
    const topLevel = named(rawCli({ version: 1, operation, data: { cwd: '/w' }, mystery: true }));
    assert.equal(topLevel.operation, operation);
    assert.equal(topLevel.error.details.subcheck, 'request_shape');
    assert.equal(topLevel.error.details.observed, 'mystery');

    // Review-driven (SOL-99-NAMED-OBSERVED-FAILURES, round 4): the observed value is a
    // truthful bounded description — missing and null are distinct, scalars keep their
    // concrete value, containers are summarized, and typeof null never says object.
    for (const [payload, observed] of [
      [{ version: 1, operation, data: null }, 'data null'],
      [{ version: 1, operation }, 'data undefined'],
      [{ version: 1, operation, data: [] }, 'data array of 0'],
      [{ version: 1, operation, data: 'x' }, 'data string "x"'],
      [{ version: 1, operation, data: 5 }, 'data number 5'],
      [{ version: 1, operation, data: true }, 'data boolean true'],
      [{ version: 2, operation, data: { cwd: '/w' } }, 'version number 2'],
      [{ version: '1', operation, data: { cwd: '/w' } }, 'version string "1"'],
      [{ version: null, operation, data: { cwd: '/w' } }, 'version null'],
    ]) {
      const result = named(rawCli(payload));
      assert.equal(result.operation, operation, `${operation}: ${observed}`);
      assert.equal(result.error.details.observed, observed);
    }

    // Review-driven (SOL-99-NAMED-OBSERVED-FAILURES, round 5): raw-stdin regressions,
    // because JSON.stringify(-0) already loses the sign before the CLI would see it. The
    // parsed value is negative zero and the report says so; and truncation lands on
    // code-point boundaries, so no lone surrogate is fabricated at the cut.
    const astral = 'a'.repeat(36) + '\u{1F600}' + 'b'.repeat(10);
    for (const [rawText, observed] of [
      [`{"version":1,"operation":"${operation}","data":-0}`, 'data number -0'],
      [`{"version":-0,"operation":"${operation}","data":{"cwd":"/w"}}`, 'version number -0'],
      [JSON.stringify({ version: 1, operation, data: astral }), `data string ${JSON.stringify('a'.repeat(36) + '\u{1F600}' + '...')}`],
    ]) {
      const raw = JSON.parse(spawnSync(process.execPath, [CLI], { input: rawText, encoding: 'utf8' }).stdout);
      named(raw);
      assert.equal(raw.operation, operation, `${operation}: ${observed}`);
      assert.equal(raw.error.details.observed, observed);
    }
  }
  const stranger = rawCli({ version: 2, operation: 'workspace_verify', data: {} });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.operation, 'cli', 'unrecognized operations keep reporting as cli');
  assert.equal(stranger.error.details, undefined);
});

test('Issue #96 the aggregate alarm reset is the one the suites assert', () => {
  const surface = readText('test/issue-59-helper-surface.test.js');
  assert.match(surface, /const AGGREGATE_SMOKE_ALARM = 200000; \/\/ CL-D57 planned-growth reset from 160,000 \(CL-D53\) for the guard family/);
  assert.match(readText('test/package.test.js'), /helperBytes < 200000/);
});

test('Issue #96 CL-D57 records the guard family and the reviewed alarm reset', () => {
  const decision = sectionOf(readText('CONTRACT.md'), '## CL-D57 — The batch-sequence guards are packaged and the alarm is reset for them');
  assert.ok(decision, 'CONTRACT.md must record CL-D57');
  for (const field of ['*Decision ID:* CL-D57', '*Kind:*', '*Target and revision:*', '*Question:*', '*Options and trade-offs:*', '*Recommendation:*', '*Owner choice:*', '*Rationale:*', '*Validity and invalidation conditions:*']) {
    assert.ok(decision.includes(field), `CL-D57 must carry ${field}`);
  }
  assert.match(decision, /issues\/96#issuecomment-5478036060/);
  assert.match(decision, /160,000 to 200,000/);
  assert.match(decision, /authorized paths are a maximum set/);
  assert.match(decision, /never against only the authorized changed files/);
  assert.match(decision, /Packaging changes who implements the check, not what happens when it truly fails/);
});
