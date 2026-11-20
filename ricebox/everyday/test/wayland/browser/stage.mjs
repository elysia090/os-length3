import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const [output, translator, muk, elf] = process.argv.slice(2);
assert.ok(output && translator && muk && elf, 'usage: stage.mjs NEW_DIR TRANSLATOR_WASM MUK WAYLAND_TEST_ELF');
await mkdir(output);
const target = join(output, 'fixture');
await mkdir(target);
const manifest = {};
for (const [key, name, path] of [['translator','sods.wasm',translator],['muk','muk',muk],['elf','wayland-presenter',elf]]) {
  const contents = await readFile(path);
  assert.ok(contents.length);
  manifest[key] = [name, createHash('sha256').update(contents).digest('hex')];
  await writeFile(join(target,name),contents,{flag:'wx'});
}
await writeFile(join(target,'pins.json'),JSON.stringify(manifest),{flag:'wx'});
