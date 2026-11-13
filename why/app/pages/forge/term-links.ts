import {onChange, store} from '../../repos/repos.ts';
export {asPath} from './term-path.ts';

// A terminal's output on the desk names files as a shell names them: `ls` says them, the compiler says them with where
// (`count.c:7:24: error`), grep says them with their line. A word that is a file of the repo is underlined under the
// pointer and, pressed, opens that file's box at that line, as a terminal's hints open what they point at. Nothing is
// drawn into the output for it: the word is read where the pointer is.

/** A word of a terminal's output under (x, y), and where it lies; none off the words. */
export function wordAt(x: number, y: number, within: Element): {text: string; range: Range} | null {
  const pos = document.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const node = pos.offsetNode;
  if (node.nodeType !== Node.TEXT_NODE || !within.contains(node)) return null;
  const s = node.textContent ?? '';
  let a = pos.offset, b = pos.offset;
  while (a > 0 && !/\s/.test(s[a - 1])) a--;
  while (b < s.length && !/\s/.test(s[b])) b++;
  if (a === b) return null;
  // (Past a word's end on its line, the pointer is over nothing.)
  const range = document.createRange();
  range.setStart(node, a);
  range.setEnd(node, b);
  const r = range.getBoundingClientRect();
  if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y > r.bottom + 1) return null;
  return {text: s.slice(a, b), range};
}

/** The files of each folder of a repo, as last read (read again once anything in the repo changes). */
const known = new Map<string, Promise<Set<string>>>();
onChange((c) => { for (const k of known.keys()) if (k.startsWith(`${c.repo}\n`)) known.delete(k); });

/** Whether `path` is a file of `repo`. */
export async function isFile(repo: string, path: string): Promise<boolean> {
  const cut = path.lastIndexOf('/'), dir = cut < 0 ? '' : path.slice(0, cut), name = path.slice(cut + 1);
  const key = `${repo}\n${dir}`;
  let files = known.get(key);
  if (!files) {
    files = store.tree(repo, dir).then((es) => new Set(es.filter((e) => e.kind === 'file').map((e) => e.name)), () => new Set<string>());
    known.set(key, files);
  }
  return (await files).has(name);
}
