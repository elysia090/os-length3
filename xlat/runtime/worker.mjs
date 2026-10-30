// A kernel in a Worker. The page posts
//   {type: 'start', translator, files: [{path, bytes, mode}], dirs: [path],
//    links: [{path, target}], argv, env, cwd}
// (`translator` and a file's optional `module`, its translation made ahead
// of time, may be compiled WebAssembly.Modules, shared between workers.)
// then {type: 'input', bytes} as the person types and {type: 'eof'}, and
// {type: 'interrupt'} for Ctrl-C: what was typed and not read yet is
// dropped, and what runs in front of the shell ends (Kernel.interrupt).
// It receives {type: 'output', fd, bytes}, {type: 'waiting', for, ms,
// memory, held}, {type: 'exit', status} or {type: 'error', message}. A
// kernel waits `for` 'input' (what runs reads what is typed) or 'time' (it
// sleeps, and goes on by itself in `ms` milliseconds; waiting.mjs). `memory` is all the
// kernel holds, and `held` the same by kind (Kernel.held: guest,
// translations, translator, files, and what of it can go now, spare).
// {type: 'free'} gives back all that can go without stopping anything and
// answers {type: 'freed', before, after}; a program that ends gives back
// what is past the kernel's budget on its own.
//
// Where the page is cross-origin isolated, every guest thread runs in a
// Worker of its own (remote.mjs) and the kernel serves them from here;
// otherwise they take turns here, and each input message runs them again.
// It says {type: 'threads', apart} once started.
//
// With `mirror: '/root/<repo>'` in 'start', what the guest changes there is
// sent after each run as {type: 'changes', dirs, files, removed} (see
// mirror.mjs), and {type: 'put', path, what} puts an outside change in.
//
// With `root: {index, url}` in 'start', the whole root (packs and their
// index, pack.mjs) fills in around the files given: each file of it is
// fetched from the packs under `url` when a program first reads it.
//
// A file given with its translation (`module`) may come with `more`: the code
// an earlier run of it reached later, as that run made it ([{module, bytes,
// base}], in order; Image.adopt), so it is not translated again here. What
// this run reaches later of such a program is said once the kernel pauses, as
// {type: 'more', path, from, more: [{module, bytes, base}]}: the modules from
// the `from`th on, for the page to keep and give the next Prompt.
//
// {type: 'warm'}, before 'start' (sent as soon as the Worker is made, while
// what 'start' needs is still being fetched): the Workers the first threads
// will run in are started now, so they are up when the shell starts.
//
// Every other program of the root is translated when it is first run; with
// `kept: {cache, at: {[origin]: {main, more}}}` in 'start', a program whose
// translation an earlier Prompt made is read from that Cache Storage instead
// (by its file's origin, pack.mjs: the URLs of its translation and of the
// code it reached later, keeper.mjs), and the exec waits only for that read.
// What is translated here of a root file is said once the kernel pauses, for
// the page to keep: {type: 'translated', origin, wasm, segments} once, then
// {type: 'reached', origin, from, more} as code is reached later; and what
// was read of what is kept, {type: 'used', urls}, for the page to count.

import {Vfs} from './fs.mjs';
import {Mirror} from './mirror.mjs';
import {mountPack, syncRange} from './pack.mjs';
import {Kernel} from './process.mjs';
import {RemoteKernel, canRunApart, warmThreads} from './remote.mjs';
import {keeper} from './keeper.mjs';
import {loadTranslator} from './translator.mjs';
import {said} from './waiting.mjs';

let kernel = null;
let mirror = null;
let apart = false;
const pending = [];
let ended = false;
/** The programs given with their translation: the image of each, and how much of its code reached later is said. */
const kept = [];
/** Translations kept from earlier Prompts (keeper.mjs), when the page has any. */
let keep = null;

function read(n) {
  if (!pending.length) return ended ? new Uint8Array(0) : null;
  const head = pending[0];
  if (head.length <= n) { pending.shift(); return head; }
  pending[0] = head.subarray(n);
  return head.subarray(0, n);
}

const failed = (e) => self.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});

/** The kernel paused (here: every thread waits or it ended, `r` as pump says): what the shell changed, and why it waits. */
function paused(r) {
  const c = mirror?.changes();
  if (c) self.postMessage({type: 'changes', ...c}, c.files.filter((f) => f.bytes).map((f) => f.bytes.buffer));
  // Code reached later since it was last said, for the page to keep (each module's bytes copied: the image keeps its own).
  for (const k of kept) {
    const x = k.image.extras;
    if (x.length <= k.told) continue;
    const more = x.slice(k.told).map((e) => ({module: e.module, bytes: e.bytes.slice(), base: e.base}));
    self.postMessage({type: 'more', path: k.path, from: k.told, more}, more.map((m) => m.bytes.buffer));
    k.told = x.length;
  }
  // What was translated here of the root's programs, and the code they reached later since it was said.
  for (const e of kernel.images.values()) {
    const im = e.image;
    if (!im.origin || e.kept) continue;
    if (!im.mainTold && im.wasm) {
      const wasm = im.wasm;
      im.wasm = null;
      im.mainTold = true;
      const segments = im.segments ? im.segments.map((s) => ({offset: s.offset, bytes: s.bytes.slice()})) : null;
      self.postMessage({type: 'translated', origin: im.origin, wasm, segments}, [wasm.buffer, ...(segments ?? []).map((s) => s.bytes.buffer)]);
    }
    if (im.mainTold && im.extras.length > im.told) {
      const more = im.extras.slice(im.told).map((x) => ({module: x.module, bytes: x.bytes.slice(), base: x.base}));
      self.postMessage({type: 'reached', origin: im.origin, from: im.told, more}, more.map((m) => m.bytes.buffer));
      im.told = im.extras.length;
    }
  }
  const m = said(r, kernel.held(), performance.now(), (keep?.reading() ?? 0) > 0);
  self.postMessage(m);
  return m;
}

let waking;
/** Threads in turn here: run until they all wait, then again for input or when a sleep ends. */
function pump() {
  try {
    const m = paused(kernel.pump());
    // A process that sleeps goes on when its time comes, input or not.
    clearTimeout(waking);
    if (m.for === 'time') waking = setTimeout(pump, m.ms);
  } catch (e) {
    failed(e);
  }
}

/** Something came from outside (input, Ctrl-C): the kernel looks again. */
const nudge = () => { if (!kernel) return; if (apart) kernel.kick(); else pump(); };

self.onmessage = async ({data}) => {
  if (data.type === 'input') { pending.push(data.bytes); nudge(); return; }
  if (data.type === 'eof') { ended = true; nudge(); return; }
  if (data.type === 'interrupt') { pending.length = 0; if (kernel?.interrupt()) nudge(); return; }
  if (data.type === 'put') { mirror?.put(data.path, data.what); return; }
  if (data.type === 'free') { if (kernel) self.postMessage({type: 'freed', ...kernel.free(0)}); return; }
  if (data.type === 'warm') { if (canRunApart()) warmThreads(); return; }
  if (data.type !== 'start') return;
  try {
    const translate = await loadTranslator(data.translator);
    const vfs = new Vfs();
    for (const d of data.dirs ?? []) vfs.mkdirp(d);
    for (const f of data.files) vfs.writeFile(f.path, f.bytes, f.mode ?? 0o644);
    for (const l of data.links ?? []) vfs.symlink(l.target, l.path);
    // The root after the files given, so what was given (l3, its BusyBox) is what runs.
    if (data.root) mountPack(vfs, data.root.index, syncRange(data.root.url), translate.unzstd);
    vfs.mkdirp(data.cwd);
    // Each thread in a Worker of its own, all at once, where memory can be shared and every ready translation was made
    // for shared memory; otherwise they take turns here.
    apart = canRunApart() && data.files.every((f) => !f.module || f.shared);
    const console = {
      interactive: false,
      write: (fd, bytes) => self.postMessage({type: 'output', fd, bytes}, [bytes.buffer]),
      read,
      ready: () => pending.length > 0 || ended,
      pending: () => pending.reduce((n, b) => n + b.length, 0),
    };
    // Translations kept from earlier Prompts: read when their program is first run, the kernel looking again once they are.
    keep = data.kept ? keeper(data.kept, () => nudge(), (urls) => self.postMessage({type: 'used', urls})) : null;
    kernel = apart ? new RemoteKernel({vfs, translate, console, keeper: keep, onIdle: (r) => paused(r)}) : new Kernel({vfs, translate, console, keeper: keep});
    for (const f of data.files) {
      if (!f.module) continue;
      const node = vfs.lookup(f.path, '/');
      kernel.prebuilt(node, f.module, f.segments ?? null);
      const image = kernel.images.get(node).image;
      kept.push({path: f.path, image, told: f.more?.length ? image.adopt(f.more) : 0});
    }
    if (data.mirror) mirror = new Mirror(vfs, data.mirror);
    kernel.start(data.argv[0], data.argv, data.env, data.cwd);
    self.postMessage({type: 'threads', apart});
  } catch (e) {
    failed(e);
    return;
  }
  if (apart) kernel.serve().catch(failed); else pump();
};
