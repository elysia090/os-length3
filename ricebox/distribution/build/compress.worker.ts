// Build-time compression worker. Input and response ownership match distribution.ts.
import {parentPort, isMarkedAsUntransferable} from 'node:worker_threads';
import {constants, zstdCompressSync} from 'node:zlib';
if (!parentPort) throw new Error('compression worker requires a parent port');
const port = parentPort;
port.on('message', ({id,bytes}: {id:number;bytes:Uint8Array}) => {
  const z=zstdCompressSync(bytes,{params:{[constants.ZSTD_c_compressionLevel]:19,[constants.ZSTD_c_checksumFlag]:0}});
  // Small Buffer results can share Node's non-transferable slab.
  const ready=isMarkedAsUntransferable(z.buffer)?new Uint8Array(z):z;
  port.postMessage({id,z:ready},[ready.buffer]);
});
