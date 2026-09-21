'use strict';

// Issue #159 (CL-D82). `references/autofix.md` and the addendum state that the gates run at the isolated workspace's
// cwd, and `build_gate_launch` emitted no `cwd` at all, so pi-subagents resolved the child's cwd from the caller's
// context — the operator checkout at the immutable baseline. After the writer commits a correction the two trees
// differ, so a route-to-Sol gate would read the uncorrected tree while the procedure claimed otherwise. The builder
// now takes the created workspace, optional because review-only has none, and emits its path as the child's `cwd`
// (owner choice B, issues/159#issuecomment-5748464962).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const helpers = require('../skills/closed-loop-pr/helpers');
const { readText, repoPath, cliSchemas } = require('./helpers');

const CLI = repoPath('skills/closed-loop-pr/helpers/cli.js');
const OID = 'a'.repeat(40), SHA = '1'.repeat(64);
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const CREATED = Object.freeze({
  kind: 'linked',
  path: '/tmp/pi-autofix-helper-test/workspace',
  root: '/tmp/pi-autofix-helper-test',
  head: OID,
  tree: 'b'.repeat(40),
  cleanupAllowed: true,
  receipt: { version: 1, id: 'id', root: '/tmp/pi-autofix-helper-test', storedPath: '/tmp/pi-autofix-helper-test/.cleanup-receipt.json' },
});

function correlation(gate) {
  return { repository: 'o/r', number: 159, baseOid: 'b'.repeat(40), headRepository: 'o/r', headBranch: 'b', headOid: OID, lifecycle: 'open', draft: false, gate, invocation: 1, contractInput: 'c'.repeat(64), snapshotFingerprint: 'd'.repeat(64) };
}
function expectationFor(gate) {
  const built = helpers.buildGateExpectation({ workflow: 'pr', correlation: correlation(gate), assignedFindings: [], requiredEvidence: [{ source: 'CONTRACT.md', kind: 'file', identity: SHA }] });
  assert.equal(built.ok, true, JSON.stringify(built.error));
  return built.data;
}
function completeVolatile(gate, mode = 'autofix') {
  const envelope = {
    target: { repository: 'o/r', number: 159, mode, gate, baseOid: 'b'.repeat(40), headOid: OID, headBranch: 'b' },
    fingerprints: { issue_spec: SHA, pr_base: 'b'.repeat(40), pr_tree: 'c'.repeat(40), pr_head: OID, pr_diff: SHA, pr_commits: SHA, snapshot: 'd'.repeat(64) },
    body: 'body',
    languageProfile: 'conversation: ja; GitHub issue / pull request: en',
    acceptanceCriteria: ['AC1'], history: { unresolved: [], reopened: [], settled: [] },
    diff: 'diff --git a/a b/a' + String.fromCharCode(10),
  };
  if (gate === 'adversarial') { envelope.decisions = []; envelope.comments = []; }
  return envelope;
}

function withExpectationFile(gate, run, mode = 'autofix') {
  const dir = temp('issue-159-launch-');
  try {
    const expectation = expectationFor(gate);
    const expectationPath = path.join(dir, `${gate}.json`);
    fs.writeFileSync(expectationPath, `${JSON.stringify(expectation.expected, null, 2)}\n`);
    run({ expectation, expectationPath, volatile: completeVolatile(gate, mode) });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Issue #159 a gate launch built with the created workspace runs in it', () => {
  for (const gate of ['convergence', 'adversarial', 'safety']) {
    withExpectationFile(gate, (data) => {
      const built = helpers.buildGateLaunch({ ...data, created: CREATED });
      assert.equal(built.ok, true, `${gate}: ${JSON.stringify(built.error)}`);
      assert.equal(built.data.request.cwd, CREATED.path, `${gate}: the gate child runs in the run's own workspace`);
      // The one field added, and nothing else: the launch is otherwise what CL-D68 fixed.
      assert.deepEqual(Object.keys(built.data.request).sort(), ['acceptance', 'agent', 'async', 'context', 'cwd', 'outputMode', 'outputSchema', 'task'], gate);
    });
  }
});

test('Issue #159 a review-only gate launch carries no cwd, and an autofix one may not omit it', () => {
  // Review-only has no workspace: it reviews the operator checkout, and the child inherits that cwd as before.
  withExpectationFile('adversarial', (data) => {
    const built = helpers.buildGateLaunch(data);
    assert.equal(built.ok, true, JSON.stringify(built.error));
    assert.equal(Object.hasOwn(built.data.request, 'cwd'), false, 'no workspace, no cwd');
    assert.deepEqual(Object.keys(built.data.request).sort(), ['acceptance', 'agent', 'async', 'context', 'outputMode', 'outputSchema', 'task']);
    // The envelope states the mode, so the builder relates the two rather than trusting the parent to remember:
    // a review-only launch may not carry a workspace at all (ADV159B-MODE-AND-WORKSPACE-UNRELATED).
    const withWorkspace = helpers.buildGateLaunch({ ...data, created: CREATED });
    assert.deepEqual([withWorkspace.ok, withWorkspace.error?.code, withWorkspace.error?.phase], [false, 'invalid_request', 'build'], JSON.stringify(withWorkspace));
    assert.match(withWorkspace.error.message, /a review-only gate reviews the operator checkout/);
  }, 'review-only');
  // And the hazard CL-D82 closed cannot come back by omission: an autofix launch without the workspace is refused.
  withExpectationFile('adversarial', (data) => {
    const refused = helpers.buildGateLaunch(data);
    assert.deepEqual([refused.ok, refused.error?.code, refused.error?.phase], [false, 'invalid_request', 'build'], JSON.stringify(refused));
    assert.match(refused.error.message, /an autofix gate runs in the run-owned workspace/);
  });
});

test('Issue #159 a child sent to the workspace is given no path it must resolve there', () => {
  // The task interpolates `expectationPath`, and the child validates its draft against that file. While the child
  // inherited the parent's cwd a relative path resolved; sent to the workspace it would resolve inside the worked
  // tree, or not at all. With a workspace, the path must be absolute (ADV159-EXPECTATION-PATH-RELATIVE).
  withExpectationFile('adversarial', (data) => {
    const relative = path.relative(process.cwd(), data.expectationPath);
    assert.equal(path.isAbsolute(relative), false, 'the fixture is relative, or this case proves nothing');
    const refused = helpers.buildGateLaunch({ ...data, expectationPath: relative, created: CREATED });
    assert.deepEqual([refused.ok, refused.error?.code, refused.error?.phase], [false, 'invalid_request', 'build'], JSON.stringify(refused));
    assert.match(refused.error.message, /expectationPath must be absolute/);
  });
  // Without a workspace the child stays where the parent is, and a relative path still resolves there.
  withExpectationFile('adversarial', (data) => {
    const relative = path.relative(process.cwd(), data.expectationPath);
    const built = helpers.buildGateLaunch({ ...data, expectationPath: relative });
    assert.equal(built.ok, true, JSON.stringify(built.error));
    assert.ok(built.data.request.task.includes(`Expectation file: ${relative}`));
  }, 'review-only');
});

test('Issue #159 the workspace must satisfy the declared shape, and an unusable path is refused', () => {
  withExpectationFile('adversarial', (data) => {
    // A clone as `workspace_create` returns it carries no `receipt` key at all; spelling it `receipt: undefined`
    // leaves an own key, and the declared shape then refuses the object one layer before the builder's clone rule,
    // which would never run (ADV159-CLONE-CASE-NOT-DISCRIMINATING, the same trap as ADV-152).
    const CLONE = { kind: 'clone', path: '/tmp/pi-autofix-helper-test/clone', root: '/tmp/pi-autofix-helper-test', head: OID, tree: 'b'.repeat(40), cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable' };
    assert.equal(helpers.inputShapeProblem('build_gate_launch', { ...data, created: CLONE }), null, 'the shape accepts a clone; the builder is what refuses it');
    for (const [label, code, created] of [
      ['a hand-made object', 'input_shape_mismatch', { path: '/tmp/w' }],
      ['null', 'input_shape_mismatch', null],
      ['a clone fallback', 'invalid_request', CLONE],
    ]) {
      const refused = helpers.buildGateLaunch({ ...data, created });
      assert.equal(refused.ok, false, `${label}: ${JSON.stringify(refused.data)}`);
      assert.deepEqual([refused.error.code, refused.error.phase], [code, 'build'], label);
    }
    // A relative or control-bearing workspace path is refused as the writer launch refuses it (CL-D81).
    for (const candidate of ['relative/workspace', `/tmp/w${String.fromCharCode(0)}`, '/tmp/w\ud800']) {
      const refused = helpers.buildGateLaunch({ ...data, created: { ...CREATED, path: candidate } });
      assert.deepEqual([refused.ok, refused.error?.code], [false, 'invalid_request'], JSON.stringify(candidate));
    }
  });
});

test('Issue #159 what the screens do not judge is stated, not assumed', () => {
  // CL-D44 says an object constructed by hand to satisfy a declared predicate passes: detecting fabricated producer
  // output is outside this boundary. The three screens are the whole of what CL-D82 adds, so the residual is pinned
  // here rather than left to be discovered as a surprise (DEC-PR167-WORKSPACE-INPUT-CLAIMS, option A).
  withExpectationFile('adversarial', (data) => {
    const fabricated = { kind: 'linked', path: '/tmp/not-a-run/workspace', root: '/tmp/not-a-run', head: OID, tree: 'b'.repeat(40), cleanupAllowed: true, receipt: {} };
    const built = helpers.buildGateLaunch({ ...data, created: fabricated });
    assert.equal(built.ok, true, `a hand-made workspace that satisfies the shape passes: ${JSON.stringify(built.error)}`);
    assert.equal(built.data.request.cwd, fabricated.path);
    // And the screens are the three the record names, not a control-character class: a tab or a line feed inside an
    // absolute path is emitted as given, because nothing here interpolates the cwd into text.
    for (const control of [String.fromCharCode(9), String.fromCharCode(10)]) {
      const odd = helpers.buildGateLaunch({ ...data, created: { ...CREATED, path: `/tmp/w${control}x` } });
      assert.equal(odd.ok, true, `${JSON.stringify(control)}: ${JSON.stringify(odd.error)}`);
      assert.equal(odd.data.request.cwd, `/tmp/w${control}x`);
    }
    // The three that are screened stay screened.
    for (const path of [`/tmp/w${String.fromCharCode(0)}x`, '/tmp/w\ud800', 'relative/w']) {
      const refused = helpers.buildGateLaunch({ ...data, created: { ...CREATED, path } });
      assert.deepEqual([refused.ok, refused.error?.code], [false, 'invalid_request'], JSON.stringify(path));
    }
  });
});

test('Issue #159 the parent cannot add a field to the built gate launch', () => {
  // A misspelt `created` would leave the child in the parent's cwd, which is the hazard CL-D82 closed, so this
  // composer refuses a field it does not know — as `build_writer_launch` does (ADV159B-UNKNOWN-FIELD-UNPINNED).
  withExpectationFile('adversarial', (data) => {
    for (const [label, extra] of [['a misspelt workspace', { Created: CREATED }], ['a cwd of its own', { cwd: CREATED.path } ], ['anything else', { model: 'sol' }]]) {
      const refused = helpers.buildGateLaunch({ ...data, created: CREATED, ...extra });
      assert.deepEqual([refused.ok, refused.error?.code, refused.error?.phase], [false, 'invalid_request', 'build'], `${label}: ${JSON.stringify(refused)}`);
      assert.match(refused.error.message, /unknown request field/, label);
    }
    // And the request it does build carries no key beyond the launch fields and the workspace.
    const built = helpers.buildGateLaunch({ ...data, created: CREATED });
    assert.deepEqual(Object.keys(built.data.request).sort(), ['acceptance', 'agent', 'async', 'context', 'cwd', 'outputMode', 'outputSchema', 'task']);
  });
});

// Every CL-D82 path, through both interfaces a parent can use: the builder in process, and the packaged CLI the run
// actually invokes (CL-D30). One table, two drivers, and the same answer required of each
// (ADV-167-CLI-PATH-COVERAGE).
const NUL = String.fromCharCode(0);
function cl82Cases(data) {
  const created = CREATED;
  const clone = { kind: 'clone', path: '/tmp/pi-autofix-helper-test/clone', root: '/tmp/pi-autofix-helper-test', head: OID, tree: 'b'.repeat(40), cleanupAllowed: false, retained: true, fallbackReason: 'linked_unavailable' };
  const fabricated = { kind: 'linked', path: '/tmp/not-a-run/workspace', root: '/tmp/not-a-run', head: OID, tree: 'b'.repeat(40), cleanupAllowed: true, receipt: {} };
  const withPath = (path) => ({ ...created, path });
  return [
    ['autofix with its workspace', { ...data, created }, { ok: true, cwd: created.path }],
    ['autofix without it', { ...data }, { ok: false, code: 'invalid_request', phase: 'build' }],
    ['review-only without one', { ...data, volatile: completeVolatile('adversarial', 'review-only') }, { ok: true, cwd: undefined }],
    ['review-only carrying one', { ...data, volatile: completeVolatile('adversarial', 'review-only'), created }, { ok: false, code: 'invalid_request', phase: 'build' }],
    ['a clone fallback', { ...data, created: clone }, { ok: false, code: 'invalid_request', phase: 'build' }],
    // The declared-shape check runs at the request boundary, so the CLI names the operation as the phase where the
    // builder names `build`; the refusal is the same one.
    ['a workspace that is not producer-shaped', { ...data, created: { path: '/tmp/w' } }, { ok: false, code: 'input_shape_mismatch', phase: 'build', cliPhase: 'build_gate_launch' }],
    ['a NUL in the path', { ...data, created: withPath(`/tmp/w${NUL}x`) }, { ok: false, code: 'invalid_request', phase: 'build' }],
    ['a lone surrogate in the path', { ...data, created: withPath('/tmp/w\ud800') }, { ok: false, code: 'invalid_request', phase: 'build' }],
    ['a relative path', { ...data, created: withPath('relative/w') }, { ok: false, code: 'invalid_request', phase: 'build' }],
    ['a tab in the path', { ...data, created: withPath(`/tmp/w${String.fromCharCode(9)}x`) }, { ok: true, cwd: `/tmp/w${String.fromCharCode(9)}x` }],
    ['a line feed in the path', { ...data, created: withPath(`/tmp/w${String.fromCharCode(10)}x`) }, { ok: true, cwd: `/tmp/w${String.fromCharCode(10)}x` }],
    ['a fabricated workspace', { ...data, created: fabricated }, { ok: true, cwd: fabricated.path }],
    ['a relative expectationPath beside a workspace', { ...data, created, expectationPath: 'relative.json' }, { ok: false, code: 'invalid_request', phase: 'build' }],
    // The CLI's own input table refuses an unknown field before the builder sees it, so the phase differs by design.
    ['an unknown field', { ...data, created, model: 'sol' }, { ok: false, code: 'invalid_request', phase: 'build', cliPhase: 'cli' }],
  ];
}

test('Issue #159 the builder and the packaged CLI answer every CL-D82 path the same way', () => {
  withExpectationFile('adversarial', (data) => {
    const cli = (input) => {
      const result = spawnSync(process.execPath, [CLI], { input: JSON.stringify({ version: 1, operation: 'build_gate_launch', data: input }), encoding: 'utf8' });
      assert.match(result.stdout, /^\{"version":1,/, `the CLI did not answer: ${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    for (const [label, input, expected] of cl82Cases(data)) {
      for (const [driver, answer, phase] of [['builder', helpers.buildGateLaunch(input), expected.phase], ['CLI', cli(input), expected.cliPhase ?? expected.phase]]) {
        assert.equal(answer.ok, expected.ok, `${label} via the ${driver}: ${JSON.stringify(answer.error ?? answer.data?.request?.cwd)}`);
        if (expected.ok) {
          assert.equal(answer.data.request.cwd, expected.cwd, `${label} via the ${driver}: the cwd`);
          const keys = ['acceptance', 'agent', 'async', 'context', 'outputMode', 'outputSchema', 'task'];
          assert.deepEqual(Object.keys(answer.data.request).sort(), expected.cwd === undefined ? keys : [...keys, 'cwd'].sort(), `${label} via the ${driver}: the key set`);
        } else {
          assert.deepEqual([answer.error.code, answer.error.phase], [expected.code, phase], `${label} via the ${driver}: ${JSON.stringify(answer.error)}`);
        }
      }
    }
    // The CLI's own input table names the workspace beside the three CL-D68 inputs.
    assert.deepEqual(cliSchemas().build_gate_launch, ['expectation', 'expectationPath', 'volatile']);
    assert.match(readText('skills/closed-loop-pr/helpers/cli.js'), /build_gate_launch: \{ required: \['expectation', 'expectationPath', 'volatile'\], optional: \['created'\] \}/);
  });
});

// The receiver is pi-subagents, installed beside pi. CL-D81's regression drives its own validators over the writer
// launch because this package's predicates accepted two requests the receiver refused; the gate launch now carries a
// field too, and the same check applies to it (ADV159-RECEIVER-CASE-MISSING). Only an absent package skips (CL-D25).
const RECEIVER = path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
const RECEIVER_MODULES = ['src/extension/schemas.js', 'src/extension/public-execution.js'];
const receiverSkip = (() => {
  try { fs.lstatSync(RECEIVER); return false; } catch (error) { return error.code === 'ENOENT' ? 'pi-subagents is not installed in this environment' : false; }
})();

test('Issue #159 the receiver accepts the cwd the gate launch now carries', { skip: receiverSkip }, async () => {
  const installed = (() => { try { return JSON.parse(fs.readFileSync(path.join(RECEIVER, 'package.json'), 'utf8')).version; } catch { return undefined; } })();
  for (const module of RECEIVER_MODULES) {
    assert.equal(fs.existsSync(path.join(RECEIVER, module)), true, `pi-subagents ${installed ?? 'with no readable package.json'} carries no ${module}; the contracted minimum is 0.70.0 (CL-D25)`);
  }
  const load = (relative) => import(pathToFileURL(path.join(RECEIVER, relative)).href);
  const [schemas, execution] = [await load(RECEIVER_MODULES[0]), await load(RECEIVER_MODULES[1])];
  const typebox = await import(pathToFileURL(createRequire(path.join(RECEIVER, 'package.json')).resolve('typebox/value')).href);
  assert.ok(schemas.SubagentParams && execution.normalizePublicSubagentExecution && typebox.Value, 'the receiver exports the surfaces this case drives');

  await new Promise((resolve) => { withExpectationFile('adversarial', (data) => {
    const built = helpers.buildGateLaunch({ ...data, created: CREATED });
    assert.equal(built.ok, true, JSON.stringify(built.error));
    const request = built.data.request;
    // `cwd` is a declared parameter of the receiver, and the schema accepts the built request with it.
    assert.ok(Object.hasOwn(schemas.SubagentParams.properties ?? {}, 'cwd'), 'the receiver declares cwd');
    assert.equal(typebox.Value.Check(schemas.SubagentParams, request), true, JSON.stringify([...typebox.Value.Errors(schemas.SubagentParams, request)].map((error) => error.message)));
    const normalized = execution.normalizePublicSubagentExecution(request);
    assert.notEqual(normalized.ok, false, `the receiver refused the built gate launch: ${normalized.error}`);
    assert.equal(normalized.params.cwd, CREATED.path, 'and keeps the workspace the builder named');
    // The schema is run, not read: `SubagentParams` declares no `additionalProperties: false`, so the assertion above
    // discriminates only against a value the schema types. A `cwd` of the wrong type is such a value, and the
    // receiver refuses it — which is why the builder must never emit one (ADV159B-SCHEMA-ASSERTION-WEAK).
    assert.equal(typebox.Value.Check(schemas.SubagentParams, { ...request, cwd: 42 }), false, 'the receiver types cwd');
    const refused = helpers.buildGateLaunch({ ...data, created: { ...CREATED, path: 42 } });
    assert.deepEqual([refused.ok, refused.error?.code, refused.error?.phase], [false, 'input_shape_mismatch', 'build'], JSON.stringify(refused));
    resolve();
  }); });
});

test('Issue #159 the procedure states where each mode runs its gates', () => {
  // The map gains the input; the addendum's own cwd sentence, true only now, names how a gate child gets there. The
  // two authority files sit at their ceilings, so the statement is carried where it already belonged.
  const map = readText('skills/closed-loop-pr/references/helper-map.md');
  assert.ok(map.includes('| Gate launch request (CL-D2, CL-D68, CL-D82) | `build_gate_launch` | `expectation` (data of `build_gate_expectation`), `expectationPath`, `volatile`, `created` (data of `workspace_create`; required in autofix, refused in review-only) |'), 'the map declares the new input');
  const addendum = readText('skills/closed-loop-pr/references/autofix-addendum.md');
  assert.ok(addendum.includes('uses exact workspace cwd/identity, gate children via `created` (CL-D82)'), 'the addendum names how a gate child reaches the workspace');
  const record = readText('CONTRACT.md');
  assert.ok(record.includes('## CL-D82 — The gate launch names the workspace its child runs in'), 'CL-D82 must exist');
});
