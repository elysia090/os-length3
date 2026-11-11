import {readFileSync} from 'node:fs';
import {Vfs} from '../runtime/fs.ts';
import {Kernel} from '../runtime/process.ts';
import {loadTranslator} from '../runtime/translator.ts';
const S = process.argv[2]!;
const vfs = new Vfs();
const bash = vfs.writeFile('/bin/bash', readFileSync(`${S}/bash.elf`), 0o755);
vfs.writeFile('/etc/length3/shrc', readFileSync('../os/root/etc/length3/shrc'));
vfs.mkdirp('/root');
const input = [new TextEncoder().encode('echo hi\nexit\n')];
let out = '';
const kernel = new Kernel({
  vfs, translate: await loadTranslator(readFileSync('../os/target/userland/sods.wasm')),
  console: {interactive: true, screen: true, cols: 80, rows: 24, write: (_, b) => { out += new TextDecoder().decode(b); }, read: () => input.shift() ?? null, ready: () => input.length > 0},
});
kernel.prebuilt(bash, new WebAssembly.Module(readFileSync(`${S}/bash.wasm`)));
kernel.start('/bin/bash', ['/bin/bash', '--noediting', '--rcfile', '/etc/length3/shrc', '-i'], ['HOME=/root', 'PATH=/bin', 'TERM=xterm-256color'], '/root');
for (let i = 0; i < 50; i++) { const r = kernel.pump(); if (!r.waiting) { console.log('status', r.status); break; } if (!input.length) { console.log('waits'); break; } }
console.log(JSON.stringify(out));
