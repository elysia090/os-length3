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
