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
  #external: 'checking' | 'unread' | null = null;
  #copy: string | null = null;
  #locked = false;
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
  get unread() { return this.#external === 'unread'; }
  get checking() { return this.#external === 'checking'; }
  get copy() { return this.#copy; }
  get locked() { return this.#locked; }
  get unsaved() { return this.#held.asking || this.#failed || this.#text !== this.#held.saved; }
  get clean() { return !this.#writing && !this.#external && !this.unsaved; }
  get tooLarge() { return this.#text.length > this.#limit / 4 && this.bytes() > this.#limit; }
  bytes() { return this.#size ??= new TextEncoder().encode(this.#text).length; }

  #set(text: string) { this.#text = text; this.#size = undefined; this.#copy = null; }

  watch(listen: Listen) { this.#listeners.add(listen); return () => this.#listeners.delete(listen); }
  #say() { for (const listen of this.#listeners) listen(); }

  #later() {
    clearTimeout(this.#timer);
    if (!this.#stopped && !this.#locked && !this.#external && !this.#held.asking && !this.#failed && this.unsaved)
      this.#timer = setTimeout(() => void this.flush(), 700);
  }

  edit(text: string) {
    if (this.#stopped || this.#locked || this.#text === text) return;
    this.#set(text);
    this.#failed = false;
    this.#held.typed(text);
    this.#later();
    this.#say();
  }

  /** Path work and recovery need a stable draft across an asynchronous save or move. */
  lock(): (() => void) | null {
    if (this.#locked || this.#stopped) return null;
    this.#locked = true;
    this.#later();
    this.#say();
    return () => {
      this.#locked = false;
      this.#later();
      this.#say();
    };
  }

  take(text: string): boolean {
    if (this.#stopped) return false;
    const checking = this.#external !== null;
    const came = this.#held.came(text, this.#text);
    this.#external = null;
    if (came === 'known' && !checking) return true;
    if (came !== 'known') this.#failed = false;
    if (came === 'take') this.#set(text);
    this.#later();
    this.#say();
    return came !== 'ask';
  }

  /** Called in the notification turn, before any read or wait can let a queued write through. */
  checkOutside() {
    if (this.#stopped) return;
    this.#external = 'checking';
    this.#later();
    this.#say();
  }

  blockUnread() {
    if (this.#stopped) return;
    this.#external = 'unread';
    this.#later();
    this.#say();
  }

  /** The original was not saved; only the exact current draft has a verifiable, separate copy. */
  copied(path: string, text: string) {
    if (this.#stopped || this.#text !== text) return;
    this.#copy = path;
    this.#say();
  }

  /** Closing a view is safe with an acknowledged original or a retained copy, unlike moving the original. */
  async closeable(): Promise<boolean> {
    return !this.#locked && (this.#copy !== null || (this.unread && !this.unsaved) || await this.flush());
  }

  useTheirs() {
    if (this.#external || this.#locked) return;
    this.#set(this.#held.useTheirs());
    this.#failed = false;
    this.#say();
  }

  keepMine() {
    if (this.#external || this.#locked) return Promise.resolve(false);
    this.#held.keepMine(this.#text);
    this.#say();
    return this.flush();
  }

  /** Only writes already begun; queued/user saves remain subject to the external check. */
  async idle() { while (this.#writing) await this.#writing; }

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
    if (this.#stopped || !this.#held.canSave || this.#external) return false;
    if (this.#text === this.#held.saved) return !this.#failed;
    if (this.tooLarge && !whole) { this.#say(); return false; }
    const text = this.#text;
    this.#held.writes(text);
    // Start after publishing the in-flight promise, even if the store throws synchronously.
    const writing = Promise.resolve().then(async () => {
      try {
        if (this.#stopped || this.#external || !this.#held.canSave) { this.#held.failed(); return false; }
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
