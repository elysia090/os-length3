// Which of l3's programs the browser's Prompt can run today: each program
// of the root (every executable under /usr/bin, /usr/sbin and /usr/libexec,
// BusyBox's applets by their links) is run once with `--version` under the
// xlat kernel in node, mounted from l3's packs as the browser mounts it
// (with its translations made ahead of time), and once on this machine's
// kernel in the same root (bwrap: its own /, /dev, /proc, as a Prompt has), and the two are compared:
//
//   runs     the same exit status and output as native (or, as native, no end)
//   not yet  xlat cannot run it yet: it ends otherwise than native (and the
//            system calls it was answered ENOSYS), what xlat said (an
//            instruction it does not translate, a refusal), or no end
//            within the time given
//
// A program that cannot run yet still ships: this says which, and why, for
// the translator's work.
//
//   node scripts/l3-runnable.mjs WEB ROOT_DIR [--out FILE.md] [--json FILE] [--jobs N] [--only REGEX] [--work-only] [--seconds N] [--fresh] [--warm]
//
// --fresh: this checkout's translator (../xlat's wasm build), every program translated as it runs, not what WEB carries.
// --warm: each line run once before the run timed, what it translated kept between runs as a browser keeps it (Cache
// Storage, keeper.mjs): the time of a Prompt that ran its programs before, not of the first one.
//
// WEB is l3 for the browser (public/l3; a root of packs of before is read
// too), ROOT_DIR the same root unpacked (for the native run). The translator
// is l3's own (its index names it), else ../xlat's wasm build.
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openWeb} from './l3-tree.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ENV = ['HOME=/root', 'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'LANG=C.UTF-8', 'TERM=dumb'];


/**
 * Translations kept in `dir` as a browser keeps them (xlat/runtime/keeper.mjs: 'L3T1' and 'L3M1', each sealed with
 * its SHA-256), for a kernel's keeper: {kept, save(kernel)}, save writing what the kernel translated since.
 */
async function keptIn(dir) {
  const {mkdirSync, readdirSync, renameSync, rmSync} = await import('node:fs');
  const {createHash} = await import('node:crypto');
  mkdirSync(dir, {recursive: true});
  const url = (name) => new URL(name, `file://${dir}/`).href;
  // keeper.mjs reads through the Cache Storage API: here, the files.
  globalThis.caches ??= {open: async () => ({match: async (u) => { try { return new Response(readFileSync(new URL(u))); } catch { return undefined; } }})};
  const at = {};
  for (const f of readdirSync(dir)) {
    const m = /^(.+)\.wasm$/.exec(f);
    if (m) at[m[1]] = {main: url(f), more: existsSync(`${dir}/${m[1]}.more`) ? url(`${m[1]}.more`) : null};
  }
  const sealed = (body) => Buffer.concat([body, createHash('sha256').update(body).digest()]);
  // Written whole, then named: lines run side by side read what another keeps.
  const put = (name, body) => { const tmp = `${dir}/.${name}.${process.pid}`; writeFileSync(tmp, sealed(body)); renameSync(tmp, `${dir}/${name}`); };
  const save = (kernel) => {
    for (const e of kernel.images.values()) {
      const im = e.image;
      if (!im.origin || e.kept) continue;
      if (im.wasm) {
        const segs = im.segments ?? [];
        const head = Buffer.alloc(8);
        head.writeUInt32BE(0x4c335431, 0); head.writeUInt32BE(im.segments ? segs.length : 0xffffffff, 4);
        const parts = [head];
        for (const x of segs) { const h = Buffer.alloc(8); h.writeUInt32BE(x.offset, 0); h.writeUInt32BE(x.bytes.length, 4); parts.push(h, Buffer.from(x.bytes)); }
        const len = Buffer.alloc(4); len.writeUInt32BE(im.wasm.length, 0);
        put(`${im.origin}.wasm`, Buffer.concat([...parts, len, Buffer.from(im.wasm)]));
        // What was kept of code reached later went with the translation it was made from.
        if (!im.extras.length) rmSync(`${dir}/${im.origin}.more`, {force: true});
      }
      if (im.extras.length > (im.wasm ? 0 : im.told ?? 0)) {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(0x4c334d31, 0); head.writeUInt32BE(im.extras.length, 4);
        const parts = [head];
        for (const x of im.extras) { const h = Buffer.alloc(8); h.writeUInt32BE(x.base, 0); h.writeUInt32BE(x.bytes.length, 4); parts.push(h, Buffer.from(x.bytes)); }
        put(`${im.origin}.more`, Buffer.concat(parts));
      }
    }
  };
  return {kept: {cache: 'l3', at}, save};
}

/** One program under xlat, in this process: prints {status, stdout, stderr, error?, ms} as JSON. */
async function child({web, path, args, translator, fresh, kept: keptDir}) {
  const {Vfs} = await import('../../xlat/runtime/fs.mjs');
  const {mountPack} = await import('../../xlat/runtime/pack.mjs');
  const {Kernel} = await import('../../xlat/runtime/process.mjs');
  const {loadTranslator} = await import('../../xlat/runtime/translator.mjs');
  const {keeper} = await import('../../xlat/runtime/keeper.mjs');
  const store = keptDir ? await keptIn(keptDir) : null;
  const w = openWeb(web);
  // --fresh: this checkout's translator, translating everything as it runs (what the next l3 will be).
  const translate = await loadTranslator(w.index.translator && !fresh ? w.blob(w.index.translator) : readFileSync(translator));
  const vfs = new Vfs();
  // As the page gives them: each program translated ahead of time, with its bytes.
  const ready = (fresh ? [] : w.index.translations ?? []).map((t) => {
    const f = w.index.files.find((x) => x.path === t.path);
    vfs.writeFile(t.path, new Uint8Array(w.blob(t.elf)), f.mode);
    return {path: t.path, module: new WebAssembly.Module(w.blob(t.wasm))};
  });
  mountPack(vfs, w.index, (pack, at, len) => { const b = Buffer.alloc(len); w.readRange(pack, at, len, b); return new Uint8Array(b); }, (b) => new Uint8Array(w.unzstd(b)));
  vfs.mkdirp('/root');
  let stdout = '', stderr = '';
  const dec = new TextDecoder();
  const kernel = new Kernel({vfs, translate, keeper: store ? keeper(store.kept, () => {}) : null, console: {
    interactive: false,
    // A program that writes on and on is cut at a megabyte: what it said first is what is compared.
    write: (fd, b) => {
      if (fd === 2) { if (stderr.length < 1 << 20) stderr += dec.decode(b, {stream: true}); }
      else if (stdout.length < 1 << 20) stdout += dec.decode(b, {stream: true});
    },
    read: () => new Uint8Array(0),
    ready: () => true,
  }});
  for (const r of ready) kernel.prebuilt(vfs.lookup(r.path, '/'), r.module);
  const t = performance.now();
  let status = null, error = null;
  try {
    // As spawn runs it, and also waiting out a kept translation being read.
    kernel.start(path, [path.split('/').pop(), ...args], ENV, '/root');
    for (;;) {
      const r = kernel.pump();
      if (!r.waiting) { status = r.status; break; }
      if (r.until !== undefined) await new Promise((go) => setTimeout(go, Math.max(0, r.until - performance.now())));
      else if (kernel.keeper?.reading()) await new Promise((go) => setTimeout(go, 1));
      else throw new Error('process waits for input that will never come');
    }
  } catch (e) { error = e instanceof Error ? e.message.split('\n')[0] : String(e); }
  const ms = Math.round(performance.now() - t);
  store?.save(kernel);
  process.stdout.write(JSON.stringify({status, stdout, stderr, error, ms}));
}

/** The root as a Prompt on the device has it: its own /, /dev, /proc, /tmp and /root, no network, nothing of this machine's. */
const sandbox = (root) => ['--unshare-all', '--die-with-parent', '--ro-bind', root, '/', '--dev', '/dev', '--proc', '/proc',
  '--tmpfs', '/tmp', '--tmpfs', '/root', '--chdir', '/root', '--clearenv', ...ENV.flatMap((e) => ['--setenv', ...e.split(/=(.*)/s).slice(0, 2)])];

/** Run `cmd` with a time limit: {code, signal, stdout, stderr, timedOut}. */
function run(cmd, argv, {seconds, env}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, {stdio: ['ignore', 'pipe', 'pipe'], env});
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, timedOut = false;
    p.stdout.on('data', (b) => { outBytes += b.length; if (outBytes < 16 << 20) out.push(b); });
    // A trace of every system call can be long: what matters is kept (the calls that are not there).
    p.stderr.on('data', (b) => { errBytes += b.length; if (errBytes < 64 << 20) err.push(b); });
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, seconds * 1000);
    p.on('close', (code, signal) => { clearTimeout(timer); resolve({code, signal, stdout: Buffer.concat(out).subarray(0, 1 << 20).toString('utf8'), stderr: Buffer.concat(err).toString('latin1'), timedOut}); });
  });
}

/** The programs: every executable regular file under /usr/bin, /usr/sbin, /usr/libexec, and the links in /usr/bin and /usr/sbin to one. */
function programs(index) {
  const files = new Map(index.files.map((f) => [f.path, f]));
  const links = new Map(index.links.map((l) => [l.path, l.target]));
  const resolve = (path, depth = 0) => {
    if (depth > 8) return null;
    if (files.has(path)) return path;
    // A link in a path (/bin is usr/bin): resolved part by part.
    const parts = path.split('/').filter(Boolean);
    for (let k = 1; k <= parts.length; k++) {
      const head = `/${parts.slice(0, k).join('/')}`;
      if (links.has(head)) {
        const t = links.get(head);
        const base = `/${parts.slice(0, k - 1).join('/')}`;
        const to = t.startsWith('/') ? t : `${base === '/' ? '' : base}/${t}`;
        const norm = [];
        for (const p of `${to}/${parts.slice(k).join('/')}`.split('/')) { if (!p || p === '.') continue; if (p === '..') norm.pop(); else norm.push(p); }
        return resolve(`/${norm.join('/')}`, depth + 1);
      }
    }
    return null;
  };
  const out = [];
  for (const f of index.files) {
    if (!/^\/usr\/(bin|sbin|libexec)\//.test(f.path) || !(f.mode & 0o111)) continue;
    out.push({path: f.path, file: f.path, kind: null});
  }
  for (const l of index.links) {
    if (!/^\/usr\/s?bin\/[^/]+$/.test(l.path)) continue;
    const file = resolve(l.path);
    if (file && files.get(file).mode & 0o111) out.push({path: l.path, file, kind: 'link'});
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, d = null) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
  const outMd = flag('--out'), outJson = flag('--json'), jobs = Number(flag('--jobs', '4')), only = flag('--only'), seconds = Number(flag('--seconds', '30'));
  const workOnly = args.includes('--work-only') && args.splice(args.indexOf('--work-only'), 1);
  const fresh = args.includes('--fresh') && !!args.splice(args.indexOf('--fresh'), 1);
  const warm = args.includes('--warm') && !!args.splice(args.indexOf('--warm'), 1);
  const {mkdtempSync} = await import('node:fs');
  const kept = warm ? mkdtempSync('/tmp/l3-kept-') : null;
  const [web, rootDir] = args;
  if (!web || !rootDir) { console.error('usage: l3-runnable.mjs WEB ROOT_DIR [--out FILE.md] [--json FILE] [--jobs N] [--only REGEX] [--work-only] [--seconds N]'); process.exit(2); }
  const w = openWeb(web);
  const translator = new URL('../../xlat/target/wasm32-unknown-unknown/release/xlat.wasm', import.meta.url).pathname;
  if (!w.index.translator && !existsSync(translator)) throw new Error(`no translator: l3 names none, and ${translator} is not built`);
  // What each file is, by its first bytes (ELF, a script and its interpreter).
  const head = (path) => { const f = w.index.files.find((x) => x.path === path); return f ? w.read(f).subarray(0, 128) : Buffer.alloc(0); };
  const what = (path) => {
    const b = head(path);
    if (b[0] === 0x7f && b.subarray(1, 4).toString('latin1') === 'ELF') return 'ELF';
    if (b[0] === 0x23 && b[1] === 0x21) return `script (${b.toString('latin1').slice(2).split('\n')[0].trim().split(/\s+/)[0]})`;
    return 'data';
  };
  let list = programs(w.index).map((p) => ({...p, type: p.kind === 'link' ? `link to ${p.file}` : what(p.file)}));
  if (only) list = list.filter((p) => new RegExp(only).test(p.path));
  if (workOnly) list = [];
  w.close();
  const rows = await compare(list.map((p) => ({name: p.path, what: p.type, path: p.path, args: ['--version']})), {web, rootDir, translator, jobs, seconds, fresh, kept});
  // Work a person does in a Prompt, each a line of sh, compared the same way: what --version cannot show (fork, pipes, signals, threads).
  const work = only ? [] : await compare(WORK.map(([name, line]) => ({name, what: line, path: '/usr/bin/sh', args: ['-c', line]})), {web, rootDir, translator, jobs, seconds: seconds * 4, fresh, kept});
  const tally = (rs, v) => rs.filter((r) => r.verdict === v).length;
  const about = w.about ? `l3 ${w.about.version} (sha256 ${w.about.sha256})` : `${w.index.name} ${w.index.version} (a root of packs of before)`;
  const cell = (t) => String(t).replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\n/g, ' ');
  const md = [
    `# Which programs of l3 the browser's Prompt runs`,
    '',
    `${about}. Each program is run under the xlat kernel in node (mounted from l3's packs as the browser mounts it, with its translations made ahead of time) and natively in the same root (bwrap: its own /, /dev, /proc, as a Prompt on the device has it), and the two are compared. Made by \`node os/scripts/l3-runnable.mjs\`.`,
    '',
    `- **runs**: the same exit status and output as native (or, as native, no end)`,
    `- **not yet**: present, not yet runnable under xlat: it ends otherwise than native (what differs, the system calls it was answered ENOSYS), xlat said why, or no end within the time`,
    '',
    `## Work, a line of sh each (${work.length}): ${tally(work, 'runs')} run, ${tally(work, 'not yet')} not yet`,
    '',
    '| Work | Line | Under xlat | Why | Native exit | ms | Says |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...work.map((r) => `| ${r.name} | \`${cell(r.what)}\` | ${r.verdict} | ${cell(r.why)} | ${r.native} | ${r.ms ?? ''} | ${cell(r.first)} |`),
    '',
    `## Every program, \`--version\` (${rows.length}): ${tally(rows, 'runs')} run, ${tally(rows, 'not yet')} not yet`,
    '',
    '| Program | What | Under xlat | Why | Native exit | ms | Says |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| \`${r.name}\` | ${r.what} | ${r.verdict} | ${cell(r.why)} | ${r.native} | ${r.ms ?? ''} | ${cell(r.first)} |`),
    '',
  ].join('\n');
  if (outMd) writeFileSync(outMd, md);
  if (outJson) writeFileSync(outJson, JSON.stringify({programs: rows, work}, null, 2));
  console.log(`${rows.length} programs: ${tally(rows, 'runs')} run as native, ${tally(rows, 'not yet')} not yet`);
  if (work.length) {
    console.log(`${work.length} lines of work: ${tally(work, 'runs')} run as native, ${tally(work, 'not yet')} not yet`);
    // How long each took, natively and in the browser's kernel (its own work: the program, not node starting).
    const timed = work.filter((w) => w.verdict === 'runs' && w.ms && w.nativeMs);
    for (const w of timed) console.log(`  ${String(w.nativeMs).padStart(6)} ms native  ${String(w.ms).padStart(6)} ms xlat  ${(w.ms / w.nativeMs).toFixed(2).padStart(6)}x  ${w.name}`);
    const geo = Math.exp(timed.reduce((a, w) => a + Math.log(w.ms / w.nativeMs), 0) / Math.max(1, timed.length));
    if (timed.length) console.log(`  geometric mean ${geo.toFixed(2)}x over ${timed.length}`);
  }
}

/** Lines of sh a Prompt runs, each named: what --version does not reach. */
const WORK = [
  ['pipeline', "printf 'b\\na\\nb\\n' | sort | uniq -c"],
  ['text tools', "echo 'a,b,c' | sed s/b/x/ | awk -F, '{print $2}' | tr a-z A-Z"],
  ['grep -r', "mkdir -p /tmp/g && echo needle > /tmp/g/f && grep -rn needle /tmp/g"],
  ['find and xargs', "mkdir -p /tmp/d/e && touch /tmp/d/e/x && find /tmp/d -type f | xargs ls"],
  ['a signal handler', "trap 'echo caught' USR1; kill -USR1 $$; echo after"],
  ['background job', "sleep 1 & wait; echo waited"],
  ['a pipe over 64 MiB', "dd if=/dev/zero bs=1000000 count=70 2>/dev/null | wc -c"],
  ['tar, gzip, xz, bzip2, zstd', "cd /tmp && echo x > f && tar -cf - f | gzip | gunzip | xz | unxz | bzip2 | bunzip2 | zstd -q | zstd -dq | tar -tf -"],
  ['sha256sum and openssl', "echo hi | sha256sum && echo hi | openssl dgst -sha256 -r"],
  ['curl file://', "echo hi > /tmp/c && curl -s file:///tmp/c"],
  ['git init, commit, log', "cd /tmp && git init -q r && cd r && git config user.email a@b && git config user.name a && echo hi > f && git add f && git commit -qm m && git log --oneline | wc -l"],
  ['git status', "cd /tmp && git init -q s && cd s && echo x > y && git status --short"],
  ['gcc', "cd /tmp && printf 'int main(void){return 42;}\\n' > a.c && gcc a.c -o a && ./a; echo $?"],
  ['make', "cd /tmp && printf 'all:\\n\\t@echo made\\n' > Makefile && make"],
  ['ssh-keygen', "ssh-keygen -q -t ed25519 -N '' -f /tmp/k && wc -l < /tmp/k.pub"],
  ['apk info', "apk info 2>/dev/null | wc -l"],
  ['l3 help', "l3 help | head -n 1"],
  ['nano --help', "nano --help | head -n 1"],
  // Work as heavy as a person's: threads, many processes, a parallel build, a history, floating point, signals and
  // timers, mmap, deep recursion, big pipelines, crypto, archives of many files.
  ['threads, mutexes, condition variables, atomics', `cd /tmp && cat > th.c <<'C'
#include <pthread.h>
#include <stdio.h>
#include <stdatomic.h>
static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER; static pthread_cond_t c = PTHREAD_COND_INITIALIZER;
static long total; static atomic_long fast; static int ready;
static void *work(void *a) { long n = (long)a, s = 0;
  pthread_mutex_lock(&m); while (!ready) pthread_cond_wait(&c, &m); pthread_mutex_unlock(&m);
  for (long i = 0; i < 200000; i++) { s += i % (n + 3); atomic_fetch_add(&fast, 1); }
  pthread_mutex_lock(&m); total += s; pthread_mutex_unlock(&m); return 0; }
int main(void) { pthread_t t[8]; for (long i = 0; i < 8; i++) pthread_create(&t[i], 0, work, (void *)i);
  pthread_mutex_lock(&m); ready = 1; pthread_cond_broadcast(&c); pthread_mutex_unlock(&m);
  for (int i = 0; i < 8; i++) pthread_join(t[i], 0); printf("%ld %ld\\n", total, (long)fast); return 0; }
C
gcc -O2 -pthread th.c -o th && ./th`],
  ['200 processes one after another', "i=0; while [ $i -lt 200 ]; do /usr/bin/true; i=$((i+1)); done; echo $i"],
  ['make -j4 over 8 files', `mkdir -p /tmp/mk && cd /tmp/mk && for k in 1 2 3 4 5 6 7 8; do printf 'int f%d(int x){int s=0;for(int i=0;i<x;i++)s+=i*%d%%7;return s;}\\n' $k $k > f$k.c; done
printf '#include <stdio.h>\\n' > main.c; for k in 1 2 3 4 5 6 7 8; do printf 'int f%d(int);\\n' $k >> main.c; done
printf 'int main(void){long s=0;' >> main.c; for k in 1 2 3 4 5 6 7 8; do printf 's+=f%d(100000);' $k >> main.c; done; printf 'printf("%%ld\\\\n",s);return 0;}\\n' >> main.c
printf 'OBJ=main.o f1.o f2.o f3.o f4.o f5.o f6.o f7.o f8.o\\nall: p\\np: $(OBJ)\\n\\tcc -o p $(OBJ)\\n%%.o: %%.c\\n\\tcc -O2 -c $<\\n' > Makefile
make -s -j4 && ./p`],
  ['git: 60 commits, a branch, a merge', `cd /tmp && git init -q h && cd h && git config user.email a@b && git config user.name a
i=0; while [ $i -lt 60 ]; do echo $i >> f; git add f; git commit -qm "c$i"; i=$((i+1)); done
git checkout -qb side && echo side > g && git add g && git commit -qm side && git checkout -q - && echo main >> f && git commit -qam main
git merge -q --no-edit side && git log --oneline | wc -l && git diff HEAD~3 --stat | tail -n 1`],
  ['floating point through libm', `cd /tmp && printf '#include <stdio.h>\\n#include <math.h>\\nint main(void){double s=0;for(int i=1;i<200000;i++)s+=sin(i)*cos(i/3.0)+sqrt(i)/log(i+1.0);printf("%%.6f\\\\n",s);return 0;}\\n' > fp.c && gcc -O2 fp.c -o fp -lm && ./fp`],
  ['SIGALRM, setitimer and setjmp', `cd /tmp && cat > al.c <<'C'
#include <signal.h>
#include <setjmp.h>
#include <stdio.h>
#include <sys/time.h>
static sigjmp_buf j; static volatile int n;
static void tick(int s) { (void)s; if (++n == 5) siglongjmp(j, 1); }
int main(void) { signal(SIGALRM, tick); struct itimerval t = {{0, 2000}, {0, 2000}}; setitimer(ITIMER_REAL, &t, 0);
  if (!sigsetjmp(j, 1)) for (;;) ; printf("ticks %d\\n", n); return 0; }
C
gcc -O2 al.c -o al && ./al`],
  ['mmap a file, write through it, read it back', `cd /tmp && cat > mm.c <<'C'
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>
int main(void) { int fd = open("mm.dat", O_RDWR | O_CREAT | O_TRUNC, 0644); ftruncate(fd, 1 << 20);
  unsigned char *p = mmap(0, 1 << 20, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  for (int i = 0; i < 1 << 20; i++) p[i] = i * 7; msync(p, 1 << 20, MS_SYNC); munmap(p, 1 << 20);
  unsigned char b[4096]; long s = 0; lseek(fd, 0, SEEK_SET); ssize_t r; while ((r = read(fd, b, sizeof b)) > 0) for (int i = 0; i < r; i++) s += b[i];
  printf("%ld\\n", s); return 0; }
C
gcc -O2 mm.c -o mm && ./mm`],
  ['recursion 100000 deep', `cd /tmp && printf '#include <stdio.h>\\nstatic long d(long n){volatile char pad[32];pad[0]=n;return n?d(n-1)+pad[0]%%3:0;}\\nint main(void){printf("%%ld\\\\n",d(100000));return 0;}\\n' > rc.c && gcc -O0 rc.c -o rc && ./rc`],
  ['sort, uniq and awk over 200000 lines', "seq 1 200000 | awk '{print $1 % 997}' | sort -n | uniq -c | sort -rn | head -n 3 | awk '{s+=$1} END {print s}'"],
  ['openssl AES, deterministic', "dd if=/dev/zero bs=1000 count=1000 2>/dev/null | openssl enc -aes-256-cbc -K 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f -iv 0f0e0d0c0b0a09080706050403020100 | sha256sum | cut -c1-16"],
  ['tar and gzip of 400 files', "mkdir -p /tmp/tz && cd /tmp/tz && i=0; while [ $i -lt 400 ]; do echo $i > f$i; i=$((i+1)); done; tar -cf - . | gzip | gunzip | tar -tf - | wc -l"],
];

/**
 * Programs whose output describes the machine they run on (its memory, its processes): the browser's kernel and the
 * sandbox here are different machines, so what they say is compared by its form, each line of the one as each line
 * of the other is made: the same header, the same labels, every process line a process line.
 */
const SHAPES = {
  '/usr/bin/free': (out) => out.split('\n').map((l) => l.trim().split(/\s+/)[0]),
  '/usr/bin/ps': (out) => out.split('\n').filter(Boolean).map((l) => /^\s*PID\b/.test(l) ? l.trim() : /^\s*\d+ \S+\s+\d+ [RSDZTW]\s+\S/.test(l) ? 'a process' : l),
};
function sameShape(path, a, b) {
  const shape = SHAPES[path];
  if (!shape) return false;
  const [x, y] = [shape(a), shape(b)];
  // The same lines, in kind: each process's line a process line, however many processes each machine has.
  const kinds = (v) => [...new Set(v)].sort().join('\n');
  return path === '/usr/bin/ps' ? kinds(x) === kinds(y) : x.join('\n') === y.join('\n');
}

/** Each of `items` ({name, what, path, args}) under xlat and natively, `jobs` at a time: one row each. */
async function compare(items, {web, rootDir, translator, jobs, seconds, fresh, kept}) {
  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const p = items[next++];
      // One after the other, so neither's time is the other's load.
      const started = performance.now();
      const native = {...await run('bwrap', [...sandbox(rootDir), p.path, ...p.args], {seconds, env: {}}), ms: Math.round(performance.now() - started)};
      const under = (env) => run(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify({web, path: p.path, args: p.args, translator, fresh, kept})], {seconds, env: {...process.env, ...env}});
      // Warm: run once first, keeping what it translates (a Prompt that ran it before).
      if (kept) await under({});
      // Timed as it runs; traced (every system call, which costs) only when it did not run, to say what it lacked.
      const xlat = await under({});
      let x = null;
      try { x = JSON.parse(xlat.stdout); } catch { /* ended without saying: killed, or the kernel threw */ }
      const nativeStatus = native.timedOut ? 'no end' : native.signal ? `signal ${native.signal}` : native.code;
      let verdict, why = '';
      if (xlat.timedOut) {
        if (native.timedOut) verdict = 'runs';
        else { verdict = 'not yet'; why = `no end within ${seconds} s`; }
      }
      else if (!x) { verdict = 'not yet'; why = (xlat.stderr.split('\n').filter((l) => l && !l.startsWith('[')).pop() ?? 'the kernel stopped').slice(0, 160); }
      else if (x.error) { verdict = 'not yet'; why = x.error.slice(0, 160); }
      else {
        const xs = x.status & 0x7f ? `signal ${x.status & 0x7f}` : x.status >> 8;
        const said = x.stderr.split('\n').find((l) => l.startsWith('xlat:'));
        if (said) { verdict = 'not yet'; why = said.slice(0, 160); }
        else if (xs === nativeStatus && (x.stdout === native.stdout || sameShape(p.path, x.stdout, native.stdout))) verdict = 'runs';
        else {
          verdict = 'not yet';
          why = `ends, differs: exit ${xs} (native ${nativeStatus})${x.stdout === native.stdout ? '' : `, says ${JSON.stringify(x.stdout.slice(0, 60))} (native ${JSON.stringify(native.stdout.slice(0, 60))})`}`;
          const err = x.stderr.split('\n').find((l) => l.trim());
          if (err) why += `; stderr ${JSON.stringify(err.slice(0, 100))}`;
        }
      }
      if (verdict !== 'runs') {
        // The system calls xlat has no answer for, by number, from a trace of a run again (a trace costs, so the run
        // timed has none).
        const trace = (await under({XLAT_SYSCALLS: '1'})).stderr;
        const missing = [...trace.matchAll(/syscall (\d+) \(none\)/g)].map((m) => Number(m[1]));
        const enosys = [...trace.matchAll(/\] syscall (\d+)[^\n]*\n\[\d+\]   = -38\n/g)].map((m) => Number(m[1]));
        const calls = [...new Set([...missing, ...enosys])].sort((a, b) => a - b);
        if (calls.length) why += `${why ? '; ' : ''}ENOSYS: ${calls.join(' ')}`;
      }
      rows.push({name: p.name, what: p.what, verdict, why, native: nativeStatus, ms: x?.ms ?? null, nativeMs: native.ms, first: (x?.stdout || native.stdout).split('\n')[0].slice(0, 80)});
      process.stderr.write(`${verdict.padEnd(14)} ${p.name}${why ? `  (${why})` : ''}\n`);
    }
  };
  await Promise.all(Array.from({length: jobs}, worker));
  return rows.sort((a, b) => (a.name < b.name ? -1 : 1));
}

if (process.argv[2] === '--child') await child(JSON.parse(process.argv[3]));
else await main();
