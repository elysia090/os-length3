// Which repos' Prompts may reach the network: this device's grant, kept in Home's state (`network`, which the core
// and why read too), given and taken from Runtime and the Agent's cards.

import {getState, setState} from './state.ts';
import {onRenamed} from '../repos/repos.ts';

/** The repos whose Prompts may reach the network. */
export const granted = (): string[] => { try { return JSON.parse(getState('network') ?? '[]') as string[]; } catch { return []; } };
/** Give `repo`'s Prompts the network (from their next start), or take it. */
export async function grant(repo: string, on: boolean) {
  const all = new Set(granted());
  if (on) all.add(repo); else all.delete(repo);
  await setState('network', JSON.stringify([...all].sort()));
}
// A repo renamed keeps its grant under its new name.
onRenamed((from, to) => { if (granted().includes(from)) void grant(from, false).then(() => grant(to, true)).catch(() => {}); });
