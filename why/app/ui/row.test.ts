import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {declarations, readSheet} from '../../build/styles/sheet.ts';
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

test('the side sheets and Inbox address track keep their exact cell widths', () => {
  const style = (name: string, selector: string | RegExp, prop: string) => {
    const css = readFileSync(new URL(`../styles/${name}.css`, import.meta.url), 'utf8');
    const values = readSheet(css).nodes.flatMap((rule) => rule.kind === 'rule'
      && (typeof selector === 'string' ? rule.selector === selector : selector.test(rule.selector))
      ? declarations(rule.body).filter((d) => d.prop === prop).map((d) => d.value) : []);
    assert.equal(values.length, 1, `${name}.css ${selector} must set ${prop} once`);
    return values[0];
  };
  const cells = (n: number) => `calc(${n} * var(--u))`;
  assert.equal(style('home', '.home-waits > .lately', 'width'), cells(12));
  assert.equal(style('server', '.slide-track > .server-side', 'width'), cells(8));
  assert.equal(style('git-desk', '.git-desk > .git-side', 'width'), cells(8));
  assert.equal(style('page', /^\.page:not\(\.page-work\)/, 'max-width'), cells(48));

  // The Inbox index is no longer a boxed sheet; its nine-cell track shares the grid with an open letter.
  const inbox = '.page.page-inbox > .inbox-shell';
  assert.equal(style('inbox', inbox, '--inbox-index-width'), cells(9));
  assert.equal(style('inbox', inbox, '--inbox-gap'), cells(2));
  assert.equal(style('inbox', '.inbox-page', 'grid-template-columns'), 'var(--inbox-index-width) var(--inbox-paper-width)');
  assert.equal(style('inbox', '.inbox-page', 'column-gap'), 'var(--inbox-gap)');
});
