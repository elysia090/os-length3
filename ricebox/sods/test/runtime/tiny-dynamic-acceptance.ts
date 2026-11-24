// Test-owned positive witness. Importing or preparing it never admits a guest.
// Only a separately reviewed host supervisor may call run(), after attesting the
// actual sealed payload's limits, egress, output capture, and independent watchdog.
import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync} from 'node:fs';
import {join} from 'node:path';
import {openDistribution} from '../../../distribution/deployment/local.ts';
import {canonicalPackedFileSet} from '../../../distribution/format/executable-source.ts';
import {prepareTree} from '../../../distribution/runtime/prepared-tree.ts';
import {captureMappedLibraries} from '../../runtime/linux/mapped-libraries.ts';
import type {Console} from '../../runtime/linux/parts.ts';
import {Kernel, prepareMappedInitial, type Pumped} from '../../runtime/linux/process.ts';
import {loadTranslator} from '../../runtime/translate.ts';

const indexPin = '63afcb4b01dd613d6fac278bd3c0ecf833750a6e2ee79e7f3e9271145018eb16';
const translatorPin = '0fb90238f257ce02bdddd184a9df1534bed1e3f6accc53170ea7c52e7fd3aedb';
const lib = '/usr/lib/x86_64-linux-gnu';
const app = '/usr/bin/ricebox-pie-fixture', ld = lib + '/ld-linux-x86-64.so.2';
const members = [
  [app, '8028e1aba59525173a1245f7366b021ec2e4d124fff4b0562fa61881695d86cf'],
  [ld, '8642358c60bdf4579911381070c69cc7b1a447809b73d483ce799c4421609d21'],
  [lib + '/libc.so.6', 'cc7377e8816cefadbb4ee083f5387f67a4a883d90bc273160842a6ac075af662'],
  [lib + '/libricebox-pie-fixture.so.1', '56adf27180e9b67919f95bc8cb8e5f8c2ffebf9bbe84b992bcc0202f89f80ea5'],
] as const;
const expectedStdout = new TextEncoder().encode('dynamic-pie:42\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
function need(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error('Tiny dynamic acceptance: ' + why);
}

function pinned(path: string, size: number, sha256: string, role: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    need(stat.isFile() && stat.size === size, role);
    const bytes = new Uint8Array(size);
    need(readSync(fd, bytes, 0, size, 0) === size && digest(bytes).toString('hex') === sha256, role);
    return bytes;
  } finally { closeSync(fd); }
}

export function tinyDynamicConsole() {
  const channels = [1, 2].map(() => ({bytes: new Uint8Array(1024), used: 0})), eof = new Uint8Array(0);
  let overflow = false;
  const console: Console = {
    interactive: false, read: () => eof, ready: () => true, pending: () => 0,
    write(fd, bytes) {
      const channel = fd === 1 ? channels[0] : fd === 2 ? channels[1] : undefined;
      if (!channel || bytes.length > channel.bytes.length - channel.used) { overflow = true; return; }
      if (!overflow) { channel.bytes.set(bytes, channel.used); channel.used += bytes.length; }
    },
  };
  const outcome = (pumped: Pumped, kernelStatus: number | null, guestStatus: number | undefined, stops: number) => {
    const [a, b] = channels;
    need(!overflow && a.used === expectedStdout.length && b.used === 0 &&
      expectedStdout.every((byte, i) => a.bytes[i] === byte), 'guest output is not the exact stdout and empty stderr');
    need(!pumped.waiting && pumped.status === 0 && kernelStatus === 0 && guestStatus === 0 && stops === 1,
      'no single normal zero-status guest stop');
    return {stdout: a.bytes.slice(0, a.used), stderr: b.bytes.slice(0, b.used), status: 0, stopReceipts: 1} as const;
  };
  return {console, outcome};
}

/** webroot must be the supervisor's immutable, independently pinned local input.
 * A caller may verify and close it offline without creating a Kernel. */
export async function prepareTinyDynamicAcceptance(webroot: string, mukPath: string) {
  pinned(join(webroot, 'webroot.json'), 655, '759dd0adfe9d9304016d2e0ad8c44c2c002f506bf07667f935e8c5467a8fd76c', 'webroot pin');
  pinned(join(webroot, 'index-' + indexPin + '.json'), 1521, indexPin, 'index pin');
  const muk = pinned(mukPath, 65456, '0668fceb53911c4a9f89f013ce94c92eeac9df62754dfba4bc563fe7384c6348', 'Muk pin');
  const stage = openDistribution(webroot);
  try {
    need(stage.about.index.sha256 === indexPin, 'index agreement');
    stage.checkAll();
    const selected = canonicalPackedFileSet(stage.index, members.map(row => row[0]));
    for (const [path, hash] of members) {
      const file = stage.index.files.find(row => row.path === path);
      need(file && digest(stage.read(file)).toString('hex') === hash, 'fixture member pin');
    }
    const artifact = stage.blob(stage.index.translator);
    need(digest(artifact).toString('hex') === translatorPin, 'decoded translator pin');
    const translate = await loadTranslator(artifact);
    need(translate.mapped && translate.describeDynamic, 'mapped translator');
    const {vfs, sources: captured} = prepareTree({muk, captureSources: selected, root: {index: stage.index, reading: {
      range: (name, at, len) => stage.readRange(name, at, len, new Uint8Array(len)),
      sha256: digest, decode: stage.unzstd,
    }}});
    const loader = vfs.lookup(ld);
    need(loader && vfs.lookup('/lib64/ld-linux-x86-64.so.2') === loader, 'canonical interpreter link');
    const [main, interpreter, ...deps] = selected.map(row => captured.get(row.origin)!);
    const sources = {main, interpreter, libraries: captureMappedLibraries(vfs, deps)};

    let unused = true;
    return {
      close() { if (unused) { unused = false; stage.close(); } },
      run() {
        need(unused, 'acceptance body is unavailable or already used');
        unused = false;
        const output = tinyDynamicConsole();
        const kernel = new Kernel({vfs, translate, console: output.console});
        let stops = 0;
        kernel.stopped = () => { stops++; };
        const held = prepareMappedInitial(kernel, {path: app, argv: [app, 'check'], env: ['LC_ALL=C']}, sources, '/usr/bin');
        try { held.checkStart(); }
        catch (error) { held.discard(); throw error; }
        // Keep the pack reader with any unresolved run. The supervisor owns
        // shutdown on rejection or waiting; never replay or close its inputs here.
        held.publishInitial();
        const p = kernel.initOf(), task = p?.own, memory = p?.memory;
        need(p && task && memory?.mappedVm && p.pid === 1 && p.noNewPrivs && !p.image &&
          p.exe === app && p.exeAt?.node === vfs.lookup(app) && kernel.runq.length === 1 && kernel.runq[0] === task,
          'ordinary queued mapped init');
        const {code} = memory.mappedVm, {fds, fs} = p, entry = task.context().rip;
        const stdio = [0, 1, 2].map(fd => fds.get(fd));
        need(code.find(entry, code.generation)?.text.role === 'interpreter' && stdio.every(Boolean), 'real interpreter entry and stdio');

        const result = output.outcome(kernel.pump(), kernel.status, p.exitStatus, stops);
        need(task.dead && !p.tasks.size && !kernel.current && !kernel.procs.size && !kernel.tasks.size &&
          !kernel.runq.length && !kernel.blocked.size && !p.cgroup.procs.size &&
          p.memory === null && memory.users === 0 && !kernel.spareMemories.includes(memory) &&
          !code.find(entry, code.generation) && !fs.users && !fds.holders && !fds.slots.size && stdio.every(fd => fd?.closed) &&
          kernel.retireInitialMounts(), 'guest owner not retired');
        stage.close();
        return {...result, pumps: 1 as const, guestRetired: true as const};
      },
    };
  } catch (error) { stage.close(); throw error; }
}
