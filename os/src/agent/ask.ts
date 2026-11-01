import {MAKERS, newest, type Listed, type Maker} from './makers.ts';

// The Agent asked: the model a key opens, found once when the key is given, and a question sent to it with what the
// person is looking at, its answer coming back a few words at a time. Straight from this device to the maker: nothing
// of it, the key least of all, goes by the Remote.

/** What asking needs: the key, the variable it is read from (its maker), and the model it opens. */
export interface Use { key: string; variable: string; model: string }

/** A maker's refusal or silence, said as a person would read it. */
export class AgentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function makerOf(variable: string): Maker {
  const m = MAKERS[variable];
  if (!m) throw new AgentError(0, `no maker for ${variable}`);
  return m;
}

async function refused(r: Response): Promise<AgentError> {
  let said = '';
  try {
    const body = await r.json() as {error?: {message?: string} | string; message?: string};
    said = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '';
  } catch { /* none said */ }
  return new AgentError(r.status, said || `${r.status} ${r.statusText}`.trim());
}

/** The models `key` opens, as its maker lists them. */
export async function listed(key: string, variable: string, signal?: AbortSignal): Promise<Listed[]> {
  const m = makerOf(variable);
  const r = await fetch(`${m.base}/models`, {headers: m.headers(key), signal});
  if (!r.ok) throw await refused(r);
  const body = await r.json() as {data?: Listed[]; models?: Listed[]};
  return body.data ?? body.models ?? [];
}

/** The body of a question to `model`: what it is told (`system`) and asked (`question`), answered as it comes (`stream`). */
function body(m: Maker, model: string, system: string, question: string, stream: boolean, most: number) {
  return m.protocol === 'messages'
    ? {model, max_tokens: most, system, messages: [{role: 'user', content: question}], stream}
    : {model, max_tokens: most, messages: [{role: 'system', content: system}, {role: 'user', content: question}], stream};
}

/**
 * The newest model `key` opens that answers: its maker's list, newest first, each asked for one word until one gives
 * it (a list holds models a key may not open, or that speak another API). Throws what the maker said when none does.
 */
export async function choose(key: string, variable: string, signal?: AbortSignal): Promise<string> {
  const m = makerOf(variable);
  let last: AgentError | null = null;
  for (const model of newest(await listed(key, variable, signal)).slice(0, 6)) {
    const r = await fetch(`${m.base}${m.protocol === 'messages' ? '/messages' : '/chat/completions'}`, {
      method: 'POST', headers: {...m.headers(key), 'content-type': 'application/json'}, signal,
      body: JSON.stringify(body(m, model, 'Answer with one word.', 'Ready?', false, 8)),
    });
    if (r.ok) return model;
    last = await refused(r);
    // The key itself refused: no other model will take it either.
    if (r.status === 401 || r.status === 403) throw last;
  }
  throw last ?? new AgentError(0, 'no model to talk to');
}

/** The words of one event of a streamed answer, as each protocol says them. */
export function wordsOf(protocol: 'messages' | 'chat', data: string): string {
  if (data === '[DONE]') return '';
  try {
    const e = JSON.parse(data) as {type?: string; delta?: {text?: string}; choices?: {delta?: {content?: string}}[]};
    if (protocol === 'messages') return e.type === 'content_block_delta' ? e.delta?.text ?? '' : '';
    return e.choices?.[0]?.delta?.content ?? '';
  } catch { return ''; }
}

/** `question` asked of the model `use` opens, told `system`: its answer, a few words at a time as they come. */
export async function* ask(use: Use, system: string, question: string, signal?: AbortSignal): AsyncGenerator<string> {
  const m = makerOf(use.variable);
  const r = await fetch(`${m.base}${m.protocol === 'messages' ? '/messages' : '/chat/completions'}`, {
    method: 'POST', headers: {...m.headers(use.key), 'content-type': 'application/json', accept: 'text/event-stream'}, signal,
    body: JSON.stringify(body(m, use.model, system, question, true, 2048)),
  });
  if (!r.ok || !r.body) throw await refused(r);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let held = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    held += value;
    // Server-sent events, one `data:` line each; a line cut between two reads waits for its end.
    const lines = held.split('\n');
    held = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const words = wordsOf(m.protocol, line.slice(5).trim());
      if (words) yield words;
    }
  }
}
