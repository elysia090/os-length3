import assert from 'node:assert/strict';
import {test} from 'node:test';
import cases from '../shared/cases.json' with {type: 'json'};
import {joinTodo} from './draft.ts';

// Two devices' TODO lists as one, against the list both last agreed
// (draft.ts syncHome): what one side changed is that side's; what neither
// side lost stays. The same cases core/src/home.rs join_todo reads.

for (const c of cases.todoJoin) {
  test(`TODO joined: ${c.why}`, () => {
    const got = joinTodo(c.base, c.here, c.there);
    // A side kept as it is comes back as the very text; a join, as JSON.
    if (c.want === c.here) assert.equal(got, c.here);
    else assert.deepEqual(JSON.parse(got), JSON.parse(c.want));
  });
}
