#!/usr/bin/env node
// node runtime/run.mjs [--root DIR | --pack DIR] [--cwd DIR] PROGRAM [args...]
//
// Run a static x86-64 program translated by xlat. PROGRAM is a host path
// (placed at /bin/<name>) or, with --root, a path inside that tree; --pack
// mounts a web root (root.json and its packs, scripts/webroot.mjs) as the
// browser does, each file read from the pack when first opened.
// stdin/stdout/stderr attach to this process.
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync, writeFileSync, writeSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';
import {Dir, File, Link, Vfs} from './fs.mjs';
import {mountPack} from './pack.mjs';
import {Kernel, PROFILE} from './process.mjs';
import {loadTranslator} from './translator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const translator = join(here, '..', 'target', 'release', 'xlat');
const wasmTranslator = join(here, '..', 'target', 'wasm32-unknown-unknown', 'release', 'xlat.wasm');
const cacheDir = join(here, '..', 'target', 'xlat-cache');

// XLAT_BLOCKS=1: translate with --trace, so every block entered is reported (process.mjs prints it).
const traced = process.env.XLAT_BLOCKS ? ['--trace'] : [];

// The translator built as wasm, run in this process as the browser runs
// it, when it is built from the same source as the native one (or newer):
// code reached later is then translated here, from the ELF it holds parsed,
// with no process or file per function. Modules from two builds never mix.
const mtime = (f) => (existsSync(f) ? statSync(f).mtimeMs : -1);
const inProcess = !traced.length && mtime(wasmTranslator) >= mtime(translator) ? await loadTranslator(readFileSync(wasmTranslator)) : null;

// Cached translations are keyed by the translator too, so rebuilding it
// never reuses modules made by an older one.
const translatorId = createHash('sha256').update(readFileSync(inProcess ? wasmTranslator : translator)).digest('hex');

// Each program's digest, taken once however often its code is asked for.
const digests = new WeakMap();
const digest = (bytes) => {
  if (!digests.has(bytes)) digests.set(bytes, createHash('sha256').update(bytes).digest('hex'));
  return digests.get(bytes);
};

function translate(bytes) {
  const key = createHash('sha256').update(translatorId).update(traced.join()).update(digest(bytes)).digest('hex');
  const wasm = join(cacheDir, key + '.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    if (inProcess) writeFileSync(wasm, inProcess(bytes));
    else {
      const elf = join(cacheDir, key + '.elf');
      writeFileSync(elf, bytes);
      execFileSync(translator, [...traced, elf, wasm], {stdio: ['ignore', 'ignore', 'ignore']});
    }
  }
  return readFileSync(wasm);
}

/** Code reached later, from `seeds` past the `known` starts, filling table slots from `base`. */
// What the translator keeps, and giving it back (Kernel.free), when it runs here.
if (inProcess) Object.assign(translate, {held: inProcess.held, spare: inProcess.spare, close: inProcess.close, renew: inProcess.renew});

translate.more = inProcess ? inProcess.more : function more(bytes, seeds, starts, base) {
  const known = [...starts];
  const key = createHash('sha256').update(translatorId).update(traced.join()).update(digest(bytes)).update(`${seeds}|${known}|${base}`).digest('hex');
  const wasm = join(cacheDir, key + '.more.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    const elf = join(cacheDir, digest(bytes) + '.elf');
    if (!existsSync(elf)) writeFileSync(elf, bytes);
    writeFileSync(`${wasm}.seeds`, seeds.join('\n'));
    writeFileSync(`${wasm}.known`, known.join('\n'));
    const done = spawnSync(translator, [...traced, `--more=${wasm}.seeds`, `--known=${wasm}.known`, `--base=${base}`, elf, wasm], {stdio: ['ignore', 'ignore', 'pipe']});
    if (done.status !== 0) throw new Error(`xlat --more failed: ${done.stderr}`);
    const report = done.stderr.toString();
    // XLAT_UNSUPPORTED=1: say which instructions code reached later uses that are not translated yet.
    if (process.env.XLAT_UNSUPPORTED && !report.includes('"unsupported":{}')) process.stderr.write(`xlat: at ${seeds}: ${report.trim()}\n`);
  }
  return readFileSync(wasm);
};

/** Mirror a host tree into the VFS; file contents load on first read. */
function mount(vfs, host, at) {
  const dir = vfs.mkdirp(at);
  for (const name of readdirSync(host)) {
    const full = join(host, name), st = lstatSync(full);
    if (st.isSymbolicLink()) dir.entries.set(name, new Link(readlinkSync(full)));
    else if (st.isDirectory()) { mount(vfs, full, join(at, name)); }
    else if (st.isFile()) {
      const file = new File(new Uint8Array(0), st.mode & 0o7777, () => new Uint8Array(readFileSync(full)));
      file.size = st.size;
      dir.entries.set(name, file);
    }
  }
}

const args = process.argv.slice(2);
let root = null, pack = null, cwd = '/root';
while (args[0]?.startsWith('--')) {
  const flag = args.shift();
  if (flag === '--root') root = args.shift();
  else if (flag === '--pack') pack = args.shift();
  else if (flag === '--cwd') cwd = args.shift();
}
const [program, ...rest] = args;
const vfs = new Vfs();
if (root) mount(vfs, root, '/');
if (pack) {
  const index = JSON.parse(readFileSync(join(pack, 'root.json'), 'utf8'));
  const fds = new Map();
  const fd = (name) => { if (!fds.has(name)) fds.set(name, openSync(join(pack, 'packs', name), 'r')); return fds.get(name); };
  mountPack(vfs, index, (name, at, len) => { const b = new Uint8Array(len); readSync(fd(name), b, 0, len, at); PROFILE.fetches++; PROFILE.fetched += len; return b; },
    (bytes) => new Uint8Array(zstdDecompressSync(bytes)));
  process.on('exit', () => { for (const f of fds.values()) closeSync(f); });
}
let path = program;
if (!root && !pack) {
  path = '/bin/' + basename(program);
  vfs.writeFile(path, new Uint8Array(readFileSync(program)), 0o755);
}
vfs.mkdirp(cwd);

let stdin = new Uint8Array(0), stdinAt = 0;
try { if (!process.stdin.isTTY) stdin = new Uint8Array(readFileSync(0)); } catch {}
const kernel = new Kernel({
  vfs,
  translate,
  console: {
    interactive: false,
    // At once, not when this thread next idles: a sleep here holds it, and what was said before must show before.
    write: (fd, bytes) => { for (let at = 0; at < bytes.length;) { try { at += writeSync(fd === 2 ? 2 : 1, bytes, at); } catch (e) { if (e.code !== "EAGAIN") throw e; } } },
    read: (n) => { const out = stdin.subarray(stdinAt, stdinAt + n); stdinAt += out.length; return out; },
  },
});
const started = performance.now();
const status = kernel.spawn(path, [path, ...rest], ['HOME=/root', 'PATH=/bin:/usr/bin', 'LANG=C.UTF-8', 'TERM=dumb'], cwd);
if (process.env.XLAT_TIMING) {
  // What the run still holds once its programs have ended (after a collection, when node allows one).
  globalThis.gc?.();
  const m = process.memoryUsage(), mb = (n) => Math.round(n / 2 ** 20);
  process.stderr.write(JSON.stringify({ms: Math.round(performance.now() - started), ...PROFILE, translate: Math.round(PROFILE.translate), compile: Math.round(PROFILE.compile),
    heldMB: {rss: mb(m.rss), heap: mb(m.heapUsed), buffers: mb(m.arrayBuffers), external: mb(m.external)},
    kernelMB: Object.fromEntries(Object.entries(kernel.held()).map(([k, v]) => [k, mb(v)]))}) + '\n');
  // XLAT_FREE=1: then give back all that can go, and say what the host shows.
  if (process.env.XLAT_FREE) {
    const r = kernel.free(0);
    globalThis.gc?.();
    const n = process.memoryUsage();
    process.stderr.write(JSON.stringify({freedMB: mb(r.before.total - r.after.total), kernelAfterMB: Object.fromEntries(Object.entries(r.after).map(([k, v]) => [k, mb(v)])), hostAfterMB: {rss: mb(n.rss), external: mb(n.external)}}) + '\n');
  }
}
process.exitCode = status & 0x7f ? 128 + (status & 0x7f) : status >> 8;
