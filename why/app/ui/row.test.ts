import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atRest, pieceWidth, turnedTo} from './row.ts';

// A row's numbers (DESIGN §6), every row's: Forge's files, Server's boards, Inbox's conversation.

test('a piece is 24 cells, or as many whole cells as the desk has room for with its shadow, never under ten', () => {
  assert.equal(pieceWidth(1488), 576);            // a whole screen
  assert.equal(pieceWidth(720), 576);             // half a screen
  assert.equal(pieceWidth(342), 312);             // a phone: 13 cells
  assert.equal(pieceWidth(588), 576);             // just room for it and its shadow
  assert.equal(pieceWidth(587), 552);             // a pixel short: a cell narrower
  assert.equal(pieceWidth(200), 240);             // never under ten
});

test('a row whose first sheet is narrower than its pieces: the desk rests at any of them, and stays while what is gone to is whole in sight', () => {
  // Server on a whole screen: its own sheet eight cells, then boards of 24, two cells apart.
  const starts = [0, 240, 864, 1488], face = 1488;
  assert.equal(turnedTo(0, 240, 576, face, starts), 0);       // the first board: whole in sight beside the sheet
  assert.equal(turnedTo(0, 864, 576, face, starts), 0);       // the second: whole in sight too (its shadow ends at 1452)
  assert.equal(turnedTo(0, 1488, 576, face, starts), 864);    // the third: the nearest rest that shows it whole
  assert.equal(turnedTo(864, 240, 576, face, starts), 240);   // back to the first: it comes to the edge
  // A phone: one piece in sight; the sheet is a step back.
  const phone = [0, 240, 600], narrow = 342;
  assert.equal(turnedTo(0, 240, 312, narrow, phone), 240);
  assert.equal(turnedTo(240, 0, 192, narrow, phone), 0);
  assert.equal(atRest(130, phone), 240);
  assert.equal(atRest(110, phone), 0);
});

// The widths are one programme (DESIGN §3): a sheet has a cell of paper each side and two cells between its columns,
// so n columns of c cells fill an inside of n·c + 2·(n − 1): inside + 2 = n·(c + 2).
const columns = (wide: number) => [1, 2, 3, 4, 6].map((n) => (wide - 2 + 2) / n - 2);

test('a piece of 24 cells divides into 1, 2, 3, 4 and 6 columns with nothing over; so does a sheet of 48; the first sheets are those columns', () => {
  assert.deepEqual(columns(24), [22, 10, 6, 4, 2]);
  assert.deepEqual(columns(48), [46, 22, 14, 10, 6]);
  // 25 or 20 would not: that is why a piece is 24.
  assert.ok(columns(25).some((c) => !Number.isInteger(c)) && columns(20).some((c) => !Number.isInteger(c)));
  // A first sheet of 12 cells holds a half of a piece's inside, one of 8 a third.
  assert.equal(12 - 2, columns(24)[1]);
  assert.equal(8 - 2, columns(24)[2]);
  // A whole screen (1536) shows the first sheet of 8 and two pieces, each with its two cells, and the last one's shadow.
  assert.ok(48 + 24 * (8 + 2 + 24 + 2 + 24) + 12 <= 1536);
  assert.ok(48 + 24 * (10 + 2 + 24 + 2 + 24) + 12 > 1536);
});

test('the sheets are cut to the programme: no width of a sheet on a desk is outside 8, 12, 24 and 48 cells', async () => {
  const {readFileSync} = await import('node:fs');
  const sheet = (name: string) => readFileSync(new URL(`../styles/${name}.css`, import.meta.url), 'utf8');
  const widthOf = (css: string, selector: string) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, selector);
    return Number(/(?:max-)?width: (?:min\()?calc\((\d+) \* var\(--u\)\)/.exec(css.slice(at, at + 900))?.[1]);
  };
  assert.equal(widthOf(sheet('home'), '.home-waits > .lately {'), 12);
  assert.equal(widthOf(sheet('server'), '.slide-track > .server-side { display: grid;'), 8);
  assert.equal(widthOf(sheet('inbox'), '.inbox-index {'), 12);
  assert.equal(widthOf(sheet('git-desk'), '.git-desk > .git-side {'), 8);
  assert.equal(widthOf(sheet('page'), '.page:not(.page-work)'), 48);
});
