import {MAKERS, type Maker} from './makers.ts';
import {AgentError, type Use} from './ask.ts';

// The Agent at work: asked to do something in a repo, it reads its files, runs commands in its Prompt (a build, the
// tests, a program under a debugger) and, on an issue's work only, writes files, a step at a time, until it says it
// is done. Each step is the maker's model choosing a tool and this device doing it (`Hands`): nothing of the repo
// goes anywhere but to the maker the key is for, and what it runs runs in the repo's own Prompt, where the person
// sees it run. A turn's tools, and what they gave back, are said to `step` as they happen.

/** What the Agent can do in the repo: read a file, run a command in its Prompt, and (on an issue's work) write one. */
export interface Hands {
  read(path: string): Promise<string>;
  run(command: string): Promise<{output: string; status: number | null}>;
  /** Absent on main: the Agent writes only on work handed to it (an issue started). */
  write?: (path: string, text: string) => Promise<{added: number; removed: number}>;
}

/** One thing the Agent did or said, as it happened. */
export type Step =
  | {kind: 'text'; text: string}
  | {kind: 'read'; path: string; error?: string}
  | {kind: 'write'; path: string; added: number; removed: number; error?: string}
  | {kind: 'run'; command: string; status: number | null; output: string; error?: string};

/** At most this many turns of the model's in one piece of work. */
const TURNS = 24;
/** What a tool gives back is cut to this many characters (a run's last ones: where its result is). */
const GIVEN = 12_000;

interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

const READ: ToolSpec = {name: 'read_file', description: 'Read a file of the repo, by its path from the repo\'s top folder.',
  parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}};
const RUN: ToolSpec = {name: 'run', description: 'Run a shell command in the repo\'s Prompt (sh, in the repo\'s top folder: make, cc, gdb, the tests, ls, grep). Gives back what it printed and its exit status.',
  parameters: {type: 'object', properties: {command: {type: 'string'}}, required: ['command']}};
const WRITE: ToolSpec = {name: 'write_file', description: 'Write a file of the repo whole (made if it is not there), by its path from the repo\'s top folder.',
  parameters: {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}, required: ['path', 'content']}};

/** The tools `hands` offers. */
const toolsOf = (hands: Hands): ToolSpec[] => (hands.write ? [READ, RUN, WRITE] : [READ, RUN]);

/** A tool called by the model, in either protocol's terms. */
interface Call { id: string; name: string; input: Record<string, unknown> }

const cut = (s: string, tail = false) => (s.length <= GIVEN ? s : tail ? `…${s.slice(-GIVEN)}` : `${s.slice(0, GIVEN)}…`);

/** `call` done with `hands`: what is given back to the model, and the step it is to the person. */
async function done(call: Call, hands: Hands): Promise<{given: string; error: boolean; step: Step}> {
  const str = (k: string) => (typeof call.input[k] === 'string' ? call.input[k] as string : '');
  try {
    if (call.name === 'read_file') {
      const text = await hands.read(str('path'));
      return {given: cut(text), error: false, step: {kind: 'read', path: str('path')}};
    }
    if (call.name === 'run') {
      const r = await hands.run(str('command'));
      return {given: `${cut(r.output, true)}\n[exit status ${r.status ?? 'unknown'}]`, error: false, step: {kind: 'run', command: str('command'), status: r.status, output: r.output}};
    }
    if (call.name === 'write_file' && hands.write) {
      const r = await hands.write(str('path'), str('content'));
      return {given: `written: ${r.added} lines added, ${r.removed} removed`, error: false, step: {kind: 'write', path: str('path'), ...r}};
    }
    throw new Error(`no such tool here: ${call.name}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const step: Step = call.name === 'run' ? {kind: 'run', command: str('command'), status: null, output: '', error: why}
      : call.name === 'write_file' ? {kind: 'write', path: str('path'), added: 0, removed: 0, error: why}
      : {kind: 'read', path: str('path'), error: why};
    return {given: why, error: true, step};
  }
}

/** One turn asked of the maker: the model's words and the tools it called. */
interface Turn { text: string; calls: Call[] }

/** The conversation as each protocol keeps it. */
interface Talk { ask(): Promise<Turn>; answered(turn: Turn, results: {call: Call; given: string; error: boolean}[]): void }

async function post(m: Maker, use: Use, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const r = await fetch(`${m.base}${m.protocol === 'messages' ? '/messages' : '/chat/completions'}`, {
    method: 'POST', headers: {...m.headers(use.key), 'content-type': 'application/json'}, signal, body: JSON.stringify(body),
  });
  if (!r.ok) {
    let said = '';
    try { const b = await r.json() as {error?: {message?: string} | string; message?: string}; said = typeof b.error === 'string' ? b.error : b.error?.message ?? b.message ?? ''; } catch { /* none said */ }
    throw new AgentError(r.status, said || `${r.status} ${r.statusText}`.trim());
  }
  return r.json();
}

/** Anthropic's Messages: tool_use blocks in the model's turn, tool_result blocks in the next user turn. */
function messagesTalk(m: Maker, use: Use, system: string, question: string, tools: ToolSpec[], signal?: AbortSignal): Talk {
  const messages: unknown[] = [{role: 'user', content: question}];
  return {
    async ask() {
      const b = await post(m, use, {model: use.model, max_tokens: 4096, system, messages,
        tools: tools.map((t) => ({name: t.name, description: t.description, input_schema: t.parameters}))}, signal) as
        {content?: {type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>}[]};
      const content = b.content ?? [];
      messages.push({role: 'assistant', content});
      return {text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        calls: content.filter((c) => c.type === 'tool_use').map((c) => ({id: c.id ?? '', name: c.name ?? '', input: c.input ?? {}}))};
    },
    answered(_turn, results) {
      messages.push({role: 'user', content: results.map((r) => ({type: 'tool_result', tool_use_id: r.call.id, content: r.given, ...(r.error ? {is_error: true} : {})}))});
    },
  };
}

/** OpenAI's chat completions (and every maker that speaks it): tool_calls on the assistant, a `tool` message each. */
function chatTalk(m: Maker, use: Use, system: string, question: string, tools: ToolSpec[], signal?: AbortSignal): Talk {
  const messages: unknown[] = [{role: 'system', content: system}, {role: 'user', content: question}];
  return {
    async ask() {
      const b = await post(m, use, {model: use.model, max_tokens: 4096, messages,
        tools: tools.map((t) => ({type: 'function', function: t}))}, signal) as
        {choices?: {message?: {content?: string | null; tool_calls?: {id: string; function: {name: string; arguments: string}}[]}}[]};
      const msg = b.choices?.[0]?.message ?? {};
      messages.push({role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? {tool_calls: msg.tool_calls} : {})});
      const input = (s: string) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };
      return {text: msg.content ?? '', calls: (msg.tool_calls ?? []).map((c) => ({id: c.id, name: c.function.name, input: input(c.function.arguments)}))};
    },
    answered(_turn, results) {
      for (const r of results) messages.push({role: 'tool', tool_call_id: r.call.id, content: r.given});
    },
  };
}

/**
 * `question` worked on with the model `use` opens, told `system`, doing what it asks with `hands`: each step said to
 * `step` as it happens. Returns its last words (what it says it did), once it calls no more tools.
 */
export async function work(use: Use, system: string, question: string, hands: Hands, step: (s: Step) => void, signal?: AbortSignal): Promise<string> {
  const m = MAKERS[use.variable];
  if (!m) throw new AgentError(0, `no maker for ${use.variable}`);
  const tools = toolsOf(hands);
  const talk = (m.protocol === 'messages' ? messagesTalk : chatTalk)(m, use, system, question, tools, signal);
  let last = '';
  for (let k = 0; k < TURNS; k++) {
    const turn = await talk.ask();
    if (turn.text.trim()) { last = turn.text; step({kind: 'text', text: turn.text}); }
    if (!turn.calls.length) return last;
    const results = [];
    // One after another, as a person would: a write then the tests that read it.
    for (const call of turn.calls) {
      const r = await done(call, hands);
      step(r.step);
      results.push({call, given: r.given, error: r.error});
    }
    talk.answered(turn, results);
  }
  throw new AgentError(0, `stopped after ${TURNS} turns without finishing`);
}
