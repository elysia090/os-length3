// Validate one exact shipped observation, never an execution fallback.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decompressionOracle} from './decompression-oracle.mjs';
const file = process.argv[2];
if (!file) throw new Error('usage: check-decompression-oracle.mjs SHIPPED-BZIMAGE');
const kernel = await readFile(file), output = decompressionOracle(kernel);
assert.equal(output.outputSha256,'6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9');
assert.equal(output.gzipCrc32,380732796); assert.equal(output.pages.length,3571);
assert.equal(output.elfEntry,'0x14015e4');
assert(output.pages.every(digest => /^[a-f0-9]{64}$/.test(digest)));
kernel[17070] ^= 1;
assert.throws(() => decompressionOracle(kernel),/shipped kernel/);
console.log('Shipped gzip CRC/ISIZE and bounded page-hash observation, corrupted source refused: green (not guest execution)');
