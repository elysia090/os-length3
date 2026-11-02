// One package of the root made anew (root-refresh.sh), put in place of the base's: what the database
// (lib/apk/db/installed) gave that package goes from the root, what was made comes in, and the package's entry says
// the new version and its files. Its files carry no checksum (Z:): the base's own are not the files' digests as they
// are now (its post-link compiler rewrote them after they were packaged), and the root is trusted whole by its pin.
//
//   node scripts/root-refresh-db.mjs ROOT PACKAGE VERSION TREE [as-base]
//
// ROOT is the root laid out for Prompts (merged /usr); TREE what was installed for PACKAGE (DESTDIR), at VERSION as
// its maker writes it (10.6p1 is the database's 10.6_p1). With as-base, the package keeps the files the base gave it
// and only those, each taken from TREE (made in the same layout), which must have every one of them: a link the base
// had and TREE has not (BusyBox's applets) stays as the base had it.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

const [root, pkg, version, tree, mode] = process.argv.slice(2);
const asBase = mode === 'as-base';
if (mode !== undefined && !asBase) { console.error(`root-refresh-db: ${mode}: the one mode is as-base`); process.exit(2); }
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
// As the base had them: each from TREE, or a link of the base's that TREE has not made.
const links = new Map();
if (asBase) {
  const has = (p) => { try { lstatSync(p); return true; } catch { return false; } };
  const lacking = [];
  for (const f of old) {
    if (has(join(tree, f))) continue;
    if (has(join(root, f)) && lstatSync(join(root, f)).isSymbolicLink()) links.set(f, readlinkSync(join(root, f)));
    else lacking.push(f);
  }
  if (lacking.length) throw new Error(`root-refresh-db: ${pkg} as made has not ${lacking.join(', ')}, which the base's has`);
}
for (const f of old) rmSync(join(root, f), {force: true});
for (const d of oldDirs.sort().reverse()) { try { rmdirSync(join(root, d)); } catch { /* another's, or not empty */ } }

// What was made, but its manuals (the root has none), put in as it is (modes, links, hard links kept).
const MANUALS = /^usr\/share\/(man|doc|info|locale)(\/|$)/;
for (const d of ['usr/share/man', 'usr/share/doc', 'usr/share/info', 'usr/share/locale']) rmSync(join(tree, d), {recursive: true, force: true});
const made = [];
if (asBase) {
  for (const f of old) {
    mkdirSync(dirname(join(root, f)), {recursive: true});
    if (links.has(f)) symlinkSync(links.get(f), join(root, f));
    else execFileSync('cp', ['-a', join(tree, f), join(root, f)]);
    made.push(f);
  }
} else execFileSync('cp', ['-a', `${tree}/.`, `${root}/`]);
const walk = (d) => {
  for (const n of readdirSync(join(tree, d)).sort()) {
    const p = d ? `${d}/${n}` : n;
    if (MANUALS.test(p)) continue;
    if (lstatSync(join(tree, p)).isDirectory()) walk(p); else made.push(p);
  }
};
if (!asBase) walk('');
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
