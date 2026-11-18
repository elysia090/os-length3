import {readSync, writeSync} from 'node:fs';
import {isatty} from 'node:tty';

/** Borrowed standard descriptors, not guest FD numbers. The embedding must not
 * close/reuse or concurrently consume these descriptors while this profile runs.
 * No ownership transfer, host close, generic FD input, retry or async callback.
 * Initial profile is Linux/non-TTY only; terminal/job-control is not implemented.
 */
const read = readSync, write = writeSync, terminal = isatty;
const own = Object.getOwnPropertyDescriptor, freeze = Object.freeze, define = Object.defineProperty;
const isInteger = Number.isInteger, isSafeInteger = Number.isSafeInteger;
const apply = Reflect.apply;
const typedLength = own(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
const platform = process.platform;
const nodeMajor = Number(process.versions.node.split('.')[0]);
export type Endpoint = 1 | 2 | 3;
export type ZeroCode = 'EAGAIN' | 'EINTR' | 'EBADF' | 'EPIPE' | 'EIO';
export type PhysicalResult = {kind: 'count'; count: number}
  | {kind: 'zero'; code: ZeroCode}
  | {kind: 'unknown'; error: unknown};

function failure(error: unknown, syscall: 'read' | 'write'): PhysicalResult {
  // Captured native APIs, trusted intrinsics at module loading, no caller hook.
  // Read own data fields only: a thrown accessor/proxy is not completion proof.
  try {
    if (typeof error === 'object' && error !== null) {
      const code = own(error, 'code')?.value, operation = own(error, 'syscall')?.value;
      const errno = own(error, 'errno')?.value;
      if (operation === syscall && typeof errno === 'number' && isInteger(errno) && errno < 0 &&
          (code === 'EAGAIN' || code === 'EINTR' || code === 'EBADF' || code === 'EPIPE' || code === 'EIO')) {
        return {kind: 'zero', code};
      }
    }
  } catch { /* Ambiguous error inspection remains Unknown. */ }
  return {kind: 'unknown', error};
}

/** Node 22/24 libuv Unix evidence: fs.js readSync/writeSync forward the native
 * result; uv__fs_read uses read, uv__fs_write_all returns a positive accumulated
 * prefix even if a later write fails. Negative native results therefore establish
 * zero for THIS call, not prior writes' persistence. libuv may retry EINTR or
 * split writes internally: one Node call is not necessarily one OS syscall.
 * https://github.com/nodejs/node/blob/v22.16.0/lib/fs.js
 * https://github.com/nodejs/node/blob/v22.16.0/src/node_file.cc
 * https://github.com/nodejs/node/blob/v22.16.0/deps/uv/src/unix/fs.c
 * https://github.com/nodejs/node/blob/v24.22.1/lib/fs.js
 * https://github.com/libuv/libuv/blob/v1.52.1/src/unix/fs.c
 */
function checkHost(): void {
  if (platform !== 'linux') throw new Error('Synchronous stdio profile requires Linux');
  if (nodeMajor !== 22 && nodeMajor !== 24) throw new Error('Synchronous stdio profile requires reviewed Node 22 or 24');
}

/** Before stream_start. Node's JS wrapper reads buffer.byteLength; an own
 * immutable data property closes that wrapper property-read path. With the
 * five primitive arguments used here, Node 22/24 native Buffer::Data/Length
 * access backing-store slots, not JS buffer/byteOffset getters. This is a
 * scoped trusted-runtime guarantee, not arbitrary monkeypatched-Node safety. */
function prepareView(bytes: Uint8Array): void {
  const length: number = apply(typedLength, bytes, []);
  if (!isSafeInteger(length) || length > 0x7ffff000) throw new RangeError('Unsupported physical IO span');
  define(bytes, 'byteLength', {value: length, writable: false, configurable: false});
}

function transfer(endpoint: Endpoint, bytes: Uint8Array): PhysicalResult {
  // Construct and range-check this view before Rust stream_start. This
  // synchronous operation borrows it only until return and never retains it.
  const length: number = apply(typedLength, bytes, []);
  if (!isSafeInteger(length) || length > 0x7ffff000) throw new RangeError('Unsupported physical IO span');
  if (own(bytes, 'byteLength')?.value !== length) throw new TypeError('Physical IO view was not prepared');
  if (endpoint !== 1 && endpoint !== 2 && endpoint !== 3) throw new TypeError('Unknown standard endpoint');
  try {
    const count = endpoint === 1 ? read(0, bytes, 0, length, null) : write(endpoint - 1, bytes, 0, length, null);
    if (!isInteger(count) || count < 0 || count > length) return {kind: 'unknown', error: new Error('Invalid native IO count')};
    return {kind: 'count', count};
  } catch (error) { return failure(error, endpoint === 1 ? 'read' : 'write'); }
}

export function captureStdio() {
  checkHost();
  if (terminal(0) || terminal(1) || terminal(2)) throw new Error('Synchronous stdio profile does not support TTYs');
  return freeze({prepareView, transfer});
}

/** Same exact borrowed read, no physical output authority. Do not even
 * qualify the process's unrelated output descriptors for this profile. */
export function captureStdin(): ReturnType<typeof captureStdio> {
  checkHost();
  if (terminal(0)) throw new Error('Synchronous stdin profile does not support TTY input');
  return freeze({prepareView, transfer(endpoint: Endpoint, bytes: Uint8Array) {
    if (endpoint !== 1) throw new Error('Borrowed stdin does not grant physical output');
    return transfer(1, bytes);
  }});
}
