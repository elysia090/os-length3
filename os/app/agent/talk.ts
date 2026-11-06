import {MAKERS, type Maker} from './makers.ts';
import {AgentError, type Use} from './ask.ts';

// A conversation with a maker's model, as each protocol keeps it: what was said, the tools it called and what they
// gave back, turn after turn (the transcript is the conversation's only state, as Pi keeps it). Straight from this
// device to the maker the key is for: nothing of it goes by the Remote.

/** A tool the model is offered: its name, what it does, and its arguments' JSON Schema. */
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

/** A tool called by the model, in either protocol's terms. */
export interface Call { id: string; name: string; input: Record<string, unknown> }

/** One turn of the model's: its words, and the tools it called. */
export interface Turn { text: string; calls: Call[] }

/** What a tool gave back, as the model is told it. */
export interface Given { call: Call; text: string; error: boolean }

export interface Talk {
  /** The person's words, as the next user turn (or with what tools gave back, when that is still to go). */
  said(text: string): void;
  /** The model's next turn. */
  ask(): Promise<Turn>;
  /** What the tools of `turn` gave back. */
  answered(results: Given[]): void;
}

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
function messagesTalk(m: Maker, use: Use, system: string, tools: ToolSpec[], signal?: AbortSignal): Talk {
  const messages: {role: string; content: unknown}[] = [];
  /** A user turn not sent yet: tool results first, then the person's words. */
  let next: unknown[] = [];
  return {
    said(text) { next.push({type: 'text', text}); },
    async ask() {
      if (next.length) { messages.push({role: 'user', content: next}); next = []; }
      const b = await post(m, use, {model: use.model, max_tokens: 4096, system, messages,
        tools: tools.map((t) => ({name: t.name, description: t.description, input_schema: t.parameters}))}, signal) as
        {content?: {type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>}[]};
      const content = b.content ?? [];
      messages.push({role: 'assistant', content});
      return {text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
        calls: content.filter((c) => c.type === 'tool_use').map((c) => ({id: c.id ?? '', name: c.name ?? '', input: c.input ?? {}}))};
    },
    answered(results) {
      next.unshift(...results.map((r) => ({type: 'tool_result', tool_use_id: r.call.id, content: r.text, ...(r.error ? {is_error: true} : {})})));
    },
  };
}

/** OpenAI's chat completions (and every maker that speaks it): tool_calls on the assistant, a `tool` message each. */
function chatTalk(m: Maker, use: Use, system: string, tools: ToolSpec[], signal?: AbortSignal): Talk {
  const messages: unknown[] = [{role: 'system', content: system}];
  return {
    said(text) { messages.push({role: 'user', content: text}); },
    async ask() {
      const b = await post(m, use, {model: use.model, max_tokens: 4096, messages,
        tools: tools.map((t) => ({type: 'function', function: t}))}, signal) as
        {choices?: {message?: {content?: string | null; tool_calls?: {id: string; function: {name: string; arguments: string}}[]}}[]};
      const msg = b.choices?.[0]?.message ?? {};
      messages.push({role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? {tool_calls: msg.tool_calls} : {})});
      const input = (s: string) => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };
      return {text: msg.content ?? '', calls: (msg.tool_calls ?? []).map((c) => ({id: c.id, name: c.function.name, input: input(c.function.arguments)}))};
    },
    answered(results) {
      // The tools' answers go right after the turn that called them, before anything the person said since.
      let at = messages.length;
      while (at > 0 && (messages[at - 1] as {role: string}).role !== 'assistant') at--;
      messages.splice(at, 0, ...results.map((r) => ({role: 'tool', tool_call_id: r.call.id, content: r.text})));
    },
  };
}

/** A conversation with the model `use` opens, told `system`, offered `tools`. */
export function talkTo(use: Use, system: string, tools: ToolSpec[], signal?: AbortSignal): Talk {
  const m = MAKERS[use.variable];
  if (!m) throw new AgentError(0, `no maker for ${use.variable}`);
  return (m.protocol === 'messages' ? messagesTalk : chatTalk)(m, use, system, tools, signal);
}
