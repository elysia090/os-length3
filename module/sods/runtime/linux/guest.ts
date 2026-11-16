// A process's memory as the kernel reads and writes it for the process's calls. An address the process gave that is
// outside its memory is the call's own failure (EFAULT, as Linux's copy to or from a bad address is), never the
// host's RangeError, and a span that runs off the end is never quietly cut short: a call that may do part of its work
// (a file's read or write) asks how far its span reaches first (sys-file.ts reach).
//
// Only what goes through these two is the guest's: an index out of range in the kernel's own arrays stays the host's
// error, and is not hidden as the guest's.
import {E, FsError} from './fs.ts';

const fault = (): never => { throw new FsError(E.FAULT); };
/** Whether [begin, end) lies in `length` bytes (a NaN or a negative lies nowhere). */
const inside = (begin: number, end: number, length: number): boolean => begin >= 0 && begin <= end && end <= length;

/**
 * The memory as bytes. A view or a copy taken of it is plain bytes (what a caller keeps is not the memory itself),
 * and one asked for outside it, or a write or a fill that would run outside it, is EFAULT.
 */
export class GuestBytes extends Uint8Array<ArrayBufferLike> {
  static get [Symbol.species](): Uint8ArrayConstructor { return Uint8Array; }
  override subarray(begin = 0, end = this.length): Uint8Array<ArrayBufferLike> {
    if (!inside(begin, end, this.length)) fault();
    return new Uint8Array(this.buffer, begin, end - begin);
  }
  override slice(begin = 0, end = this.length): Uint8Array<ArrayBuffer> {
    if (!inside(begin, end, this.length)) fault();
    return new Uint8Array(this.buffer, begin, end - begin).slice();
  }
  override set(from: ArrayLike<number>, at = 0): void {
    if (!inside(at, at + from.length, this.length)) fault();
    super.set(from, at);
  }
  override fill(value: number, begin = 0, end = this.length): this {
    if (!inside(begin, end, this.length)) fault();
    return super.fill(value, begin, end);
  }
  override copyWithin(to: number, begin: number, end = this.length): this {
    if (!inside(begin, end, this.length) || !inside(to, to + (end - begin), this.length)) fault();
    return super.copyWithin(to, begin, end);
  }
}

/** A DataView's own word that an offset is outside it (its only RangeError) is the guest's bad address; anything else is the kernel's. */
const outside = (e: unknown): never => { if (e instanceof RangeError) fault(); throw e; };

/** The memory as words of each size: one read or written outside it is EFAULT. */
export class GuestView extends DataView<ArrayBufferLike> {
  override getInt8(at: number): number { try { return super.getInt8(at); } catch (e) { return outside(e); } }
  override getUint8(at: number): number { try { return super.getUint8(at); } catch (e) { return outside(e); } }
  override getInt16(at: number, little?: boolean): number { try { return super.getInt16(at, little); } catch (e) { return outside(e); } }
  override getUint16(at: number, little?: boolean): number { try { return super.getUint16(at, little); } catch (e) { return outside(e); } }
  override getInt32(at: number, little?: boolean): number { try { return super.getInt32(at, little); } catch (e) { return outside(e); } }
  override getUint32(at: number, little?: boolean): number { try { return super.getUint32(at, little); } catch (e) { return outside(e); } }
  override getFloat32(at: number, little?: boolean): number { try { return super.getFloat32(at, little); } catch (e) { return outside(e); } }
  override getFloat64(at: number, little?: boolean): number { try { return super.getFloat64(at, little); } catch (e) { return outside(e); } }
  override getBigInt64(at: number, little?: boolean): bigint { try { return super.getBigInt64(at, little); } catch (e) { return outside(e); } }
  override getBigUint64(at: number, little?: boolean): bigint { try { return super.getBigUint64(at, little); } catch (e) { return outside(e); } }
  override setInt8(at: number, value: number): void { try { super.setInt8(at, value); } catch (e) { outside(e); } }
  override setUint8(at: number, value: number): void { try { super.setUint8(at, value); } catch (e) { outside(e); } }
  override setInt16(at: number, value: number, little?: boolean): void { try { super.setInt16(at, value, little); } catch (e) { outside(e); } }
  override setUint16(at: number, value: number, little?: boolean): void { try { super.setUint16(at, value, little); } catch (e) { outside(e); } }
  override setInt32(at: number, value: number, little?: boolean): void { try { super.setInt32(at, value, little); } catch (e) { outside(e); } }
  override setUint32(at: number, value: number, little?: boolean): void { try { super.setUint32(at, value, little); } catch (e) { outside(e); } }
  override setFloat32(at: number, value: number, little?: boolean): void { try { super.setFloat32(at, value, little); } catch (e) { outside(e); } }
  override setFloat64(at: number, value: number, little?: boolean): void { try { super.setFloat64(at, value, little); } catch (e) { outside(e); } }
  override setBigInt64(at: number, value: bigint, little?: boolean): void { try { super.setBigInt64(at, value, little); } catch (e) { outside(e); } }
  override setBigUint64(at: number, value: bigint, little?: boolean): void { try { super.setBigUint64(at, value, little); } catch (e) { outside(e); } }
}
