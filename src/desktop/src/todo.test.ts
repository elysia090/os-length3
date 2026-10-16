import assert from 'node:assert/strict';
import {test} from 'node:test';
import {add, edit, insertAfter, kindOf, parse, persisted, remove, toggle} from './todo.ts';

test('a kind is the word before a full- or half-width colon', () => {
  assert.deepEqual(kindOf('Fix：再起動すると保存内容が消える'), {kind: 'Fix', title: '再起動すると保存内容が消える'});
  assert.deepEqual(kindOf('RFC: Remoteの保持期間'), {kind: 'RFC', title: 'Remoteの保持期間'});
  assert.deepEqual(kindOf('牛乳を買う'), {kind: null, title: '牛乳を買う'});
  assert.deepEqual(kindOf('12:30 に会議'), {kind: null, title: '12:30 に会議'});
});

test('lines are inserted after the current one and edited in place', () => {
  let list = add([], 'Fix：a', null, 1);
  list = add(list, 'Patch：c', null, 2);
  const r = insertAfter(list, list[0].id, 3);
  list = edit(r.list, r.id, {kind: 'RFC', title: 'b'});
  assert.deepEqual(list.map((t) => [t.kind, t.title]), [['Fix', 'a'], ['RFC', 'b'], ['Patch', 'c']]);
  // Removing the kind keeps "Fix：" as plain text.
  list = edit(list, list[0].id, {kind: null, title: 'Fix：a'});
  assert.deepEqual([list[0].kind, list[0].title], [null, 'Fix：a']);
  assert.equal(insertAfter(list, null, 4).list.length, 4);
});

test('detail lines are kept with the item, trailing blank lines trimmed', () => {
  let list = add([], 'Fix：a', null, 1);
  list = edit(list, list[0].id, {detail: '手順\n\n'});
  assert.equal(persisted(list)[0].detail, '手順');
  // An item with only detail is still an item.
  const r = insertAfter(list, null, 2);
  assert.equal(persisted(edit(r.list, r.id, {detail: 'メモ'})).length, 2);
});

test('done toggles, removal and blank lines are not kept', () => {
  let list = add(add([], 'a', null, 1), 'b', null, 2);
  list = toggle(list, list[0].id);
  assert.equal(list[0].done, true);
  list = insertAfter(list, null, 3).list;
  assert.deepEqual(persisted(list).map((t) => t.title), ['a', 'b']);
  assert.deepEqual(remove(list, list[1].id).map((t) => t.title), ['a', '']);
});

test('stored lists keep well-formed items and read the older single-string form', () => {
  const good = {id: 'x', kind: 'Fix', title: 't', detail: '再現手順\n1. 保存\n2. 再起動', done: false, repo: null, created: 1};
  assert.deepEqual(parse(JSON.stringify([good, {id: 1}, null])), [good]);
  assert.deepEqual(parse(JSON.stringify([{id: 'y', text: 'Patch：u', done: true, repo: null, created: 2}])),
    [{id: 'y', kind: 'Patch', title: 'u', detail: '', done: true, repo: null, created: 2}]);
  assert.deepEqual(parse('{}'), []);
  assert.deepEqual(parse('nope'), []);
});
