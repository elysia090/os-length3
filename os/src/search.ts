// Finding text in a repo: plain, case-insensitive, line by line, the way
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

/** Lines of `text` that contain `query`, at most `limit`. */
export function findInText(text: string, query: string, limit = 50): Hit[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const hits: Hit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const at = lines[i].toLowerCase().indexOf(q);
    if (at < 0) continue;
    // Keep a long line readable: a window around the match.
    const start = Math.max(0, Math.min(at - 40, lines[i].length - SNIPPET));
    const text = lines[i].slice(start, start + SNIPPET);
    hits.push({line: i + 1, text, from: at - start, to: at - start + q.length});
  }
  return hits;
}

/** Whether a path's name holds `query`. */
export const nameMatches = (path: string, query: string) => !!query && path.toLowerCase().includes(query.toLowerCase());
