import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {constants,zstdCompressSync,zstdDecompressSync} from 'node:zlib';

test('the build worker returns identical compressed bytes and request IDs',async()=>{
  const worker=new Worker(new URL('../compress.worker.ts',import.meta.url));
  try {
    const large=new Uint8Array(32768);
    let seed=1;
    for(let i=0;i<large.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;large[i]=seed>>>24;}
    const inputs=[new Uint8Array(),new Uint8Array([1,2,3]),large];
    for(const [id,bytes] of inputs.entries()){
      const response=once(worker,'message');
      worker.postMessage({id,bytes});
      const [result]=await response;
      const expected=zstdCompressSync(bytes,{params:{[constants.ZSTD_c_compressionLevel]:19,[constants.ZSTD_c_checksumFlag]:0}});
      assert.equal(result.id,id);
      assert.deepEqual(Buffer.from(result.z),expected);
      assert.deepEqual(zstdDecompressSync(result.z),Buffer.from(bytes));
    }
  }finally{await worker.terminate();}
});
