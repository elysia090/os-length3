import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Vfs} from '../runtime/fs.mjs';
import {Kernel, PROFILE} from '../runtime/process.mjs';
import {loadTranslator} from '../runtime/translator.mjs';

// A program translated whole ahead of time (xlat --whole) runs without translating anything more, though it keeps no
// symbols and no relocations (as a distribution ships it, BusyBox among them): the cases its switches jump to through
// tables and the functions it passes by address are found from its code. Built both ways a compiler makes such
// tables: position-independent (static-pie, entries relative to the table) and not (entries the addresses).

const here = new URL('.', import.meta.url).pathname;
const out = `${here}out/`;
const xlat = `${here}../target/release/xlat`;
const translator = `${here}../target/wasm32-unknown-unknown/release/xlat.wasm`;
const cc = spawnSync('musl-gcc', ['--version']).status === 0;
const ready = cc && existsSync(xlat) && existsSync(translator);

for (const [name, flags] of [['pie', ['-static-pie', '-fPIE']], ['absolute', ['-static', '-fno-pie', '-no-pie']]]) {
  test(`whole: a stripped ${name} program's switches and callbacks are translated ahead of time`, {skip: !ready && 'needs musl-gcc and the translator built (tests/run.sh)'}, async () => {
    mkdirSync(out, {recursive: true});
    const elf = `${out}switches-${name}`;
    execFileSync('musl-gcc', [...flags, '-O2', '-s', `${here}c/switches.c`, '-o', elf]);
    execFileSync(xlat, ['--whole', elf, `${elf}.wasm`], {stdio: 'ignore'});
    const native = execFileSync(elf, ['a'], {encoding: 'utf8'});
    const vfs = new Vfs();
    vfs.writeFile('/bin/switches', readFileSync(elf), 0o755);
    let said = '';
    const kernel = new Kernel({vfs, translate: await loadTranslator(readFileSync(translator)),
      console: {interactive: false, write: (_, b) => { said += new TextDecoder().decode(b); }, read: () => null, ready: () => false}});
    kernel.prebuilt(vfs.lookup('/bin/switches', '/'), new WebAssembly.Module(readFileSync(`${elf}.wasm`)));
    const before = PROFILE.modules;
    kernel.start('/bin/switches', [elf, 'a'], [], '/');
    const r = kernel.pump();
    assert.equal(r.status, 0);
    assert.equal(said, native);
    assert.equal(PROFILE.modules - before, 0, 'nothing was translated as it ran');
  });
}
