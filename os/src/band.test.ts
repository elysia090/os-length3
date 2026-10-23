import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addToBand, BESIDE, closeBeside, moveTo, offBand, openBeside, parseBand, removeFromBand, showIn} from './band.ts';

test('a band never stored starts with the open repo, a stored one keeps only real repos', () => {
  assert.deepEqual(parseBand(null, ['a', 'b'], 'b'), ['b']);
  assert.deepEqual(parseBand(null, ['a', 'b'], null), ['a']);
  assert.deepEqual(parseBand(null, [], null), []);
  assert.deepEqual(parseBand('["b","gone","b",3]', ['a', 'b'], null), ['b']);
  assert.deepEqual(parseBand('[]', ['a'], 'a'), []);
  assert.deepEqual(parseBand('nope', ['a'], 'a'), []);
});

test('repos go on at the end and come off one at a time', () => {
  assert.deepEqual(addToBand(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(addToBand(['a'], 'a'), ['a']);
  assert.deepEqual(removeFromBand(['a', 'b', 'c'], 'b', 'b'), {band: ['a', 'c'], active: 'c'});
  assert.deepEqual(removeFromBand(['a', 'b', 'c'], 'c', 'c'), {band: ['a', 'b'], active: 'b'});
  assert.deepEqual(removeFromBand(['a', 'b'], 'a', 'b'), {band: ['b'], active: 'b'});
  assert.deepEqual(removeFromBand(['a'], 'a', 'a'), {band: [], active: null});
  assert.deepEqual(offBand(['b'], ['a', 'b', 'c']), ['a', 'c']);
});

test('a repo opens beside the one worked on, up to three, the farthest going to make room', () => {
  assert.equal(BESIDE, 3);
  assert.deepEqual(openBeside(['a'], 'b', 'a'), ['a', 'b']);
  assert.deepEqual(openBeside(['a', 'b'], 'c', 'a'), ['a', 'c', 'b']);
  assert.deepEqual(openBeside(['a', 'b'], 'c', 'b', 0), ['c', 'a', 'b']);
  assert.deepEqual(openBeside(['a', 'b'], 'a', 'b'), ['a', 'b']);
  // A fourth: opened at the right, the leftmost goes; at the left, the rightmost.
  assert.deepEqual(openBeside(['a', 'b', 'c'], 'd', 'c'), ['b', 'c', 'd']);
  assert.deepEqual(openBeside(['a', 'b', 'c'], 'd', 'a', 0), ['d', 'a', 'b']);
  assert.deepEqual(openBeside([], 'a', null), ['a']);
});

test('a repo chosen on the band takes the place of the one worked on; closing one closes the row up', () => {
  assert.deepEqual(showIn(['a', 'b'], 'c', 'b'), ['a', 'c']);
  assert.deepEqual(showIn(['a', 'b'], 'a', 'b'), ['a', 'b']);
  assert.deepEqual(showIn([], 'a', null), ['a']);
  assert.deepEqual(closeBeside(['a', 'b', 'c'], 'b', 'b'), {shown: ['a', 'c'], active: 'c'});
  assert.deepEqual(closeBeside(['a', 'b'], 'b', 'b'), {shown: ['a'], active: 'a'});
  assert.deepEqual(closeBeside(['a', 'b'], 'a', 'b'), {shown: ['b'], active: 'b'});
});

test('a repo dragged along the band or the row lands where it is let go', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'a', 3), ['b', 'c', 'a']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'a', 2), ['b', 'a', 'c']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'b', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'b', 2), ['a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b'], 'x', 0), ['a', 'b']);
});
