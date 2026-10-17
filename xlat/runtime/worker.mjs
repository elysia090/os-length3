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
// Nothing blocks: a read with no input yet stops the kernel (the syscall
// restarts later), and each input message runs it again.
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
import {loadTranslator} from './translator.mjs';
import {said} from './waiting.mjs';

let kernel = null;
let mirror = null;
const pending = [];
let ended = false;

function read(n) {
  if (!pending.length) return ended ? new Uint8Array(0) : null;
  const head = pending[0];
  if (head.length <= n) { pending.shift(); return head; }
  pending[0] = head.subarray(n);
  return head.subarray(0, n);
}

let waking;
function pump() {
  try {
    const r = kernel.pump();
    const c = mirror?.changes();
    if (c) self.postMessage({type: 'changes', ...c}, c.files.map((f) => f.bytes.buffer));
    const m = said(r, kernel.held(), performance.now());
    self.postMessage(m);
    // A process that sleeps goes on when its time comes, input or not.
    clearTimeout(waking);
    if (m.for === 'time') waking = setTimeout(pump, m.ms);
  } catch (e) {
    self.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
  }
}

self.onmessage = async ({data}) => {
  if (data.type === 'input') { pending.push(data.bytes); if (kernel) pump(); return; }
  if (data.type === 'eof') { ended = true; if (kernel) pump(); return; }
  if (data.type === 'interrupt') { pending.length = 0; if (kernel?.interrupt()) pump(); return; }
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
    kernel = new Kernel({
      vfs,
      translate,
      console: {
        interactive: false,
        write: (fd, bytes) => self.postMessage({type: 'output', fd, bytes}, [bytes.buffer]),
        read,
        ready: () => pending.length > 0 || ended,
      },
    });
    for (const f of data.files) if (f.module) kernel.prebuilt(vfs.lookup(f.path, '/'), f.module);
    if (data.mirror) mirror = new Mirror(vfs, data.mirror);
    kernel.start(data.argv[0], data.argv, data.env, data.cwd);
  } catch (e) {
    self.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
    return;
  }
  pump();
};
