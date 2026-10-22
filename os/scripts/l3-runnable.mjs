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
//   node scripts/l3-runnable.mjs WEB ROOT_DIR [--out FILE.md] [--json FILE] [--jobs N] [--only REGEX] [--work-only] [--seconds N]
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


/** One program under xlat, in this process: prints {status, stdout, stderr, error?, ms} as JSON. */
async function child({web, path, args, translator}) {
  const {Vfs} = await import('../../xlat/runtime/fs.mjs');
  const {mountPack} = await import('../../xlat/runtime/pack.mjs');
  const {Kernel} = await import('../../xlat/runtime/process.mjs');
  const {loadTranslator} = await import('../../xlat/runtime/translator.mjs');
  const w = openWeb(web);
  const translate = await loadTranslator(w.index.translator ? w.blob(w.index.translator) : readFileSync(translator));
  const vfs = new Vfs();
  // As the page gives them: each program translated ahead of time, with its bytes.
  const ready = (w.index.translations ?? []).map((t) => {
    const f = w.index.files.find((x) => x.path === t.path);
    vfs.writeFile(t.path, new Uint8Array(w.blob(t.elf)), f.mode);
    return {path: t.path, module: new WebAssembly.Module(w.blob(t.wasm))};
  });
  mountPack(vfs, w.index, (pack, at, len) => { const b = Buffer.alloc(len); w.readRange(pack, at, len, b); return new Uint8Array(b); }, (b) => new Uint8Array(w.unzstd(b)));
  vfs.mkdirp('/root');
  let stdout = '', stderr = '';
  const dec = new TextDecoder();
  const kernel = new Kernel({vfs, translate, console: {
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
  try { status = kernel.spawn(path, [path.split('/').pop(), ...args], ENV, '/root'); }
  catch (e) { error = e instanceof Error ? e.message.split('\n')[0] : String(e); }
  process.stdout.write(JSON.stringify({status, stdout, stderr, error, ms: Math.round(performance.now() - t)}));
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
  const rows = await compare(list.map((p) => ({name: p.path, what: p.type, path: p.path, args: ['--version']})), {web, rootDir, translator, jobs, seconds});
  // Work a person does in a Prompt, each a line of sh, compared the same way: what --version cannot show (fork, pipes, signals, threads).
  const work = only ? [] : await compare(WORK.map(([name, line]) => ({name, what: line, path: '/usr/bin/sh', args: ['-c', line]})), {web, rootDir, translator, jobs, seconds: seconds * 4});
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
  if (work.length) console.log(`${work.length} lines of work: ${tally(work, 'runs')} run as native, ${tally(work, 'not yet')} not yet`);
}

/** Lines of sh a Prompt runs, each named: what --version does not reach. */
const WORK = [
  ['pipeline', "printf 'b\\na\\nb\\n' | sort | uniq -c"],
  ['text tools', "echo 'a,b,c' | sed s/b/x/ | awk -F, '{print $2}' | tr a-z A-Z"],
  ['grep -r', "mkdir -p /tmp/g && echo needle > /tmp/g/f && grep -rn needle /tmp/g"],
  ['find and xargs', "mkdir -p /tmp/d/e && touch /tmp/d/e/x && find /tmp/d -type f | xargs ls"],
  ['a signal handler', "trap 'echo caught' USR1; kill -USR1 $$; echo after"],
  ['background job', "sleep 1 & wait; echo waited"],
  ['a pipe over 64 MiB', "head -c 70000000 /dev/zero | wc -c"],
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
];

/** Each of `items` ({name, what, path, args}) under xlat and natively, `jobs` at a time: one row each. */
async function compare(items, {web, rootDir, translator, jobs, seconds}) {
  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const p = items[next++];
      const [native, xlat] = await Promise.all([
        run('bwrap', [...sandbox(rootDir), p.path, ...p.args], {seconds, env: {}}),
        run(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify({web, path: p.path, args: p.args, translator})],
          {seconds, env: {...process.env, XLAT_SYSCALLS: '1'}}),
      ]);
      let x = null;
      try { x = JSON.parse(xlat.stdout); } catch { /* ended without saying: killed, or the kernel threw */ }
      // The system calls xlat has no answer for, by number, from its trace.
      const missing = [...new Set([...xlat.stderr.matchAll(/syscall (\d+) \(none\)/g)].map((m) => Number(m[1])))];
      const enosys = [...new Set([...xlat.stderr.matchAll(/\] syscall (\d+)[^\n]*\n\[\d+\]   = -38\n/g)].map((m) => Number(m[1])))];
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
        else if (xs === nativeStatus && x.stdout === native.stdout) verdict = 'runs';
        else {
          verdict = 'not yet';
          why = `ends, differs: exit ${xs} (native ${nativeStatus})${x.stdout === native.stdout ? '' : `, says ${JSON.stringify(x.stdout.slice(0, 60))} (native ${JSON.stringify(native.stdout.slice(0, 60))})`}`;
          const err = x.stderr.split('\n').find((l) => l.trim());
          if (err) why += `; stderr ${JSON.stringify(err.slice(0, 100))}`;
        }
      }
      const calls = [...new Set([...missing, ...enosys])].sort((a, b) => a - b);
      if (calls.length && verdict !== 'runs') why += `${why ? '; ' : ''}ENOSYS: ${calls.join(' ')}`;
      rows.push({name: p.name, what: p.what, verdict, why, native: nativeStatus, ms: x?.ms ?? null, first: (x?.stdout || native.stdout).split('\n')[0].slice(0, 80)});
      process.stderr.write(`${verdict.padEnd(14)} ${p.name}${why ? `  (${why})` : ''}\n`);
    }
  };
  await Promise.all(Array.from({length: jobs}, worker));
  return rows.sort((a, b) => (a.name < b.name ? -1 : 1));
}

if (process.argv[2] === '--child') await child(JSON.parse(process.argv[3]));
else await main();
