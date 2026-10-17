import {getState, setState} from './state.ts';

// The person's dotfiles: Home keeps them (`dotfiles`, name → text), the
// Remote keeps them in step across devices like the profile, and every
// Prompt starts with them written into /root, fresh each time (the repo is
// still the only place written back). Runtime shows and edits them.

/** A name that may be written into /root: a dot, then letters, digits and . _ -. */
export const validName = (name: string) => /^\.[A-Za-z0-9._-]{1,63}$/.test(name) && !name.includes('..');

/** Names a person commonly keeps, offered when making a new one. */
export const COMMON = ['.profile', '.shrc', '.gitconfig', '.nanorc', '.inputrc', '.editorconfig'] as const;

export function read(): Record<string, string> {
  try {
    const v = JSON.parse(getState('dotfiles') ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, t]) => validName(k) && typeof t === 'string')) as Record<string, string>;
  } catch { return {}; }
}

export async function write(all: Record<string, string>): Promise<void> {
  await setState('dotfiles', JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)))));
}

/** What a Prompt starts with: each dotfile as a file under /root. */
export function asFiles(): {path: string; bytes: Uint8Array; mode: number}[] {
  return Object.entries(read()).map(([name, text]) => ({path: `/root/${name}`, bytes: new TextEncoder().encode(text), mode: 0o644}));
}
