// A page comes whole, at once (DESIGN §8, a cut): what it reads before it is whole (the name it is called by, its lists,
// what waits) is in before it is seen, never a piece at a time: a "Loading…" a moment, a name standing in for another,
// a box with nothing in it yet, a line that comes and pushes what is under it down. Until then the frame is there (the
// rail, the ground) and the page is not. A read that takes longer than LONGEST comes in where it is once it is in.

/** The longest a page is held back for what it reads (ms): longer, it is shown, and what is late comes in where it is. */
export const LONGEST = 500;

/** What the page being drawn reads before it is whole (null: no page is being drawn). */
let reads: Promise<unknown>[] | null = null;

/** `p`, a read the page being drawn now is not whole without: it is not shown before it is in (or LONGEST is past). */
export function whole<T>(p: Promise<T>): Promise<T> {
  reads?.push(p.then(() => {}, () => {}));
  return p;
}

/**
 * `draw` run, and when what it read is in: after every step a read's own `then` took (those were asked for while it
 * drew, so they are taken before this), or LONGEST, whichever is first.
 */
export function drawing<T>(draw: () => T): [T, Promise<void>] {
  const was = reads;
  const mine: Promise<unknown>[] = reads = [];
  try {
    const drawn = draw();
    const late = new Promise<void>((done) => setTimeout(done, LONGEST));
    return [drawn, Promise.race([Promise.all(mine).then(() => {}), late])];
  } finally { reads = was; }
}
