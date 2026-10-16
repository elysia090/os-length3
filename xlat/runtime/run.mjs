#!/usr/bin/env node
// node runtime/run.mjs [--root DIR] [--cwd DIR] PROGRAM [args...]
//
// Run a static x86-64 program translated by xlat. PROGRAM is a host path
// (placed at /bin/<name>) or, with --root, a path inside that tree.
// stdin/stdout/stderr attach to this process.
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Dir, File, Link, Vfs} from './fs.mjs';
import {Kernel} from './process.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const translator = join(here, '..', 'target', 'release', 'xlat');
const cacheDir = join(here, '..', 'target', 'xlat-cache');

// Cached translations are keyed by the translator too, so rebuilding it
// never reuses modules made by an older one.
const translatorId = createHash('sha256').update(readFileSync(translator)).digest('hex');

function translate(bytes) {
  const key = createHash('sha256').update(translatorId).update(bytes).digest('hex');
  const wasm = join(cacheDir, key + '.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    const elf = join(cacheDir, key + '.elf');
    writeFileSync(elf, bytes);
    execFileSync(translator, [elf, wasm], {stdio: ['ignore', 'ignore', 'ignore']});
  }
  return readFileSync(wasm);
}

/** Code reached later, from `seeds` past the `known` starts, filling table slots from `base`. */
translate.more = function more(bytes, seeds, known, base) {
  const key = createHash('sha256').update(translatorId).update(bytes).update(`${seeds}|${known}|${base}`).digest('hex');
  const wasm = join(cacheDir, key + '.more.wasm');
  if (!existsSync(wasm)) {
    mkdirSync(cacheDir, {recursive: true});
    const elf = join(cacheDir, createHash('sha256').update(bytes).digest('hex') + '.elf');
    if (!existsSync(elf)) writeFileSync(elf, bytes);
    writeFileSync(`${wasm}.seeds`, seeds.join('\n'));
    writeFileSync(`${wasm}.known`, known.join('\n'));
    const done = spawnSync(translator, [`--more=${wasm}.seeds`, `--known=${wasm}.known`, `--base=${base}`, elf, wasm], {stdio: ['ignore', 'ignore', 'pipe']});
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
let root = null, cwd = '/root';
while (args[0]?.startsWith('--')) {
  const flag = args.shift();
  if (flag === '--root') root = args.shift();
  else if (flag === '--cwd') cwd = args.shift();
}
const [program, ...rest] = args;
const vfs = new Vfs();
if (root) mount(vfs, root, '/');
let path = program;
if (!root) {
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
    write: (fd, bytes) => (fd === 2 ? process.stderr : process.stdout).write(bytes),
    read: (n) => { const out = stdin.subarray(stdinAt, stdinAt + n); stdinAt += out.length; return out; },
  },
});
const started = performance.now();
const status = kernel.spawn(path, [path, ...rest], ['HOME=/root', 'PATH=/bin:/usr/bin', 'LANG=C.UTF-8', 'TERM=dumb'], cwd);
if (process.env.XLAT_TIMING) process.stderr.write(JSON.stringify({ms: performance.now() - started}) + '\n');
process.exitCode = status & 0x7f ? 128 + (status & 0x7f) : status >> 8;
