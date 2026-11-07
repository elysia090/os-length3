// Finding text in a repo: plain, case-insensitive, by line, the way
// grep -in reads. Pure, so it is tested without a page.

export interface Hit {
  /** 1-based line number. */
  line: number;
  text: string;
  /** Where the match starts and ends in `text`. */
  from: number;
  to: number;
}

const SNIPPET = 160;

/**
 * Lines of `text` that contain `query`, at most `limit`, each without its indent (the words, as a reader names the
 * line). `low` is the text lowercased, kept by whoever searches the same text key after key: the whole text is then
 * gone through once by the engine's own search, and the lines counted only up to each hit, never split.
 */
export function findInText(text: string, query: string, limit = 50, low = text.toLowerCase()): Hit[] {
  const q = query.toLowerCase();
  if (!q) return [];
  // A letter whose lowercase is longer (İ) moves every place after it: line by line then, as grep reads.
  if (low.length !== text.length) return byLine(text, q, limit);
  const hits: Hit[] = [];
  let line = 1, counted = 0;
  for (let at = low.indexOf(q); at >= 0 && hits.length < limit;) {
    const from = text.lastIndexOf('\n', at - 1) + 1;
    let to = text.indexOf('\n', at);
    if (to < 0) to = text.length;
    for (let nl = text.indexOf('\n', counted); nl >= 0 && nl < from; nl = text.indexOf('\n', nl + 1)) line++;
    counted = from;
    hits.push(hit(line, text.slice(from, to), at - from, q.length));
    at = to < text.length ? low.indexOf(q, to + 1) : -1;
  }
  return hits;
}

/** As findInText, a line at a time. */
function byLine(text: string, q: string, limit: number): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const at = lines[i].toLowerCase().indexOf(q);
    if (at >= 0) hits.push(hit(i + 1, lines[i], at, q.length));
  }
  return hits;
}

/** Line `n` found at `at` (`len` long): its indent off (not where the match is), a long line cut to a window around it. */
function hit(n: number, whole: string, at: number, len: number): Hit {
  let lead = 0;
  while (lead < at && (whole[lead] === ' ' || whole[lead] === '\t')) lead++;
  const words = whole.slice(lead), w = at - lead;
  const start = Math.max(0, Math.min(w - 40, words.length - SNIPPET));
  return {line: n, text: words.slice(start, start + SNIPPET), from: w - start, to: w - start + len};
}

/** Whether a path's name holds `query`. */
export const nameMatches = (path: string, query: string) => !!query && path.toLowerCase().includes(query.toLowerCase());

/** Groups of a search, those whose name holds the query first (a file looked for by its name is the first choice), each kept in its order. */
export function nameFirst<G extends {path: string}>(groups: G[], query: string): G[] {
  return [...groups.filter((g) => nameMatches(g.path, query)), ...groups.filter((g) => !nameMatches(g.path, query))];
}

/**
 * Where a line found earlier is in `text` now: the same line if it still
 * holds `query`, else the nearest line that does (the text moved under it),
 * else null (it is gone).
 */
export function stillAt(text: string, query: string, line: number): number | null {
  const hits = findInText(text, query, Number.MAX_SAFE_INTEGER);
  if (!hits.length) return null;
  return hits.reduce((best, h) => (Math.abs(h.line - line) < Math.abs(best - line) ? h.line : best), hits[0].line);
}
