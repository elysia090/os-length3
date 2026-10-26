import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Tabs, type Channel, type Locks, type Message} from './tabs.ts';

/** One browser's channel: what a tab posts, every other tab hears (a moment later, as a BroadcastChannel does). */
function browserOf() {
  const open: Channel[] = [];
  return () => {
    const me: Channel = {
      onmessage: null,
      postMessage(m: Message) { for (const c of open) if (c !== me) setTimeout(() => c.onmessage?.({data: structuredClone(m)}), 0); },
    };
    open.push(me);
    return me;
  };
}
/** Every message posted so far heard, and every answer to them: a few turns of the event loop, in order. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

test('a tab knows another of this browser is open until it says it goes, or its lock is let go', async () => {
  const channel = browserOf();
  const held = new Set<string>();
  const locks: Locks = {
    async request(name: string) { held.add(name); return new Promise(() => {}); },
    async query() { return {held: [...held].map((name) => ({name}))}; },
  };
  const a = new Tabs(channel(), locks);
  assert.equal(a.othersOpen(), false);
  // B opens: each hears of the other.
  const bc = channel();
  const b = new Tabs(bc, locks);
  await settle();
  assert.equal(a.othersOpen(), true);
  assert.equal(b.othersOpen(), true);
  // B closes as a page does (it says so, and hears no more): A is alone again.
  b.bye();
  bc.onmessage = null;
  await settle();
  assert.equal(a.othersOpen(), false);
  // C ends without a word (it crashed): its lock goes with it, and A finds it gone.
  const c = new Tabs(channel(), locks);
  await settle();
  assert.equal(a.othersOpen(), true);
  held.delete(`length3:tab:${c.me}`);
  await a.prune();
  assert.equal(a.othersOpen(), false);
  // Back from the back-forward cache: the others are asked again.
  const d = new Tabs(channel(), locks);
  await settle();
  a.again();
  await settle();
  assert.equal(a.othersOpen(), true);
  assert.equal(d.othersOpen(), true);
});

test('in the app, or a page without channels, a tab is alone', () => {
  assert.equal(new Tabs(null).othersOpen(), false);
});
