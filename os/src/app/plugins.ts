// The optional plugin area at the top of the center (Forge's, Git's): plain
// until it is opened from the rail's plug, and able to hold up to seven
// plugins side by side, one shown at a time and switched sideways. Which
// plugins there are is not decided yet, so none comes with the OS and none
// can be installed from outside; this is only the room and its switch.

/** The most plugins the area holds. */
export const SLOTS = 7;

/** One plugin in the area: its name, and what it shows when it is the one shown. */
export interface Slot { id: string; label: string; make(): HTMLElement }

/** The area's plugins, in order, and the one shown. */
export class Slots {
  private list: Slot[] = [];
  private at = 0;

  get all(): readonly Slot[] { return this.list; }
  /** The one shown (its index); 0 when there are none. */
  get shown(): number { return this.at; }

  /** Take a plugin in; false when the area is full or one has its id already. */
  add(slot: Slot): boolean {
    if (this.list.length >= SLOTS || this.list.some((s) => s.id === slot.id)) return false;
    this.list.push(slot);
    return true;
  }

  /** Show the `n`th, kept within the ones there are. */
  choose(n: number): number {
    this.at = this.list.length ? Math.max(0, Math.min(this.list.length - 1, n)) : 0;
    return this.at;
  }

  /** One along to the right (+1) or the left (−1), stopping at either end. */
  step(by: 1 | -1): number { return this.choose(this.at + by); }
}

/** The plugins every center's area shows. */
export const slots = new Slots();

let open = false;
const listeners = new Set<() => void>();

/** Whether the area is out (the rail's plug pressed). */
export const pluginsOpen = () => open;

export function setPluginsOpen(on: boolean) {
  if (on === open) return;
  open = on;
  for (const fn of [...listeners]) fn();
}

export function onPlugins(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
