import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {contrast, things} from '../../../module/everyday/src/everyday.ts';
import {sheets, table} from '../../../scripts/look.ts';
import {THINGS} from './look-things.ts';
import {PAIRS, worn} from './look.ts';

test('the table of what may be changed is the one the sheets give', () => {
  assert.equal(readFileSync(new URL('./look-things.ts', import.meta.url), 'utf8'), table(things(sheets())), 'node scripts/look.ts writes it again');
});

test('the words that must stay read are read as the sheets have them, each of the pair a colour that may be changed', () => {
  const usual = new Map(THINGS.map((t) => [t.name, t]));
  for (const {on, under, least} of PAIRS) {
    assert.equal(usual.get(on)?.kind, 'colour', on);
    assert.equal(usual.get(under)?.kind, 'colour', under);
    assert.ok(contrast(usual.get(on)!.usual, usual.get(under)!.usual) >= least, `${on} on ${under}`);
  }
});

test('each thing takes its own usual value, and so changes nothing by it', () => {
  for (const thing of THINGS) {
    const made = worn(`${thing.name}: ${thing.usual}`);
    assert.deepEqual(made.left, [], thing.name);
    assert.equal(Object.keys(made.values).length, 1, thing.name);
  }
});

test('a look changed is one rule of what was read, and what would not be read is left as it was', () => {
  const made = worn('ink: #000\npace: 1.5\nground: #111111\nsans: Georgia\nno-such: 1\npace: 9\nink: red; } body { display: none');
  assert.equal(made.css, ':root { --ink: #000000; --pace: 1.5; --sans: "Georgia", ' + THINGS.find((t) => t.name === 'sans')!.usual + '; }');
  // (black ink is taken; the ground made as dark after it, on which nothing would be read, is as it was)
  assert.deepEqual(made.left.map((l) => l.line), [3, 5, 6, 7]);
  assert.match(made.left[0].why, /would not be read/);
  assert.match(made.left.at(-1)!.why, /a colour is written/);
});
