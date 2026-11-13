#!/usr/bin/env node
// node runtime/run.ts [--root DIR] [--cwd DIR] [--tty] PROGRAM [args...]
//
// Run a static x86-64 program translated by sods, on node. PROGRAM is a host path
// (placed at /bin/<name>) or, with --root, a path inside that tree (a root unpacked).
// stdin/stdout/stderr attach to this process. A root still in its layers is run by
// what reads layers (ricebox: scripts/webroot-runnable.ts), over the same linux.ts.
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync, writeSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {File, Link, Vfs} from './linux/fs.ts';
import {PROFILE, type Translator} from './linux/process.ts';
import {linux} from './linux.ts';
import {NotAProgram, loadTranslator} from './translation/translator.ts';
import {steady} from './host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const translator = join(here, '..', 'target', 'release', 'sods');
const wasmTranslator = join(here, '..', 'target', 'wasm32-unknown-unknown', 'release', 'sods.wasm');

// SODS_BLOCKS=1: translate with --trace, so every block entered is reported (process.ts prints it).
const traced = process.env.SODS_BLOCKS ? ['--trace'] : [];
// SODS_RUN=N: functions cut into runs of N blocks (sods' layout.rs RUN), so the cut is tested on small programs.
const cut = process.env.SODS_RUN ? [`--run=${process.env.SODS_RUN}`] : [];

// The translator built as wasm, run in this process as the browser runs
// it, when it is built from the same source as the native one (or newer):
// code reached later is then translated here, from the ELF it holds parsed,
// with no process or file per function. Modules from two builds never mix.
const mtime = (f: string): number => (existsSync(f) ? statSync(f).mtimeMs : -1);
const inProcess = !traced.length && mtime(wasmTranslator) >= mtime(translator) ? await loadTranslator(readFileSync(wasmTranslator)) : null;

// Cached translations are keyed by the translator too, so rebuilding it
// never reuses modules made by an older one.
const fileDigest = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const translatorId = fileDigest(inProcess ? wasmTranslator : translator);

// Each translator's translations in a folder of its own, named by its digest. A translator rebuilt starts a new
// one, and then the folders of translators no longer built (neither the native one's nor the wasm one's) go: an
// older translator's modules are never read again.
const cacheRoot = join(here, '..', 'target', 'sods-cache');
const cacheDir = join(cacheRoot, translatorId);
if (!existsSync(cacheDir)) {
  const built = new Set([translator, wasmTranslator].filter(existsSync).map(fileDigest));
  for (const name of existsSync(cacheRoot) ? readdirSync(cacheRoot) : []) {
    if (!built.has(name)) rmSync(join(cacheRoot, name), {recursive: true, force: true});
  }
  mkdirSync(cacheDir, {recursive: true});
}

// Each program's digest, taken once however often its code is asked for.
const digests = new WeakMap<Uint8Array, string>();
const digest = (bytes: Uint8Array): string => {
  let d = digests.get(bytes);
  if (!d) digests.set(bytes, d = createHash('sha256').update(bytes).digest('hex'));
  return d;
};

const translate: Translator = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const key = createHash('sha256').update(translatorId).update([...traced, ...cut].join()).update(digest(bytes)).digest('hex');
  const wasm = join(cacheDir, key + '.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    if (inProcess) writeFileSync(wasm, inProcess(bytes));
    else {
      const elf = join(cacheDir, key + '.elf');
      writeFileSync(elf, bytes);
      // (Its exit status 8: no program it takes, as it read it. The file's fault, as the wasm translator's NotAProgram.)
      const done = spawnSync(translator, [...traced, ...cut, elf, wasm], {stdio: ['ignore', 'ignore', 'pipe']});
      if (done.status === 8) throw new NotAProgram(done.stderr.toString().trim());
      if (done.status !== 0) throw new Error(`sods failed: ${done.stderr}`);
    }
  }
  return new Uint8Array(readFileSync(wasm));
};
// This runner assembles the translator and the kernel: only it knows the translator's rejection type.
translate.notProgram = (error: unknown): boolean => error instanceof NotAProgram;

/** The program with the code it reached later (from the function starts `seeds`), as one module. */
translate.seeded = inProcess ? inProcess.seeded : function seeded(bytes: Uint8Array, seeds: (bigint | number)[]): Uint8Array<ArrayBuffer> {
  const key = createHash('sha256').update(translatorId).update([...traced, ...cut].join()).update(digest(bytes)).update(`seeded|${seeds}`).digest('hex');
  const wasm = join(cacheDir, key + '.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    const elf = join(cacheDir, digest(bytes) + '.elf');
    if (!existsSync(elf)) writeFileSync(elf, bytes);
    writeFileSync(`${wasm}.seeds`, seeds.join('\n'));
    execFileSync(translator, [...traced, ...cut, `--seeds=${wasm}.seeds`, elf, wasm], {stdio: ['ignore', 'ignore', 'ignore']});
  }
  return new Uint8Array(readFileSync(wasm));
};

/** Code reached later, from `seeds` past the `known` starts, filling table slots from `base`. */
// What the translator keeps, and giving it back (Kernel.free), when it runs here.
if (inProcess) Object.assign(translate, {held: inProcess.held, spare: inProcess.spare, close: inProcess.close, renew: inProcess.renew});

translate.more = inProcess ? inProcess.more : function more(bytes: Uint8Array, seeds: (bigint | number)[], starts: Set<bigint>, base: number): Uint8Array<ArrayBuffer> {
  const known = [...starts];
  const key = createHash('sha256').update(translatorId).update([...traced, ...cut].join()).update(digest(bytes)).update(`${seeds}|${known}|${base}`).digest('hex');
  const wasm = join(cacheDir, key + '.more.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    const elf = join(cacheDir, digest(bytes) + '.elf');
    if (!existsSync(elf)) writeFileSync(elf, bytes);
    writeFileSync(`${wasm}.seeds`, seeds.join('\n'));
    writeFileSync(`${wasm}.known`, known.join('\n'));
    const done = spawnSync(translator, [...traced, ...cut, `--more=${wasm}.seeds`, `--known=${wasm}.known`, `--base=${base}`, elf, wasm], {stdio: ['ignore', 'ignore', 'pipe']});
    if (done.status !== 0) throw new Error(`sods --more failed: ${done.stderr}`);
    const report = done.stderr.toString();
    // SODS_UNSUPPORTED=1: say which instructions code reached later uses that are not translated yet.
    if (process.env.SODS_UNSUPPORTED && !report.includes('"unsupported":{}')) process.stderr.write(`sods: at ${seeds}: ${report.trim()}\n`);
  }
  return new Uint8Array(readFileSync(wasm));
};

/** Mirror a host tree into the VFS; file contents load on first read. */
function mount(vfs: Vfs, host: string, at: string): void {
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
let root: string | null = null, cwd = '/root', tty = false;
while (args[0]?.startsWith('--')) {
  const flag = args.shift();
  if (flag === '--root') root = args.shift() ?? null;
  else if (flag === '--cwd') cwd = args.shift() ?? cwd;
  // Its console a terminal, 80 by 24, as a Prompt has it: what reads keys reads them from one.
  else if (flag === '--tty') tty = true;
}
const [program = '', ...rest] = args;
const vfs = new Vfs();
if (root) mount(vfs, root, '/');
let path = program;
if (!root) {
  path = '/bin/' + basename(program);
  vfs.writeFile(path, new Uint8Array(readFileSync(program)), 0o755);
}
vfs.mkdirp(cwd);

let stdin = new Uint8Array(0), stdinAt = 0;
try { if (!process.stdin.isTTY) stdin = new Uint8Array(readFileSync(0)); } catch { /* no input */ }
// Each thread in a Worker of its own, as a cross-origin isolated page runs them; SODS_INLINE=1: all here, in turn.
const kernel = linux({
  vfs,
  translate,
  // The x87 is the translator's wasm's (x87.ts), whichever build translates.
  x87: inProcess?.module ?? (existsSync(wasmTranslator) ? new WebAssembly.Module(readFileSync(wasmTranslator)) : undefined),
  console: {
    interactive: tty,
    screen: tty, cols: 80, rows: 24,
    // At once, not when this thread next idles: a sleep here holds it, and what was said before must show before.
    write: (fd: number, bytes: Uint8Array) => { for (let at = 0; at < bytes.length;) { try { at += writeSync(fd === 2 ? 2 : 1, bytes, at); } catch (e) { if ((e as {code?: string}).code !== 'EAGAIN') throw e; } } },
    read: (n: number) => { const out = stdin.subarray(stdinAt, stdinAt + n); stdinAt += out.length; return out; },
  },
});
const started = steady();
const status = await kernel.spawn(path, [path, ...rest], ['HOME=/root', 'PATH=/bin:/usr/bin', 'LANG=C.UTF-8', 'TERM=dumb'], cwd);
if (process.env.SODS_TIMING) {
  // What the run still holds once its programs have ended (after a collection, when node allows one).
  globalThis.gc?.();
  const m = process.memoryUsage(), mb = (n: number): number => Math.round(n / 2 ** 20);
  writeSync(2, JSON.stringify({ms: Math.round(steady() - started), ...PROFILE, translate: Math.round(PROFILE.translate), compile: Math.round(PROFILE.compile),
    heldMB: {rss: mb(m.rss), heap: mb(m.heapUsed), buffers: mb(m.arrayBuffers), external: mb(m.external)},
    kernelMB: Object.fromEntries(Object.entries(kernel.held()).map(([k, v]) => [k, mb(v)]))}) + '\n');
  // SODS_FREE=1: then give back all that can go, and say what the host shows.
  if (process.env.SODS_FREE) {
    const r = kernel.free(0);
    globalThis.gc?.();
    const n = process.memoryUsage();
    writeSync(2, JSON.stringify({freedMB: mb(r.before.total - r.after.total), kernelAfterMB: Object.fromEntries(Object.entries(r.after).map(([k, v]) => [k, mb(v)])), hostAfterMB: {rss: mb(n.rss), external: mb(n.external)}}) + '\n');
  }
}
// Ended once the run has: V8 may still be optimizing the hottest translated code in the background (a second and
// more after a compiler's run), and node would wait for that before it left. Everything said was written at once.
process.exit(status & 0x7f ? 128 + (status & 0x7f) : status >> 8);
