// The root's package database (usr/lib/apk/db/installed) and world (etc/apk/world), written from what each package
// put in the root: apk reads it as it reads any root's, so `apk info`, `apk info -L` and `apk audit` say what is there
// and whether it is as it was made. Each file has its checksum (Z:, SHA-1 as apk takes it), each directory and file
// its owner and mode where they are not apk's default, and each package the words of its recipe's first line, its
// version as apk orders versions, and where its source is from.
//
//   node root/db.mjs ROOT LIST
//
// LIST names a package a line: NAME VERSION URL TREE, TREE being what that package installed (its files are taken as
// the root has them).
import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

const [root, list] = process.argv.slice(2);
if (!list) { console.error('usage: root-db.mjs ROOT LIST'); process.exit(2); }
const recipes = new URL('packages/', import.meta.url).pathname;

/** A version as apk compares them: digits and dots, a letter, and _p for a portable release (10.6p1, 2026-10-20). */
const apkVersion = (v) => v.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1$2$3').replace(/p(\d+)$/, '_p$1');
/** What a package is, as its recipe's first comment says it. */
const about = (name) => {
  try {
    const first = readFileSync(join(recipes, `${name}.sh`), 'utf8').split('\n').find((l) => l.startsWith('# '));
    return first ? first.slice(2).replace(/[.:].*$/, '').trim() : name;
  } catch { return name; }
};
const checksum = (data) => `Q1${createHash('sha1').update(data).digest('base64')}`;

const blocks = [];
const names = [];
for (const line of readFileSync(list, 'utf8').split('\n').filter(Boolean)) {
  const [name, version, url, tree] = line.split(' ');
  names.push(name);
  const byDir = new Map();
  let size = 0;
  const walk = (d) => {
    for (const n of readdirSync(join(tree, d)).sort()) {
      const p = d ? `${d}/${n}` : n;
      const s = lstatSync(join(tree, p));
      if (s.isDirectory()) { if (!byDir.has(p)) byDir.set(p, []); walk(p); continue; }
      if (!byDir.has(d)) byDir.set(d, []);
      const at = join(root, p);
      const r = lstatSync(at);
      const z = r.isSymbolicLink() ? checksum(readlinkSync(at)) : checksum(readFileSync(at));
      if (!r.isSymbolicLink()) size += r.size;
      byDir.get(d).push({name: n, mode: r.isSymbolicLink() ? null : r.mode & 0o7777, z});
    }
  };
  walk('');
  const out = [`P:${name}`, `V:${apkVersion(version)}-r0`, 'A:x86_64', `S:${size}`, `I:${size}`, `T:${about(name)}`];
  if (url && url !== '-') out.push(`U:${url}`);
  out.push(`o:${name}`);
  for (const d of [...byDir.keys()].sort()) {
    if (d) {
      out.push(`F:${d}`);
      const m = lstatSync(join(root, d)).mode & 0o7777;
      if (m !== 0o755) out.push(`M:0:0:${m.toString(8)}`);
    }
    for (const f of byDir.get(d)) {
      if (!d) throw new Error(`root-db: ${name} puts ${f.name} at the root's top`);
      out.push(`R:${f.name}`);
      if (f.mode !== null && f.mode !== 0o644) out.push(`a:0:0:${f.mode.toString(8)}`);
      out.push(`Z:${f.z}`);
    }
  }
  // apk names an installed package by a checksum (C:, first): here, of what its entry says.
  const entry = out.join('\n');
  blocks.push(`C:${checksum(entry)}\n${entry}`);
}
const db = join(root, 'usr/lib/apk/db/installed');
mkdirSync(dirname(db), {recursive: true});
writeFileSync(db, `${blocks.join('\n\n')}\n\n`);
mkdirSync(join(root, 'etc/apk'), {recursive: true});
writeFileSync(join(root, 'etc/apk/world'), `${[...names].sort().join('\n')}\n`);
console.log(`root-db: ${names.length} packages`);
