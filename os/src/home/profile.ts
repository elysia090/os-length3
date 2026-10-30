// The profile Home shows: a name to be called by, the handle others find one
// by (signed in, the username on the Remote: service/names.ts), and a line
// about them. Kept on this device, and on the Remote when signed in.

import {clipChars} from '../repos/text.ts';

export interface Profile {
  name: string;
  handle: string;
  bio: string;
}

export const EMPTY: Profile = {name: '', handle: '', bio: ''};

/** In characters, as l3 counts them (core/src/home.rs PROFILE_LIMITS). */
export const LIMITS = {name: 50, handle: 31, bio: 160};

/** A handle is a username: 2–31 lowercase letters, digits, `.`, `-` and `_`, from a letter or digit (service/names.ts NAME). */
export function validHandle(handle: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,30}$/.test(handle);
}

/** Up to two letters for the avatar: initials of the name, else the handle. */
export function initials(p: Profile): string {
  const words = p.name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (first(words[0]) + first(words[1])).toUpperCase();
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return p.handle ? first(p.handle).toUpperCase() : '';
}

function first(s: string): string {
  return [...s][0] ?? '';
}

/** Clean user input; returns the error field when something is invalid. */
export function normalize(input: Profile): {profile: Profile; error: keyof Profile | null} {
  const profile = {
    name: clipChars(input.name.trim(), LIMITS.name),
    handle: input.handle.trim().replace(/^@/, '').toLowerCase(),
    bio: clipChars(input.bio.trim(), LIMITS.bio),
  };
  if (profile.handle && !validHandle(profile.handle)) return {profile, error: 'handle'};
  return {profile, error: null};
}

/** Read a stored profile, accepting only well-formed values: a handle kept under an older rule (one letter, or
 *  from a dash) is left out, never the name and the line about them with it. */
export function parse(stored: string | null): Profile {
  try {
    const v = JSON.parse(stored ?? 'null');
    if (v && typeof v.name === 'string' && typeof v.handle === 'string' && typeof v.bio === 'string') {
      const {profile, error} = normalize(v);
      return error ? {...profile, handle: ''} : profile;
    }
  } catch { /* fall through */ }
  return {...EMPTY};
}
