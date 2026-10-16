// The root for the browser's Prompt: the same tree the app's Prompt runs,
// as one pack and its index, so a browser fetches each file only when a
// program first reads it (one Range request) and nothing else.
//
//   node scripts/webroot.mjs ROOT OUT
//
// ROOT is an unpacked release root (its `root` directory). OUT receives
//   root-<sha256>.pack   every file's bytes, each deflated (raw) unless that
//                        would not make it smaller, one after another
//   root.json            {name, version, pack, sha256, bytes, dirs, links,
//                        files: [{path, mode, size, at, len, raw?}]}
// Names are sorted and nothing depends on time, so the same root gives the
// same pack, byte for byte. Devices, sockets and fifos are left out; the
// names of one file (hard links) share its bytes in the pack.
import {createHash} from 'node:crypto';
import {closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';

const [root, out] = process.argv.slice(2);
if (!root || !out) { console.error('usage: webroot.mjs ROOT OUT'); process.exit(2); }
mkdirSync(out, {recursive: true});

const release = (() => {
  try {
    const v = Object.fromEntries(readFileSync(join(root, 'etc/os-release'), 'utf8').split('\n').map((l) => /^([A-Z_]+)="?([^"]*)"?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
    return {name: v.NAME ?? 'OS Length3 Linux', version: v.VERSION_ID ?? ''};
  } catch { return {name: 'OS Length3 Linux', version: ''}; }
})();

const dirs = [], links = [], files = [];
const tmp = join(out, '.root.pack.partial');
const fd = openSync(tmp, 'w');
const hash = createHash('sha256');
let at = 0;
const seen = new Map(); // dev:ino -> the stored place of a file with more than one name
const put = (bytes) => { writeSync(fd, bytes); hash.update(bytes); const p = at; at += bytes.length; return p; };

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
      const place = {size: bytes.length, at: put(stored), len: stored.length, ...(raw ? {raw: true} : {})};
      if (st.nlink > 1) seen.set(`${st.dev}:${st.ino}`, place);
      files.push({path, mode, ...place});
    }
  }
})(root, '');
closeSync(fd);

const sha256 = hash.digest('hex');
const pack = `root-${sha256}.pack`;
renameSync(tmp, join(out, pack));
const index = {...release, pack, sha256, bytes: at, dirs, links, files};
const text = JSON.stringify(index);
const w = openSync(join(out, 'root.json'), 'w');
writeSync(w, text);
closeSync(w);
console.log(`${pack}  ${at} bytes  ${files.length} files  ${dirs.length} dirs  ${links.length} links  (${seen.size} with more than one name)`);
