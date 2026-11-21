import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const [output, translator, muk, elf, shell] = process.argv.slice(2);
assert.ok(output && translator && muk && elf, 'usage: stage.mjs NEW_DIR TRANSLATOR_WASM MUK WAYLAND_TEST_ELF [STATIC_BUSYBOX]');
await mkdir(output);
const target = join(output, 'fixture');
await mkdir(target);
const manifest = {};
const files = [['translator','sods.wasm',translator],['muk','muk',muk],['elf','wayland-presenter',elf]];
if (shell) files.push(['shell','busybox',shell]);
const alpha = process.env.EVERYDAY_ALPHA_ELF;
if (alpha) files.push(['alpha','wayland-alpha-presenter',alpha]);
for (const [key, name, path] of files) {
  const contents = await readFile(path);
  assert.ok(contents.length);
  manifest[key] = [name, createHash('sha256').update(contents).digest('hex')];
  await writeFile(join(target,name),contents,{flag:'wx'});
}
await writeFile(join(target,'pins.json'),JSON.stringify(manifest),{flag:'wx'});
