// One distribution root as content-addressed layers for any static host. This is a
// delivery form of the same tree, not a separate product or package selection.
// node ricebox/distribution/build/distribution.ts ROOT OUT [--translator SODS.wasm] [--sods SODS]
//   [--deploy [--maker FILE] [--framed-aot] | --hot PATH,…] [--name NAME] [--cache DIR]
// The root's filename binds its version and digest. Each pack is checked by its
// digest; files and deployed code are fetched only when used.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withCompression} from './compression-pool.ts';
import {gzipSync} from 'node:zlib';
import {packOf} from '../format/pack.ts';
import {aotObjects} from '../format/aot-frames.ts';
import {canonicalExecutableSource, canonicalPackedFileSet} from '../format/executable-source.ts';
import {wholeTranslator} from './aot-cache.ts';
import {FRAMED_MIN_BYTES, writeFramedAot} from './framed-aot.ts';
import {buildMuk, writeMuk} from './muk-artifact.ts';
import {readTarball} from '../host/node/tar.ts';
import {sha256} from '../host/node/hash.ts';
import type {Blob, DeployedWasm, Index, WebExecution} from '../format/manifest.ts';

const here = fileURLToPath(new URL('../../..', import.meta.url));
const repo = here;

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
const translatorWasm = flag('--translator', join(repo, 'ricebox/sods/target/wasm32-unknown-unknown/release/sods.wasm'));
const sods = flag('--sods', join(repo, 'ricebox/sods/target/release/sods'));
const deployment = args.includes('--deploy');
if (deployment) args.splice(args.indexOf('--deploy'), 1);
const framed = args.includes('--framed-aot');
if (framed) args.splice(args.indexOf('--framed-aot'), 1);
const makerInput = flag('--maker');
const chosenHot = flag('--hot');
const hot = (chosenHot || (deployment ? '' : '/usr/bin/bash,/usr/bin/busybox,/usr/bin/git')).split(',').filter(Boolean);
const distributionName = flag('--name');
const aotCache = flag('--cache', join(repo, 'target/ricebox-aot'));
const [rootFile, out] = args;
if (args.length !== 2 || !rootFile || !out || args.some(arg => arg.startsWith('--')) || ((makerInput !== null || framed) && !deployment)) {
  console.error('usage: distribution.ts ROOT OUT [--translator SODS.wasm] [--sods SODS] [--deploy [--maker FILE] [--framed-aot] | --hot PATH,…] [--name NAME] [--cache DIR]');
  process.exit(2);
}


// A root is a few hundred megabytes: past a few gigabytes held, something is wrong, and it stops before the machine does.
setInterval(() => { const rss = process.memoryUsage().rss; if (rss > 3e9) { console.error(`distribution.ts: holding ${(rss / 1e9).toFixed(1)} GB; stopped`); process.exit(1); } }, 500).unref();

const named = /^[a-zA-Z0-9._-]+-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-x86_64-([0-9a-f]{64})\.tar\.zst$/.exec(basename(rootFile));
if (!named) throw new Error(`${basename(rootFile)} is not named as a release root (NAME-X.Y.Z-x86_64-<sha256>.tar.zst)`);
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

const wasm = deployment ? strip(readFileSync(translatorWasm)) : null;
const compile = wasm ? wholeTranslator(sods, wasm, aotCache || null) : null;
const deployed = new Map<string, {sha256: string; wasm: DeployedWasm}>();
const modules = new Map<string, DeployedWasm>();
if (deployment) mkdirSync(join(out, 'blobs'), {recursive: true});
const requested = new Set(hot);

// Second pass: the archive waits when all compression slots or their byte
// budget are occupied. Translate each deployed program while its source is
// already in hand, leaving only the blob descriptor for the index.
/** A file's bytes as its pack keeps them: compressed when that is smaller, else raw. */
type Stored = {bytes: Buffer; raw: boolean};
const hotBytes = new Map<string, Buffer>();
const {entries,manifest,packed}=await withCompression(async compress=>{
  const packed = new Map<string, Stored>();
  const {entries,manifest}=await readTarball(rootFile,(e,bytes)=>{
    if (!bytes) return;
    const {path} = e;
    const hotInput = requested.has(path);
    if (hotInput && !deployment) hotBytes.set(path, bytes);
    if (compile && (e.mode & 0o111) && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
      const digest = e.sha256!;
      try {
        let wasm = modules.get(digest);
        if (!wasm) {
          const whole = compile(bytes, digest);
          wasm = framed && whole.length >= FRAMED_MIN_BYTES ? writeFramedAot(out, whole, true) : blob(whole, 6);
          modules.set(digest, wasm);
        }
        deployed.set(path, {sha256: digest, wasm});
      } catch (cause) { throw new Error(`ricebox: could not translate ${path} for deployment`, {cause}); }
    }
    const stored: Stored = {bytes, raw: true};
    packed.set(path, stored); // Archive order, not compression completion order.
    if (bytes.length) return compress(bytes, (bytes, raw) => { stored.bytes = bytes; stored.raw = raw; }, deployment || !hotInput);
  });
  if (!deployment) {
    if (!chosenHot) for (let i = hot.length - 1; i >= 0; i--) if (!hotBytes.has(hot[i])) hot.splice(i, 1);
    for (const p of hot) if (!hotBytes.has(p)) throw new Error(`${p} is not a file of this root`);
  }
  return {entries,manifest,packed};
});
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
    const {bytes, raw} = s;
    let pack = packs.get(who);
    if (!pack) { pack = []; packs.set(who, pack); }
    // An empty file stores nothing, and has no line of its pack's table.
    const pl: Place = {who, entry: bytes.length ? pack.push(bytes) - 1 : -1, len: bytes.length, raw};
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
function blob(bytes: Uint8Array, level = 9): Blob {
  const gz = gzipSync(bytes, {level});
  const sha = sha256(gz);
  const path = `blobs/${sha}.bin`;
  if (!existsSync(join(out, path))) writeFileSync(join(out, path), gz);
  return {path, sha256: sha, size: gz.length, bytes: bytes.length};
}


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
const support = wasm ?? strip(readFileSync(translatorWasm));
const translator = {name: 'sods', version: crate(join(repo, 'ricebox/sods/Cargo.toml')), wasm: sha256(support), ...blob(support)};
// Each hot program translated whole by the native build of the same translator (it gives the bytes the wasm one
// does): what it reaches only through a pointer (BusyBox's applets and its shell's builtins) is there from its first
// run, not translated as it runs.
const translations: Index['translations'] = [];
const translateHot = hotBytes.size ? wholeTranslator(sods, support, aotCache || null) : null;
for (const path of deployment ? [] : hot) {
  const bytes = hotBytes.get(path) ?? Buffer.alloc(0);
  const made = translateHot!(bytes);
  const translation: Index['translations'][number] = {path, sha256: sha256(bytes), elf: blob(bytes), wasm: blob(made)};
  // Bind the same captured hot bytes to their exact placed canonical file. This
  // additive descriptor leaves the established ELF/Wasm blob format unchanged.
  const source = canonicalExecutableSource({packs: packList, files}, translation);
  translation.association = {version: 1, origin: source.origin, sourceSha256: source.sha256, sourceBytes: bytes.length, mode: 'whole'};
  translations.push(translation);
}

let execution: WebExecution | undefined;
if (compile) {
  const maker = readFileSync(makerInput ?? buildMuk());
  const made = maker.length >= 8 && maker.readUInt32LE(0) === 0x6d736100 ? maker : compile(maker);
  const programs = deployed.size ? canonicalPackedFileSet({packs: packList, files}, [...deployed.keys()]).map(source => {
    const code = deployed.get(source.path)!;
    return {path: source.path, ...code, association: {version: 1 as const, origin: source.origin, sourceSha256: code.sha256, sourceBytes: source.size, mode: 'whole' as const}};
  }) : [];
  execution = {maker: writeMuk(out, made), programs};
}

const index: Index = {
  name: release.NAME ?? 'ricebox', version, sha256: rootSha, codec: 'zstd',
  packs: packList,
  dirs: entries.filter((e) => e.type === 'dir').map((e) => ({path: e.path, mode: e.mode})),
  links: entries.filter((e) => e.type === 'link').map((e) => ({path: e.path, target: e.target ?? ''})),
  files, translator, translations, ...(execution ? {execution} : {}),
};
const json = Buffer.from(JSON.stringify(index));
const indexSha = sha256(json);
const indexPath = `index-${indexSha}.json`;
writeFileSync(join(out, indexPath), json);
const profile = /^base\.profile=(.*)$/m.exec(manifest ?? '')?.[1] ?? '';
const about = {
  name: distributionName || index.name, version, sha256: rootSha, bytes: statSync(rootFile).size, file: basename(rootFile),
  root: {name: index.name, profile},
  index: {path: indexPath, sha256: indexSha, size: json.length},
  translator: {name: translator.name, version: translator.version},
};
writeFileSync(join(out, 'webroot.json'), `${JSON.stringify(about, null, 2)}\n`);

// Artifacts a previous distribution left here, and this one does not name, go (only names this script makes).
const keep = new Set([indexPath, 'webroot.json', ...packList.map((p) => `packs/${p.name}`), translator.path,
  ...translations.flatMap(t => [t.elf.path, t.wasm.path]),
  ...(execution ? [execution.maker.path, ...execution.programs.flatMap(t => aotObjects(t.wasm).map(asset => asset.path))] : [])]);
for (const f of readdirSync(out)) if (/^index-[0-9a-f]{64}\.json$/.test(f) && !keep.has(f)) rmSync(join(out, f));
for (const [dir, re] of [['packs', /^[0-9a-f]{64}\.pack$/], ['blobs', /^[0-9a-f]{64}\.bin$/]] as const) {
  for (const f of readdirSync(join(out, dir))) if (re.test(f) && !keep.has(`${dir}/${f}`)) rmSync(join(out, dir, f));
}
const total = packList.reduce((n, p) => n + p.bytes, 0);
const code = execution ? `${execution.programs.length} deployed programs` : translations.map(t => `${t.path} ${t.elf.size}+${t.wasm.size}`).join(', ');
console.log(`${about.name} ${version} (root sha256 ${rootSha.slice(0, 12)}…): ${packList.length} packs ${total} bytes, ${files.length} files, ${index.dirs.length} dirs, ${index.links.length} links; translator ${translator.size} bytes; ${code}; index ${indexPath} ${json.length} bytes`);

