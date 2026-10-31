// Who answers the box's Agent, by the key it was given: where each maker's API is reached and how it is spoken to.
// Kept as the open tools keep theirs (Charm's Catwalk, models.dev, which OpenCode reads): an endpoint, a protocol and
// the variable the key is read from, one entry a maker. The maker is never asked for: the key's own form says it
// (core agent_key.rs kind, after the forms gitleaks and TruffleHog look for), and the model is the newest the key opens,
// read from the maker's own list when the key is given (newest), never written down here.

export type Protocol = 'messages' | 'chat';

export interface Maker {
  /** Where its API is, without a slash at the end: `${base}/models`, and the asking under it. */
  base: string;
  /** Anthropic's Messages, or the Chat Completions most others speak. */
  protocol: Protocol;
  /** The headers that carry the key. */
  headers(key: string): Record<string, string>;
}

const bearer = (key: string) => ({authorization: `Bearer ${key}`});

/** By the variable the key is read from (core agent_key.rs kind). */
export const MAKERS: Readonly<Record<string, Maker>> = {
  // From a page, Anthropic asks to be told so (its key is in the page anyway: the person's own, on their device).
  ANTHROPIC_API_KEY: {base: 'https://api.anthropic.com/v1', protocol: 'messages',
    headers: (key) => ({'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'})},
  OPENAI_API_KEY: {base: 'https://api.openai.com/v1', protocol: 'chat', headers: bearer},
  OPENROUTER_API_KEY: {base: 'https://openrouter.ai/api/v1', protocol: 'chat', headers: bearer},
  XAI_API_KEY: {base: 'https://api.x.ai/v1', protocol: 'chat', headers: bearer},
  GROQ_API_KEY: {base: 'https://api.groq.com/openai/v1', protocol: 'chat', headers: bearer},
  DEEPSEEK_API_KEY: {base: 'https://api.deepseek.com', protocol: 'chat', headers: bearer},
  GEMINI_API_KEY: {base: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'chat', headers: bearer},
  PERPLEXITY_API_KEY: {base: 'https://api.perplexity.ai', protocol: 'chat', headers: bearer},
  FIREWORKS_API_KEY: {base: 'https://api.fireworks.ai/inference/v1', protocol: 'chat', headers: bearer},
  HF_TOKEN: {base: 'https://router.huggingface.co/v1', protocol: 'chat', headers: bearer},
};

/** The origins the page may reach for them (policy.ts connect-src). */
export const MAKER_ORIGINS: readonly string[] = [...new Set(Object.values(MAKERS).map((m) => new URL(m.base).origin))];

/** A model in a maker's list: its name, and when it was made (seconds or a date), where the list says. */
export interface Listed { id: string; created?: number | string; created_at?: string }

/** What is no model to talk to over Chat Completions: embeddings, speech, pictures, moderation, search, the older text
 * completions, and those a maker serves only through another API of its own (its coding and research models). */
const NOT_TALK = /embed|whisper|tts|speech|transcri|audio|realtime|dall-e|image|imagen|moderation|guard|search|rerank|vision-preview|instruct|davinci|babbage|codex|computer-use|deep-research/i;

/** When `m` was made, as a time to compare (0 when its list does not say). */
const madeAt = (m: Listed) => {
  const v = m.created ?? m.created_at;
  if (typeof v === 'number') return v * 1000;
  return v ? Date.parse(v) || 0 : 0;
};
/** Its numbers, to put a name with a later version after one with an earlier (where nothing says when it was made). */
const versions = (id: string) => (id.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const later = (a: string, b: string) => {
  const x = versions(a), y = versions(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
};

/** The models to answer with, of those a maker lists, newest first: those to talk to (the first that answers is the one). */
export function newest(list: readonly Listed[]): string[] {
  const talk = list.filter((m) => m.id && !NOT_TALK.test(m.id));
  const dated = talk.some((m) => madeAt(m) > 0);
  return [...talk].sort((a, b) => (dated ? madeAt(b) - madeAt(a) : 0) || later(b.id, a.id)).map((m) => m.id.replace(/^models\//, ''));
}
