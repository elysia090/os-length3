import {core, isNative} from '../app/host.ts';
import {choose, type Use} from '../agent/ask.ts';
import {connection, passkeys} from '../remote/connection.ts';
import {canSeal, seal, unseal, type SealedKey} from './seal.ts';

// The Agent's key on this device (core agent_key.rs): kept here alone, never sent to the Remote, whole only for the
// asking. Whether there is one decides whether the box offers the Agent at all. In a browser, where what is kept is
// in the profile's files, it is sealed by the person's passkey where there is one with PRF (seal.ts), and opened
// once a session, the first time the Agent is asked.

/** The key as it may be shown (`sk-ant-…a9AA`), the model it opens, and whether a passkey sealed it; null with none. */
export interface Shown { shown: string; model: string; sealed?: boolean }

/** The key opened this session (a sealed one), so the passkey is asked once. */
let opened: Use | null = null;

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
  opened = null;
  const sealed = await sealing(given);
  if (sealed) {
    await core('agent_key_seal', {sealed, key: given, model});
    opened = {key: given, variable, model};
  } else {
    await core('agent_key_set', {key: given, model});
  }
  await told();
}

/**
 * `key` sealed by the person's passkey, in a browser signed in with one whose browser says its passkeys can (seal.ts);
 * null where it cannot be: no passkey asked of someone who has none, and one called off keeps the key as given.
 */
async function sealing(key: string): Promise<SealedKey | null> {
  if (isNative || !connection() || !await canSeal()) return null;
  if (!(await passkeys().catch(() => [])).length) return null;
  return seal(key).catch(() => null);
}

/** The key taken away from this device. */
export async function forgetAgentKey(): Promise<void> {
  opened = null;
  await core('agent_key_set', {key: null});
  await told();
}

/**
 * The key, whole, for asking with; null with none. A sealed one is opened by the passkey the first time it is asked
 * for (`open`; never by what only reads it, a Prompt starting, which goes without it until then), then kept for the
 * session; one the person would not open throws.
 */
export async function agentUse(open = true): Promise<Use | null> {
  const u = await core<Use | {sealed: SealedKey; variable: string; model: string} | null>('agent_key_use', {}).catch(() => null);
  if (!u) return null;
  if ('key' in u) return u;
  if (opened) return opened;
  if (!open) return null;
  opened = {key: await unseal(u.sealed), variable: u.variable, model: u.model};
  return opened;
}
