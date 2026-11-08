// The band at the top of Forge: the repos the person has out to work on, in
// the order they put them there. Taking a repo off the band never touches
// the repo itself. An empty band is a choice too: Forge then says how to bring one out.

/** Read a stored band. Never stored yet: start with the open repo (or the first). */
export function parseBand(stored: string | null, repos: readonly string[], current: string | null): string[] {
  if (stored === null) {
    const first = current && repos.includes(current) ? current : repos[0];
    return first ? [first] : [];
  }
  try {
    const v: unknown = JSON.parse(stored);
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((n): n is string => typeof n === 'string' && repos.includes(n)))];
  } catch {
    return [];
  }
}

export function addToBand(band: readonly string[], name: string): string[] {
  return band.includes(name) ? [...band] : [...band, name];
}

/** Take `name` off; if it was the active one, the next to its right (else left) becomes active. */
export function removeFromBand(band: readonly string[], name: string, active: string | null): {band: string[]; active: string | null} {
  const at = band.indexOf(name);
  if (at < 0) return {band: [...band], active};
  const next = band.filter((n) => n !== name);
  if (active !== name) return {band: next, active};
  return {band: next, active: next[at] ?? next[at - 1] ?? null};
}

/** Repos not on the band yet, in the order given. */
export function offBand(band: readonly string[], repos: readonly string[]): string[] {
  return repos.filter((r) => !band.includes(r));
}

/** The most repos side by side in Forge's center. */
export const BESIDE = 3;

/**
 * The repos shown side by side, with `name` opened beside them at `at` (an index among them; by default just right
 * of `active`). Already shown, it stays where it is. One past the most, the one farthest from where it opens goes.
 */
export function openBeside(shown: readonly string[], name: string, active: string | null, at?: number): string[] {
  if (shown.includes(name)) return [...shown];
  const where = Math.max(0, Math.min(shown.length, at ?? (active && shown.includes(active) ? shown.indexOf(active) + 1 : shown.length)));
  const next = [...shown.slice(0, where), name, ...shown.slice(where)];
  while (next.length > BESIDE) {
    const i = next.indexOf(name);
    next.splice(i >= next.length / 2 ? 0 : next.length - 1, 1);
  }
  return next;
}

/** `name` shown in `active`'s place (the one box there is, when none is shown yet); already shown, as it is. */
export function showIn(shown: readonly string[], name: string, active: string | null): string[] {
  if (shown.includes(name)) return [...shown];
  const i = active ? shown.indexOf(active) : -1;
  if (i < 0) return shown.length ? [...shown.slice(0, -1), name] : [name];
  return shown.map((n, j) => (j === i ? name : n));
}

/** `name`'s box closed: the others close up; the one beside it (right, else left) is the one worked on if it was. */
export function closeBeside(shown: readonly string[], name: string, active: string | null): {shown: string[]; active: string | null} {
  const at = shown.indexOf(name);
  if (at < 0) return {shown: [...shown], active};
  const next = shown.filter((n) => n !== name);
  return {shown: next, active: active === name ? next[at] ?? next[at - 1] ?? null : active};
}

/**
 * A repo renamed, in a band or in what is shown (its page `from` and each file of it beside, `from:path`): each where
 * it stood, under the new name.
 */
export function renamedIn(list: readonly string[], from: string, to: string): string[] {
  return list.map((k) => (k === from ? to : k.startsWith(`${from}:`) ? `${to}${k.slice(from.length)}` : k));
}

/** `name` moved to `to` (an index in the list as it is now, `name` included) in a band or in what is shown. */
export function moveTo(list: readonly string[], name: string, to: number): string[] {
  const from = list.indexOf(name);
  if (from < 0) return [...list];
  const rest = list.filter((n) => n !== name);
  const at = Math.max(0, Math.min(rest.length, to > from ? to - 1 : to));
  return [...rest.slice(0, at), name, ...rest.slice(at)];
}
