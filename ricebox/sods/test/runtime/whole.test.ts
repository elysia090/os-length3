import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Vfs} from '../../runtime/linux/fs.ts';
import {Kernel, PROFILE} from '../../runtime/linux/process.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';
import {nativeTranslator, translatorWasm} from '../fixtures/runtime.ts';

// A program translated whole ahead of time (sods --whole) runs without translating anything more, though it keeps no
// symbols and no relocations (as a distribution ships it, BusyBox among them): the cases its switches jump to through
// tables and the functions it passes by address are found from its code. Built both ways a compiler makes such
// tables: position-independent (static-pie, entries relative to the table) and not (entries the addresses).

const switches = fileURLToPath(new URL('../programs/switches.c', import.meta.url));
const cc = spawnSync('musl-gcc', ['--version']).status === 0;
const ready = cc && existsSync(nativeTranslator) && existsSync(translatorWasm);

for (const [name, flags] of [['pie', ['-static-pie', '-fPIE']], ['absolute', ['-static', '-fno-pie', '-no-pie']]]) {
  test(`whole: a stripped ${name} program's switches and callbacks are translated ahead of time`, {skip: !ready && 'needs musl-gcc and the built Sods translators'}, async t => {
    const out = mkdtempSync(join(tmpdir(), 'sods-whole-'));
    t.after(() => rmSync(out, {recursive: true, force: true}));
    const elf = join(out, `switches-${name}`);
    execFileSync('musl-gcc', [...flags, '-O2', '-s', switches, '-o', elf]);
    execFileSync(nativeTranslator, ['--whole', elf, `${elf}.wasm`], {stdio: 'ignore'});
    const native = execFileSync(elf, ['a'], {encoding: 'utf8'});
    const vfs = new Vfs();
    vfs.writeFile('/bin/switches', readFileSync(elf), 0o755);
    let said = '';
    const kernel = new Kernel({vfs, translate: await loadTranslator(readFileSync(translatorWasm)),
      console: {interactive: false, write: (_, b) => { said += new TextDecoder().decode(b); }, read: () => null, ready: () => false}});
    kernel.prebuilt(vfs.file('/bin/switches'), new WebAssembly.Module(readFileSync(`${elf}.wasm`)));
    const before = PROFILE.modules;
    kernel.start('/bin/switches', [elf, 'a'], [], '/');
    const r = kernel.pump();
    assert.equal(r.status, 0);
    assert.equal(said, native);
    assert.equal(PROFILE.modules - before, 0, 'nothing was translated as it ran');
  });
}
