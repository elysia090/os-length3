import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {ask, choose, wordsOf} from './ask.ts';
import {MAKER_ORIGINS, newest} from './makers.ts';

// The Agent's asking (ask.ts) over a maker's API as fetch sees it: the model a key opens found from its list, newest
// first, the first that answers; an answer read a few words at a time from server-sent events.

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

/** fetch answering each request with `answer(url, body)`, every request kept. */
function maker(answer: (url: string, body: {model?: string; stream?: boolean} | null) => Response) {
  const asked: {url: string; headers: Record<string, string>; body: {model?: string; stream?: boolean} | null}[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    asked.push({url, headers: init?.headers as Record<string, string>, body});
    return answer(url, body);
  }) as typeof fetch;
  return asked;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});

test('the newest of a maker\'s list first, by when it was made or else by its version, and nothing that is no model to talk to', () => {
  assert.deepEqual(newest([{id: 'm-1', created: 100}, {id: 'text-embedding-2', created: 900}, {id: 'm-2', created: 200}, {id: 'whisper-3', created: 950}]),
    ['m-2', 'm-1']);
  assert.deepEqual(newest([{id: 'm-a', created_at: '2025-01-01T00:00:00Z'}, {id: 'm-b', created_at: '2026-02-01T00:00:00Z'}]), ['m-b', 'm-a']);
  // A list that says nothing of when: by the numbers in the names, as Google's does (its "models/" taken off).
  assert.deepEqual(newest([{id: 'models/g-1.5-x'}, {id: 'models/g-2.5-x'}, {id: 'models/g-2-x'}]), ['g-2.5-x', 'g-2-x', 'g-1.5-x']);
});

test('the model chosen is the newest that answers; a key refused is said at once, no other tried', async () => {
  const asked = maker((url, body) => {
    if (url.endsWith('/models')) return json({data: [{id: 'old', created: 1}, {id: 'new', created: 3}, {id: 'mid', created: 2}]});
    return body?.model === 'new' ? json({error: {message: 'not for this key'}}, 404) : json({content: [{type: 'text', text: 'Ready'}]});
  });
  assert.equal(await choose('k', 'ANTHROPIC_API_KEY'), 'mid');
  assert.deepEqual(asked.map((a) => a.body?.model ?? 'list'), ['list', 'new', 'mid']);
  assert.equal(asked[0].headers['x-api-key'], 'k');
  assert.ok(asked.every((a) => MAKER_ORIGINS.includes(new URL(a.url).origin)));

  maker((url) => (url.endsWith('/models') ? json({data: [{id: 'a', created: 1}, {id: 'b', created: 2}]}) : json({error: {message: 'invalid key'}}, 401)));
  await assert.rejects(choose('k', 'OPENAI_API_KEY'), (e: Error & {status: number}) => e.status === 401 && e.message === 'invalid key');
});

test('an answer comes a few words at a time, an event cut between two reads put together, each protocol as it says them', async () => {
  const events = ['data: {"type":"content_block_delta","delta":{"text":"Hel"}}\n\n', 'data: {"type":"content_block_del', 'ta","delta":{"text":"lo"}}\n\n',
    'data: {"type":"message_stop"}\n\n'];
  maker(() => new Response(new ReadableStream({start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(e)); c.close(); }})));
  const words: string[] = [];
  for await (const w of ask({key: 'k', variable: 'ANTHROPIC_API_KEY', model: 'm'}, 'told', 'asked')) words.push(w);
  assert.deepEqual(words, ['Hel', 'lo']);
  assert.equal(wordsOf('chat', '{"choices":[{"delta":{"content":"hi"}}]}'), 'hi');
  assert.equal(wordsOf('chat', '[DONE]'), '');
  assert.equal(wordsOf('messages', 'not json'), '');
});
