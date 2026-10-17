import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addToBand, offBand, parseBand, removeFromBand} from './band.ts';

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
