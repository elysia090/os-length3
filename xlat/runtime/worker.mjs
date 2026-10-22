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

import {Vfs} from './fs.mjs';
import {Mirror} from './mirror.mjs';
import {mountPack, syncRange} from './pack.mjs';
import {Kernel} from './process.mjs';
import {RemoteKernel, canRunApart} from './remote.mjs';
import {loadTranslator} from './translator.mjs';
import {said} from './waiting.mjs';

let kernel = null;
let mirror = null;
let apart = false;
const pending = [];
let ended = false;

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
  const m = said(r, kernel.held(), performance.now());
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
    kernel = apart ? new RemoteKernel({vfs, translate, console, onIdle: (r) => paused(r)}) : new Kernel({vfs, translate, console});
    for (const f of data.files) if (f.module) kernel.prebuilt(vfs.lookup(f.path, '/'), f.module, f.segments ?? null);
    if (data.mirror) mirror = new Mirror(vfs, data.mirror);
    kernel.start(data.argv[0], data.argv, data.env, data.cwd);
    self.postMessage({type: 'threads', apart});
  } catch (e) {
    failed(e);
    return;
  }
  if (apart) kernel.serve().catch(failed); else pump();
};
