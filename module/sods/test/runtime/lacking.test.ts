import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {CALLED, lacking} from '../../runtime/translation/translator.ts';
import {exporting as make} from '../../../ricebox/make/standin.ts';

// A translator of another build than this runtime: one before its names were sods's (the root released as 0.6.4 carried
// one whose exports were xlat_*), with which every Prompt halted on its first program. What it lacks is said, so a root
// that carries it is refused before it is shipped (scripts/prompt-files.ts).

const translator = new URL('../../target/wasm32-unknown-unknown/release/sods.wasm', import.meta.url);

/** A module exporting `names` (module/ricebox/make/standin.ts's). */
const exporting = (names: readonly string[]) => new WebAssembly.Module(make(names) as BufferSource);

test('a translator of another build is told by what it lacks of the names this runtime calls', () => {
  assert.deepEqual(lacking(exporting(['xlat_alloc', 'xlat_translate'])), [...CALLED]);
  assert.deepEqual(lacking(exporting([...CALLED])), []);
  assert.deepEqual(lacking(exporting(CALLED.filter((n) => n !== 'sods_x87_names'))), ['sods_x87_names']);
});

test('this tree\'s translator has every name this runtime calls', {skip: !existsSync(translator) && 'sods.wasm not built'}, () => {
  assert.deepEqual(lacking(new WebAssembly.Module(readFileSync(translator))), []);
});
