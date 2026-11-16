// /sys as far as a program looks: the processors, the kernel's few files, and the places other file systems are
// mounted under it (the cgroups). Made from the kernel as it is read.

import {E, Super} from './fs.ts';
import type {Entry} from './fs.ts';
import {Listing, Made} from './made.ts';
import type {Kern} from './parts.ts';
import {processors} from '../host.ts';

/** A /sys of `kernel`: the file system. */
export function sysfs(kernel: Kern): Super {
  void kernel;
  const dir = (entries: Record<string, Entry>): Listing => { const m = new Map(Object.entries(entries)); return new Listing(() => m); };
  const cpus = (): string => { const n = processors(); return n > 1 ? `0-${n - 1}\n` : '0\n'; };
  let helper = '';
  const root = dir({
    block: dir({}), bus: dir({}), class: dir({}), dev: dir({block: dir({}), char: dir({})}), module: dir({}), power: dir({}),
    devices: dir({
      system: dir({cpu: dir({online: new Made(cpus), possible: new Made(cpus), present: new Made(cpus)})}),
      virtual: dir({}),
    }),
    fs: dir({cgroup: dir({})}),
    kernel: dir({
      // (what the machine runs when a device comes or goes: kept as written, and nothing is run)
      uevent_helper: new Made(() => helper + '\n', 0o644, (text) => { helper = text.replace(/\n$/, ''); }),
      mm: dir({transparent_hugepage: dir({enabled: new Made(() => 'always madvise [never]\n')})}),
    }),
  });
  root.refuses = E.PERM;
  return new Super('sysfs', 0x62656572, root, 'sysfs');
}
