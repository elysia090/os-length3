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
