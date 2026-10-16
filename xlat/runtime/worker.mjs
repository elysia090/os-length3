// A kernel in a Worker. The page posts
//   {type: 'start', translator, files: [{path, bytes, mode}], dirs: [path],
//    links: [{path, target}], argv, env, cwd}
// then {type: 'input', bytes} as the person types and {type: 'eof'}.
// It receives {type: 'output', fd, bytes}, {type: 'waiting'},
// {type: 'exit', status} or {type: 'error', message}.
//
// Nothing blocks: a read with no input yet stops the kernel (the syscall
// restarts later), and each input message runs it again.
//
// With `mirror: '/root/<repo>'` in 'start', what the guest changes there is
// sent after each run as {type: 'changes', dirs, files, removed} (see
// mirror.mjs), and {type: 'put', path, what} puts an outside change in.

import {Vfs} from './fs.mjs';
import {Mirror} from './mirror.mjs';
import {Kernel} from './process.mjs';
import {loadTranslator} from './translator.mjs';

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

function pump() {
  try {
    const r = kernel.pump();
    const c = mirror?.changes();
    if (c) self.postMessage({type: 'changes', ...c}, c.files.map((f) => f.bytes.buffer));
    self.postMessage(r.waiting ? {type: 'waiting'} : {type: 'exit', status: r.status});
  } catch (e) {
    self.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
  }
}

self.onmessage = async ({data}) => {
  if (data.type === 'input') { pending.push(data.bytes); if (kernel) pump(); return; }
  if (data.type === 'eof') { ended = true; if (kernel) pump(); return; }
  if (data.type === 'put') { mirror?.put(data.path, data.what); return; }
  if (data.type !== 'start') return;
  try {
    const translate = await loadTranslator(data.translator);
    const vfs = new Vfs();
    for (const d of data.dirs ?? []) vfs.mkdirp(d);
    for (const f of data.files) vfs.writeFile(f.path, f.bytes, f.mode ?? 0o644);
    for (const l of data.links ?? []) vfs.symlink(l.target, l.path);
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
    if (data.mirror) mirror = new Mirror(vfs, data.mirror);
    kernel.start(data.argv[0], data.argv, data.env, data.cwd);
  } catch (e) {
    self.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});
    return;
  }
  pump();
};
