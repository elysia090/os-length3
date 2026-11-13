// What this browser's pages kept (localStorage, and a tab's sessionStorage) under the name the product had before,
// root3: kept under this one from here on, so a page of this build finds what a page before it left (the purpose and
// repo last open, Home's settings, which Remote, what a tab was in the middle of). start.ts reads this file before
// any other, so nothing has read a note by then. What the core kept (its files, in IndexedDB) is carried by its
// worker (core/worker.ts carry).

const BEFORE = 'root3.', NOW = 'why.';

function carry(notes: Storage): void {
  for (const k of Object.keys(notes)) {
    if (!k.startsWith(BEFORE)) continue;
    const to = NOW + k.slice(BEFORE.length), kept = notes.getItem(k);
    if (kept !== null && notes.getItem(to) === null) notes.setItem(to, kept);
    notes.removeItem(k);
  }
}

for (const notes of [() => localStorage, () => sessionStorage]) {
  try { carry(notes()); } catch { /* a browser that keeps nothing for a page has nothing to carry */ }
}
