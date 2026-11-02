import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {work, type Hands, type Step} from './work.ts';

// The Agent at work (work.ts) over a maker's API as fetch sees it: each turn of the model's, the tools it chose done
// with the hands given, what they gave back sent on, until it says it is done; in each protocol's terms.

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

/** fetch answering each request with the next of `turns` (given the body asked), every body kept. */
function maker(turns: ((body: Record<string, unknown>) => unknown)[]) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    asked.push(body);
    return new Response(JSON.stringify(turns[asked.length - 1](body)), {headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  return asked;
}

/** Hands over a repo of `files`, its runs answered by `ran`, each deed kept. */
function hands(files: Record<string, string>, ran: (command: string) => {output: string; status: number | null}, writes = true) {
  const did: string[] = [];
  const h: Hands = {
    read: async (path) => { did.push(`read ${path}`); if (!(path in files)) throw new Error(`no ${path}`); return files[path]; },
    run: async (command) => { did.push(`run ${command}`); return ran(command); },
    ...(writes ? {write: async (path: string, text: string) => { did.push(`write ${path}`); files[path] = text; return {added: 1, removed: 1}; }} : {}),
  };
  return {h, did};
}

test('a fix as Anthropic\'s Messages say it: the tests run, failing; the file read and written; the tests run again; its words', async () => {
  const files = {'rows.c': 'int rows(int n, int per) { return n / per; }\n'};
  let fixed = false;
  const {h, did} = hands(files, () => (fixed ? {output: 'ok 3 tests', status: 0} : {output: 'FAIL rows(10, 4) = 2, want 3', status: 1}));
  const asked = maker([
    () => ({content: [{type: 'tool_use', id: 'a', name: 'run', input: {command: 'make test'}}]}),
    () => ({content: [{type: 'text', text: 'It rounds down.'}, {type: 'tool_use', id: 'b', name: 'read_file', input: {path: 'rows.c'}}]}),
    () => { fixed = true; return {content: [{type: 'tool_use', id: 'c', name: 'write_file', input: {path: 'rows.c', content: 'int rows(int n, int per) { return (n + per - 1) / per; }\n'}}]}; },
    () => ({content: [{type: 'tool_use', id: 'd', name: 'run', input: {command: 'make test'}}]}),
    () => ({content: [{type: 'text', text: 'Rows now round up; the tests pass.'}]}),
  ]);
  const steps: Step[] = [];
  const said = await work({key: 'k', variable: 'ANTHROPIC_API_KEY', model: 'm'}, 'told', 'Fix #1', h, (s) => steps.push(s));
  assert.equal(said, 'Rows now round up; the tests pass.');
  assert.deepEqual(did, ['run make test', 'read rows.c', 'write rows.c', 'run make test']);
  assert.match(files['rows.c'], /\(n \+ per - 1\)/);
  assert.deepEqual(steps.map((s) => s.kind), ['run', 'text', 'read', 'write', 'run', 'text']);
  assert.equal((steps[0] as {status: number}).status, 1);
  // Offered all three tools; each result given back in the next user turn, a run's with how it ended.
  assert.deepEqual((asked[0].tools as {name: string}[]).map((t) => t.name), ['read_file', 'run', 'write_file']);
  const back = (asked[1].messages as {role: string; content: {type: string; tool_use_id: string; content: string}[]}[]).at(-1)!;
  assert.equal(back.role, 'user');
  assert.equal(back.content[0].tool_use_id, 'a');
  assert.match(back.content[0].content, /FAIL rows\(10, 4\)[\s\S]*\[exit status 1\]$/);
});

test('on main it is offered no writing, and a tool that fails is said to it as failed, as OpenAI\'s chat says tools', async () => {
  const {h} = hands({}, () => ({output: '', status: 0}), false);
  const asked = maker([
    () => ({choices: [{message: {content: null, tool_calls: [{id: 'x', type: 'function', function: {name: 'read_file', arguments: '{"path":"gone.c"}'}}]}}]}),
    () => ({choices: [{message: {content: 'There is no gone.c.'}}]}),
  ]);
  const steps: Step[] = [];
  const said = await work({key: 'k', variable: 'OPENAI_API_KEY', model: 'm'}, 'told', 'What is in gone.c?', h, (s) => steps.push(s));
  assert.equal(said, 'There is no gone.c.');
  assert.deepEqual((asked[0].tools as {function: {name: string}}[]).map((t) => t.function.name), ['read_file', 'run']);
  assert.equal(steps[0].kind, 'read');
  assert.match((steps[0] as {error?: string}).error ?? '', /no gone\.c/);
  const tool = (asked[1].messages as {role: string; tool_call_id?: string; content: string}[]).at(-1)!;
  assert.deepEqual([tool.role, tool.tool_call_id, tool.content], ['tool', 'x', 'no gone.c']);
});
