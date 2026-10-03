// Independent diagnostic only. No output bytes enter guest execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync,crc32} from 'node:zlib';

export const shippedKernelSha256 = '21771c757255406ce090faa6c5108b72618f794c8e46379a4a3d50dc21364e67';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function decompressionOracle(kernel) {
  assert.equal(digest(kernel),shippedKernelSha256,'this witness belongs to the shipped kernel only');
  const setup = ((kernel[0x1f1] || 4) + 1) * 512;
  const offset = setup + kernel.readUInt32LE(0x248), bytes = kernel.readUInt32LE(0x24c);
  assert(offset >= setup && bytes > 18 && offset + bytes <= kernel.length);
  const input = kernel.subarray(offset,offset + bytes);
  assert.equal(input.subarray(0,10).toString('hex'),'1f8b0800000000000203');
  const output = gunzipSync(input,{maxOutputLength:32 * 1024 * 1024});
  assert.equal(output.subarray(0,5).toString('hex'),'7f454c4602');
  assert.equal(output.length,14622864);
  // Linux's PREBOOT inflater uses raw DEFLATE and does not validate the gzip
  // trailer. Node's independent gzip oracle does validate CRC and ISIZE.
  const trailer = input.length - 8;
  assert.equal(input.readUInt32LE(trailer),crc32(output));
  assert.equal(input.readUInt32LE(trailer + 4),output.length);
  const pageBytes = 4096, pages = [];
  for (let at = 0; at < output.length; at += pageBytes)
    pages.push(digest(output.subarray(at,at + pageBytes)));
  return {format:'shipped-kernel-decompression-observation-v1',kernelSha256:shippedKernelSha256,
    outputBytes:output.length,outputSha256:digest(output),gzipCrc32:input.readUInt32LE(trailer),
    pageBytes,pages,outputAddress:'0x1000000',
    // Exact native disassembly: first ELF-header read, before memmove of PT_LOAD.
    observationRip:'0x1e23d31',observationSource:[0x49,0x8b,0x55,0x08],
    elfEntry:`0x${output.readBigUInt64LE(24).toString(16)}`};
}
