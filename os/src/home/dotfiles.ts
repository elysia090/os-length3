import {t} from '../i18n.ts';
import {core} from '../app/host.ts';
import {getState, reloadState} from './state.ts';

// The person's dotfiles: Home keeps them (`dotfiles`, name → text), the
// Remote keeps them in step across devices like the profile, and every
// Prompt starts with them written into /root, fresh each time (the repo is
// still the only place written back). Runtime shows and edits them.
//
// What they hold runs (`.setup` with the network, `.profile` in every shell,
// the keys of `.authorized_keys` let in over SSH), so one changed elsewhere
// (another device, or anyone able to write to the Remote as the person) runs
// nowhere here until it is taken here: a Prompt starts with those this device
// took (`trusted`, never sent), and one written here is taken at once. The
// core keeps the rule (core/src/home.rs dotfiles_in_effect); this reads it.

/** A name that may be written into /root: a dot, then letters, digits and . _ -. */
export const validName = (name: string) => /^\.[A-Za-z0-9._-]{1,63}$/.test(name) && !name.includes('..');

/** Names a person commonly keeps, offered when making a new one. */
export const COMMON = ['.profile', '.shrc', '.gitconfig', '.nanorc', '.inputrc', '.editorconfig'] as const;

/** The dotfiles kept under `key`, those with a name that may be written. */
function kept(key: 'dotfiles' | 'trusted'): Record<string, string> {
  try {
    const v = JSON.parse(getState(key) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, t]) => validName(k) && typeof t === 'string')) as Record<string, string>;
  } catch { return {}; }
}

/** The dotfiles as the Remote keeps them: what is listed and edited. */
export const read = (): Record<string, string> => kept('dotfiles');

/** What this device runs: each as it was taken here, of those still kept. */
export function inEffect(): Record<string, string> {
  const all = read();
  return Object.fromEntries(Object.entries(kept('trusted')).filter(([n]) => n in all));
}

/** Those changed or added elsewhere and not taken here: kept, and nothing of them runs here yet. */
export function waiting(): string[] {
  const here = kept('trusted');
  return Object.entries(read()).filter(([n, text]) => here[n] !== text).map(([n]) => n).sort();
}

/** Keep `text` as `name` (made or changed), on every device; it runs here at once, elsewhere once taken there. */
export async function save(name: string, text: string): Promise<void> {
  if (!validName(name)) throw new Error(t('Dotfiles must begin with a dot (e.g. .profile)'));
  await core('dotfile_set', {name, text});
  await reloadState(['dotfiles', 'trusted']);
}

/** Take `name` away, from every device (asked first: nothing keeps it); a running Prompt keeps its copy until it starts again. */
export async function remove(name: string): Promise<void> {
  if (!(name in read())) return;
  await core('dotfile_set', {name, text: null});
  await reloadState(['dotfiles', 'trusted']);
}

/** Run here what changed elsewhere: `names`, or every one waiting. */
export async function take(names: string[] = []): Promise<void> {
  await core('dotfiles_take', {names});
  await reloadState(['dotfiles', 'trusted']);
}

/** What a Prompt starts with: each dotfile this device runs, as a file under /root. */
export function asFiles(): {path: string; bytes: Uint8Array; mode: number}[] {
  return Object.entries(inEffect()).map(([name, text]) => ({path: `/root/${name}`, bytes: new TextEncoder().encode(text), mode: 0o644}));
}
