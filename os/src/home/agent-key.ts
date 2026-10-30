import {core} from '../app/host.ts';
import {choose, type Use} from '../agent/ask.ts';

// The Agent's key on this device (core agent_key.rs): kept here alone, never sent to the Remote, whole only for the
// asking. Whether there is one decides whether the box offers the Agent at all.

/** The key as it may be shown (`sk-ant-…a9AA`) and the model it opens; null with none. */
export interface Shown { shown: string; model: string }

let known: Shown | null | undefined;
const heard = new Set<(k: Shown | null) => void>();

/** The key kept here, as it may be shown (read once, then as it changes). */
export async function agentKey(): Promise<Shown | null> {
  // Not read (the core not up yet): asked again next time, not taken as none.
  if (known === undefined) known = await core<Shown | null>('agent_key', {}).catch(() => undefined);
  return known ?? null;
}
/** Whether a key is kept here, as last read (false before it is). */
export const hasAgentKey = (): boolean => !!known;
/** Hear the key kept, changed or taken away; returns how to stop. */
export function onAgentKey(f: (k: Shown | null) => void): () => void { heard.add(f); return () => heard.delete(f); }

async function told() {
  known = await core<Shown | null>('agent_key', {}).catch(() => null);
  for (const f of [...heard]) f(known);
}

/**
 * `key` given: read as its maker's (refused if it is no key this OS knows), the newest model it opens that answers
 * found, and both kept here. Throws what was wrong (the maker's own words for a key it refuses).
 */
export async function giveAgentKey(key: string, signal?: AbortSignal): Promise<void> {
  const given = key.trim();
  const variable = await core<string>('agent_key_kind', {key: given});
  const model = await choose(given, variable, signal);
  await core('agent_key_set', {key: given, model});
  await told();
}

/** The key taken away from this device. */
export async function forgetAgentKey(): Promise<void> {
  await core('agent_key_set', {key: null});
  await told();
}

/** The key, whole, for asking with; null with none. */
export const agentUse = (): Promise<Use | null> => core<Use | null>('agent_key_use', {}).catch(() => null);
