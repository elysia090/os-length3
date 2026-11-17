// The root run in a page's Worker: its layers mounted (mount.ts), the Linux that runs it (sods: the tree, the
// kernel, what the translator makes and what was kept of it) and the box its programs run in, which muk makes here
// as it does on a Linux machine: the same program, run on this Linux with the bundle written for it (../src/bundle.rs,
// the one writer for every host). Nothing here starts a box's program itself. A directory of the tree is kept in
// step with the page where it asks (`mirror`: a product's repo). The page posts
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
// worker holds, including disposable pack responses, and `held` the same by kind (Kernel.held: guest,
// translations, translator, files including pack responses, and what of it can go now, spare).
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
// once the Prompt is up (the page readies the others after its first
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
// A program the page translates ahead while a person reads (ahead.ts) is told as it is kept,
// {type: 'kept', at: {[origin]: {main, more}}}, and read as one kept before would be.
// What is translated here of a root file is said once the kernel pauses, for
// the page to keep: {type: 'translated', origin, wasm, segments} once, then
// {type: 'reached', origin, from, more} as code is reached later; and what
// was read of what is kept, {type: 'used', urls}, for the page to count.

import {WorkerLifetime} from './worker-lifetime.ts';
import {canRunApart, rangeNow} from '../../sods/runtime/host.ts';
import {Mirror, RemoteKernel, Vfs, keeper, linux, provide, said, warmThreads,
  type Console, type File, type Kept, type Kernel, type Pumped, type Reading, type Said} from '../../sods/runtime/linux.ts';
import {loadTranslator, type Segment, type Translate} from '../../sods/runtime/translate.ts';
import {type Given, type Packed} from './mount.ts';
import {prepareTree, type FileCore, type PreparedTree} from './prepared-tree.ts';
import {syncRange} from './pack.ts';
import {TranslationObserver} from './translation-observer.ts';

/** A module of code a run reached later: its first table slot and bytes (Image.adopt). */
interface Reached { module: WebAssembly.Module; bytes: Uint8Array; base: number }
/** A program given: its bytes, and its translation where the page has one (made for memory `shared` or not). */
interface Program extends Given { module?: WebAssembly.Module; segments?: Segment[] | null; shared?: boolean; more?: Reached[] }
/** A box as it is written for muk (../src/bundle.rs): config.json, and the words muk is run with. */
interface Box { config: string; words: string[] }
/** What every start has the same ('ready', or 'start' where none came first). `muk`: the box's maker, served beside the root. */
interface Ready { fileCore?: FileCore; translator: WebAssembly.Module | BufferSource; files?: Program[]; root?: {index: Packed; url: string}; muk?: Uint8Array | null; rehearse?: Box }
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
  | {type: 'eof' | 'typing' | 'free' | 'warm' | 'retire'}
  | {type: 'interrupt'; sig?: number; flush?: number}
  | {type: 'put'; path: string; what: Uint8Array | null | 'dir'}
  | {type: 'hot'; files: Program[]}
  | {type: 'kept'; at: Kept['at']}
  | (Ready & {type: 'ready'})
  | Start;
/** What was readied: the translator loaded, the files given and the root put around them, the box's maker beside it. */
interface Readied { translate: Translate; vfs: Vfs; files: Program[]; tree: PreparedTree }

/** Where the bundle is in the tree (BOX, as whoever asks for the bundle names it), under the tmpfs the box has at /run: its maker and its config.json. */
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

const lifetime = new WorkerLifetime();
const executionOwners = new Set<WeakRef<Kernel>>();
let kernel: Kernel | null = null;
let mirror: Mirror | null = null;
/** What 'ready' readied ({translate, vfs, files}), or 'start' itself where none came first. */
let readied: Promise<Readied> | null = null;
/** One finite prepared result, including a result arriving after freeze. This
 * root is explicit; weak observations must never stand in for ownership. */
let preparedOwner: PreparedTree | null = null;
const rehearsalTimers = new Set<ReturnType<typeof setTimeout>>();
// Transport cache belongs to the root's worker, never the guest or a product.
let packRange: ReturnType<typeof syncRange> | null = null;
const withPacks = <T extends {files: number; spare: number; total: number}>(held: T, bytes = packRange?.held() ?? 0): T =>
  ({...held, files: held.files + bytes, spare: held.spare + bytes, total: held.total + bytes});
let apart = false;
const pending: Uint8Array[] = [];
let ended = false;
/** The programs given with their translation: the image of each, and how much of its code reached later is said. */
const observations = new TranslationObserver();
const observerOwner = lifetime.observe('translation-observer', observations);
let mirrorOwner: {release(): void} | null = null;
let warmOwner: {release(): void} | null = null;
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
  if (readied && data.fileCore !== undefined) {
    throw new Error('File-core ownership was selected by the first preparation; omit fileCore when using that prepared root');
  }
  readied ??= (async () => {
    const preparing = lifetime.enter('preparation');
    try {
      const translate = await loadTranslator(data.translator);
      lifetime.check();
      const tree = await prepareTree({core: data.fileCore, muk: data.muk, files: data.files,
        root: data.root ? {index: data.root.index, reading: {
          range: packRange = syncRange(data.root.url, rangeNow, new Map(data.root.index.packs.map(p => [p.name, p.bytes]))),
          decode: translate.unzstd, sha256: translate.sha256,
        }} : undefined,
      });
      preparedOwner = tree;
      lifetime.observe('prepared-tree', preparedOwner);
      lifetime.check();
      // This owner survives rehearsal and ordinary kernel exit. Worker termination
      // releases the realm; no per-run path may dispose a tree borrowed by another run.
      const r: Readied = {translate, vfs: tree.vfs, files: data.files ?? [], tree};
      if (data.rehearse) await rehearse(r, data.rehearse).catch(() => { /* only a start that is not faster */ });
      return r;
    } finally { preparing.release(); }
  })();
  return readied;
}

/** How long a rehearsal may take: what has not ended by then is left (a program that waits for time). */
const REHEARSAL_MS = 2000;

/** `box` run to its end over what is readied, in a kernel made for it alone (see 'ready'). */
async function rehearse({translate, vfs, files}: Readied, box: Box): Promise<void> {
  const argv = boxed(vfs, box), env: string[] = [], cwd = '/';
  const quiet: Console = {interactive: false, write() {}, read: () => new Uint8Array(0), ready: () => true, pending: () => 0};
  const k = linux({vfs, translate, console: quiet, passOn: true, unownedWorkerFailure: failed, translated: files});
  executionOwners.add(new WeakRef(k)); lifetime.observe('rehearsal-kernel', k);
  const operation = lifetime.enter('rehearsal-operation');
  const timer = setTimeout(() => k.halt(), REHEARSAL_MS);
  rehearsalTimers.add(timer);
  try {
    if (k instanceof RemoteKernel) { await k.spawn(argv[0], argv, env, cwd); return; }
    // In turn here, a turn at a time, the host's own work (messages) between.
    k.start(argv[0], argv, env, cwd);
    while (lifetime.accepting && k.status === null) { k.pump(); await new Promise((go) => setTimeout(go, 0)); }
  } finally {
    clearTimeout(timer); rehearsalTimers.delete(timer);
    operation.release();
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
const consolidateLater = (ms: number): void => { clearTimeout(idle); idle = setTimeout(() => { if (lifetime.accepting && kernel?.consolidateDue()) told(); }, ms); };
/** A program in front reads each key as it comes (vi, less, top): waiting for input is waiting for the next key, the
 * person typing, not reading; nothing is translated again until it gives the terminal back (it would hold up the page's
 * frames, the translation taking the threads the page draws with, at every pause between keys). */
let rawKeys = false;

/** The kernel paused (here: every thread waits or it ended, `r` as pump says): what the shell changed, and why it waits. */
function paused(r: Pumped): Said {
  if (publishingOutput) throw new Error('Output publication is already active; cannot establish a final boundary');
  if (!lifetime.accepting) return said(r, withPacks(kernel!.held()), performance.now(), false);
  const k = kernel!;
  // What the shell changed goes before what it printed (send reports it first): a page that has the prompt back has
  // what the line wrote.
  report();
  send();
  told();
  const m = said(r, withPacks(k.held()), performance.now(), (keep?.reading() ?? 0) > 0);
  if (!lifetime.accepting) return m;
  if (m.type === 'exit' && !outputBoundarySent) {
    outputBoundarySent = true; // Before posting: an ambiguous send must not be retried.
    self.postMessage({type: 'output-boundary', sentBytes: publishedOutputBytes});
  }
  if (!lifetime.accepting) return m;
  self.postMessage(m);
  if (!lifetime.accepting) return m;
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
  if (outputBoundarySent || !lifetime.accepting) return;
  const c = mirror?.changes();
  if (c) self.postMessage({type: 'changes', ...c}, moved(...c.files.filter((f) => f.bytes).map((f) => f.bytes)));
}

/** What was translated here or reached later since it was last said. */
function told(): void {
  if (outputBoundarySent || !lifetime.accepting) return;
  observations.publish(kernel?.images.values() ?? [], (message, options) => self.postMessage(message, options));
}

let waking: ReturnType<typeof setTimeout> | undefined;
/** Threads in turn here: run until they all wait, then again for input or when a sleep ends. */
function pump(): void {
  if (!lifetime.accepting) return;
  try {
    if (publishingOutput) throw new Error('Output publication is already active; cannot reenter execution');
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
  observations.track(f.path, image, f.more?.length ? image.adopt(f.more) : 0);
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
const nudge = (): void => { if (outputBoundarySent || !kernel) return; clearTimeout(idle); waitingInput = false; if (kernel instanceof RemoteKernel) kernel.kick(); else pump(); };

/**
 * Output on its way to the page and not yet taken in there (it says how much it took, 'drained', once a frame): past
 * this much, what writes to the console waits, as a terminal's writer waits when its screen cannot keep up. Without it
 * a flood (yes) was sent faster than the page could take it, its messages piling up until the page was out of memory.
 */
const ON_ITS_WAY_MOST = 1 << 20;
let onItsWay = 0;
let publishedOutputBytes = 0;
let outputBoundarySent = false;
let publishingOutput = false;
let abandonedAfterBoundary = 0;

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
  if (publishingOutput) throw new Error('Output publication is already active');
  if (outputBoundarySent || !lifetime.accepting || !gatheredBytes) return;
  publishingOutput = true;
  try {
    // What the shell changed goes before anything it printed after: a page that shows a line has what it wrote before.
    report();
    if (!lifetime.accepting) return;
    let bytes = gathered[0];
    if (gathered.length > 1) {
      bytes = new Uint8Array(gatheredBytes);
      let at = 0;
      for (const b of gathered) { bytes.set(b, at); at += b.length; }
    }
    if (!Number.isSafeInteger(publishedOutputBytes + bytes.length)) throw new Error('Output byte count exhausted');
    const count = bytes.length;
    self.postMessage({type: 'output', fd: gatheredFd, bytes, epoch}, moved(bytes));
    publishedOutputBytes += count;
    gathered = [];
    gatheredBytes = 0;
    sentAt = performance.now();
  } finally { publishingOutput = false; }
}
function gather(fd: number, bytes: Uint8Array): void {
  if (publishingOutput) throw new Error('Output publication is already active');
  if (outputBoundarySent) { abandonedAfterBoundary += bytes.length; return; }
  onItsWay += bytes.length;
  if (fd !== gatheredFd) { send(); gatheredFd = fd; }
  gathered.push(bytes);
  gatheredBytes += bytes.length;
  if (gatheredBytes >= GATHER_MOST || performance.now() - sentAt >= GATHER_MS) send();
}
/** A turn of the kernel (a thread's time slice up, a pause between calls): what gathered goes if it has waited long enough. */
const due = (): void => { if (gatheredBytes && performance.now() - sentAt >= GATHER_MS) send(); };

self.onmessage = async ({data}: MessageEvent<Posted>) => {
  if (data.type === 'retire') {
    if (!lifetime.accepting) { self.postMessage({type: 'retiring', owners: lifetime.snapshot()}); return; }
    lifetime.freeze(); // Before callbacks, including synchronous message reentry.
    clearTimeout(idle); clearTimeout(waking);
    for (const timer of rehearsalTimers) clearTimeout(timer);
    rehearsalTimers.clear();
    const errors: unknown[] = [];
    for (const ref of [...executionOwners]) {
      const k = ref.deref();
      if (!k) { executionOwners.delete(ref); continue; }
      try { k.halt(); } catch (error) { errors.push(error); }
      if (k instanceof RemoteKernel) { try { k.close(); } catch (error) { errors.push(error); } }
    }
    observations.close(); observerOwner.release();
    mirror = null; mirrorOwner?.release(); mirrorOwner = null;
    if (gatheredBytes) lifetime.observe('pending-output');
    if (abandonedAfterBoundary) errors.push(new Error(`${abandonedAfterBoundary} output bytes were abandoned after the final boundary`));
    // This acknowledges admission closure, not stopped Workers or tree disposal.
    self.postMessage({type: 'retiring', owners: lifetime.snapshot(), failures: errors.map(error => error instanceof Error ? `${error.name}: ${error.message}` : String(error))});
    if (errors.length) failed(new AggregateError(errors, 'Worker retirement failed'));
    return;
  }
  if (!lifetime.accepting) { failed(new Error('Worker is retiring; new work is not accepted')); return; }
  if (outputBoundarySent && data.type !== 'drained') { failed(new Error('Worker output boundary is closed; new work is not accepted')); return; }
  const command = lifetime.enter(`command:${data.type}`);
  try {
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
    if (data.type === 'free') {
      const bytes = packRange?.held() ?? 0;
      packRange?.clear();
      if (kernel) { const result = kernel.free(0); self.postMessage({type: 'freed', before: withPacks(result.before, bytes), after: withPacks(result.after, 0)}); }
      return;
    }
    if (data.type === 'warm') { if (canRunApart()) { warmOwner ??= lifetime.observe('warm-pool'); warmThreads({failed}); } return; }
    if (data.type === 'hot') { if (kernel) given(kernel, data.files); return; }
    // A program translated ahead by the page since this Prompt started (ahead.ts): read when it is run.
    if (data.type === 'kept') { if (keptAt) Object.assign(keptAt, data.at); return; }
    // (A failure is said by the 'start' that waits for it.)
    if (data.type === 'ready') {
      try { ready(data).catch(() => {}); } catch (error) { failed(error); }
      return;
    }
    if (data.type !== 'start') return;
    try {
      // Readied before, or now: then this start's files are those readied, put before the root.
      const before = readied !== null;
      const {translate, vfs, files: early} = await ready(data);
      lifetime.check();
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
      executionOwners.add(new WeakRef(k)); lifetime.observe('foreground-kernel', k);
      apart = k instanceof RemoteKernel;
      for (const f of files) if (f.module) follow(k, vfs.file(f.path), f);
      if (data.mirror) { mirror = new Mirror(vfs, data.mirror); mirrorOwner = lifetime.observe('mirror', mirror); }
      const run = boxed(vfs, data.box);
      k.start(run[0], run, [], '/');
      self.postMessage({type: 'threads', apart});
    } catch (e) {
      failed(e);
      return;
    }
    if (!lifetime.accepting) return;
    if (kernel instanceof RemoteKernel) {
      const serving = lifetime.enter('serve-operation');
      void kernel.serve().then(() => serving.release(), error => {
        serving.release();
        try { failed(error); }
        catch (notification) { lifetime.failures.push({error, notification}); lifetime.observe('diagnostic-failure'); }
      });
    } else pump();
  } finally { command.release(); }
};

