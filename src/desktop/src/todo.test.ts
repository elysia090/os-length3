import assert from 'node:assert/strict';
import {test} from 'node:test';
import {add, ordered, parse, remove, toggle} from './todo.ts';

test('adding trims, ignores blanks and keeps order', () => {
  let list = add([], '  write tests ', null, 1);
  list = add(list, '   ', null, 2);
  list = add(list, 'ship', 'hello-c', 3);
  assert.deepEqual(list.map((t) => [t.text, t.repo]), [['write tests', null], ['ship', 'hello-c']]);
  assert.notEqual(list[0].id, list[1].id);
});

test('finished items sink below open ones', () => {
  let list = add(add(add([], 'a', null, 1), 'b', null, 2), 'c', null, 3);
  list = toggle(list, list[0].id);
  assert.deepEqual(ordered(list).map((t) => t.text), ['b', 'c', 'a']);
  assert.deepEqual(remove(list, list[1].id).map((t) => t.text), ['a', 'c']);
});

test('stored lists keep only well-formed items', () => {
  const good = {id: 'x', text: 't', done: false, repo: null, created: 1};
  assert.deepEqual(parse(JSON.stringify([good, {id: 1}, null])), [good]);
  assert.deepEqual(parse('{}'), []);
  assert.deepEqual(parse('nope'), []);
});
