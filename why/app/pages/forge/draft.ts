import {Held} from '../../../repo/conflict.ts';

type Write = (text: string, whole: boolean) => Promise<void>;
type Listen = () => void;

/** What one file owns, regardless of how many sheets are showing it. */
export class Draft {
  readonly #held: Held;
  readonly #write: Write;
  readonly #limit: number;
  readonly #listeners = new Set<Listen>();
  #text: string;
  #size: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writing: Promise<boolean> | null = null;
  #error: unknown;
  #failed = false;
  #unread = false;
  #stopped = false;

  constructor(text: string, limit: number, write: Write) {
    this.#held = new Held(text);
    this.#text = text;
    this.#limit = limit;
    this.#write = write;
  }

  get text() { return this.#text; }
  get theirs() { return this.#held.theirs; }
  get failed() { return this.#failed; }
  get error() { return this.#error; }
  get unread() { return this.#unread; }
  get clean() { return !this.#writing && !this.#held.asking && !this.#unread && !this.#failed && this.#text === this.#held.saved; }
  get tooLarge() { return this.#text.length > this.#limit / 4 && this.bytes() > this.#limit; }
  bytes() { return this.#size ??= new TextEncoder().encode(this.#text).length; }

  #set(text: string) { this.#text = text; this.#size = undefined; }

  watch(listen: Listen) { this.#listeners.add(listen); return () => this.#listeners.delete(listen); }
  #say() { for (const listen of this.#listeners) listen(); }

  edit(text: string) {
    if (this.#stopped || this.#text === text) return;
    this.#set(text);
    this.#failed = false;
    this.#held.typed(text);
    clearTimeout(this.#timer);
    if (!this.#held.asking && !this.#unread) this.#timer = setTimeout(() => void this.flush(), 700);
    this.#say();
  }

  take(text: string): boolean {
    if (this.#stopped) return false;
    const came = this.#held.came(text, this.#text);
    if (came === 'known') return true;
    this.#unread = this.#failed = false;
    if (came === 'ask') clearTimeout(this.#timer);
    if (came === 'take') this.#set(text);
    this.#say();
    return came !== 'ask';
  }

  /** Re-reading found something this editor cannot take. Never write over it on a timer. */
  blockUnread() {
    if (this.#stopped) return;
    this.#unread = true;
    clearTimeout(this.#timer);
    this.#say();
  }

  useTheirs() {
    this.#set(this.#held.useTheirs());
    this.#failed = false;
    this.#say();
  }

  keepMine() {
    this.#held.keepMine(this.#text);
    this.#say();
    return this.flush();
  }

  async settled(): Promise<boolean> {
    while (this.#writing) await this.#writing;
    return this.clean;
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#listeners.clear();
  }

  /**
   * Acknowledge the current draft, not the area or byte string that began saving.
   * Blur, the timer, and closing can arrive together. They join the one write;
   * a newer edit (including an Undo to the previous saved value) goes behind it.
   * A refused or conflicting write leaves the draft and the views where they are.
   */
  async flush(whole = false): Promise<boolean> {
    clearTimeout(this.#timer);
    if (this.#writing) {
      const ok = await this.#writing;
      if (!ok) return false;
      return this.flush(whole);
    }
    if (this.#stopped || !this.#held.canSave || this.#unread) return false;
    if (this.#text === this.#held.saved) return !this.#failed;
    if (this.tooLarge && !whole) { this.#say(); return false; }
    const text = this.#text;
    this.#held.writes(text);
    // Start after publishing the in-flight promise, even if the store throws synchronously.
    const writing = Promise.resolve().then(async () => {
      try {
        if (this.#stopped) { this.#held.failed(); return false; }
        await this.#write(text, whole);
        this.#held.wrote(text);
        this.#failed = false;
        return true;
      } catch (err) {
        this.#held.failed();
        this.#error = err;
        this.#failed = true;
        return false;
      } finally {
        this.#writing = null;
        this.#say();
      }
    });
    this.#writing = writing;
    if (!await writing) return false;
    // The explicit full-file decision applies to its snapshot only.
    if (whole && this.#text !== text && this.tooLarge) return false;
    return this.flush();
  }
}
