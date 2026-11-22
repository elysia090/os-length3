// Build-time compression worker. Input and response ownership match distribution.ts.
import {parentPort, isMarkedAsUntransferable} from 'node:worker_threads';
import {constants, zstdCompressSync} from 'node:zlib';
if (!parentPort) throw new Error('compression worker requires a parent port');
const port = parentPort;
port.on('message', ({id, bytes, moved}: {id:number; bytes:Uint8Array<ArrayBuffer>; moved:boolean}) => {
  const z=zstdCompressSync(bytes,{params:{[constants.ZSTD_c_compressionLevel]:19,[constants.ZSTD_c_checksumFlag]:0}});
  if (z.length >= bytes.length) {
    port.postMessage({id, bytes: moved ? bytes : null, raw: true}, moved ? [bytes.buffer] : []);
    return;
  }
  // Transfer an exact body, not Node's non-transferable slab or a large
  // backing allocation with unused bytes. The recipient can keep the view.
  const exact = z.byteOffset === 0 && z.length === z.buffer.byteLength && !isMarkedAsUntransferable(z.buffer);
  const ready = exact ? z : new Uint8Array(z);
  port.postMessage({id, bytes: ready, raw: false}, [ready.buffer]);
});
