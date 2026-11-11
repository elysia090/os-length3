import assert from 'node:assert/strict';
import {test} from 'node:test';
import {change, contrast, MOST, things} from '../src/everyday.ts';

const SHEET = `
/* A look. */
:root {
  /* What everything stands on. */
  --ground: #dcd9d4;
  --ink: #2c2a27; --paper: #f9f8f5;
  --dots: radial-gradient(circle, color-mix(in srgb, var(--ink) 55%, transparent) 1px, transparent 2px);
  --sans: system-ui, 'Segoe UI', sans-serif;
  --display: 'Inter Display', var(--sans);
  /* How long a move is. */
  --move: 280ms; --pace: 1; --share: .38; --none: 0px;
  --body: 15px; --gap: 18px;
  --pointer: url("data:image/svg+xml,%3Csvg%3E;}--ink:#fff;{%3C/svg%3E") 3 3, default;
  --twice: 4px;
}
.box { --ink: #000000; color: var(--ink); }
@media (max-width: 560px) { :root { --gap: 10px; } }
:root { --twice: 5px; }
`;

test('what may be changed is what a sheet sets once, plainly, for every window', () => {
  const all = things(SHEET);
  assert.deepEqual(all.map((t) => `${t.name} ${t.kind}`), ['ground colour', 'ink colour', 'paper colour', 'sans face', 'move time', 'pace number', 'share share', 'body length']);
  // (made of others: dots, display, the pointer; nothing to be a half of: none; set by the window: gap; set twice: twice)
  const by = new Map(all.map((t) => [t.name, t]));
  assert.equal(by.get('ground')!.says, 'What everything stands on.');
  assert.equal(by.get('ink')!.says, '');
  assert.equal(by.get('move')!.says, 'How long a move is.');
  assert.deepEqual([by.get('body')!.least, by.get('body')!.most], [7.5, 30]);
  assert.deepEqual([by.get('move')!.least, by.get('move')!.most], [0, 1120]);
  assert.deepEqual([by.get('pace')!.least, by.get('pace')!.most], [0.25, 4]);
  assert.deepEqual([by.get('share')!.least, by.get('share')!.most], [0, 1]);
  // (what a string holds is not read as the sheet's own: the pointer's ink is no second ink)
  assert.equal(by.get('ink')!.usual, '#2c2a27');
});

test('a change is a line: read, held to its kind and its bounds, and written again from what was read', () => {
  const all = things(SHEET);
  const made = change(all, [
    '# a note', '// another', '',
    'ink: #000', '--paper: #FFFFFF;', 'body: 16px', 'move:0ms', 'pace: 2', 'share: 0.5', 'sans: Georgia, "Noto Serif JP"',
    'body: 31px', 'body: 15', 'pace: 2px', 'move: 1s', 'share: 1.5', 'ground: rgb(0,0,0)', 'ground: #12345', 'nothing: 1', 'just words', 'sans: a;b',
    'dots: none', 'gap: 12px',
  ].join('\r\n'));
  assert.deepEqual(made.values, {ink: '#000000', paper: '#ffffff', body: '16px', move: '0ms', pace: '2', share: '0.5', sans: `"Georgia", "Noto Serif JP", system-ui, 'Segoe UI', sans-serif`});
  assert.equal(made.css, `:root { --ink: #000000; --paper: #ffffff; --body: 16px; --move: 0ms; --pace: 2; --share: 0.5; --sans: "Georgia", "Noto Serif JP", system-ui, 'Segoe UI', sans-serif; }`);
  assert.deepEqual(made.left.map((l) => l.line), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  assert.match(made.left[0].why, /between 7\.5px and 30px/);
  assert.match(made.left.at(-2)!.why, /nothing that may be changed has that name/); // (made of others)
  assert.match(made.left.at(-1)!.why, /nothing that may be changed has that name/); // (set by the window)
});

test('the last line for a name counts; with nothing taken there is no rule; no file is the look as it came', () => {
  const all = things(SHEET);
  assert.deepEqual(change(all, 'pace: 2\npace: 3\npace: 9').values, {pace: '3'});
  assert.equal(change(all, '').css, '');
  assert.equal(change(all, 'pace: 9\n# only a note').css, '');
  assert.deepEqual(change(all, 'pace: 1').values, {pace: '1'});
});

test('nothing of what was written is in the rule as it came', () => {
  const all = things(SHEET);
  const hostile = [
    'ink: #000; } html { display: none } :root { --x: 1', 'ink: #000 /* */', 'sans: x; } * { color: red', 'sans: url(http://example.com/a.woff)', 'sans: "a\\"b"',
    'sans: expression(alert(1))', 'pace: 1; --ink: red', 'body: calc(15px * 100)', 'ground: var(--ink)', 'ink: #000\\', 'move: 1e9ms', 'pace: 0x10', 'pace: -1', 'pace: 1.',
    'paper: #fff\u0000', 'ink:\t#000;;', '--: #000', 'ink : ; ', '@import url(x)', '</style><script>', 'body: 99999999999999999999px',
  ];
  for (const line of hostile) {
    const made = change(all, line);
    assert.match(made.css, /^(?:|:root \{ (?:--[a-z-]+: (?:#[0-9a-f]{6}|[0-9.]+(?:px|ms)?|"[A-Za-z0-9 _-]+"(?:, [-A-Za-z0-9 '"_]+)*); )+\})$/, line);
    assert.ok(made.left.length === 1 || Object.keys(made.values).length === 1, line);
  }
  // (and all of them at once, with a look that is taken among them)
  const made = change(all, [...hostile, 'pace: 2'].join('\n'));
  assert.equal(made.css, ':root { --pace: 2; }');
  // More than is read is not read in part.
  const long = change(all, 'pace: 2\n' + '#'.repeat(MOST));
  assert.equal(long.css, '');
  assert.equal(long.left.length, 1);
});

test('words stay read on their grounds: while a pair would fail, the line written last of what changed it is left out', () => {
  const all = things(SHEET);
  const pairs = [{on: 'ink', under: 'ground', least: 4.5}, {on: 'ink', under: 'paper', least: 4.5}];
  assert.ok(contrast('#2c2a27', '#dcd9d4') > 10 && contrast('#000', '#fff') === 21 && contrast('#777', '#777') === 1);
  // Ink made the ground's own colour: ink is left as it was, and the pace beside it is taken.
  let made = change(all, 'ink: #dcd9d4\npace: 2', pairs);
  assert.deepEqual(made.values, {pace: '2'});
  assert.match(made.left[0].why, /ink would not be read on ground/);
  // Both changed, and read together: both taken.
  made = change(all, 'ink: #f0f0f0\nground: #101010\npaper: #000000', pairs);
  assert.deepEqual(made.values, {ink: '#f0f0f0', ground: '#101010', paper: '#000000'});
  // The ground alone made dark under the usual ink: the ground is left as it was.
  made = change(all, 'ground: #101010', pairs);
  assert.deepEqual(made.values, {});
  // The later line of a pair that fails is the one left out: the ground stays, and the ink that matched it does not.
  made = change(all, 'ground: #e9e4d8\nink: #e9e4d8', pairs);
  assert.deepEqual(made.values, {ground: '#e9e4d8'});
  assert.deepEqual(made.left.map((l) => l.line), [2]);
  // And on until every pair holds: light ink, then a light ground (out), which leaves light ink on the usual ground
  // (out), which leaves the usual ink on black paper (out).
  made = change(all, 'ink: #f0f0f0\nground: #e0e0e0\npaper: #000000', pairs);
  assert.deepEqual(made.values, {});
});
