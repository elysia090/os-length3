// Independent diagnostic only. No output bytes enter guest execution.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync,crc32} from 'node:zlib';

export const shippedKernelSha256 = '21771c757255406ce090faa6c5108b72618f794c8e46379a4a3d50dc21364e67';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function shippedKernelElf(kernel,expectedSha256=shippedKernelSha256) {
  assert(/^[a-f0-9]{64}$/.test(expectedSha256),'trusted kernel identity');
  assert.equal(digest(kernel),expectedSha256,'this witness belongs to the shipped kernel only unless a trusted rebuilt identity is explicit');
  const setup = ((kernel[0x1f1] || 4) + 1) * 512;
  // This bounded witness may accept a rebuilt payload ONLY while the native
  // disassembly/boot geometry it observes stays unchanged. It is not a
  // generic bzImage loader, replacement bytes or a guessed new checkpoint.
  assert.equal(setup,16384);assert.equal(kernel.readUInt32LE(0x260),15081472);
  assert.equal(digest(kernel.subarray(setup+512,setup+675)),'aaffdb1770b7d60ff3d8c283e66474871dcae5a3dd3766bf260e579a687ee5d0');
  const relocated=0x1000000+kernel.readUInt32LE(0x260)-0x320000,at=setup+0x1e23d31-relocated;
  assert.equal(kernel.subarray(at,at+4).toString('hex'),'498b5508');
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
  return output;
}
export function decompressionOracle(kernel,expectedSha256=shippedKernelSha256) {
  const output=shippedKernelElf(kernel,expectedSha256);
  const pageBytes = 4096, pages = [];
  for (let at = 0; at < output.length; at += pageBytes)
    pages.push(digest(output.subarray(at,at + pageBytes)));
  return {format:'shipped-kernel-decompression-observation-v1',kernelSha256:expectedSha256,
    outputBytes:output.length,outputSha256:digest(output),gzipCrc32:crc32(output),
    pageBytes,pages,outputAddress:'0x1000000',
    // Exact native disassembly: first ELF-header read, before memmove of PT_LOAD.
    observationRip:'0x1e23d31',observationSource:[0x49,0x8b,0x55,0x08],
    elfEntry:`0x${output.readBigUInt64LE(24).toString(16)}`};
}
