import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allSessions, forgetPrompt, keepPrompt, promptHolds, sessionIfAny, stopPrompt, type Prompt} from './sessions.ts';

function shell(opts: Partial<Prompt> = {}) {
  const s = {
    element: {} as HTMLElement, runs: [], running: false, begun: false, ended: false,
    on: null, memory: 0, spare: 0, processes: 0, freed: null, stopped: null,
    preparing: false, promptLine: '', watch: () => () => {}, fold() {}, settlesIn: () => 0, free() {}, restart() {},
    async stop() { Object.assign(this, {running: false, ended: true}); },
    ...opts,
  } satisfies Prompt;
  return s;
}

test('two positions hold independent shells under the same repo and in other repos', () => {
  const a = shell({begun: true, running: true});
  const b = shell({begun: true});
  const c = shell();
  keepPrompt('oak', 'left', a); keepPrompt('oak', 'right', b); keepPrompt('ash', 'right', c);
  try {
    assert.equal(sessionIfAny('oak'), a);
    assert.equal(sessionIfAny('oak', 'right'), b);
    assert.equal(sessionIfAny('ash'), undefined);
    assert.deepEqual(allSessions(), [['oak', a], ['oak', b], ['ash', c]]);
    assert.equal(promptHolds('oak', 'left'), 'idle');
    assert.equal(promptHolds('oak', 'right'), 'busy');
    assert.equal(promptHolds('oak'), 'busy');
    assert.equal(promptHolds('ash'), null);
  } finally {
    forgetPrompt('oak', 'left', a); forgetPrompt('oak', 'right', b); forgetPrompt('ash', 'right', c);
  }
});

test('repo teardown awaits both sides; a failed side still holds the repo', async () => {
  const a = shell({running: true});
  const b = shell({begun: true, async stop() { throw new Error('still open'); }});
  keepPrompt('oak', 'left', a); keepPrompt('oak', 'right', b);
  try {
    await assert.rejects(stopPrompt('oak', true), /still open/);
    assert.equal(a.ended, true);
    assert.equal(sessionIfAny('oak'), a);
    assert.equal(sessionIfAny('oak', 'right'), b);
    assert.equal(promptHolds('oak'), 'busy');
    b.stop = async () => { b.ended = true; };
    await stopPrompt('oak', true);
    assert.equal(sessionIfAny('oak'), undefined);
    assert.equal(sessionIfAny('oak', 'right'), undefined);
  } finally { forgetPrompt('oak', 'left', a); forgetPrompt('oak', 'right', b); }
});

test('repo teardown neither forgets process survivors nor releases a later session', async () => {
  const a = shell({ended: true, stopped: {before: {processes: 2, memory: 0}, left: 1, ms: null}});
  keepPrompt('elm', 'left', a);
  await assert.rejects(stopPrompt('elm', true), /processes remaining/);
  assert.equal(sessionIfAny('elm'), a);
  assert.equal(promptHolds('elm'), 'busy');
  forgetPrompt('elm', 'left', a);
  const next = shell({begun: true}), old = shell({begun: true, async stop() { keepPrompt('elm', 'left', next); }});
  keepPrompt('elm', 'left', old);
  try {
    await assert.rejects(stopPrompt('elm', true), /processes remaining/);
    assert.equal(forgetPrompt('elm','left',old), false);
    assert.equal(sessionIfAny('elm'), next);
  } finally { forgetPrompt('elm','left',next); }
});
