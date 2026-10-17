// The profile Home shows. Everyone sees the same page; only its owner gets
// the edit control. Until accounts exist it lives on this device.

export interface Profile {
  name: string;
  handle: string;
  bio: string;
}

export const EMPTY: Profile = {name: '', handle: '', bio: ''};

export const LIMITS = {name: 50, handle: 32, bio: 160};

/** Handles are lowercase letters, digits, `-` and `_`. */
export function validHandle(handle: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(handle);
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
    name: input.name.trim().slice(0, LIMITS.name),
    handle: input.handle.trim().replace(/^@/, '').toLowerCase(),
    bio: input.bio.trim().slice(0, LIMITS.bio),
  };
  if (profile.handle && !validHandle(profile.handle)) return {profile, error: 'handle'};
  return {profile, error: null};
}

/** Read a stored profile, accepting only well-formed values. */
export function parse(stored: string | null): Profile {
  try {
    const v = JSON.parse(stored ?? 'null');
    if (v && typeof v.name === 'string' && typeof v.handle === 'string' && typeof v.bio === 'string') {
      const {profile, error} = normalize(v);
      if (!error) return profile;
    }
  } catch { /* fall through */ }
  return {...EMPTY};
}
