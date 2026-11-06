import assert from 'node:assert/strict';
import {test} from 'node:test';
import {onPlugins, pluginsOpen, setPluginsOpen, SLOTS, Slots} from './plugins.ts';

const slot = (id: string) => ({id, label: id, make: () => ({}) as HTMLElement});

test('the area holds up to seven plugins, each once', () => {
  const s = new Slots();
  for (let i = 0; i < SLOTS; i++) assert.equal(s.add(slot(`p${i}`)), true);
  assert.equal(s.add(slot('p7')), false);
  assert.equal(s.all.length, 7);
  assert.equal(new Slots().add(slot('a')) && new Slots().add(slot('a')), true);
  const t = new Slots();
  t.add(slot('a'));
  assert.equal(t.add(slot('a')), false);
});

test('plugins switch sideways, one at a time, stopping at either end', () => {
  const s = new Slots();
  assert.equal(s.step(1), 0);
  for (const id of ['a', 'b', 'c']) s.add(slot(id));
  assert.equal(s.step(1), 1);
  assert.equal(s.step(1), 2);
  assert.equal(s.step(1), 2);
  assert.equal(s.step(-1), 1);
  assert.equal(s.choose(-5), 0);
  assert.equal(s.choose(99), 2);
});

test('the area is plain until it is opened, and says when it opens or closes', () => {
  assert.equal(pluginsOpen(), false);
  let told = 0;
  const off = onPlugins(() => told++);
  setPluginsOpen(true);
  setPluginsOpen(true);
  assert.equal(pluginsOpen(), true);
  setPluginsOpen(false);
  off();
  setPluginsOpen(true);
  assert.equal(told, 2);
  setPluginsOpen(false);
});
