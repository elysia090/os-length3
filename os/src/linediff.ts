// Lines added and removed between two texts, for a checkout that has no git
// (the browser): the longest common subsequence of lines, as git's diff
// would count them for files of the size a repo here holds. Past a size
// where that is too slow, lines are counted as a multiset instead (still
// right for appends and removals, only a move reads as both).

export type Op = {kind: 'same' | 'add' | 'del'; text: string};

const split = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
const CAP = 2_000_000;

export function lineOps(before: string, after: string): Op[] {
  const a = split(before), b = split(after);
  // Common head and tail first: most edits touch a little in the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  const ops: Op[] = a.slice(0, head).map((text) => ({kind: 'same', text}));
  if (x.length * y.length > CAP) {
    const count = new Map<string, number>();
    for (const l of x) count.set(l, (count.get(l) ?? 0) + 1);
    const added: string[] = [];
    for (const l of y) { const n = count.get(l) ?? 0; if (n) count.set(l, n - 1); else added.push(l); }
    for (const [text, n] of count) for (let i = 0; i < n; i++) ops.push({kind: 'del', text});
    for (const text of added) ops.push({kind: 'add', text});
  } else {
    // lcs[i][j]: the longest common run of x[i..] and y[j..].
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { ops.push({kind: 'same', text: x[i]}); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push({kind: 'del', text: x[i++]});
      else ops.push({kind: 'add', text: y[j++]});
    }
    while (i < x.length) ops.push({kind: 'del', text: x[i++]});
    while (j < y.length) ops.push({kind: 'add', text: y[j++]});
  }
  for (const text of a.slice(a.length - tail)) ops.push({kind: 'same', text});
  return ops;
}

export function counts(ops: Op[]): {added: number; removed: number} {
  let added = 0, removed = 0;
  for (const o of ops) { if (o.kind === 'add') added++; else if (o.kind === 'del') removed++; }
  return {added, removed};
}

/** A diff line; `at` is which line it is (in the new text, or the old for a removed one). */
export interface DiffLine { kind: 'hunk' | 'add' | 'del' | 'same'; text: string; at?: number }

/** Three lines either side of each change, as git shows them. */
export function hunks(ops: Op[]): {lines: DiffLine[]; more: number} {
  const keep = ops.map((o, i) => o.kind !== 'same' || ops.slice(Math.max(0, i - 3), i + 4).some((x) => x.kind !== 'same'));
  const lines: DiffLine[] = [];
  let old = 0, now = 0;
  ops.forEach((o, i) => {
    const at = o.kind === 'del' ? ++old : o.kind === 'add' ? ++now : (++old, ++now);
    if (!keep[i]) return;
    if (i > 0 && !keep[i - 1]) lines.push({kind: 'hunk', text: '…'});
    lines.push({kind: o.kind, text: o.text, at});
  });
  return {lines: lines.slice(0, 400), more: Math.max(0, lines.length - 400)};
}
