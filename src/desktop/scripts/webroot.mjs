// The root for the browser's Prompt: the same tree the app's Prompt runs,
// as packs and their index, so a browser fetches each file only when a
// program first reads it (one Range request) and nothing else.
//
//   node scripts/webroot.mjs ROOT OUT
//
// ROOT is an unpacked release root (its `root` directory). OUT receives
//   packs/<sha256>.pack  one per package of the root (lib/apk/db/installed
//                        says which owns a file; what none owns is one more,
//                        `local`): its files' bytes, each deflated (raw)
//                        unless that would not make it smaller, one after
//                        another, named by the digest of what it holds
//   root.json            {name, version, packs: [{name, owner, bytes}],
//                        dirs, links, files: [{path, mode, size, pack, at,
//                        len, raw?}]}, `pack` an index into `packs`
// A release changes few packages (l3 and its files, a package updated), so
// every other pack keeps its name, and what a browser fetched of it before
// is what it has. Names are sorted and nothing depends on time, so the same
// root gives the same packs, byte for byte. Devices, sockets and fifos are
// left out; the names of one file (hard links) share its bytes.
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';

const [root, out] = process.argv.slice(2);
if (!root || !out) { console.error('usage: webroot.mjs ROOT OUT'); process.exit(2); }
mkdirSync(join(out, 'packs'), {recursive: true});

const release = (() => {
  try {
    const v = Object.fromEntries(readFileSync(join(root, 'etc/os-release'), 'utf8').split('\n').map((l) => /^([A-Z_]+)="?([^"]*)"?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
    return {name: v.NAME ?? 'OS Length3 Linux', version: v.VERSION_ID ?? ''};
  } catch { return {name: 'OS Length3 Linux', version: ''}; }
})();

// Which package owns each file: P: names one, F: a directory, R: a file in the last F.
const owner = new Map();
try {
  let pkg = '', dir = '';
  for (const line of readFileSync(join(root, 'lib/apk/db/installed'), 'utf8').split('\n')) {
    if (line.startsWith('P:')) pkg = line.slice(2);
    else if (line.startsWith('F:')) dir = line.slice(2);
    else if (line.startsWith('R:')) owner.set(`/${dir ? dir + '/' : ''}${line.slice(2)}`, pkg);
    else if (line === '') { pkg = ''; dir = ''; }
  }
} catch { /* no package database: one pack */ }
const LOCAL = 'local';

const dirs = [], links = [], files = [];
// owner -> {parts, at}: each pack's bytes as they are added.
const packs = new Map();
const seen = new Map(); // dev:ino -> the stored place of a file with more than one name
const put = (who, bytes) => {
  if (!packs.has(who)) packs.set(who, {parts: [], at: 0});
  const p = packs.get(who);
  p.parts.push(bytes);
  const at = p.at;
  p.at += bytes.length;
  return at;
};

(function walk(dir, rel) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name), path = `${rel}/${name}`, st = lstatSync(full);
    const mode = st.mode & 0o7777;
    if (st.isSymbolicLink()) links.push({path, target: readlinkSync(full)});
    else if (st.isDirectory()) { dirs.push({path, mode}); walk(full, path); }
    else if (st.isFile()) {
      const same = st.nlink > 1 ? seen.get(`${st.dev}:${st.ino}`) : undefined;
      if (same) { files.push({path, mode, ...same}); continue; }
      const bytes = readFileSync(full);
      const z = bytes.length ? deflateRawSync(bytes, {level: 9}) : bytes;
      const raw = z.length >= bytes.length;
      const stored = raw ? bytes : z;
      const who = owner.get(path) ?? LOCAL;
      const place = {size: bytes.length, owner: who, at: put(who, stored), len: stored.length, ...(raw ? {raw: true} : {})};
      if (st.nlink > 1) seen.set(`${st.dev}:${st.ino}`, place);
      files.push({path, mode, ...place});
    }
  }
})(root, '');

// Each pack is named by the digest of what it holds.
const order = [...packs.keys()].sort();
const list = order.map((who) => {
  const bytes = Buffer.concat(packs.get(who).parts);
  const name = `${createHash('sha256').update(bytes).digest('hex')}.pack`;
  const file = join(out, 'packs', name);
  if (!existsSync(file)) writeFileSync(file, bytes);
  return {name, owner: who, bytes: bytes.length};
});
const number = new Map(order.map((who, k) => [who, k]));
for (const f of files) { f.pack = number.get(f.owner); delete f.owner; }

const index = {...release, packs: list, dirs, links, files};
writeFileSync(join(out, 'root.json'), JSON.stringify(index));
const total = list.reduce((n, p) => n + p.bytes, 0);
console.log(`${list.length} packs  ${total} bytes  ${files.length} files  ${dirs.length} dirs  ${links.length} links  (${seen.size} with more than one name)`);
