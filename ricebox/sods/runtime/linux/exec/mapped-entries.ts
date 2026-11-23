// Private dispatch index shared by the attachment owner and the Wasm core.
// A slot is a 32-bit PC, padding, and the packed block and function indices.
// Slot zero's padding holds the hash shift. PC zero is the empty marker.
const SLOT_BYTES = 16, WASM_PAGE = 65536, MULTIPLIER = 0x9e3779b1;
export const MAPPED_ENTRY_BYTES = 12; // PC, block, piece-relative function slot

export class MappedEntries {
  readonly memory = new WebAssembly.Memory({initial: 1});
  #view = new DataView(this.memory.buffer);
  #capacity = WASM_PAGE / SLOT_BYTES;
  #shift = 32 - Math.log2(this.#capacity);
  #used = 0;

  constructor() { this.#view.setUint32(4, this.#shift, true); }

  reserve(additional: number): void {
    const needed = this.#used + additional;
    let capacity = this.#capacity;
    while (needed * 2 > capacity) capacity *= 2;
    if (capacity === this.#capacity) return;
    if (capacity * SLOT_BYTES > 2 ** 32) throw new RangeError('Mapped dispatch index exhausted');
    const old = new DataView(this.memory.buffer.slice(0));
    this.memory.grow((capacity - this.#capacity) * SLOT_BYTES / WASM_PAGE);
    this.#capacity = capacity;
    this.#shift = 32 - Math.log2(capacity);
    this.#view = new DataView(this.memory.buffer);
    this.#reset(old.byteLength);
    for (let at = 0; at < old.byteLength; at += SLOT_BYTES) {
      const pc = old.getUint32(at, true);
      if (pc) this.#put(pc, old.getUint32(at + 8, true), old.getUint32(at + 12, true));
    }
  }

  /** Install already validated metadata after its function slots exist. */
  publish(entries: DataView, base: number): void {
    for (let at = 0; at < entries.byteLength; at += MAPPED_ENTRY_BYTES)
      this.#put(entries.getUint32(at, true), entries.getUint32(at + 4, true), base + entries.getUint32(at + 8, true));
  }

  clear(): void { this.#reset(this.#view.byteLength); }

  #reset(clearBytes: number): void {
    new Uint8Array(this.memory.buffer, 0, clearBytes).fill(0);
    this.#view.setUint32(4, this.#shift, true);
    this.#used = 0;
  }

  #put(pc: number, block: number, slot: number): void {
    const view = this.#view, mask = this.#capacity - 1;
    let bucket = Math.imul(pc, MULTIPLIER) >>> this.#shift;
    let at = bucket * SLOT_BYTES;
    let key = view.getUint32(at, true);
    while (key && key !== pc) {
      bucket = (bucket + 1) & mask;
      at = bucket * SLOT_BYTES;
      key = view.getUint32(at, true);
    }
    if (!key) this.#used++;
    view.setUint32(at, pc, true);
    view.setUint32(at + 8, block, true);
    view.setUint32(at + 12, slot, true);
  }
}
