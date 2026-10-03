'use strict';

// Issue #216: the filesystem states on the path to the operator configuration ($XDG_CONFIG_HOME/tidd/<owner>/<repo>.json),
// each with the outcome CL-D97 gives: `read` (commands from the file), `none` (a genuinely missing entry) or `BLOCKED`
// (anything else). The table is the PR #211 pre-push sweep, kept so every suite run checks it and the next sweep on this
// component hunts only for states outside it. Each row calls validationCommands in-process and must return, not throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { repoPath } = require('./helpers');
const { validationCommands } = require(repoPath('skills/closed-loop-pr/driver/run.js'));

const made = [];
const temp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(dir); return dir; };
// Every fixture is removed after the file, the PATH_MAX tree and mode-000 folders included.
test.after(() => { for (const dir of made) { try { execFileSync('chmod', ['-R', 'u+rwx', dir], { stdio: 'ignore' }); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } });
// A target checkout whose base carries no .tidd.json, so the operator configuration is the source under test.
const REPO = temp('i216-repo-');
execFileSync('git', ['-C', REPO, 'init', '-q']);
fs.writeFileSync(path.join(REPO, 'a'), 'a');
execFileSync('git', ['-C', REPO, 'add', 'a']);
execFileSync('git', ['-C', REPO, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
const BASE = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim();

const GOOD = JSON.stringify({ validate: [['true']] });
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const put = (p, s = GOOD) => { mk(path.dirname(p)); fs.writeFileSync(p, s); };
const ln = (target, p) => { mk(path.dirname(p)); fs.symlinkSync(target, p); };
const X = (F) => path.join(F, 'cfg');
const FILE = (x) => path.join(x, 'tidd', 'o', 'r.json');
const root = process.getuid?.() === 0;

function row(label, expected, setup, { skip = false, reason } = {}) {
  test(`Issue #216 operator configuration state: ${label} -> ${expected}`, { skip }, () => {
    const F = temp('i216-'), home = path.join(F, 'home'); mk(home);
    const env = setup(F, home);
    const saved = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.HOME };
    if (env.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = env.xdg;
    process.env.HOME = home;
    let result;
    try { result = validationCommands(REPO, BASE, { repository: 'o/r' }); } finally {
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
      env.cleanup?.();
    }
    const got = result.problem ? 'BLOCKED' : result.source === 'none' ? 'none' : 'read';
    assert.equal(got, expected, JSON.stringify(result));
    if (expected === 'read') assert.deepEqual(result.commands, [['true']]);
    if (expected === 'BLOCKED') assert.match(result.problem, reason ?? /operator configuration/);
  });
}

// Absence, presence and plain files.
row('X exists, empty', 'none', (F) => { mk(X(F)); return { xdg: X(F) }; });
row('X missing, parent exists', 'none', (F) => ({ xdg: X(F) }));
row('X missing, several ancestors missing', 'none', (F) => ({ xdg: path.join(F, 'a', 'b', 'c') }));
row('valid file', 'read', (F) => { put(FILE(X(F))); return { xdg: X(F) }; });
row('file is a link to a regular file', 'read', (F) => { put(path.join(F, 'real.json')); ln(path.join(F, 'real.json'), FILE(X(F))); return { xdg: X(F) }; });
// Dangling links at every depth, and chains (CONV-211-DANGLING-PARENT-SYMLINK).
row('X dangling absolute link', 'BLOCKED', (F) => { ln(path.join(F, 'gone'), X(F)); return { xdg: X(F) }; });
row('X dangling relative link', 'BLOCKED', (F) => { ln('gone', X(F)); return { xdg: X(F) }; });
row('tidd dangling', 'BLOCKED', (F) => { ln(path.join(F, 'gone'), path.join(X(F), 'tidd')); return { xdg: X(F) }; });
row('owner folder dangling', 'BLOCKED', (F) => { ln('../gone', path.join(X(F), 'tidd', 'o')); return { xdg: X(F) }; });
row('file dangling', 'BLOCKED', (F) => { ln('gone.json', FILE(X(F))); return { xdg: X(F) }; });
row('ancestor above X dangling', 'BLOCKED', (F) => { ln(path.join(F, 'gone'), path.join(F, 'up')); return { xdg: path.join(F, 'up', 'deeper', 'cfg') }; });
row('X chain link to link to missing', 'BLOCKED', (F) => { ln('l2', X(F)); ln('missing', path.join(F, 'l2')); return { xdg: X(F) }; });
row('tidd chain link to link to missing (relative)', 'BLOCKED', (F) => { ln('../l2', path.join(X(F), 'tidd')); ln('missing', path.join(F, 'l2')); return { xdg: X(F) }; });
row('file chain link to link to missing', 'BLOCKED', (F) => { ln('l2.json', FILE(X(F))); ln('missing.json', path.join(X(F), 'tidd', 'o', 'l2.json')); return { xdg: X(F) }; });
row('X link to link to a folder without the file', 'none', (F) => { mk(path.join(F, 'real')); ln('l2', X(F)); ln('real', path.join(F, 'l2')); return { xdg: X(F) }; });
row('X link whose target crosses a dangling link', 'BLOCKED', (F) => { ln('gone', path.join(F, 'mid')); ln('mid/sub', X(F)); return { xdg: X(F) }; });
// Loops.
row('X self loop', 'BLOCKED', (F) => { ln('cfg', X(F)); return { xdg: X(F) }; });
row('tidd two-link cycle', 'BLOCKED', (F) => { ln('b', path.join(X(F), 'tidd')); ln('tidd', path.join(X(F), 'b')); return { xdg: X(F) }; });
row('file self loop', 'BLOCKED', (F) => { ln('r.json', FILE(X(F))); return { xdg: X(F) }; });
// A regular file, or a link to one, where a folder belongs.
row('X is a regular file', 'BLOCKED', (F) => { fs.writeFileSync(X(F), 'x'); return { xdg: X(F) }; });
row('tidd is a regular file', 'BLOCKED', (F) => { put(path.join(X(F), 'tidd'), 'x'); return { xdg: X(F) }; });
row('owner folder is a regular file', 'BLOCKED', (F) => { put(path.join(X(F), 'tidd', 'o'), 'x'); return { xdg: X(F) }; });
row('X link to a regular file', 'BLOCKED', (F) => { fs.writeFileSync(path.join(F, 'f'), 'x'); ln('f', X(F)); return { xdg: X(F) }; });
row('X link to /dev/null', 'BLOCKED', (F) => { ln('/dev/null', X(F)); return { xdg: X(F) }; });
// Something other than a readable regular file in the file's place.
row('file link to /dev/null', 'BLOCKED', (F) => { ln('/dev/null', FILE(X(F))); return { xdg: X(F) }; }, { reason: /not a regular file/ });
row('file is a directory', 'BLOCKED', (F) => { mk(FILE(X(F))); return { xdg: X(F) }; }, { reason: /not a regular file/ });
row('file is a FIFO', 'BLOCKED', (F) => { mk(path.dirname(FILE(X(F)))); execFileSync('mkfifo', [FILE(X(F))]); return { xdg: X(F) }; }, { reason: /not a regular file/ });
row('file mode 000', 'BLOCKED', (F) => { put(FILE(X(F))); fs.chmodSync(FILE(X(F)), 0); return { xdg: X(F) }; }, { skip: root });
row('file over 64 KiB', 'BLOCKED', (F) => { put(FILE(X(F)), ' '.repeat(70000) + GOOD); return { xdg: X(F) }; });
// Permissions at four depths: unsearchable stops; searchable but unreadable still resolves (ADV-211-OPERATOR-CONFIG-EACCES).
for (const [where, rel] of [['parent of X', '..'], ['X', ''], ['tidd', 'tidd'], ['owner folder', 'tidd/o']]) {
  for (const [mode, present, expected] of [[0o000, true, 'BLOCKED'], [0o000, false, 'BLOCKED'], [0o444, false, 'BLOCKED'], [0o111, false, 'none'], [0o111, true, 'read']]) {
    row(`${where} mode ${mode.toString(8).padStart(3, '0')}, file ${present ? 'present' : 'missing'}`, expected, (F) => {
      const x = path.join(F, 'p', 'cfg'); mk(path.join(x, 'tidd', 'o')); if (present) put(FILE(x));
      const d = path.resolve(x, rel); fs.chmodSync(d, mode);
      return { xdg: x, cleanup: () => fs.chmodSync(d, 0o755) };
    }, { skip: root });
  }
}
// Links that resolve to a folder: absence below them is absence.
row('X link to a folder without the file', 'none', (F) => { mk(path.join(F, 'real')); ln(path.join(F, 'real'), X(F)); return { xdg: X(F) }; });
row('X link to a folder, tidd missing beneath', 'none', (F) => { mk(path.join(F, 'real')); ln('real', X(F)); return { xdg: X(F) }; });
row('X link to a folder, owner folder missing', 'none', (F) => { mk(path.join(F, 'real', 'tidd')); ln('real', X(F)); return { xdg: X(F) }; });
row('X link to a folder whose tidd dangles', 'BLOCKED', (F) => { mk(path.join(F, 'real')); ln('nowhere', path.join(F, 'real', 'tidd')); ln('real', X(F)); return { xdg: X(F) }; });
row('X link to a folder, file present', 'read', (F) => { put(FILE(path.join(F, 'real'))); ln('real', X(F)); return { xdg: X(F) }; });
// XDG_CONFIG_HOME unset, empty, relative or oddly spelled.
row('XDG unset, ~/.config missing', 'none', () => ({ xdg: undefined }));
row('XDG unset, ~/.config dangling', 'BLOCKED', (F, h) => { ln('nowhere', path.join(h, '.config')); return { xdg: undefined }; });
row('XDG unset, file present', 'read', (F, h) => { put(FILE(path.join(h, '.config'))); return { xdg: undefined }; });
row('XDG empty, file present in ~/.config', 'read', (F, h) => { put(FILE(path.join(h, '.config'))); return { xdg: '' }; });
row('XDG relative is ignored, ~/.config missing', 'none', (F) => { put(FILE(X(F))); return { xdg: path.relative(process.cwd(), X(F)) }; });
row('XDG relative is ignored, ~/.config dangling', 'BLOCKED', (F, h) => { ln('nowhere', path.join(h, '.config')); return { xdg: 'rel' }; });
row('HOME itself dangling, XDG unset', 'BLOCKED', (F, h) => { fs.rmdirSync(h); ln('nowhere', h); return { xdg: undefined }; });
row('XDG trailing slash, X dangling', 'BLOCKED', (F) => { ln('gone', X(F)); return { xdg: `${X(F)}/` }; });
row('XDG trailing slash, X an empty folder', 'none', (F) => { mk(X(F)); return { xdg: `${X(F)}/` }; });
row('XDG trailing slashes, file present', 'read', (F) => { put(FILE(X(F))); return { xdg: `${X(F)}//` }; });
// `.` and `..` are the kernel's, resolved physically by the walk (ADV-211-XDG-DOTDOT-NORMALIZATION).
row('XDG with .. over a missing folder', 'none', (F) => { mk(X(F)); return { xdg: `${path.join(F, 'nope')}/../cfg` }; });
row('XDG with .. over a link resolves physically, not at the textual spot', 'none', (F) => { put(FILE(X(F))); mk(path.join(F, 'el', 'deep')); ln(path.join(F, 'el', 'deep'), path.join(F, 'lnk')); return { xdg: `${path.join(F, 'lnk')}/../cfg` }; });
row('XDG with .. over a dangling link', 'BLOCKED', (F) => { mk(X(F)); ln('gone', path.join(F, 'lnk')); return { xdg: `${F}/lnk/../cfg` }; }, { reason: /a dangling link/ });
row('XDG with .. after a regular file', 'BLOCKED', (F) => { fs.writeFileSync(path.join(F, 'plain'), 'x'); return { xdg: `${F}/plain/..` }; }, { reason: /ENOTDIR/ });
row('XDG with . after a regular file', 'BLOCKED', (F) => { fs.writeFileSync(path.join(F, 'plain'), 'x'); return { xdg: `${F}/plain/.` }; }, { reason: /ENOTDIR/ });
row('XDG with .. after an overlong name', 'BLOCKED', (F) => ({ xdg: `${F}/${'x'.repeat(256)}/..` }), { reason: /ENAMETOOLONG/ });
row('XDG with .. at the root', 'none', () => ({ xdg: `/../${temp('i216-root-').slice(1)}` }));
row('a missing path past PATH_MAX is not absence', 'BLOCKED', (F) => ({ xdg: path.join(F, ...Array(25).fill('e'.repeat(200))) }), { reason: /ENAMETOOLONG/ });
// Length limits.
row('XDG path over PATH_MAX', 'BLOCKED', (F) => ({ xdg: path.join(F, 'a'.repeat(5000)) }));
row('XDG component over NAME_MAX', 'BLOCKED', (F) => ({ xdg: path.join(F, 'a'.repeat(300)) }));
row('X link chain resolving beyond PATH_MAX', 'BLOCKED', (F) => {
  const seg = 'd'.repeat(200);
  execFileSync('bash', ['-c', `cd "$1" && mkdir deep && cd deep && for i in $(seq 25); do mkdir ${seg} && cd ${seg}; done && mkdir -p tidd/o`, '-', F]);
  ln(path.join('deep', ...Array(13).fill(seg)), path.join(F, 'hop'));
  ln(path.join('hop', ...Array(12).fill(seg)), X(F));
  return { xdg: X(F) };
});
// Inside the target checkout, however it is reached (CONV-211-XDG-IN-REPO).
row('XDG inside the checkout', 'BLOCKED', () => ({ xdg: path.join(REPO, 'cfg') }));
row('XDG link into the checkout, file missing', 'BLOCKED', (F) => { ln(REPO, X(F)); return { xdg: path.join(X(F), 'sub') }; });
row('XDG under a missing folder inside the checkout', 'BLOCKED', () => ({ xdg: path.join(REPO, 'nope', 'cfg') }));
const inside = /resolves inside the target checkout/;
row('X link to a checkout folder holding the file', 'BLOCKED', (F) => { put(FILE(path.join(REPO, 'sub-x'))); ln(path.join(REPO, 'sub-x'), X(F)); return { xdg: X(F) }; }, { reason: inside });
row('file link to a checkout file', 'BLOCKED', (F) => { put(path.join(REPO, 'cfg.json')); ln(path.join(REPO, 'cfg.json'), FILE(X(F))); return { xdg: X(F) }; }, { reason: inside });
row('owner folder link to a checkout folder', 'BLOCKED', (F) => { mk(path.join(REPO, 'own')); ln(path.join(REPO, 'own'), path.join(X(F), 'tidd', 'o')); return { xdg: X(F) }; }, { reason: inside });
for (const [where, rel] of [['cfg', ''], ['tidd', 'tidd'], ['owner folder', 'tidd/o'], ['file', 'tidd/o/r.json']]) {
  row(`a tracked link at ${where} inside the checkout pointing out`, 'BLOCKED', (F) => {
    const out = path.join(F, 'out'); put(FILE(out)); const x = path.join(REPO, `in-${where.replace(' ', '-')}`);
    ln(rel ? path.join(out, rel) : out, rel ? path.join(x, rel) : x); return { xdg: x };
  }, { reason: inside });
}
row('an outside link through the checkout and out again', 'BLOCKED', (F) => { const out = path.join(F, 'out'); put(FILE(out)); ln(out, path.join(REPO, 'through')); ln(path.join(REPO, 'through'), X(F)); return { xdg: X(F) }; }, { reason: inside });
row('an outside link into a checkout folder, then ..', 'BLOCKED', (F) => { mk(path.join(REPO, 'deep')); ln(path.join(REPO, 'deep'), path.join(F, 'into')); return { xdg: `${F}/into/../cfg` }; }, { reason: inside });
