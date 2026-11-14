// A Prompt's kernel in a Worker: the root (ricebox, its layers mounted), the Linux that runs it (sods: the tree,
// the kernel, what the translator makes and what was kept of it) and the box its programs run in, which muk makes
// here as it does on a Linux machine: the same program, run on this Linux with the bundle the core wrote for it
// (why/core/src/prompt/bundle.rs). Nothing here starts a box's program itself. The repo is kept in step. The page
// (userland.ts promptWorker) posts
//   {type: 'start', translator, muk, files: [{path, bytes, mode}], dirs: [path],
//    links: [{path, target}], box: {config, words}, cwd}
// (`translator` and a file's optional `module`, its translation made ahead
// of time, may be compiled WebAssembly.Modules, shared between workers.)
// then {type: 'input', bytes} as the person types and {type: 'eof'}, and
// {type: 'typing'} while keys are pressed on the page (what is due waits for them to be still), and
// {type: 'interrupt', sig?, flush?} for Ctrl-C (or Ctrl-Z, Ctrl-\\: its signal): what
// was typed and not read yet is dropped, and what runs in front of the shell
// gets the signal (Kernel.interrupt); with `flush` (the page's new epoch), what
// was written and not yet shown is dropped too. Shown as a screen, its console is a
// terminal, and {type: 'tty', iflag, oflag, lflag} says each change in how it
// is set (a program reading each key as it comes clears ICANON).
// It receives {type: 'output', fd, bytes, epoch}, {type: 'waiting', for, ms,
// memory, held}, {type: 'exit', status} or {type: 'error', message}. A
// kernel waits `for` 'input' (what runs reads what is typed) or 'time' (it
// sleeps, and goes on by itself in `ms` milliseconds; waiting.ts). `memory` is all the
// kernel holds, and `held` the same by kind (Kernel.held: guest,
// translations, translator, files, and what of it can go now, spare).
// {type: 'free'} gives back all that can go without stopping anything and
// answers {type: 'freed', before, after}; a program that ends gives back
// what is past the kernel's budget on its own.
//
// Where the page is cross-origin isolated, every guest thread runs in a
// Worker of its own (remote.ts) and the kernel serves them from here;
// otherwise they take turns here, and each input message runs them again.
// It says {type: 'threads', apart} once started.
//
// With `mirror: '/root/<repo>'` in 'start', what the guest changes there is
// sent before anything it printed after it and at each pause, before the
// pause is said, as {type: 'changes', dirs, files, removed} (see mirror.ts),
// and {type: 'put', path, what} puts an outside change in.
//
// With `root: {index, url}` in 'start', the whole root (packs and their
// index, pack.ts) fills in around the files given: each file of it is
// fetched from the packs under `url` when a program first reads it.
//
// A file given with its translation (`module`) may come with `more`: the code
// an earlier run of it reached later, as that run made it ([{module, bytes,
// base}], in order; Image.adopt), so it is not translated again here. What
// this run reaches later of such a program is said once the kernel pauses, as
// {type: 'more', path, from, more: [{module, bytes, base}]}: the modules from
// the `from`th on, for the page to keep and give the next Prompt.
//
// {type: 'hot', files}, after 'start': programs given with their translation
// once the Prompt is up (the page readies why's and git's after its first
// Prompt starts), each in the root's file (pack.ts provide: each name of it,
// a hard link, runs it), run from its next run on.
//
// A program run again that reached much of its code later is translated
// again as one module only once the shell waits for its next line, a moment
// after it does (Kernel.consolidateDue), so no run waits on that.
//
// {type: 'warm'}, before 'start' (sent as soon as the Worker is made, while
// what 'start' needs is still being fetched): the Workers the first threads
// will run in are started now, so they are up when the shell starts.
//
// {type: 'ready', translator, files, root, rehearse}, before 'start' (a
// Prompt shown, not started yet): what every start has the same is readied
// now, the translator loaded and the files given and the root put in place,
// and 'start' then brings only what is its own (the repo, the dotfiles, argv
// and env; its `files` go over those readied, and its `translator` and
// `root` are not needed). Without it, 'start' readies the same itself.
// With `rehearse: {config, words}` (a box, as 'start' has one), a start is
// rehearsed: that box's program runs to its end in a kernel of its own,
// nothing to read, its output dropped, so that what a start runs (the
// kernel's code, muk's and the program's, each compiled as it is first
// run) is compiled when 'start' comes, and
// the Workers its threads ran in are warm and taken by the kernel of
// 'start'. What it runs must write nothing (a shell reading no input does
// not), as the files are those 'start' runs on.
//
// Every other program of the root is translated when it is first run; with
// `kept: {cache, at: {[origin]: {main, more}}}` in 'start', a program whose
// translation an earlier Prompt made is read from that Cache Storage instead
// (by its file's origin, pack.ts: the URLs of its translation and of the
// code it reached later, keeper.ts), and the exec waits only for that read.
// A program the page translates ahead while a person reads (why/app/prompt/ahead.ts) is told as it is kept,
// {type: 'kept', at: {[origin]: {main, more}}}, and read as one kept before would be.
// What is translated here of a root file is said once the kernel pauses, for
// the page to keep: {type: 'translated', origin, wasm, segments} once, then
// {type: 'reached', origin, from, more} as code is reached later; and what
// was read of what is kept, {type: 'used', urls}, for the page to count.

import {canRunApart, rangeNow} from '../../../../module/sods/runtime/host.ts';
import {Mirror, RemoteKernel, Vfs, keeper, linux, mountTarget, provide, said, warmThreads,
  type Console, type File, type Image, type Kept, type Kernel, type Pumped, type Reading, type Said} from '../../../../module/sods/runtime/linux.ts';
import {loadTranslator, type Segment, type Translate} from '../../../../module/sods/runtime/translate.ts';
import {mountPack, type Given, type Packed} from '../../../../module/ricebox/layers/mount.ts';
import {syncRange} from '../../../../module/ricebox/layers/pack.ts';

/** A module of code a run reached later: its first table slot and bytes (Image.adopt). */
interface Reached { module: WebAssembly.Module; bytes: Uint8Array; base: number }
/** A program given: its bytes, and its translation where the page has one (made for memory `shared` or not). */
interface Program extends Given { module?: WebAssembly.Module; segments?: Segment[] | null; shared?: boolean; more?: Reached[] }
/** A box as the core writes it for muk (why/core/src/prompt/bundle.rs): config.json, and the words muk is run with. */
interface Box { config: string; words: string[] }
/** What every start has the same ('ready', or 'start' where none came first). `muk`: the box's maker, served beside the root. */
interface Ready { translator: WebAssembly.Module | BufferSource; files?: Program[]; root?: {index: Packed; url: string}; muk?: Uint8Array | null; rehearse?: Box }
/** What 'start' brings of its own: the box to make, and where in the tree the repo's copy is. */
interface Start extends Ready {
  type: 'start';
  box: Box;
  cwd: string;
  dirs?: string[];
  links?: {path: string; target: string}[];
  screen?: boolean;
  cols?: number;
  rows?: number;
  kept?: Kept;
  mirror?: string;
}
/** What the page posts. */
type Posted =
  | {type: 'drained'; n: number}
  | {type: 'input'; bytes: Uint8Array}
  | {type: 'eof' | 'typing' | 'free' | 'warm'}
  | {type: 'interrupt'; sig?: number; flush?: number}
  | {type: 'put'; path: string; what: Uint8Array | null | 'dir'}
  | {type: 'hot'; files: Program[]}
  | {type: 'kept'; at: Kept['at']}
  | (Ready & {type: 'ready'})
  | Start;
/** What was readied: the translator loaded, the files given and the root put around them, the box's maker beside it. */
interface Readied { translate: Translate; vfs: Vfs; files: Program[] }

/** Where the bundle is in the tree (the page's BOX), under the tmpfs the box has at /run: its maker and its config.json. */
const BOX = '/run/box';
/**
 * `box` written where muk is told it is, and what is run for it: muk itself, with its words. The program config.json
 * names is muk's to start, in the box it makes: nothing is started here but muk.
 */
function boxed(vfs: Vfs, box: Box): string[] {
  vfs.writeFile(`${BOX}/config.json`, box.config);
  return [`${BOX}/muk`, ...box.words];
}

/** The buffers of `views` that can be moved to the page (not shared memory, each once). */
const moved = (...views: {buffer: ArrayBufferLike}[]): {transfer: ArrayBuffer[]} =>
  ({transfer: [...new Set(views.map((v) => v.buffer))].filter((b) => b instanceof ArrayBuffer)});

let kernel: Kernel | null = null;
let mirror: Mirror | null = null;
/** What 'ready' readied ({translate, vfs, files}), or 'start' itself where none came first. */
let readied: Promise<Readied> | null = null;
let apart = false;
const pending: Uint8Array[] = [];
let ended = false;
/** The programs given with their translation: the image of each, and how much of its code reached later is said. */
const kept: {path: string; image: Image; told: number}[] = [];
/** Translations kept from earlier Prompts (keeper.ts), when the page has any. */
let keep: Reading | null = null;
/** What is kept, by origin, as 'start' said it: a program translated ahead later ({type: 'kept', at}) is put here. */
let keptAt: Kept['at'] | null = null;

function read(n: number): Uint8Array | null {
  if (!pending.length) return ended ? new Uint8Array(0) : null;
  const head = pending[0];
  if (head.length <= n) { pending.shift(); return head; }
  pending[0] = head.subarray(n);
  return head.subarray(0, n);
}

/** The translator loaded, `files` written and the root put around them: what every start has the same. */
function ready(data: Ready): Promise<Readied> {
  readied ??= (async () => {
    const translate = await loadTranslator(data.translator);
    const vfs = new Vfs();
    if (data.root) mountPack(mountTarget(vfs), data.root.index, {range: syncRange(data.root.url, rangeNow), decode: translate.unzstd, sha256: translate.sha256});
    // Over the root, so what was given (why, its BusyBox) is what runs: a hot program in the root's own node.
    for (const f of data.files ?? []) provide(vfs, f);
    // The box's maker, beside the root it makes boxes of. A root served with none has no way to run its programs.
    if (!data.muk) throw new Error('This root is served with no muk beside it (scripts/muk.ts puts it there)');
    vfs.writeFile(`${BOX}/muk`, data.muk, 0o755);
    const r: Readied = {translate, vfs, files: data.files ?? []};
    if (data.rehearse) await rehearse(r, data.rehearse).catch(() => { /* only a start that is not faster */ });
    return r;
  })();
  return readied;
}

/** How long a rehearsal may take: what has not ended by then is left (a program that waits for time). */
const REHEARSAL_MS = 2000;

/** `box` run to its end over what is readied, in a kernel made for it alone (see 'ready'). */
async function rehearse({translate, vfs, files}: Readied, box: Box): Promise<void> {
  const argv = boxed(vfs, box), env: string[] = [], cwd = '/';
  const quiet: Console = {interactive: false, write() {}, read: () => new Uint8Array(0), ready: () => true, pending: () => 0};
  const k = linux({vfs, translate, console: quiet, passOn: true, translated: files});
  const timer = setTimeout(() => k.halt(), REHEARSAL_MS);
  try {
    if (k instanceof RemoteKernel) { await k.spawn(argv[0], argv, env, cwd); return; }
    // In turn here, a turn at a time, the host's own work (messages) between.
    k.start(argv[0], argv, env, cwd);
    while (k.status === null) { k.pump(); await new Promise((go) => setTimeout(go, 0)); }
  } finally {
    clearTimeout(timer);
  }
}

const failed = (e: unknown): void => self.postMessage({type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)});

/**
 * How long the Prompt waits for its next line before what is due is translated again as one module (Kernel.consolidate):
 * a moment, so a line sent at once after the one before (a script, a paste) does not wait on it.
 */
const IDLE_MS = 1200;
/** Keys pressed on the page ('typing': the person writing a line, or in a file, which the kernel hears nothing of until
 * a line is sent): what is due waits until they have been still this long. */
const QUIET_MS = 5000;
let idle: ReturnType<typeof setTimeout> | undefined;
/** Waiting for a person (input), with what is due to be done then. */
let waitingInput = false;
/** Translated again as one module, a program takes every thread the page draws with for seconds: done while the
 * person is still, never while they type. */
const consolidateLater = (ms: number): void => { clearTimeout(idle); idle = setTimeout(() => { if (kernel?.consolidateDue()) told(); }, ms); };
/** A program in front reads each key as it comes (vi, less, top): waiting for input is waiting for the next key, the
 * person typing, not reading; nothing is translated again until it gives the terminal back (it would hold up the page's
 * frames, the translation taking the threads the page draws with, at every pause between keys). */
let rawKeys = false;

/** The kernel paused (here: every thread waits or it ended, `r` as pump says): what the shell changed, and why it waits. */
function paused(r: Pumped): Said {
  const k = kernel!;
  // What the shell changed goes before what it printed (send reports it first): a page that has the prompt back has
  // what the line wrote.
  report();
  send();
  told();
  const m = said(r, k.held(), performance.now(), (keep?.reading() ?? 0) > 0);
  self.postMessage(m);
  // Waiting for a person: what is due is consolidated while they read or type, then said as anything translated is.
  clearTimeout(idle);
  waitingInput = m.type === 'waiting' && m.for === 'input';
  if (waitingInput && k.due.size && !rawKeys) consolidateLater(IDLE_MS);
  return m;
}

/**
 * What the shell changed in the repo since it was last said (mirror.ts), said now. The page keeps each batch as it comes
 * (repo-copy.ts), so a page that has heard the pause, and shows the line done, has what the line wrote, a reload or not.
 */
function report(): void {
  const c = mirror?.changes();
  if (c) self.postMessage({type: 'changes', ...c}, moved(...c.files.filter((f) => f.bytes).map((f) => f.bytes)));
}

/** What was translated here or reached later since it was last said. */
function told(): void {
  // Code reached later since it was last said, for the page to keep (each module's bytes copied: the image keeps its own).
  for (const k of kept) {
    const x = k.image.extras;
    // (Reached in bytes its file had once changed: this run's own, never the program's: process.ts readLater.)
    if (x.length <= k.told || k.image.changed) continue;
    const more = x.slice(k.told).map((e) => ({module: e.module, bytes: e.bytes.slice(), base: e.base}));
    self.postMessage({type: 'more', path: k.path, from: k.told, more}, moved(...more.map((m) => m.bytes)));
    k.told = x.length;
  }
  // What was translated here of the root's programs, and the code they reached later since it was said.
  for (const e of kernel?.images.values() ?? []) {
    const im = e.image;
    if (!im.origin || e.kept) continue;
    if (!im.mainTold && im.wasm) {
      const wasm = im.wasm;
      im.wasm = null;
      im.mainTold = true;
      const segments = im.segments ? im.segments.map((s) => ({offset: s.offset, bytes: s.bytes.slice()})) : null;
      self.postMessage({type: 'translated', origin: im.origin, wasm, segments}, moved(wasm, ...(segments ?? []).map((s) => s.bytes)));
    }
    if (im.mainTold && im.extras.length > (im.told ?? 0)) {
      const more = im.extras.slice(im.told).map((x) => ({module: x.module, bytes: x.bytes.slice(), base: x.base}));
      self.postMessage({type: 'reached', origin: im.origin, from: im.told, more}, moved(...more.map((m) => m.bytes)));
      im.told = im.extras.length;
    }
  }
}

let waking: ReturnType<typeof setTimeout> | undefined;
/** Threads in turn here: run until they all wait, then again for input or when a sleep ends. */
function pump(): void {
  try {
    const m = paused(kernel!.pump());
    // A process that sleeps goes on when its time comes, input or not.
    clearTimeout(waking);
    if (m.type === 'waiting' && m.for === 'time') waking = setTimeout(pump, m.ms);
  } catch (e) {
    failed(e);
  }
}

/** The node of `f`, a program given with its translation, runs that translation from its next run on. */
function runs(k: Kernel, node: File, f: Program, module: WebAssembly.Module): void {
  k.prebuilt(node, module, f.segments ?? null);
  follow(k, node, f);
}

/** `f`, given with its translation and run from it (`node`), is followed: what it reaches later is said from where its `more` ends. */
function follow(k: Kernel, node: File, f: Program): void {
  const image = k.images.get(node)!.image;
  kept.push({path: f.path, image, told: f.more?.length ? image.adopt(f.more) : 0});
}

/**
 * Hot programs ready after this Prompt started (why, git: the page readies them once its first Prompt is up), each put
 * in the root's file and run from its next run on; what runs it now goes on as it is. One made for memory not shared
 * cannot run where threads run apart: it stays translated as it runs.
 */
function given(k: Kernel, files: Program[]): void {
  for (const f of files) if (f.module && (!apart || f.shared)) runs(k, provide(k.vfs, f), f, f.module);
}

/** Something came from outside (input, Ctrl-C): the kernel looks again. */
const nudge = (): void => { if (!kernel) return; clearTimeout(idle); waitingInput = false; if (kernel instanceof RemoteKernel) kernel.kick(); else pump(); };

/**
 * Output on its way to the page and not yet taken in there (it says how much it took, 'drained', once a frame): past
 * this much, what writes to the console waits, as a terminal's writer waits when its screen cannot keep up. Without it
 * a flood (yes) was sent faster than the page could take it, its messages piling up until the page was out of memory.
 */
const ON_ITS_WAY_MOST = 1 << 20;
let onItsWay = 0;

/**
 * Output gathered before it goes to the page. A terminal's stdout is written a line at a time, and each line sent as a
 * message of its own had the page take hundreds of thousands of messages a second (yes), each costing far more than its
 * bytes: the page stopped answering for a minute. What is written goes at once when nothing went for GATHER_MS (a key's
 * echo, a prompt line), else with what follows it: once this much has gathered, at the next write or turn of the kernel
 * after GATHER_MS, and whenever the kernel stops (every thread waits).
 */
const GATHER_MS = 4, GATHER_MOST = 64 << 10;
let gathered: Uint8Array[] = [], gatheredBytes = 0, gatheredFd = 1, sentAt = -Infinity;
/**
 * Which of the page's Ctrl-Cs (and Ctrl-\, Ctrl-Z) output comes after: a key that makes a signal flushes what was
 * written before it and not yet shown, as a terminal's line discipline does (unless NOFLSH), so ^C stands where the run
 * was cut, not under the megabyte of `yes` that was on its way. The page drops output of an epoch before its own.
 */
let epoch = 0;
function send(): void {
  if (!gatheredBytes) return;
  // What the shell changed goes before anything it printed after: a page that shows a line has what it wrote before.
  report();
  let bytes = gathered[0];
  if (gathered.length > 1) {
    bytes = new Uint8Array(gatheredBytes);
    let at = 0;
    for (const b of gathered) { bytes.set(b, at); at += b.length; }
  }
  self.postMessage({type: 'output', fd: gatheredFd, bytes, epoch}, moved(bytes));
  gathered = [];
  gatheredBytes = 0;
  sentAt = performance.now();
}
function gather(fd: number, bytes: Uint8Array): void {
  onItsWay += bytes.length;
  if (fd !== gatheredFd) { send(); gatheredFd = fd; }
  gathered.push(bytes);
  gatheredBytes += bytes.length;
  if (gatheredBytes >= GATHER_MOST || performance.now() - sentAt >= GATHER_MS) send();
}
/** A turn of the kernel (a thread's time slice up, a pause between calls): what gathered goes if it has waited long enough. */
const due = (): void => { if (gatheredBytes && performance.now() - sentAt >= GATHER_MS) send(); };

self.onmessage = async ({data}: MessageEvent<Posted>) => {
  if (data.type === 'drained') {
    onItsWay = Math.max(0, onItsWay - data.n);
    if (kernel) kernel.dirty = true;
    nudge();
    return;
  }
  if (data.type === 'input') { pending.push(data.bytes); nudge(); return; }
  if (data.type === 'eof') { ended = true; nudge(); return; }
  if (data.type === 'typing') { if (kernel && waitingInput && kernel.due.size && !rawKeys) consolidateLater(QUIET_MS); return; }
  if (data.type === 'interrupt') {
    pending.length = 0;
    // The signal first (what runs in front writes no more without asking: cpu.ts toConsole), then what was written and
    // not yet shown goes (flush: the page's epoch from here on).
    const sent = kernel?.interrupt(data.sig);
    if (data.flush !== undefined) {
      epoch = data.flush;
      onItsWay = Math.max(0, onItsWay - gatheredBytes);
      gathered = [];
      gatheredBytes = 0;
      if (kernel instanceof RemoteKernel) kernel.outbox.take();
    }
    if (sent) nudge();
    return;
  }
  if (data.type === 'put') { mirror?.put(data.path, data.what); return; }
  if (data.type === 'free') { if (kernel) self.postMessage({type: 'freed', ...kernel.free(0)}); return; }
  if (data.type === 'warm') { if (canRunApart()) warmThreads(); return; }
  if (data.type === 'hot') { if (kernel) given(kernel, data.files); return; }
  // A program translated ahead by the page since this Prompt started (why/app/prompt/ahead.ts): read when it is run.
  if (data.type === 'kept') { if (keptAt) Object.assign(keptAt, data.at); return; }
  // (A failure is said by the 'start' that waits for it.)
  if (data.type === 'ready') { ready(data).catch(() => {}); return; }
  if (data.type !== 'start') return;
  try {
    // Readied before, or now: then this start's files are those readied, put before the root.
    const before = readied !== null;
    const {translate, vfs, files: early} = await ready(data);
    const later = before ? data.files ?? [] : [];
    for (const d of data.dirs ?? []) vfs.mkdirp(d);
    // Over the root, as over the files readied: what this start gives is what is there.
    for (const f of later) provide(vfs, f);
    for (const l of data.links ?? []) vfs.symlink(l.target, l.path);
    vfs.mkdirp(data.cwd);
    const files = [...early, ...later];
    const console: Console = {
      // Shown as a terminal's screen (the app's Prompt), it is a terminal: its output a terminal's, this many columns
      // wide, and what reads keys from it reads them as from one, a line at a time unless it asks for each key as it
      // comes (then the page sends keys as they are pressed: it is told each change, `mode`).
      interactive: !!data.screen,
      screen: !!data.screen, cols: data.cols ?? 80, rows: data.rows ?? 24,
      // What was written before the change goes first: a program leaving the screen (nano, less) writes its last of it
      // and then gives the terminal back, and the page, told of the change before those last bytes, drew them on the
      // shell's lines (the prompt line came up as `hello $ ng... ][ Wrote 1 line ]`).
      mode: (tio) => { rawKeys = !(tio.lflag & 2); send(); self.postMessage({type: 'tty', ...tio}); },
      write: gather,
      // The kernel's turns (process.ts, remote.ts): what gathered goes when it is due, or now (`all`, it stops).
      flush: (all) => (all ? send() : due()),
      // Past so much on its way to the page and not yet taken in there, what writes to it waits (sys-file.ts).
      full: () => onItsWay > ON_ITS_WAY_MOST,
      read,
      ready: () => pending.length > 0 || ended,
      pending: () => pending.reduce((n, b) => n + b.length, 0),
    };
    // Translations kept from earlier Prompts: read when their program is first run, the kernel looking again once they are.
    keep = data.kept ? keeper(data.kept, () => nudge(), (urls) => self.postMessage({type: 'used', urls})) : null;
    keptAt = data.kept?.at ?? null;
    // Each thread in a Worker of its own, all at once, where memory can be shared and every ready translation was made
    // for shared memory; otherwise they take turns here (sods' linux.ts decides, by the host it is on).
    const k = kernel = linux({vfs, translate, console, keeper: keep, onIdle: (r) => paused(r), consolidateIdle: true, translated: files});
    apart = k instanceof RemoteKernel;
    for (const f of files) if (f.module) follow(k, vfs.file(f.path), f);
    if (data.mirror) mirror = new Mirror(vfs, data.mirror);
    const run = boxed(vfs, data.box);
    k.start(run[0], run, [], '/');
    self.postMessage({type: 'threads', apart});
  } catch (e) {
    failed(e);
    return;
  }
  if (kernel instanceof RemoteKernel) kernel.serve().catch(failed); else pump();
};
