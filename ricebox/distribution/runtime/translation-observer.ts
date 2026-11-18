/** Private Worker-side translation publication. This owns observation references,
 * not executable images, filesystem nodes or the lifetime of a prepared tree.
 * Send may append extras or close observation; arbitrary replacement of the same
 * Image's publication metadata during send is outside this private contract. */
import type {Image} from '../../sods/runtime/linux.ts';

export interface Reached {module: WebAssembly.Module; bytes: Uint8Array; base: number}
export type TranslationMessage =
  | {type: 'more'; path: string; from: number; more: Reached[]}
  | {type: 'translated'; origin: string; wasm: Uint8Array; segments: {offset: number; bytes: Uint8Array}[] | null}
  | {type: 'reached'; origin: string; from: number | undefined; more: Reached[]};
type Tracked = {path: string; image: Image | null; told: number};
type Entry = {image: Image; kept: boolean};
/** A returning send means local acceptance, not receiver persistence. A throw
 * has an ambiguous external outcome: fail closed, never retry through this owner. */
type Send = (message: TranslationMessage, options: {transfer: ArrayBuffer[]}) => void;
const moved = (views: {buffer: ArrayBufferLike}[]) =>
  ({transfer: [...new Set(views.map(v => v.buffer))].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer)});
const copied = (image: Image, from: number, end: number): Reached[] =>
  image.extras.slice(from, end).map(e => ({module: e.module, bytes: e.bytes.slice(), base: e.base}));

export class TranslationObserver {
  private readonly tracked = new Set<Tracked>();
  private closed = false;
  private publishing = false;
  private failed = false;
  track(path: string, image: Image, told = 0): {close(): void} {
    this.available();
    const entry: Tracked = {path, image, told};
    this.tracked.add(entry);
    return {close: () => { this.tracked.delete(entry); entry.image = null; }};
  }
  close(): void {
    this.closed = true;
    for (const entry of this.tracked) entry.image = null;
    this.tracked.clear();
  }
  private available(): void {
    if (this.closed) throw new Error('Translation observer is closed');
    if (this.failed) throw new Error('Translation observer publication failed');
    if (this.publishing) throw new Error('Translation observer publication is already active');
  }
  publish(entries: Iterable<Entry>, send: Send): void {
    this.available();
    this.publishing = true;
    try {
      // Capture identities, not a live Map iterator that a send could extend forever.
      const roots = Array.from(entries, e => ({image: e.image, kept: e.kept}));
      for (const entry of this.tracked) {
        if (this.closed) return;
        const image = entry.image;
        if (!image || image.changed || image.extras.length <= entry.told) continue;
        const end = image.extras.length, more = copied(image, entry.told, end);
        send({type: 'more', path: entry.path, from: entry.told, more}, moved(more.map(e => e.bytes)));
        // A callback may append code during send. Acknowledge only the captured prefix.
        entry.told = end;
      }
      for (const {image, kept} of roots) {
        if (this.closed) return;
        const origin = image.origin;
        if (!origin || kept) continue;
        if (!image.mainTold && image.wasm) {
          const wasm = image.wasm;
          const segments = image.segments?.map(s => ({offset: s.offset, bytes: s.bytes.slice()})) ?? null;
          send({type: 'translated', origin, wasm, segments}, moved([wasm, ...(segments ?? []).map(s => s.bytes)]));
          // Update local progress only on acceptance. A throwing transport may
          // already have detached bytes; the observer then fails permanently.
          if (image.wasm === wasm) image.wasm = null;
          image.mainTold = true;
        }
        if (this.closed) return;
        if (image.origin !== origin) continue;
        if (image.mainTold && image.extras.length > (image.told ?? 0)) {
          const end = image.extras.length, more = copied(image, image.told ?? 0, end);
          send({type: 'reached', origin, from: image.told, more}, moved(more.map(e => e.bytes)));
          image.told = end;
        }
      }
    } catch (error) { this.failed = true; throw error; }
    finally { this.publishing = false; }
  }
}
