import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {contrast, things} from '../../../ricebox/everyday/src/everyday.ts';
import {sheets, table} from '../../build/styles/look.ts';
import {THINGS} from './look-things.ts';
import {PAIRS, wear, worn} from './look.ts';

test('the table of what may be changed is the one the sheets give', () => {
  assert.equal(readFileSync(new URL('./look-things.ts', import.meta.url), 'utf8'), table(things(sheets())), 'node why/build/styles/look.ts writes it again');
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

test('active Prompt text and quiet text cannot disappear into the ink background', () => {
  const ink = THINGS.find(thing => thing.name === 'ink')!.usual;
  const made = worn(`green: ${ink}\nslot: ${ink}`);
  assert.deepEqual(made.values, {});
  assert.equal(made.css, '');
  assert.deepEqual(made.left.map(line => line.line), [1, 2]);
  assert.match(made.left[0].why, /green would not be read on ink/);
  assert.match(made.left[1].why, /slot would not be read on ink/);
});

test('a coordinated Prompt foreground and background are checked together in either order', () => {
  // This grey is readable on black, but not on the default ink. The whole
  // valid choice must survive, even when the foreground line comes first.
  const ink = THINGS.find(thing => thing.name === 'ink')!.usual;
  assert.ok(contrast('#777777', ink) < 4.5);
  for (const lines of [ ['green: #777777', 'slot: #777777', 'ink: #000000'],
    ['ink: #000000', 'slot: #777777', 'green: #777777'] ]) {
    const made = worn(lines.join('\n'));
    assert.deepEqual(made.left, []);
    assert.deepEqual(made.values, {green: '#777777', slot: '#777777', ink: '#000000'});
  }
});

test('an unreadable Prompt pair drops its last change, including a background change', () => {
  for (const foreground of ['green', 'slot']) {
    const backgroundLast = worn(`${foreground}: #999999\nink: #444444`);
    assert.deepEqual(backgroundLast.values, {[foreground]: '#999999'});
    assert.deepEqual(backgroundLast.left.map(line => line.line), [2]);
    const foregroundLast = worn(`ink: #444444\n${foreground}: #999999`);
    assert.deepEqual(foregroundLast.values, {ink: '#444444'});
    assert.deepEqual(foregroundLast.left.map(line => line.line), [2]);
  }
});

test('wear changes only its validated root properties and leaves other CSSOM state alone', t => {
  const values = new Map([['--box-drop', '2px']]), writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {documentElement: {style: {
    getPropertyValue: (name: string) => values.get(name) ?? '',
    setProperty: (name: string, value: string) => { writes.push(name); values.set(name, value); },
    removeProperty: (name: string) => { writes.push(name); values.delete(name); },
  }}}});
  t.after(() => {
    wear(undefined);
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  assert.deepEqual(wear('ground: #e9e4d8\npace: 0.5'), []);
  assert.equal(values.get('--ground'), '#e9e4d8');
  assert.equal(values.get('--pace'), '0.5');
  writes.length = 0;
  wear('ground: #e9e4d8\npace: 0.5');
  assert.deepEqual(writes, [], 'unchanged values need no CSSOM writes');
  const left = wear('ground: #e9e4d8\ngreen: #171615');
  assert.deepEqual(left.map(line => line.line), [2]);
  assert.equal(values.has('--green'), false);
  assert.equal(values.has('--pace'), false, 'removed managed value returns to the sheet');
  assert.equal(values.get('--box-drop'), '2px');
  wear(undefined);
  assert.deepEqual([...values], [['--box-drop', '2px']]);
});
