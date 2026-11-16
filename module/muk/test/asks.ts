// What a bundle asks: config.json, read as `src/muk.c` reads it. The same members and the same lists of the same
// lengths; null a member not there, a member given twice the second; a number what it says or refused; and the floor
// every box has put in (its own /dev, the paths of /proc and /sys that tell of a host hidden, no file of a mount a
// device, so many terminals and no more). What is refused is refused in muk.c's words, so the same config.json is
// answered the same on Linux and here (test/bundle/same.sh asks both). What a box here does of what was read, and
// what it does not do yet, is box.ts's.
//
// config.json asks, and the one who runs muk lends: `ids` is the lender's word for which of a host's users and groups
// a box may be (`--ids`). Where the machine is muk's own (a browser, node) there is no host's user to be, and each is
// the box's own: every one of them, the default here.

const decoder = new TextDecoder();
const utf8 = (bytes: Uint8Array): string => decoder.decode(bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice());

/** What refuses a bundle, in the words `muk run` says it in (without its name before them). */
export class Refused extends Error {}

export const MS = {RDONLY: 1, NOSUID: 2, NODEV: 4, NOEXEC: 8, SYNCHRONOUS: 16, DIRSYNC: 128, NOSYMFOLLOW: 256, NOATIME: 1024, NODIRATIME: 2048,
  BIND: 4096, REC: 16384, UNBINDABLE: 1 << 17, PRIVATE: 1 << 18, SLAVE: 1 << 19, SHARED: 1 << 20, RELATIME: 1 << 21, STRICTATIME: 1 << 24,
  LAZYTIME: 1 << 25} as const;
const MS_SPREAD = MS.UNBINDABLE | MS.PRIVATE | MS.SLAVE | MS.SHARED;
export const CLONE = {NEWNS: 0x00020000, NEWCGROUP: 0x02000000, NEWUTS: 0x04000000, NEWIPC: 0x08000000, NEWUSER: 0x10000000, NEWPID: 0x20000000,
  NEWNET: 0x40000000} as const;

const WORDS = 4096, MOUNTS = 128, PATHS = 64, LINES = 32, PTYS = 256;
/** The greatest a uid or a gid is (the one past it means none). */
export const ID = 0xfffffffen;

export const CAPS = ['CHOWN', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'LINUX_IMMUTABLE',
  'NET_BIND_SERVICE', 'NET_BROADCAST', 'NET_ADMIN', 'NET_RAW', 'IPC_LOCK', 'IPC_OWNER', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_CHROOT', 'SYS_PTRACE',
  'SYS_PACCT', 'SYS_ADMIN', 'SYS_BOOT', 'SYS_NICE', 'SYS_RESOURCE', 'SYS_TIME', 'SYS_TTY_CONFIG', 'MKNOD', 'LEASE', 'AUDIT_WRITE', 'AUDIT_CONTROL',
  'SETFCAP', 'MAC_OVERRIDE', 'MAC_ADMIN', 'SYSLOG', 'WAKE_ALARM', 'BLOCK_SUSPEND', 'AUDIT_READ', 'PERFMON', 'BPF', 'CHECKPOINT_RESTORE'];
const LIMITS = ['CPU', 'FSIZE', 'DATA', 'STACK', 'CORE', 'RSS', 'NPROC', 'NOFILE', 'MEMLOCK', 'AS', 'LOCKS', 'SIGPENDING', 'MSGQUEUE', 'NICE',
  'RTPRIO', 'RTTIME'];
const KINDS = ['bounding', 'effective', 'permitted', 'inheritable', 'ambient'] as const;
const MOUNTED = ['proc', 'sysfs', 'tmpfs', 'devpts', 'mqueue', 'cgroup', 'cgroup2'];
const SPACES = ['mount', 'cgroup', 'uts', 'ipc', 'user', 'pid', 'network'];
const SPACE = [CLONE.NEWNS, CLONE.NEWCGROUP, CLONE.NEWUTS, CLONE.NEWIPC, CLONE.NEWUSER, CLONE.NEWPID, CLONE.NEWNET];
/** A mount's options that are the kernel's flags (those that say how it spreads among them), and what each sets; a zero among the first twenty-five clears what the one before it sets. */
const OPTIONS = ['nosuid', 'suid', 'noexec', 'exec', 'nodev', 'dev', 'ro', 'rw', 'relatime', 'norelatime', 'strictatime', 'nostrictatime', 'bind',
  'rbind', 'noatime', 'atime', 'nodiratime', 'diratime', 'sync', 'async', 'dirsync', 'nosymfollow', 'symfollow', 'lazytime', 'nolazytime',
  'defaults', 'private', 'rprivate', 'slave', 'rslave', 'shared', 'rshared', 'unbindable', 'runbindable'];
const SETS = [MS.NOSUID, 0, MS.NOEXEC, 0, MS.NODEV, 0, MS.RDONLY, 0, MS.RELATIME, 0, MS.STRICTATIME, 0, MS.BIND, MS.BIND | MS.REC, MS.NOATIME, 0,
  MS.NODIRATIME, 0, MS.SYNCHRONOUS, 0, MS.DIRSYNC, MS.NOSYMFOLLOW, 0, MS.LAZYTIME, 0, 0, MS.PRIVATE, MS.PRIVATE | MS.REC, MS.SLAVE,
  MS.SLAVE | MS.REC, MS.SHARED, MS.SHARED | MS.REC, MS.UNBINDABLE, MS.UNBINDABLE | MS.REC];
/** The floor's paths (as every runtime's defaults have them): hidden, the first ten; read-only, the last five. */
const FLOOR_PROC = ['/proc/acpi', '/proc/asound', '/proc/kcore', '/proc/keys', '/proc/latency_stats', '/proc/timer_list', '/proc/timer_stats',
  '/proc/sched_debug', '/proc/scsi', '/proc/interrupts', '/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];
const FLOOR_HIDDEN = 10;
const FLOOR_SYS = ['/sys/firmware', '/sys/devices/virtual/powercap'];

/** One of config.json's mounts: where, its kind, what it takes (a bind's source), its flags, the flags it clears, how it spreads, the file system's own options; `fresh`: under a tmpfs mounted before it. */
export interface Mount { to: string; type: string | null; from: string | null; data: string | null; flags: number; clear: number; spread: number; fresh: boolean }
/** A line of a user namespace's map: so many ids from `inside` are those from `outside`. */
export interface Line { inside: bigint; outside: bigint; n: bigint }
/** What a bundle asks, the floor put in. */
export interface Asks {
  root: string | null; readOnly: boolean;
  args: string[]; env: string[]; cwd: string;
  terminal: boolean; rows: number; columns: number;
  uid: number; gid: number; groups: number[]; umask: number | null;
  /** bounding, effective, permitted, inheritable, ambient: a bit for each capability, by its number. */
  caps: [bigint, bigint, bigint, bigint, bigint];
  limits: {what: number; now: bigint; most: bigint}[];
  hostname: string | null; domainname: string | null;
  mounts: Mount[];
  masked: string[]; readonly: string[];
  /** The namespaces made for it (CLONE's bits), and those it joins by their paths. */
  spaces: number; joined: {flag: number; path: string}[];
  uids: Line[]; gids: Line[];
  /** In a user namespace, made or joined; it makes what is in its own /dev; it can be the host's root (in no user namespace of its own, or its own maps one of its users onto the host's root). */
  user: boolean; dev: boolean; host: boolean;
}

const bytes = new TextEncoder();
/** Refused, as muk.c's fail says it: what, then about what (its bytes, as config.json has them), so many bytes of them and no more. */
const refuse = (what: string, about: Uint8Array | string = ''): never => {
  const w = bytes.encode(what), a = typeof about === 'string' ? bytes.encode(about) : about, all = new Uint8Array(w.length + a.length);
  all.set(w);
  all.set(a, w.length);
  throw new Refused(utf8(all.subarray(0, 593)));
};
const bad = (why: string): never => refuse('config.json: ', why);

/** config.json's text (its bytes) as what it asks; `ids`: the first and last of a host's users and groups lent. Throws Refused. */
export function asks(text: Uint8Array, ids: {first: bigint; last: bigint} = {first: 0n, last: ID}): Asks {
  const end = text.length;
  if (end >= 1 << 20) bad('it is longer than is read');
  let j = 0;
  const at = (i: number): number => (i < end ? text[i] : 0);
  /** The next byte that is not between words (a space, or a byte below one; a NUL ends the text). */
  const peek = (): number => {
    for (;; j++) { const b = at(j); if (b > 32 || !b) return b; if (![9, 10, 13, 32].includes(b)) bad('it is not as JSON is written'); }
  };
  const take = (c: string): void => { if (peek() !== c.charCodeAt(0)) bad('it is not as JSON is written'); j++; };
  const hex4 = (): number => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = at(j++);
      const d = c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 97 + 10 : 16;
      if (d === 16) bad('a \\u is not four hex digits');
      v = v << 4 | d;
    }
    return v;
  };
  /** A string (one that is not UTF-8 is read with U+FFFD where it is not); `raw`: the bytes of the last one read. */
  let raw = text.subarray(0, 0);
  const string = (): string => {
    take('"');
    const from = j;
    while (at(j) !== 34 && at(j) !== 92 && at(j) >= 32) j++;
    if (at(j) === 34) return utf8(raw = text.subarray(from, j++));
    // (one with an escape in it, or that does not end: from where the first of them is)
    const out = Array.from(text.subarray(from, j));
    for (;;) {
      let c = at(j++);
      if (c === 34) break;
      if (c < 32) bad('a string does not end');
      if (c === 92) {
        c = at(j++);
        if (c === 110) c = 10;
        else if (c === 116) c = 9;
        else if (c === 114) c = 13;
        else if (c === 98) c = 8;
        else if (c === 102) c = 12;
        else if (c === 117) {
          c = hex4();
          if (c >= 0xd800 && c < 0xdc00 && at(j) === 92 && at(j + 1) === 117) {
            j += 2;
            c = 0x10000 + ((c - 0xd800) << 10) + ((hex4() - 0xdc00) & 0x3ff);
          }
          if (!c) bad('a string holds a NUL');
          if (c >= 0x10000) { out.push(0xf0 | c >> 18, 0x80 | (c >> 12 & 63), 0x80 | (c >> 6 & 63)); c = 0x80 | (c & 63); }
          else if (c >= 0x800) { out.push(0xe0 | c >> 12, 0x80 | (c >> 6 & 63)); c = 0x80 | (c & 63); }
          else if (c >= 0x80) { out.push(0xc0 | c >> 6); c = 0x80 | (c & 63); }
        } else if (c !== 34 && c !== 92 && c !== 47) bad('a string escapes what is not escaped');
      }
      out.push(c);
    }
    return utf8(raw = new Uint8Array(out));
  };
  /** What it asks that is not done: said, and the box not run without it. `key`: the member's, as it was read (or words). */
  let keyRaw = raw;
  const undone = (where: string, key: string | null = null): never => {
    const w = bytes.encode(where.slice(0, 60)), k = key === null ? keyRaw : bytes.encode(key), m = new Uint8Array(w.length + k.length);
    m.set(w);
    m.set(k, w.length);
    return refuse('config.json: it asks what is not done here: ', m.subarray(0, 199));
  };
  const noName = (): never => refuse('config.json: no such name: ', raw);
  const digit = (i: number): boolean => at(i) >= 48 && at(i) <= 57;
  /** A whole number from zero to `most`: none below zero, none with a fraction, none that is cut to fit. */
  const natural = (most: bigint): bigint => {
    peek();
    if (!digit(j)) bad('a whole number, zero or more, is wanted');
    let v = 0n;
    do {
      const d = BigInt(at(j++) - 48);
      if (d > most || v > (most - d) / 10n) bad('a number is greater than what it sets can be');
      v = v * 10n + d;
    } while (digit(j));
    if (at(j) === 46 || (at(j) | 32) === 101) bad('a whole number, zero or more, is wanted');
    return v;
  };
  const number = (most: number): number => Number(natural(BigInt(most)));
  const is = (word: string): boolean => { for (let i = 0; i < word.length; i++) if (at(j + i) !== word.charCodeAt(i)) return false; return true; };
  const boolean = (): boolean => {
    peek();
    if (is('true')) { j += 4; return true; }
    if (is('false')) { j += 5; return false; }
    return bad('true or false is wanted');
  };
  const skipString = (): void => {
    take('"');
    for (;;) {
      let c = at(j++);
      if (c === 34) return;
      if (c < 32) bad('a string does not end');
      if (c !== 92) continue;
      c = at(j++);
      if (c === 117) { hex4(); continue; }
      if (![34, 92, 47, 98, 102, 110, 114, 116].includes(c)) bad('a string escapes what is not escaped');
    }
  };
  /** Past one value, whatever it is. */
  const skip = (depth = 0): void => {
    if (depth > 128) bad('a value is nested too deeply');
    const c = peek();
    if (c === 34) { skipString(); return; }
    if (c === 123 || c === 91) {
      const close = c === 123 ? 125 : 93;
      j++;
      if (peek() === close) { j++; return; }
      for (;;) {
        if (c === 123) { skipString(); take(':'); }
        skip(depth + 1);
        if (peek() === close) { j++; return; }
        take(',');
      }
    }
    if (c === 116 || c === 102 || c === 110) {
      const word = c === 116 ? 'true' : c === 102 ? 'false' : 'null';
      for (const b of bytes.encode(word)) if (at(j++) !== b) bad('it is not as JSON is written');
      return;
    }
    if (c === 45) j++;
    if (at(j) === 48) j++;
    else { if (at(j) < 49 || at(j) > 57) bad('it is not as JSON is written'); while (digit(j)) j++; }
    if (at(j) === 46) { j++; if (!digit(j)) bad('it is not as JSON is written'); while (digit(j)) j++; }
    if (at(j) === 101 || at(j) === 69) { j++; if (at(j) === 43 || at(j) === 45) j++; if (!digit(j)) bad('it is not as JSON is written'); while (digit(j)) j++; }
  };
  /** Each member of the object the reader is at, by its key (null: as if the member were not there). */
  const object = (each: (key: string) => void): void => {
    take('{');
    for (let first = true;; first = false) {
      if (peek() === 125) { j++; return; }
      if (!first) take(',');
      const key = string(), its = raw;
      take(':');
      if (peek() === 110) {
        if (!is('null')) bad('it is not as JSON is written');
        j += 4;
        continue;
      }
      keyRaw = its;
      each(key);
    }
  };
  const array = (each: () => void): void => {
    take('[');
    for (let first = true;; first = false) {
      if (peek() === 93) { j++; return; }
      if (!first) take(',');
      each();
    }
  };
  const words = (most: number): string[] => {
    const into: string[] = []; // (a member given twice is the second, as every reader of JSON has it)
    array(() => {
      if (into.length === most) bad('a list is longer than is read');
      into.push(string());
    });
    return into;
  };

  const c: Asks = {root: null, readOnly: false, args: [], env: [], cwd: '', terminal: false, rows: 0, columns: 0, uid: 0, gid: 0, groups: [], umask: null,
    caps: [0n, 0n, 0n, 0n, 0n], limits: [], hostname: null, domainname: null, mounts: [], masked: [], readonly: [], spaces: 0, joined: [], uids: [], gids: [],
    user: false, dev: true, host: false};
  let cwd: string | null = null;

  const process = (): void => object((k) => {
    if (k === 'args') c.args = words(WORDS - 1);
    else if (k === 'env') c.env = words(WORDS - 1);
    else if (k === 'cwd') cwd = string();
    else if (k === 'noNewPrivileges') boolean(); // (the floor: it gains none, said or not)
    else if (k === 'terminal') c.terminal = boolean();
    else if (k === 'consoleSize') {
      object((k2) => {
        if (k2 === 'height') c.rows = number(65535);
        else if (k2 === 'width') c.columns = number(65535);
        else undone('process.consoleSize.');
      });
    } else if (k === 'user') {
      object((k2) => {
        if (k2 === 'uid') c.uid = Number(natural(ID));
        else if (k2 === 'gid') c.gid = Number(natural(ID));
        else if (k2 === 'umask') c.umask = number(0o777);
        else if (k2 === 'additionalGids') {
          c.groups = [];
          array(() => {
            if (c.groups.length === PATHS) bad('a list is longer than is read');
            c.groups.push(Number(natural(ID)));
          });
        } else if (k2 === 'username') skip(); // (another system's)
        else undone('process.user.');
      });
    } else if (k === 'capabilities') {
      c.caps = [0n, 0n, 0n, 0n, 0n];
      object((k2) => {
        const kind = (KINDS as readonly string[]).indexOf(k2);
        if (kind < 0) undone('process.capabilities.');
        c.caps[kind] = 0n;
        array(() => {
          const whole = string(), cap = whole.startsWith('CAP_') ? CAPS.indexOf(whole.slice(4)) : -1;
          if (cap < 0) noName();
          c.caps[kind] |= 1n << BigInt(cap);
        });
      });
    } else if (k === 'rlimits') {
      c.limits = [];
      array(() => {
        if (c.limits.length === 16) bad('a list is longer than is read');
        const limit = {what: -1, now: 0n, most: 0n};
        object((k2) => {
          if (k2 === 'type') {
            const whole = string();
            limit.what = whole.startsWith('RLIMIT_') ? LIMITS.indexOf(whole.slice(7)) : -1;
            if (limit.what < 0) noName();
          } else if (k2 === 'soft') limit.now = natural(0xffffffffffffffffn);
          else if (k2 === 'hard') limit.most = natural(0xffffffffffffffffn);
          else undone('process.rlimits.');
        });
        if (limit.what < 0) bad('process.rlimits: a limit does not say which it is');
        // OCI: each resource limit's type occurs at most once, even if its values agree.
        if (c.limits.some((prior) => prior.what === limit.what)) bad('process.rlimits: one kind is there twice');
        c.limits.push(limit);
      });
    } else undone('process.'); // (apparmorProfile, selinuxLabel, oomScoreAdj, scheduler, ioPriority: none is set)
  });

  /** A mount's options: those that are the kernel's flags, those that say how it spreads, and the rest, the file system's own, put together again with commas between. */
  const options = (m: Mount): void => {
    const rest: string[] = [];
    array(() => {
      const o = string(), i = OPTIONS.indexOf(o); // (one that is no flag, as every one with a value is, is the file system's own)
      if (i < 0) {
        if (rest.length === 32) bad('a mount has more options than are read');
        rest.push(o);
      } else if (SETS[i] & MS_SPREAD) m.spread = SETS[i];
      else if (SETS[i]) { m.flags |= SETS[i]; m.clear &= ~SETS[i]; }
      else if (i < 25) { m.flags &= ~SETS[i - 1]; m.clear |= SETS[i - 1]; }
    });
    if (rest.length) m.data = rest.join(',');
  };
  const lines = (): Line[] => {
    const into: Line[] = [];
    array(() => {
      if (into.length === LINES) bad('a list is longer than is read');
      const line = {inside: 0n, outside: 0n, n: 0n};
      object((k) => {
        if (k === 'containerID') line.inside = natural(ID);
        else if (k === 'hostID') line.outside = natural(ID);
        else if (k === 'size') line.n = natural(ID + 1n);
        else undone('linux.uidMappings.');
      });
      into.push(line);
    });
    return into;
  };
  const linux = (): void => object((k) => {
    if (k === 'namespaces') {
      c.spaces = 0; c.joined = [];
      let seen = 0;
      array(() => {
        let kind = -1, path: string | null = null;
        object((k2) => {
          if (k2 === 'type') {
            const name = string();
            if ((kind = SPACES.indexOf(name)) < 0) refuse('config.json: no such namespace is made here: ', raw);
          } else if (k2 === 'path') path = string();
          else undone('linux.namespaces.');
        });
        if (kind < 0) bad('a namespace has no type');
        if (seen & SPACE[kind]) bad('linux.namespaces: one kind is there twice');
        seen |= SPACE[kind];
        if (!path) c.spaces |= SPACE[kind];
        else {
          if (SPACE[kind] === CLONE.NEWNS) bad('a mount namespace is not joined yet');
          if (c.joined.length === 8) bad('a list is longer than is read');
          c.joined.push({flag: SPACE[kind], path});
        }
      });
    } else if (k === 'uidMappings') c.uids = lines();
    else if (k === 'gidMappings') c.gids = lines();
    else if (k === 'maskedPaths') c.masked = words(PATHS);
    else if (k === 'readonlyPaths') c.readonly = words(PATHS);
    else if (k === 'resources') {
      // None asked for is none to set; devices all denied is what the floor is (no device but what muk made).
      object((k2) => {
        if (k2 !== 'devices') undone('linux.resources.'); // (no cgroup is made yet)
        array(() => bad('linux.resources.devices: device rules are not enforced here'));
      });
    } else undone('linux.'); // (seccomp, cgroupsPath, sysctl, devices, rootfsPropagation: a box is not run without what it asks for)
  });

  let version = false;
  object((k) => {
    if (k === 'ociVersion') { if (!/^1\.[0-2]\.(0|[1-9][0-9]*)$/.test(string())) bad('ociVersion: supported versions are 1.0.x through 1.2.x'); version = true; }
    else if (k === 'annotations') object(() => { string(); });
    else if (k === 'process') process();
    else if (k === 'root') {
      object((k2) => {
        if (k2 === 'path') c.root = string();
        else if (k2 === 'readonly') c.readOnly = boolean();
        else undone('root.');
      });
    } else if (k === 'hostname') c.hostname = string();
    else if (k === 'domainname') c.domainname = string();
    else if (k === 'mounts') {
      c.mounts = []; c.dev = true;
      array(() => {
        if (c.mounts.length === MOUNTS) bad('a list is longer than is read');
        const m: Mount = {to: '', type: null, from: null, data: null, flags: 0, clear: 0, spread: 0, fresh: false};
        let to: string | null = null, kindRaw: Uint8Array | string = '(none is said)';
        object((k2) => {
          if (k2 === 'destination') to = string();
          else if (k2 === 'type') { m.type = string(); kindRaw = m.type ? raw : '(none is said)'; }
          else if (k2 === 'source') m.from = string();
          else if (k2 === 'options') options(m);
          else undone('mounts.'); // (uidMappings, gidMappings: a mount is not given other owners)
        });
        if (!to || (to as string)[0] !== '/') bad("a mount's destination is not a path from the root");
        m.to = to!;
        if (m.type === 'bind') m.flags |= MS.BIND;
        // What is mounted in a box: what was lent (a bind), or one of the kinds that are a box's own, each made new for
        // it. And a proc at /proc, a sysfs at /sys: where the floor hides what they tell of a host.
        if (!(m.flags & MS.BIND)) {
          const kind = m.type ? MOUNTED.indexOf(m.type) : -1;
          if (kind < 0) refuse('config.json: mounts: no such kind is mounted in a box: ', kindRaw);
          if (kind === 6) m.type = 'cgroup';
          if ((kind === 0 && m.to !== '/proc') || (kind === 1 && m.to !== '/sys')) bad('mounts: a proc is mounted at /proc and a sysfs at /sys, nowhere else');
        }
        // Under a tmpfs mounted before it, nothing is there yet to mount it on: made first, not found missing.
        for (const o of c.mounts) if (o.type === 'tmpfs' && m.to.startsWith(o.to) && m.to[o.to.length] === '/') m.fresh = true;
        // What is in /dev is made here, unless /dev is the host's, bound.
        if (m.to === '/dev' && m.flags & MS.BIND) c.dev = false;
        c.mounts.push(m);
      });
    } else if (k === 'linux') linux();
    else if (k === 'hooks') object(() => array(() => bad('hooks: none is run yet'))); // (a kind with none in it asks for nothing)
    else skip(); // (ociVersion, annotations, and what other systems read)
  });
  peek();
  if (j !== end) bad('something follows it');
  if (!version) bad('ociVersion: a supported version is required');
  if (!c.args.length) bad('process.args: nothing to run');
  if (!cwd || (cwd as string)[0] !== '/') bad('process.cwd: where it runs, a path from the root');
  c.cwd = cwd!;
  if (!(c.spaces & CLONE.NEWNS)) bad('linux.namespaces: a box has a mount namespace of its own');
  if (c.spaces & CLONE.NEWUSER && (!c.uids.length || !c.gids.length)) bad('a user namespace has uidMappings and gidMappings');

  // The floor. Its namespaces: each its own or another box's; a cgroup namespace besides.
  let own = c.spaces;
  for (const s of c.joined) own |= s.flag;
  if (~own & (CLONE.NEWPID | CLONE.NEWIPC | CLONE.NEWUTS)) bad("linux.namespaces: a box has pid, ipc and uts namespaces of its own (or another box's): the host's are never its");
  if (!(own & CLONE.NEWNET)) bad("linux.namespaces: a box has a network namespace of its own, or one lent it by its path (--lend): the host's is not its for saying nothing");
  if (!(own & CLONE.NEWCGROUP)) c.spaces |= CLONE.NEWCGROUP;
  c.user = (own & CLONE.NEWUSER) !== 0;
  const caps = c.caps[0] | c.caps[1] | c.caps[2] | c.caps[3] | c.caps[4];
  // Who it is on the host: each of the host's users and groups it can be is one lent.
  const notLent = "it would be one of the host's users or groups that was not lent (--ids)";
  const lent = (id: bigint): boolean => id >= ids.first && id <= ids.last;
  c.host = !(c.spaces & CLONE.NEWUSER);
  if (c.spaces & CLONE.NEWUSER) {
    for (const l of c.uids) { if (!l.n || l.outside < ids.first || l.outside + l.n - 1n > ids.last) bad(notLent); c.host ||= !l.outside; }
    for (const l of c.gids) if (!l.n || l.outside < ids.first || l.outside + l.n - 1n > ids.last) bad(notLent);
  } else if (!c.user) {
    let all = caps >> 6n & 1n || caps >> 7n & 1n ? !ids.first && ids.last >= ID : lent(BigInt(c.uid)) && lent(BigInt(c.gid));
    for (const g of c.groups) all &&= lent(BigInt(g));
    if (!all) bad(notLent);
  }
  // What it may do, outside a user namespace, is done to the host: it has there, at most, what is over its own files
  // and processes and (in a network namespace made for it) its own network.
  if (!c.user) {
    const over = caps & ~(0xb00485ffn | (c.spaces & CLONE.NEWNET ? 0x3800n : 0n));
    if (over) {
      let cap = 0;
      while (!(over >> BigInt(cap) & 1n)) cap++;
      refuse("config.json: process.capabilities: one over the host itself, a box's only in a user namespace: CAP_", CAPS[cap]);
    }
  }
  // A /dev of its own, where config.json mounts none: before everything else, since what is mounted under it comes after it.
  const has = (to: string): boolean => c.mounts.some((m) => m.to === to);
  const hasProc = has('/proc'), hasSys = has('/sys');
  if (!has('/dev')) {
    if (c.mounts.length === MOUNTS) bad('a list is longer than is read');
    for (const m of c.mounts) if (m.to.startsWith('/dev/')) m.fresh = true;
    c.mounts.unshift({to: '/dev', type: 'tmpfs', from: null, data: 'mode=755,size=65536k', flags: MS.NOSUID | MS.STRICTATIME, clear: 0, spread: 0, fresh: false});
  }
  // What of /proc and /sys tells of the host or changes it: hidden, or read-only, to one who is root there.
  if (c.host && (hasProc || hasSys)) {
    const listed = new Set([...c.masked, ...c.readonly]);
    FLOOR_PROC.forEach((path, row) => {
      if (!hasProc || listed.has(path)) return;
      const into = row < FLOOR_HIDDEN ? c.masked : c.readonly;
      if (into.length === PATHS) bad('a list is longer than is read');
      into.push(path);
    });
    for (const path of hasSys ? FLOOR_SYS : []) {
      if (listed.has(path)) continue;
      if (c.masked.length === PATHS) bad('a list is longer than is read');
      c.masked.push(path);
    }
  }
  // No file of a mount is a device, but in the /dev that is the box's own and among its terminals; one that can be
  // the host's root reads a /sys and its cgroups, and writes neither; and a box has so many terminals and no more.
  for (const m of c.mounts) {
    if (m.flags & MS.BIND) continue; // (a bind's, when what it takes is opened)
    const pts = m.type === 'devpts', groups = m.type === 'cgroup';
    if (!pts && !(c.dev && m.to === '/dev' && m.type === 'tmpfs')) m.flags |= MS.NODEV;
    if (c.host && (groups || m.type === 'sysfs')) m.flags |= MS.RDONLY;
    if (groups) m.data = null;
    if (pts) m.data = terminals(m.data);
  }
  return c;
}

/** A devpts's own options, with the most terminals it has: PTYS, where it asks for none or for more. */
function terminals(data: string | null): string {
  let fits = false; // (the kernel takes the last it is told)
  for (const o of (data ?? '').split(',')) if (o.startsWith('max=')) fits = /^max=\d+$/.test(o) && Number(o.slice(4)) <= PTYS;
  return fits ? data! : data ? `${data},max=${PTYS}` : `max=${PTYS}`;
}
