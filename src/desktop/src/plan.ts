// A board's plan is one text that several people write. An edit goes to the
// Remote as what it changed (hunks of lines, against the version it was made
// on), not as the whole text, and the Remote takes it in over whatever came
// meanwhile: changes in different places both stay; two different changes
// to the same lines are not merged, and the writer is shown both. This module
// is the same on both sides (the app and service/servers.ts).

/** Lines `at`..`at + del` of the base give way to `ins`. */
export interface Hunk { at: number; del: number; ins: string[] }

export const lines = (text: string) => text.split('\n');
export const text = (ls: string[]) => ls.join('\n');

/** Past this many line pairs, a change is one hunk for the whole text (the longest common run would be slow). */
const CAP = 4_000_000;

/** What turns `before` into `after`, as hunks in order. */
export function hunks(before: string[], after: string[]): Hunk[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const x = before.slice(head, before.length - tail), y = after.slice(head, after.length - tail);
  if (!x.length && !y.length) return [];
  if (x.length * y.length > CAP) return [{at: head, del: x.length, ins: y}];
  // lcs[i][j]: the longest common run of x[i..] and y[j..].
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  }
  const out: Hunk[] = [];
  let open: Hunk | null = null;
  const close = () => { if (open) out.push(open); open = null; };
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { close(); i++; j++; continue; }
    open ??= {at: head + i, del: 0, ins: []};
    if (j >= y.length || (i < x.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { open.del++; i++; } else { open.ins.push(y[j++]); }
  }
  close();
  return out;
}

/** Whether `hs` are hunks of a text of `n` lines: in order, apart, inside it. */
export function valid(hs: unknown, n: number): hs is Hunk[] {
  if (!Array.isArray(hs)) return false;
  let pos = 0;
  for (const h of hs as Hunk[]) {
    if (!h || !Number.isInteger(h.at) || !Number.isInteger(h.del) || h.at < pos || h.del < 0 || h.at + h.del > n
      || !Array.isArray(h.ins) || !h.ins.every((l) => typeof l === 'string' && !l.includes('\n'))) return false;
    pos = h.at + h.del;
  }
  return true;
}

const same = (a: Hunk, b: Hunk) => a.at === b.at && a.del === b.del && a.ins.length === b.ins.length && a.ins.every((l, k) => l === b.ins[k]);
/** Two hunks touch the same lines (or insert at the same place). */
const meet = (a: Hunk, b: Hunk) => (a.at === b.at) || (a.at < b.at + b.del && b.at < a.at + a.del);

/**
 * `base` with both sides' hunks, or null where they changed the same lines
 * differently. The same change made on both sides is taken once.
 */
export function merge(base: string[], ours: Hunk[], theirs: Hunk[]): string[] | null {
  const out: string[] = [];
  let pos = 0, i = 0, j = 0;
  while (i < ours.length || j < theirs.length) {
    const a = ours[i], b = theirs[j];
    let h: Hunk;
    if (a && b && meet(a, b)) {
      if (!same(a, b)) return null;
      h = a; i++; j++;
    } else if (a && (!b || a.at < b.at)) { h = a; i++; } else { h = b!; j++; }
    out.push(...base.slice(pos, h.at), ...h.ins);
    pos = h.at + h.del;
  }
  out.push(...base.slice(pos));
  return out;
}

export const apply = (base: string[], hs: Hunk[]) => merge(base, hs, [])!;
