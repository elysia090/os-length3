// What is half written stays with what it was written for (DESIGN §1): an
// Inbox conversation's message by its address, a board's post by the board.
// Kept while the app runs, as Forge keeps a prompt by its repo; swapped with
// what it belongs to, never carried to another; gone only when it is sent.

export class Drafts {
  private kept = new Map<string, string>();
  /** What is half written for `key`, or nothing. */
  get(key: string): string { return this.kept.get(key) ?? ''; }
  /** Written for `key` as it is now; nothing written, nothing kept. */
  set(key: string, text: string) { if (text) this.kept.set(key, text); else this.kept.delete(key); }
  /** Sent: it goes. */
  sent(key: string) { this.kept.delete(key); }
  /** Whether there are words for `key` (not only spaces). */
  holds(key: string): boolean { return this.get(key).trim() !== ''; }
}
