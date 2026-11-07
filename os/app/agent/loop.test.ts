import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {Agent, type AgentEvent, type Hands} from './loop.ts';

// The Agent's loop (loop.ts) over a maker's API as fetch sees it: each turn of the model's, the tools it chose done
// with the hands given, what they gave back sent on, until it says it is done; what it does said as it happens.

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

/** fetch answering each request with the next of `turns` (given the body asked), every body kept. */
function maker(turns: ((body: Record<string, unknown>) => unknown)[]) {
  const asked: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // The body as it was sent: what is added to the conversation after is not in it.
    asked.push(structuredClone(body));
    return new Response(JSON.stringify(turns[asked.length - 1](body)), {headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  return asked;
}

/** Hands over a repo of `files`, its runs answered by `ran`, each deed kept. */
function hands(files: Record<string, string>, ran: (command: string) => {output: string; status: number | null}, writes = true) {
  const did: string[] = [];
  const h: Hands = {
    read: async (path) => {
      did.push(`read ${path}`);
      if (!(path in files)) throw new Error(`no ${path}`);
      return {text: files[path], from: 1, to: files[path].split('\n').length - 1, lines: files[path].split('\n').length - 1};
    },
    run: async (command) => { did.push(`run ${command}`); const r = ran(command); return {...r, given: r.output}; },
    ...(writes ? {
      write: async (path: string, content: string) => { did.push(`write ${path}`); const before = files[path] ?? null; files[path] = content; return {before, added: 1, removed: before ? 1 : 0}; },
      edit: async (path: string, edits: {oldText: string; newText: string}[]) => {
        did.push(`edit ${path}`);
        const before = files[path];
        for (const e of edits) files[path] = files[path].replace(e.oldText, e.newText);
        return {before, spans: edits.map((e) => ({line: 1, column: before.indexOf(e.oldText) + 1, old: e.oldText, new: e.newText})), added: 1, removed: 1};
      },
    } : {}),
  };
  return {h, did};
}

const use = (variable: string) => ({key: 'k', variable, model: 'm'});

test('a fix as Anthropic\'s Messages say it: tests run failing, the file read and edited, tests again, its words; each said as it happens', async () => {
  const files = {'rows.c': 'int rows(int n, int per) { return n / per; }\n'};
  let fixed = false;
  const {h, did} = hands(files, () => (fixed ? {output: 'ok 3 tests', status: 0} : {output: 'FAIL rows(10, 4) = 2, want 3', status: 1}));
  const asked = maker([
    () => ({content: [{type: 'tool_use', id: 'a', name: 'bash', input: {command: 'make test'}}]}),
    () => ({content: [{type: 'text', text: 'It rounds down.'}, {type: 'tool_use', id: 'b', name: 'read', input: {path: 'rows.c'}}]}),
    () => { fixed = true; return {content: [{type: 'tool_use', id: 'c', name: 'edit', input: {path: 'rows.c', edits: [{oldText: 'n / per', newText: '(n + per - 1) / per'}]}}]}; },
    () => ({content: [{type: 'tool_use', id: 'd', name: 'bash', input: {command: 'make test'}}]}),
    () => ({content: [{type: 'text', text: 'Rows now round up; the tests pass.'}]}),
  ]);
  const agent = new Agent({use: use('ANTHROPIC_API_KEY'), system: 'told', hands: h});
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  assert.equal(await agent.prompt('Fix #1'), 'Rows now round up; the tests pass.');
  assert.deepEqual(did, ['run make test', 'read rows.c', 'edit rows.c', 'run make test']);
  assert.match(files['rows.c'], /\(n \+ per - 1\)/);
  const kinds = events.map((e) => (e.type === 'tool_execution_end' ? `${e.name}${e.isError ? '!' : ''}` : e.type));
  assert.deepEqual(kinds, ['agent_start', 'turn_start', 'tool_execution_start', 'bash', 'turn_end', 'turn_start', 'message_end', 'tool_execution_start', 'read',
    'turn_end', 'turn_start', 'tool_execution_start', 'edit', 'turn_end', 'turn_start', 'tool_execution_start', 'bash', 'turn_end', 'turn_start', 'message_end', 'turn_end', 'agent_end']);
  // What the screen plays: the edit's file as it was, and where.
  const edit = events.find((e) => e.type === 'tool_execution_end' && e.name === 'edit');
  assert.ok(edit?.type === 'tool_execution_end' && edit.done?.tool === 'edit' && edit.done.spans[0].column === 35 && edit.done.before.includes('n / per'));
  // Offered Pi's four tools; each result given back in the next user turn, a run's with how it ended.
  assert.deepEqual((asked[0].tools as {name: string}[]).map((t) => t.name), ['read', 'bash', 'edit', 'write']);
  const back = (asked[1].messages as {role: string; content: {type: string; tool_use_id: string; content: string}[]}[]).at(-1)!;
  assert.equal(back.role, 'user');
  assert.equal(back.content[0].tool_use_id, 'a');
  assert.match(back.content[0].content, /FAIL rows\(10, 4\)[\s\S]*\[exit status 1\]$/);
});

test('on main it is offered no writing, and a tool that fails is said to it as failed, as OpenAI\'s chat says tools', async () => {
  const {h} = hands({}, () => ({output: '', status: 0}), false);
  const asked = maker([
    () => ({choices: [{message: {content: null, tool_calls: [{id: 'x', type: 'function', function: {name: 'read', arguments: '{"path":"gone.c"}'}}]}}]}),
    () => ({choices: [{message: {content: 'There is no gone.c.'}}]}),
  ]);
  const agent = new Agent({use: use('OPENAI_API_KEY'), system: 'told', hands: h});
  const ends: AgentEvent[] = [];
  agent.subscribe((e) => { if (e.type === 'tool_execution_end') ends.push(e); });
  assert.equal(await agent.prompt('What is in gone.c?'), 'There is no gone.c.');
  assert.deepEqual((asked[0].tools as {function: {name: string}}[]).map((t) => t.function.name), ['read', 'bash']);
  assert.ok(ends[0].type === 'tool_execution_end' && ends[0].isError && !ends[0].done && /no gone\.c/.test(ends[0].result));
  const tool = (asked[1].messages as {role: string; tool_call_id?: string; content: string}[]).at(-1)!;
  assert.deepEqual([tool.role, tool.tool_call_id, tool.content], ['tool', 'x', 'no gone.c']);
});

test('hooks sit outside the loop: one refuses a tool, one says something else of its result; a listener that throws is let go', async () => {
  const {h, did} = hands({'a.c': 'x\n'}, () => ({output: 'gone', status: 0}));
  const asked = maker([
    () => ({content: [{type: 'tool_use', id: 'a', name: 'bash', input: {command: 'rm -rf /'}}, {type: 'tool_use', id: 'b', name: 'read', input: {path: 'a.c'}}]}),
    () => ({content: [{type: 'text', text: 'Done.'}]}),
  ]);
  const agent = new Agent({use: use('ANTHROPIC_API_KEY'), system: 'told', hands: h,
    before: (call) => (call.name === 'bash' ? 'Not that.' : undefined),
    after: (call, given) => (call.name === 'read' ? `${given.text}(read)` : undefined)});
  agent.subscribe(() => { throw new Error('a screen that broke'); });
  assert.equal(await agent.prompt('Clean up'), 'Done.');
  assert.deepEqual(did, ['read a.c']);
  const back = (asked[1].messages as {content: {content: string; is_error?: boolean}[]}[]).at(-1)!.content;
  assert.deepEqual(back.map((c) => [c.content, c.is_error ?? false]), [['Not that.', true], ['x\n(read)', false]]);
});

test('a second question goes on the same conversation; a refusal of the maker ends the work, said', async () => {
  const {h} = hands({}, () => ({output: '', status: 0}));
  const asked = maker([
    () => ({content: [{type: 'text', text: 'One.'}]}),
    () => ({content: [{type: 'text', text: 'Two.'}]}),
  ]);
  const agent = new Agent({use: use('ANTHROPIC_API_KEY'), system: 'told', hands: h});
  await agent.prompt('First?');
  await agent.prompt('Second?');
  assert.deepEqual((asked[1].messages as {role: string}[]).map((m) => m.role), ['user', 'assistant', 'user']);
  globalThis.fetch = (async () => new Response(JSON.stringify({error: {message: 'bad key'}}), {status: 401})) as typeof fetch;
  let end: AgentEvent | undefined;
  agent.subscribe((e) => { if (e.type === 'agent_end') end = e; });
  await assert.rejects(agent.prompt('Third?'), /bad key/);
  assert.ok(end?.type === 'agent_end' && end.error?.status === 401);
});
