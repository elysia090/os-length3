import assert from 'node:assert/strict';
import {test} from 'node:test';
import {kindOf} from '../repos/text.ts';
import {add, DETAIL_LIMIT, edit, insertAfter, parse, persisted, remove, TEXT_LIMIT, toggle} from './todo.ts';

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

test('an item cut at its limit keeps every character whole, so l3 can still read the list', () => {
  // 199 letters and an emoji (two UTF-16 units): the emoji does not fit, and is not cut in half.
  const long = 'a'.repeat(TEXT_LIMIT - 1) + '😀';
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const added = add([], long, null, 1)[0];
  assert.equal(added.title, 'a'.repeat(TEXT_LIMIT - 1));
  const edited = edit([added], added.id, {title: long, detail: 'x'.repeat(DETAIL_LIMIT - 1) + '𝄞'})[0];
  assert.ok(!lone.test(edited.title) && !lone.test(edited.detail));
  assert.equal(edited.detail.length, DETAIL_LIMIT - 1);
  const read = parse(JSON.stringify([{...added, title: long}]))[0];
  assert.ok(!lone.test(read.title));
  // What fits is kept whole: 100 emoji are exactly the limit.
  assert.equal(add([], '😀'.repeat(TEXT_LIMIT / 2), null, 1)[0].title, '😀'.repeat(TEXT_LIMIT / 2));
});

test('two items made at the same moment have ids of their own', () => {
  const list = add(add([], 'a', null, 5), 'b', null, 5);
  assert.notEqual(list[0].id, list[1].id);
  assert.notEqual(insertAfter(list, null, 5).id, list[1].id);
});

test('an empty line, or one of spaces, adds nothing; a kind alone is an item', () => {
  assert.deepEqual(add([], '', null, 1), []);
  assert.deepEqual(add([], '   ', null, 1), []);
  assert.deepEqual(add([], 'Fix：', null, 1).map((t) => [t.kind, t.title]), [['Fix', '']]);
});

test('editing or toggling an id not in the list changes nothing', () => {
  const list = add([], 'a', null, 1);
  assert.deepEqual(edit(list, 'nope', {title: 'b'}), list);
  assert.deepEqual(toggle(list, 'nope'), list);
  assert.deepEqual(remove(list, 'nope'), list);
  // Inserting after an id not there puts the new one at the end.
  const r = insertAfter(list, 'nope', 2);
  assert.equal(r.list.at(-1)!.id, r.id);
});

test('stored lists keep well-formed items and read the older single-string form', () => {
  const good = {id: 'x', kind: 'Fix', title: 't', detail: '再現手順\n1. 保存\n2. 再起動', done: false, repo: null, created: 1};
  assert.deepEqual(parse(JSON.stringify([good, {id: 1}, null])), [good]);
  assert.deepEqual(parse(JSON.stringify([{id: 'y', text: 'Patch：u', done: true, repo: null, created: 2}])),
    [{id: 'y', kind: 'Patch', title: 'u', detail: '', done: true, repo: null, created: 2}]);
  assert.deepEqual(parse('{}'), []);
  assert.deepEqual(parse('nope'), []);
});
