// l3 for the browser, made from the release root itself: the same tree the
// desktop app installs, so a Prompt in a browser runs the same programs
// with the same bytes. Nothing is built or chosen apart from the root:
// BusyBox, l3 and /etc are the root's own.
//
//   node scripts/l3.ts ROOT OUT [--translator XLAT.wasm] [--xlat XLAT] [--hot PATH,…] [--stage DIR]
//
// ROOT is a release root, os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst
// (checked against the digest in its name), read as l3 installs it
// (scripts/l3-tree.ts). OUT (public/l3) receives:
//
//   l3.json               what l3 this is: {name: 'l3', version, sha256 and bytes
//                         of the root (the digest core/src/root/pins.rs pins), file,
//                         root: {name, profile}, index: {path, sha256, size},
//                         translator: {name, version}}. The one name that is not a
//                         digest; everything it names is.
//   index-<sha256>.json   every path of the root ({codec: 'zstd', packs, dirs,
//                         links, files: [{path, mode, size, pack, at, len, raw?}]},
//                         as xlat/runtime/pack.ts mounts it), the translator and
//                         the translations made ahead of time ({path, sha256 of the
//                         program, elf, wasm}, each a blob: {path, sha256, size,
//                         bytes}); its digest is what a
//                         release pins for the web (core/src/root/pins.rs, `web`)
//   packs/<sha256>.pack   one per package of the root (lib/apk/db/installed says
//                         which owns a file; what none owns is one more, `local`):
//                         its table (the SHA-256 of each file it stores), then its
//                         files' bytes, each a zstd frame (level 19; as it is when
//                         that is no smaller); named by its table's digest, so a
//                         file read alone from it is checked (xlat/runtime/table.ts),
//                         and a release that changes a few packages leaves every
//                         other pack's name, and what a browser has of it
//   blobs/<sha256>.bin    the translator (xlat.wasm) and each translation made
//                         ahead of time with its program's bytes, gzip'd: the hot programs (`--hot`, by
//                         default BusyBox, which is sh and every coreutils
//                         applet, l3, and git, which every repo is), translated whole by the same
//                         translator so no Prompt spends its first seconds on them; every other
//                         program is translated in the browser when it first runs
//
// Names are sorted and nothing depends on time, so the same root and
// translator give the same files, byte for byte. Unreferenced files of an l3
// before in OUT go. `--stage DIR` also puts BusyBox, its translation and
// xlat.wasm in DIR, for xlat/tests (os/target/userland).
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {packOf} from '../../xlat/runtime/table.ts';
import {readTarball, sha256, type Index} from './l3-tree.ts';

const here = fileURLToPath(new URL('..', import.meta.url));
const repo = join(here, '..');

const args = process.argv.slice(2);
/** The value given after `name` (taken out of the arguments), else `d`. */
function flag(name: string, d: string): string;
function flag(name: string): string | null;
function flag(name: string, d: string | null = null): string | null {
  const i = args.indexOf(name);
  if (i < 0) return d;
  const v = args[i + 1] ?? d;
  args.splice(i, 2);
  return v;
}
const translatorWasm = flag('--translator', join(repo, 'xlat/target/wasm32-unknown-unknown/release/xlat.wasm'));
const xlat = flag('--xlat', join(repo, 'xlat/target/release/xlat'));
const hot = flag('--hot', '/usr/bin/busybox,/usr/bin/l3,/usr/bin/git').split(',').filter(Boolean);
const stage = flag('--stage');
const [rootFile, out] = args;
if (!rootFile || !out) { console.error('usage: l3.ts ROOT OUT [--translator XLAT.wasm] [--xlat XLAT] [--hot PATH,…] [--stage DIR]'); process.exit(2); }

// A root is a few hundred megabytes: past a few gigabytes held, something is wrong, and it stops before the machine does.
setInterval(() => { const rss = process.memoryUsage().rss; if (rss > 3e9) { console.error(`l3.ts: holding ${(rss / 1e9).toFixed(1)} GB; stopped`); process.exit(1); } }, 500).unref();

const named = /^os-length3-linux-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x86_64-([0-9a-f]{64})\.tar\.zst$/.exec(basename(rootFile));
if (!named) throw new Error(`${basename(rootFile)} is not named as a release root (os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst)`);
const [, version = '', rootSha = ''] = named;
const got = sha256(readFileSync(rootFile));
if (got !== rootSha) throw new Error(`${basename(rootFile)}: its bytes are sha256 ${got}, not the digest in its name`);

// Which package owns each file: P: names one, F: a directory, R: a file in the last F (read in a first pass: the db comes after most files).
const owner = new Map<string, string>();
const LOCAL = 'local';
let osRelease = '';
await readTarball(rootFile, (e, bytes) => {
  if (!bytes) return;
  if (e.path === '/usr/lib/apk/db/installed') {
    let pkg = '', dir = '';
    for (const line of bytes.toString('utf8').split('\n')) {
      if (line.startsWith('P:')) pkg = line.slice(2);
      else if (line.startsWith('F:')) dir = line.slice(2);
      else if (line.startsWith('R:')) owner.set(`/${dir ? `${dir}/` : ''}${line.slice(2)}`, pkg);
      else if (line === '') { pkg = ''; dir = ''; }
    }
  }
  if (e.path === '/etc/os-release') osRelease = bytes.toString('utf8');
});
const release: Record<string, string> = Object.fromEntries(osRelease.split('\n').flatMap((l) => {
  const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(l);
  return m ? [[m[1], m[2]]] : [];
}));
if (release.VERSION_ID !== version) throw new Error(`${basename(rootFile)}: its /etc/os-release says ${release.VERSION_ID}, its name ${version}`);

// Second pass: every file's bytes to its package's pack, compressed in threads (below), placed in path order.
// Three compressions at a time, each in a thread of its own and done synchronously there, so what one
// holds while it runs (tens of megabytes at level 19) goes back as it ends, not when a collector gets to it.
const POOL = 3;
const pool = Array.from({length: POOL}, () => new Worker(`
  const {parentPort} = require('node:worker_threads');
  const {constants, zstdCompressSync} = require('node:zlib');
  parentPort.on('message', ({id, bytes}) => {
    const z = zstdCompressSync(bytes, {params: {[constants.ZSTD_c_compressionLevel]: 19, [constants.ZSTD_c_checksumFlag]: 0}});
    parentPort.postMessage({id, z}, [z.buffer]);
  });`, {eval: true}));
const waiting = new Map<number, (z: Buffer) => void>();
const idle = [...pool];
const queue: (() => void)[] = [];
let ids = 0;
for (const w of pool) w.on('message', ({id, z}: {id: number; z: Uint8Array}) => { waiting.get(id)?.(Buffer.from(z)); waiting.delete(id); idle.push(w); queue.shift()?.(); });
const compress = (bytes: Buffer) => new Promise<Buffer>((resolve) => {
  const go = () => { const w = idle.pop(); const id = ids++; waiting.set(id, resolve); w?.postMessage({id, bytes}); };
  if (idle.length) go(); else queue.push(go);
});
/** A file's bytes as its pack keeps them: compressed when that is smaller, else raw. */
type Stored = {z: Buffer; raw?: undefined} | {raw: Buffer; z?: undefined};
const hotBytes = new Map<string, Buffer>();
const stored: {path: string; bytes: Promise<Stored>}[] = [];
const {entries, manifest} = await readTarball(rootFile, (e, bytes) => {
  if (!bytes) return; // a second name of a file: the file's bytes
  if (hot.includes(e.path)) hotBytes.set(e.path, bytes);
  stored.push({path: e.path, bytes: bytes.length ? compress(bytes).then((z): Stored => (z.length < bytes.length ? {z} : {raw: bytes})) : Promise.resolve({raw: bytes})});
});
for (const p of hot) if (!hotBytes.has(p)) throw new Error(`${p} is not a file of this root`);
const packed = new Map(await Promise.all(stored.map(async (s) => [s.path, await s.bytes] as const)));
for (const w of pool) void w.terminate();
/** Where a file is: its package's pack, its line in the pack's table (-1: empty, stored nowhere), its stored length. */
interface Place { who: string; entry: number; len: number; raw: boolean }
const packs = new Map<string, Buffer[]>();
const places = new Map<string, Place>();
const placed: {e: (typeof entries)[number]; place: Place}[] = [];
for (const e of entries.filter((x) => x.type === 'file')) {
  const place = places.get(e.same ?? e.path) ?? (() => {
    const who = owner.get(e.path) ?? LOCAL;
    const s = packed.get(e.path);
    if (!s) throw new Error(`${e.path}: read once, not twice`);
    const bytes = s.z ?? s.raw;
    let pack = packs.get(who);
    if (!pack) { pack = []; packs.set(who, pack); }
    // An empty file stores nothing, and has no line of its pack's table.
    const pl: Place = {who, entry: bytes.length ? pack.push(bytes) - 1 : -1, len: bytes.length, raw: !s.z};
    places.set(e.path, pl);
    return pl;
  })();
  placed.push({e, place});
}
packed.clear();

mkdirSync(join(out, 'packs'), {recursive: true});
mkdirSync(join(out, 'blobs'), {recursive: true});
const order = [...packs.keys()].sort();
const ats = new Map<string, number[]>();
const packList = order.map((who) => {
  const made = packOf(packs.get(who) ?? [], (b) => createHash('sha256').update(b).digest());
  const file = join(out, 'packs', made.name);
  if (!existsSync(file)) writeFileSync(file, made.bytes);
  ats.set(who, made.at);
  return {name: made.name, owner: who, bytes: made.bytes.length};
});
const number = new Map(order.map((who, k) => [who, k]));
const files: Index['files'] = placed.map(({e, place: {who, entry, len, raw}}) => ({
  path: e.path, mode: e.mode, size: e.size ?? 0, pack: number.get(who) ?? 0, at: entry < 0 ? 0 : ats.get(who)?.[entry] ?? 0, len, ...(raw ? {raw: true} : {}),
}));

/** A blob: gzip'd (level 9, no name or time, so the same bytes give the same blob), named by its digest. */
const blob = (bytes: Uint8Array) => {
  const gz = gzipSync(bytes, {level: 9});
  const sha = sha256(gz);
  const path = `blobs/${sha}.bin`;
  if (!existsSync(join(out, path))) writeFileSync(join(out, path), gz);
  return {path, sha256: sha, size: gz.length, bytes: bytes.length};
};

const crate = (file: string) => /^version = "(.*)"/m.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
/** A wasm module without its custom sections (names, debug info, producers): what runs, and nothing a browser fetches only to skip. */
function strip(b: Buffer): Buffer {
  if (b.readUInt32LE(0) !== 0x6d736100) throw new Error(`${translatorWasm} is not WebAssembly`);
  const leb = (at: number): [number, number] => { let n = 0, shift = 0, x; do { x = b[at++] ?? 0; n += (x & 0x7f) * 2 ** shift; shift += 7; } while (x & 0x80); return [n, at]; };
  const kept = [b.subarray(0, 8)];
  for (let at = 8; at < b.length;) {
    const [len, body] = leb(at + 1);
    if (b[at] !== 0) kept.push(b.subarray(at, body + len));
    at = body + len;
  }
  return Buffer.concat(kept);
}
const wasm = strip(readFileSync(translatorWasm));
const translator = {name: 'xlat', version: crate(join(repo, 'xlat/Cargo.toml')), wasm: sha256(wasm), ...blob(wasm)};
// Each hot program translated whole by the native build of the same translator (it gives the bytes the wasm one
// does): what it reaches only through a pointer (BusyBox's applets and its shell's builtins) is there from its first
// run, not translated as it runs.
const work = mkdtempSync(join(tmpdir(), 'l3-'));
const translations: Index['translations'] = [];
try {
  for (const path of hot) {
    const elf = join(work, 'in'), made = join(work, 'out.wasm');
    const bytes = hotBytes.get(path) ?? Buffer.alloc(0);
    writeFileSync(elf, bytes);
    execFileSync(xlat, ['--whole', elf, made], {stdio: ['ignore', 'ignore', 'inherit']});
    // The program's own bytes beside it (the same as in its pack), so a page has both without a zstd decoder of its own.
    translations.push({path, sha256: sha256(bytes), elf: blob(bytes), wasm: blob(readFileSync(made))});
    if (stage && path === '/usr/bin/busybox') { mkdirSync(stage, {recursive: true}); copyFileSync(elf, join(stage, 'busybox')); copyFileSync(made, join(stage, 'busybox.wasm')); }
  }
} finally { rmSync(work, {recursive: true, force: true}); }
if (stage) writeFileSync(join(stage, 'xlat.wasm'), wasm);

const index: Index = {
  name: release.NAME ?? 'OS Length3 Linux', version, sha256: rootSha, codec: 'zstd',
  packs: packList,
  dirs: entries.filter((e) => e.type === 'dir').map((e) => ({path: e.path, mode: e.mode})),
  links: entries.filter((e) => e.type === 'link').map((e) => ({path: e.path, target: e.target ?? ''})),
  files, translator, translations,
};
const json = Buffer.from(JSON.stringify(index));
const indexSha = sha256(json);
const indexPath = `index-${indexSha}.json`;
writeFileSync(join(out, indexPath), json);
const profile = /^base\.profile=(.*)$/m.exec(manifest ?? '')?.[1] ?? '';
const about = {
  name: 'l3', version, sha256: rootSha, bytes: statSync(rootFile).size, file: basename(rootFile),
  root: {name: index.name, profile},
  index: {path: indexPath, sha256: indexSha, size: json.length},
  translator: {name: translator.name, version: translator.version},
};
writeFileSync(join(out, 'l3.json'), `${JSON.stringify(about, null, 2)}\n`);

// What an l3 before left here, and this one does not name, goes (only names this script makes).
const keep = new Set([indexPath, 'l3.json', ...packList.map((p) => `packs/${p.name}`), translator.path, ...translations.flatMap((t) => [t.elf.path, t.wasm.path])]);
for (const f of readdirSync(out)) if (/^index-[0-9a-f]{64}\.json$/.test(f) && !keep.has(f)) rmSync(join(out, f));
for (const [dir, re] of [['packs', /^[0-9a-f]{64}\.pack$/], ['blobs', /^[0-9a-f]{64}\.bin$/]] as const) {
  for (const f of readdirSync(join(out, dir))) if (re.test(f) && !keep.has(`${dir}/${f}`)) rmSync(join(out, dir, f));
}
const total = packList.reduce((n, p) => n + p.bytes, 0);
console.log(`l3 ${version} (root sha256 ${rootSha.slice(0, 12)}…): ${packList.length} packs ${total} bytes, ${files.length} files, ${index.dirs.length} dirs, ${index.links.length} links; translator ${translator.size} bytes; ${translations.map((t) => `${t.path} ${t.elf.size}+${t.wasm.size}`).join(', ')}; index ${indexPath} ${json.length} bytes`);
