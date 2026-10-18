import assert from 'node:assert/strict';
import {test} from 'node:test';
import {joinTodo} from './draft.ts';

// Two devices' TODO lists as one, against the list both last agreed
// (draft.ts syncHome). What one side changed is that side's; what neither
// side lost stays.

type Item = {id: string; title: string; done?: boolean};
const item = (id: string, title = id, done = false): Item => ({id, title, done});
const list = (...items: Item[]) => JSON.stringify(items);
const join = (base: Item[] | string, here: Item[], there: Item[]) =>
  (JSON.parse(joinTodo(typeof base === 'string' ? base : list(...base), list(...here), list(...there))) as Item[]).map((x) => `${x.id}:${x.title}${x.done ? '✓' : ''}`);

const cases: {why: string; base: Item[] | string; here: Item[]; there: Item[]; want: string[]}[] = [
  {why: 'one added on each side: both kept, the Remote\'s new ones first',
    base: [item('a')], here: [item('a'), item('c')], there: [item('a'), item('b')], want: ['b:b', 'a:a', 'c:c']},
  {why: 'edited there, something added here: the edit is kept',
    base: [item('a')], here: [item('a'), item('c')], there: [item('a', 'A edited')], want: ['a:A edited', 'c:c']},
  {why: 'marked done there, something added here: it stays done',
    base: [item('a')], here: [item('a'), item('c')], there: [item('a', 'a', true)], want: ['a:a✓', 'c:c']},
  {why: 'removed there, untouched here: it stays removed',
    base: [item('a'), item('b')], here: [item('a'), item('b'), item('c')], there: [item('b')], want: ['b:b', 'c:c']},
  {why: 'removed here, untouched there: it stays removed',
    base: [item('a'), item('b')], here: [item('b')], there: [item('a'), item('b'), item('d')], want: ['d:d', 'b:b']},
  {why: 'removed here, edited there: the edit comes back (nothing written is lost)',
    base: [item('a')], here: [], there: [item('a', 'A edited')], want: ['a:A edited']},
  {why: 'edited here, removed there: this device\'s edit stays',
    base: [item('a')], here: [item('a', 'A mine')], there: [], want: ['a:A mine']},
  {why: 'edited on both: this device\'s',
    base: [item('a')], here: [item('a', 'mine')], there: [item('a', 'theirs')], want: ['a:mine']},
  {why: 'nothing agreed yet: every item from both, this device\'s where both have it',
    base: '', here: [item('a', 'mine'), item('c')], there: [item('a', 'theirs'), item('b')], want: ['b:b', 'a:mine', 'c:c']},
];

for (const c of cases) test(`TODO joined: ${c.why}`, () => assert.deepEqual(join(c.base, c.here, c.there), c.want));

test('TODO joined: an item is the same item whatever order its fields were written in', () => {
  // l3 writes the fields in its own order; an untouched item is still untouched.
  const base = '[{"title":"a","id":"a","done":false}]';
  assert.deepEqual(join(base, [item('a'), item('c')], [item('a', 'A edited')]), ['a:A edited', 'c:c']);
});

test('TODO joined: a side that is not a list leaves this device\'s as it is', () => {
  assert.equal(joinTodo('[]', list(item('a')), '{"not": "a list"}'), list(item('a')));
  assert.equal(joinTodo('[]', 'not json', list(item('a'))), 'not json');
  assert.equal(joinTodo('[]', list(item('a')), '[null]'), list(item('a')));
  assert.equal(joinTodo('[]', '[null]', list(item('a'))), '[null]');
  // An agreed list that cannot be read is no agreement: every item from both.
  assert.deepEqual(join('not json', [item('a')], [item('b')]), ['b:b', 'a:a']);
});
