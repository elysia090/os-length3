// What same.sh runs: a corpus of config.jsons, each asked of `muk run` (Linux) and of the test-only asks.ts.
//
//   node same.ts MUK PROBE DIR
//
// muk answers a config.json it will not run with `muk: config.json: WORDS` before any box is made; the reader here
// must refuse the same one in the same WORDS, and must read every one muk reads. (What muk refuses only once it
// makes the box, a bind with no source, a limit above the lender's, a terminal no one takes, a path not lent, is the
// box's to say: box.ts, in the same words.)
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {asks, ID, Refused} from './asks.ts';

const [muk, probe, dir] = process.argv.slice(2);
const bundle = join(dir, 'same');
mkdirSync(join(bundle, 'rootfs'), {recursive: true});
copyFileSync(probe, join(bundle, 'rootfs', 'probe'));

/** The bundle `runc spec` writes, with a little more of what can be asked. */
const base = {
  ociVersion: '1.2.0',
  process: {
    terminal: false, consoleSize: {height: 24, width: 80},
    user: {uid: 0, gid: 0, umask: 18, additionalGids: [0, 5]},
    args: ['/probe'], env: ['PATH=/bin', 'TERM=xterm'], cwd: '/',
    capabilities: {bounding: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'], effective: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'],
      permitted: ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE'], inheritable: [], ambient: []},
    rlimits: [{type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024}], noNewPrivileges: true,
  },
  root: {path: 'rootfs', readonly: true},
  hostname: 'box', domainname: 'boxes',
  mounts: [
    {destination: '/proc', type: 'proc', source: 'proc'},
    {destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k']},
    {destination: '/dev/pts', type: 'devpts', source: 'devpts', options: ['nosuid', 'noexec', 'newinstance', 'ptmxmode=0666', 'mode=0620', 'gid=5']},
    {destination: '/dev/shm', type: 'tmpfs', source: 'shm', options: ['nosuid', 'noexec', 'nodev', 'mode=1777', 'size=65536k']},
    {destination: '/dev/mqueue', type: 'mqueue', source: 'mqueue', options: ['nosuid', 'noexec', 'nodev']},
    {destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro']},
    {destination: '/sys/fs/cgroup', type: 'cgroup', source: 'cgroup', options: ['nosuid', 'noexec', 'nodev', 'relatime', 'ro']},
  ],
  linux: {
    resources: {devices: [] as {allow: boolean; access: string}[]},
    namespaces: [{type: 'pid'}, {type: 'network'}, {type: 'ipc'}, {type: 'uts'}, {type: 'mount'}, {type: 'cgroup'}],
    maskedPaths: ['/proc/acpi', '/proc/kcore', '/sys/firmware'], readonlyPaths: ['/proc/bus', '/proc/sys'],
  },
};
type Json = Record<string, unknown>;
const made = (change: (c: typeof base & Json) => void): string => { const c = structuredClone(base) as typeof base & Json; change(c); return JSON.stringify(c, null, 2); };
const text = JSON.stringify(base, null, 2);

/** A case: config.json's bytes, and what was lent of the host's users (`--ids`; root's muk lends none until told). */
interface Case { name: string; bytes: Uint8Array; lent: boolean }
const cases: Case[] = [];
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const add = (name: string, config: string | Uint8Array, lent = true): void => { cases.push({name, bytes: typeof config === 'string' ? bytesOf(config) : config, lent}); };

add('as runc spec writes it', text);
// Each thing it can ask wrongly, and each it can ask that is not done.
const wrong: [string, (c: typeof base & Json) => void][] = [
  ['nothing to run', (c) => { c.process.args = []; }],
  ['no cwd', (c) => { delete (c.process as Json).cwd; }],
  ['a cwd not from the root', (c) => { c.process.cwd = 'here'; }],
  ['a console size member unknown', (c) => { (c.process.consoleSize as Json).depth = 1; }],
  ['a user member unknown', (c) => { (c.process.user as Json).shell = '/bin/sh'; }],
  ['a username', (c) => { (c.process.user as Json).username = 'root'; }],
  ['a uid too great', (c) => { (c.process.user as Json).uid = 4294967295; }],
  ['a uid past 32 bits', (c) => { (c.process.user as Json).uid = 4294967296; }],
  ['a umask too great', (c) => { c.process.user.umask = 512; }],
  ['sixty-five groups', (c) => { c.process.user.additionalGids = Array.from({length: 65}, () => 0); }],
  ['a kind of capability unknown', (c) => { (c.process.capabilities as Json).extra = []; }],
  ['a capability unknown', (c) => { c.process.capabilities.bounding = ['CAP_FLY']; }],
  ['a capability without its prefix', (c) => { c.process.capabilities.bounding = ['KILL']; }],
  ['a capability over the host', (c) => { c.process.capabilities.effective = ['CAP_SYS_ADMIN']; }],
  ['the network\'s capabilities, in its own', (c) => { c.process.capabilities.permitted = ['CAP_NET_ADMIN', 'CAP_NET_RAW']; }],
  ['a limit unknown', (c) => { c.process.rlimits = [{type: 'RLIMIT_JOY', hard: 1, soft: 1}]; }],
  ['a limit with no type', (c) => { c.process.rlimits = [{hard: 1, soft: 1} as never]; }],
  ['a limit member unknown', (c) => { c.process.rlimits = [{type: 'RLIMIT_CPU', hard: 1, soft: 1, firm: 1} as never]; }],
  ['the same limit twice', (c) => { c.process.rlimits.push({...c.process.rlimits[0]}); }],
  ['a limit twice with other values', (c) => { c.process.rlimits.push({type: 'RLIMIT_NOFILE', hard: 2048, soft: 1024}); }],
  ['a limit twice, apart', (c) => { c.process.rlimits.push({type: 'RLIMIT_CORE', hard: 0, soft: 0}, {...c.process.rlimits[0]}); }],
  ['distinct limits', (c) => { c.process.rlimits.push({type: 'RLIMIT_CORE', hard: 0, soft: 0}); }],
  ['seventeen limits', (c) => { c.process.rlimits = Array.from({length: 17}, () => ({type: 'RLIMIT_CPU', hard: 1, soft: 1})); }],
  ['a limit of all there is', (c) => { c.process.rlimits = [{type: 'RLIMIT_CORE', hard: 0, soft: 0}]; }],
  ['a process member unknown', (c) => { (c.process as Json).oomScoreAdj = 3; }],
  ['an AppArmor profile', (c) => { (c.process as Json).apparmorProfile = 'x'; }],
  ['a root member unknown', (c) => { (c.root as Json).propagation = 'x'; }],
  ['a mount with no destination', (c) => { delete (c.mounts[0] as Json).destination; }],
  ['a mount not from the root', (c) => { c.mounts[0].destination = 'proc'; }],
  ['a mount member unknown', (c) => { (c.mounts[0] as Json).uidMappings = []; }],
  ['a kind not mounted in a box', (c) => { c.mounts[0].type = 'debugfs'; }],
  ['a mount of no kind', (c) => { delete (c.mounts[0] as Json).type; }],
  ['a proc somewhere else', (c) => { c.mounts[0].destination = '/proc2'; }],
  ['a sysfs somewhere else', (c) => { c.mounts[5].destination = '/system'; }],
  ['cgroup2', (c) => { c.mounts[6].type = 'cgroup2'; }],
  ['thirty-three options of its own', (c) => { c.mounts[1].options = Array.from({length: 33}, (_, i) => `o${i}`); }],
  ['every flag', (c) => { c.mounts[1].options = ['ro', 'rw', 'nodev', 'dev', 'noexec', 'exec', 'sync', 'async', 'dirsync', 'noatime', 'atime', 'nodiratime', 'diratime', 'relatime', 'norelatime', 'strictatime', 'nostrictatime', 'lazytime', 'nolazytime', 'nosymfollow', 'symfollow', 'defaults', 'private', 'rslave', 'shared', 'runbindable', 'size=1k']; }],
  ['terminals without end', (c) => { c.mounts[2].options = ['max=100000']; }],
  ['few terminals', (c) => { c.mounts[2].options = ['max=3', 'mode=0620']; }],
  ['a hundred and twenty-nine mounts', (c) => { c.mounts = Array.from({length: 129}, (_, i) => ({destination: `/t${i}`, type: 'tmpfs', source: 'tmpfs'})); }],
  ['a hundred and twenty-eight mounts and no /dev', (c) => { c.mounts = Array.from({length: 128}, (_, i) => ({destination: `/t${i}`, type: 'tmpfs', source: 'tmpfs'})); }],
  ['no mounts', (c) => { c.mounts = []; }],
  ['no /proc', (c) => { c.mounts = c.mounts.slice(1); }],
  ['a namespace unknown', (c) => { c.linux.namespaces.push({type: 'time'}); }],
  ['a namespace with no type', (c) => { c.linux.namespaces.push({} as never); }],
  ['a namespace twice', (c) => { c.linux.namespaces.push({type: 'pid'}); }],
  ['a namespace member unknown', (c) => { (c.linux.namespaces[0] as Json).flags = 1; }],
  ['a mount namespace joined', (c) => { (c.linux.namespaces[4] as Json).path = '/proc/1/ns/mnt'; }],
  ['no mount namespace', (c) => { c.linux.namespaces = c.linux.namespaces.filter((n) => n.type !== 'mount'); }],
  ['no pid namespace', (c) => { c.linux.namespaces = c.linux.namespaces.filter((n) => n.type !== 'pid'); }],
  ['no network namespace', (c) => { c.linux.namespaces = c.linux.namespaces.filter((n) => n.type !== 'network'); }],
  ['no cgroup namespace', (c) => { c.linux.namespaces = c.linux.namespaces.filter((n) => n.type !== 'cgroup'); }],
  ['a user namespace with no map', (c) => { c.linux.namespaces.push({type: 'user'}); }],
  ['a user namespace mapped', (c) => { c.linux.namespaces.push({type: 'user'}); Object.assign(c.linux, {uidMappings: [{containerID: 0, hostID: 100000, size: 65536}], gidMappings: [{containerID: 0, hostID: 100000, size: 65536}]}); }],
  ['a map of nothing', (c) => { c.linux.namespaces.push({type: 'user'}); Object.assign(c.linux, {uidMappings: [{containerID: 0, hostID: 1000, size: 0}], gidMappings: [{containerID: 0, hostID: 1000, size: 1}]}); }],
  ['a map member unknown', (c) => { Object.assign(c.linux, {uidMappings: [{containerID: 0, hostID: 1000, size: 1, extra: 1}]}); }],
  ['thirty-three lines of a map', (c) => { Object.assign(c.linux, {gidMappings: Array.from({length: 33}, (_, i) => ({containerID: i, hostID: i, size: 1}))}); }],
  ['sixty-five paths hidden', (c) => { c.linux.maskedPaths = Array.from({length: 65}, (_, i) => `/proc/h${i}`); }],
  ['sixty-four paths hidden, and the floor\'s', (c) => { c.linux.maskedPaths = Array.from({length: 64}, (_, i) => `/proc/h${i}`); }],
  ['a device allowed', (c) => { c.linux.resources.devices = [{allow: true, access: 'rwm'}]; }],
  ['a limit of the cgroup\'s', (c) => { (c.linux.resources as Json).memory = {limit: 1}; }],
  ['a filter of its own', (c) => { (c.linux as Json).seccomp = {defaultAction: 'SCMP_ACT_ALLOW'}; }],
  ['sysctl', (c) => { (c.linux as Json).sysctl = {'net.ipv4.ip_forward': '1'}; }],
  ['hooks, none in them', (c) => { c.hooks = {prestart: [], poststop: []}; }],
  ['hooks', (c) => { c.hooks = {prestart: [{path: '/bin/true'}]}; }],
  ['what other systems read', (c) => { Object.assign(c, {annotations: {a: 'b'}, windows: {x: [1, 2, {y: null}]}, solaris: 'z'}); }],
  ['no process', (c) => { delete (c as Json).process; }],
  ['a terminal', (c) => { c.process.terminal = true; }],
];
for (const [name, change] of wrong) { add(name, made(change)); add(`${name}, nothing lent`, made(change), false); }
// How it is written: what JSON allows and what it does not.
const written: [string, string][] = [
  ['nothing', ''], ['a space', ' '], ['a word', 'config'], ['an array', '[]'], ['a number', '7'], ['null', 'null'], ['an object and more', text + ' {}'],
  ['an object and a NUL', text + '\0'], ['a NUL in it', text.replace('"box"', '"b\0x"')], ['a control byte in a string', text.replace('"box"', '"b\x01x"')],
  ['a line feed in a string', text.replace('"box"', '"b\nx"')], ['an escape', text.replace('"box"', '"b\\n\\t\\r\\b\\f\\"\\\\\\/x"')],
  ['an escape that is none', text.replace('"box"', '"b\\x"')], ['a \\u', text.replace('"box"', '"b\\u00e9\\u3042\\ud83d\\ude00x"')],
  ['a \\u of a NUL', text.replace('"box"', '"b\\u0000x"')], ['a \\u cut short', text.replace('"box"', '"b\\u00"')], ['half a pair', text.replace('"box"', '"b\\ud83dx"')],
  ['a string that does not end', text.replace('"box"', '"box')], ['a member twice', text.replace('"hostname": "box"', '"hostname": "a", "hostname": "box"')],
  ['a member null', text.replace('"hostname": "box"', '"hostname": null')], ['null misspelt', text.replace('"hostname": "box"', '"hostname": nul')],
  ['process null', text.replace(/"process": \{[\s\S]*?\n  \},/, '"process": null,')], ['args null', text.replace(/"args": \[[^\]]*\]/, '"args": null')],
  ['a comma too many', text.replace('"hostname": "box",', '"hostname": "box",,')], ['a comma missing', text.replace('"hostname": "box",', '"hostname": "box"')],
  ['a comma before the end', text.replace(/\n\}$/, ',\n}')], ['no colon', text.replace('"hostname": "box"', '"hostname" "box"')],
  ['a number with a fraction', text.replace('"uid": 0', '"uid": 0.5')], ['a number with an exponent', text.replace('"uid": 0', '"uid": 1e3')],
  ['a number below zero', text.replace('"uid": 0', '"uid": -1')], ['a number as a string', text.replace('"uid": 0', '"uid": "0"')],
  ['a number with zeros before it', text.replace('"uid": 0', '"uid": 007')], ['a number past sixty-four bits', text.replace('"hard": 1024', '"hard": 18446744073709551616')],
  ['the greatest number', text.replace('"hard": 1024', '"hard": 18446744073709551615')], ['true misspelt', text.replace('"terminal": false', '"terminal": yes')],
  ['a truth as a string', text.replace('"terminal": false', '"terminal": "false"')], ['an array where an object is', text.replace('"root": {', '"root": [').replace('"readonly": true\n  }', '"readonly": true\n  ]')],
  ['a string where a list is', text.replace(/"args": \[[^\]]*\]/, '"args": "/probe"')], ['tabs and line ends between', text.replace(/\n/g, '\r\n\t')],
  ['no spaces at all', JSON.stringify(base)], ['a byte order mark', '﻿' + text], ['a key with an escape', text.replace('"hostname"', '"host\\u006eame"')],
  ['a long key', text.replace('"hostname"', `"${'h'.repeat(300)}"`)], ['unknown and deep', text.replace('"hostname"', '"x": [[[{"a": [1, "}", {"b": []}]}]]], "hostname"')],
  ['unknown and unclosed', text.replace('"hostname"', '"x": [[[{"a": 1}], "hostname"')], ['unknown and closed too often', text.replace('"hostname"', '"x": []], "hostname"')],
];
for (const [name, config] of written) add(name, config);
for (const value of ['bananas','01','-01','-.1','1.','1e','[1,]','[1 2]','{"x" 1}','{,"x":1}','[}','{]']) add(`invalid JSON extension ${value}`, text.slice(0, -1) + ',"extension":' + value + '}');
// Every cut of it; and bytes changed in it, two at each place (a few that mean something in JSON among them).
const whole = bytesOf(text);
for (let n = 0; n < whole.length; n++) add(`cut at ${n}`, whole.subarray(0, n));
let seed = 0x2545f491;
const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
const MEAN = bytesOf('"{}[],:\\0n \n-.e');
for (let at = 0; at < whole.length; at++) for (let k = 0; k < 2; k++) {
  const changed = whole.slice(), r = next();
  changed[at] = r & 1 ? MEAN[(r >> 1) % MEAN.length] : (r >> 1) & 0xff;
  add(`byte ${at} made ${changed[at]}`, changed);
}

/** What `muk run` says of a config.json it will not make a box of, as it reads it; null where it reads it. */
const LATER = ['a bind has no source', 'process.rlimits: one is more than', 'process.terminal: its other end', "linux.namespaces: the host's own", "it names what is the host's"];
function linux(c: Case): string | null {
  writeFileSync(join(bundle, 'config.json'), c.bytes);
  const r = spawnSync(muk, ['run', ...['--ids', c.lent ? '0-4294967294' : '1-0'], '-b', bundle, 'same'], {timeout: 20000, stdio: ['ignore', 'ignore', 'pipe']});
  // (muk's words are bytes, config.json's own among them: read as the reader here reads a string's)
  // (all it said, but the line's end: a name of config.json's own may hold one)
  const said = /^muk: (config\.json: [\s\S]*)\n$/.exec(new TextDecoder().decode(r.stderr ?? new Uint8Array(0)))?.[1] ?? null;
  return said && !LATER.some((l) => said.startsWith(`config.json: ${l}`)) ? said : null;
}
function here(c: Case): string | null {
  try { asks(c.bytes, c.lent ? {first: 0n, last: ID} : {first: 1n, last: 0n}); return null; }
  catch (e) { if (e instanceof Refused) return e.message; throw e; }
}
let differ = 0, refused = 0;
for (const c of cases) {
  const a = linux(c), b = here(c);
  if (a !== null) refused++;
  if (a === b) continue;
  if (differ++ < 20) console.error(`not ok: ${c.name}\n  muk on Linux: ${a ?? '(read)'}\n  here:         ${b ?? '(read)'}`);
}
if (differ) { console.error(`${differ} of ${cases.length} config.jsons are answered differently`); process.exit(1); }
console.log(`ok ${cases.length} (${refused} refused, in the same words; ${cases.length - refused} read by both)`);
