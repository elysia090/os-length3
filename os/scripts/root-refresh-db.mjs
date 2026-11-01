// One package of the root made anew (root-refresh.sh), put in place of the base's: what the database
// (lib/apk/db/installed) gave that package goes from the root, what was made comes in, and the package's entry says
// the new version and its files. Its files carry no checksum (Z:): the base's own are not the files' digests as they
// are now (its post-link compiler rewrote them after they were packaged), and the root is trusted whole by its pin.
//
//   node scripts/root-refresh-db.mjs ROOT PACKAGE VERSION TREE
//
// ROOT is the root laid out for Prompts (merged /usr); TREE what was installed for PACKAGE (DESTDIR), at VERSION as
// its maker writes it (10.6p1 is the database's 10.6_p1).
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

const [root, pkg, version, tree] = process.argv.slice(2);
if (!tree) { console.error('usage: root-refresh-db.mjs ROOT PACKAGE VERSION TREE'); process.exit(2); }
const db = join(root, 'usr/lib/apk/db/installed');
const blocks = readFileSync(db, 'utf8').replace(/\n+$/, '').split(/\n\n+/);
const at = blocks.findIndex((b) => b.split('\n').includes(`P:${pkg}`));
if (at < 0) throw new Error(`root-refresh-db: the root has no package ${pkg}`);
const lines = blocks[at].split('\n');
const field = (k) => lines.find((l) => l.startsWith(`${k}:`))?.slice(2) ?? '';
const parent = (p) => (dirname(p) === '.' ? '' : dirname(p));

// What the base's package had, as the database says it: it goes, and so do its directories left empty.
let dir = '';
const old = [], oldDirs = [];
for (const l of lines) {
  if (l.startsWith('F:')) oldDirs.push(dir = l.slice(2));
  else if (l.startsWith('R:')) old.push(dir ? `${dir}/${l.slice(2)}` : l.slice(2));
}
for (const f of old) rmSync(join(root, f), {force: true});
for (const d of oldDirs.sort().reverse()) { try { rmdirSync(join(root, d)); } catch { /* another's, or not empty */ } }

// What was made, but its manuals (the root has none), put in as it is (modes, links, hard links kept).
const MANUALS = /^usr\/share\/(man|doc|info|locale)(\/|$)/;
for (const d of ['usr/share/man', 'usr/share/doc', 'usr/share/info', 'usr/share/locale']) rmSync(join(tree, d), {recursive: true, force: true});
execFileSync('cp', ['-a', `${tree}/.`, `${root}/`]);
const made = [];
const walk = (d) => {
  for (const n of readdirSync(join(tree, d)).sort()) {
    const p = d ? `${d}/${n}` : n;
    if (MANUALS.test(p)) continue;
    if (lstatSync(join(tree, p)).isDirectory()) walk(p); else made.push(p);
  }
};
walk('');
if (!made.length) throw new Error(`root-refresh-db: nothing was made for ${pkg}`);

// Its entry: the base's words for it, its new version, size and files.
const apkVersion = version.replace(/p(\d+)$/, '_p$1');
const was = field('V').replace(/-r\d+$/, '');
let size = 0;
const seen = new Set(), byDir = new Map();
for (const p of made) {
  const s = lstatSync(join(root, p));
  if (!s.isSymbolicLink() && !seen.has(s.ino)) { seen.add(s.ino); size += s.size; }
  const d = parent(p);
  if (!byDir.has(d)) byDir.set(d, []);
  byDir.get(d).push({name: d ? p.slice(d.length + 1) : p, mode: s.isSymbolicLink() ? 0o777 : s.mode & 0o7777});
}
const dirs = new Set();
for (const d of byDir.keys()) for (let x = d; x; x = parent(x)) dirs.add(x);
// The head as the base's says it, in its order: its version, sizes and source said anew.
const head = lines.slice(0, lines.findIndex((l) => l.startsWith('F:')) >>> 0);
const said = {V: `${apkVersion}-r1`, S: `${size}`, I: `${size}`, U: field('U').split(was.replace(/_p(\d+)$/, 'p$1')).join(version)};
const out = head.filter((l) => !l.startsWith('C:')).map((l) => (said[l[0]] !== undefined && l[1] === ':' ? `${l[0]}:${said[l[0]]}` : l));
for (const d of [...dirs].sort()) {
  out.push(`F:${d}`);
  for (const f of byDir.get(d) ?? []) {
    out.push(`R:${f.name}`);
    if (f.mode !== 0o644) out.push(`a:0:0:${f.mode.toString(8)}`);
  }
}
// apk names an installed package by its checksum (C:, first), which a package made here has none of from a .apk:
// it is the SHA-1 of what its entry says, in apk's form, so the same entry is always the same package.
const entry = out.join('\n');
blocks[at] = `C:Q1${createHash('sha1').update(entry).digest('base64')}\n${entry}`;
writeFileSync(db, `${blocks.join('\n\n')}\n\n`);
console.log(`${pkg} ${was} -> ${apkVersion}: ${old.length} files out, ${made.length} in, ${size} bytes`);
