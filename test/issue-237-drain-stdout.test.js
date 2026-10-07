'use strict';

// Issue #237 (ADV-236-PREEXISTING-STDOUT-DRAIN): a driver command prints, then calls process.exit. On a pipe, Node
// writes what the pipe buffer takes and queues the rest, and process.exit drops the queue, so a large writer launch
// reached the parent as a truncated JSON line. The driver must leave nothing pending on a pipe when it exits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const DRIVER = path.join(__dirname, '..', 'skills', 'closed-loop-pr', 'driver');
const { writerTask } = require(path.join(DRIVER, 'writer.js'));

// A node child whose stdout and stderr are named pipes (an OS pipe's 64 KB buffer, as a shell pipeline gives), read
// only after a pause, so the buffer fills while the child still writes. No shell is involved.
function pipedNode(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-237-pipe-')), names = ['stdout', 'stderr'];
  const readers = names.map((name) => { const fifo = path.join(dir, name); execFileSync('mkfifo', [fifo]); return [fifo, fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)]; });
  const writers = readers.map(([fifo]) => fs.openSync(fifo, 'w'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', ...writers] }), out = { stdout: [], stderr: [] };
    writers.forEach((fd) => fs.closeSync(fd));
    let status, open = 3;
    const done = () => { if (--open) return; fs.rmSync(dir, { recursive: true, force: true }); resolve({ status, stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8') }); };
    child.on('error', reject);
    child.on('close', (code) => { status = code; done(); });
    setTimeout(() => readers.forEach(([, fd], i) => new net.Socket({ fd, readable: true, writable: false }).on('data', (chunk) => out[names[i]].push(chunk)).on('end', done).on('error', reject)), 1000);
  });
}
// A child that loads the driver modules as both commands do (run.js, then phases.js), runs one real write site, and
// exits at once.
function piped(body) {
  return pipedNode(['-e', `const run = require(${JSON.stringify(path.join(DRIVER, 'run.js'))});\nrequire(${JSON.stringify(path.join(DRIVER, 'phases.js'))});\n${body}`]);
}

// The writer launch for one finding carrying 1 MB of evidence, with multibyte text and the separators jsonLine escapes.
const EVIDENCE = `${'x'.repeat(400000)}${'é'.repeat(200000)}\u2028${'語'.repeat(100000)}\u0085end`;
const s = { target: { repository: 'o/r', number: 1, headBranch: 'b', headOid: 'a'.repeat(40) }, workspace: '/w', validationCommands: [['node', '--test']] };
const open = [{ findingId: 'F-1', record: { severity: 'Minor', gate: 'adversarial', evidence: EVIDENCE, impact: 'i', correction: 'c' } }];
const REQUEST = { agent: 'tidd-writer', task: writerTask(s, open, ['a.js'], 'autofix.js', '/run') };

test('Issue #237 a piped writer launch carrying 1 MB of evidence prints its whole JSON line, which parses to the request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-237-')), saved = path.join(dir, 'request.json');
  try {
    fs.writeFileSync(saved, JSON.stringify(REQUEST));
    const r = await piped(`const request = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(saved)}, 'utf8'));
      run.Run.prototype.next.call({ dir: '/run' }, request, 'autofix.js writer-done');
      process.exit(0);`);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^NEXT: /);
    assert.equal(lines.length, 3, `the NEXT line, the JSON line and the final newline; ${r.stdout.length} characters captured`);
    assert.ok(Buffer.byteLength(EVIDENCE) > 1000000, 'the evidence is over 1 MB');
    assert.deepEqual(JSON.parse(lines[1]), REQUEST);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Issue #237 a piped failure larger than a pipe buffer prints its whole message on stderr', async () => {
  const r = await piped(`run.die('m'.repeat(1000000) + ' end');`);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `tidd-driver: ${'m'.repeat(1000000)} end\n`);
});

test('Issue #237 both driver commands, run as commands, print a failure larger than a pipe buffer whole', async () => {
  const dir = `/a!${'b'.repeat(120000)}`;
  for (const command of ['review.js', 'autofix.js']) {
    const r = await pipedNode([path.join(DRIVER, command), 'status', '--run-dir', dir]);
    assert.equal(r.status, 2, command);
    assert.match(r.stderr, /^tidd-driver: /, command);
    assert.ok(r.stderr.endsWith('\n') && r.stderr.includes(dir), `${command}: ${r.stderr.length} characters captured`);
  }
});
