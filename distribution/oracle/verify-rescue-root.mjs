// Recover authenticated readback after a diagnostic harness receipt-parser
// failure. Never change the original result or a production release.
import {readFile,stat} from 'node:fs/promises';import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';import path from 'node:path';
const [directory]=process.argv.slice(2);if(!directory)throw new Error('DIAGNOSTIC-ORACLE-DIRECTORY');
const log=await readFile(path.join(directory,'serial.log'),'utf8');
if(!log.includes('selfhost-oracle: pass'))throw new Error('independent C/sanitizer gate not passed');
const rows=[...log.matchAll(/^oracle-candidate system\.squashfs ([0-9]+) ([a-f0-9]{64})\r?$/gm)];
if(rows.length!==1)throw new Error('one complete root receipt required');
const file=path.join(directory,'candidate-files/system.squashfs'),bytes=Number(rows[0][1]),expected=rows[0][2];
if(!Number.isSafeInteger(bytes)||bytes<1||bytes>128*1024*1024||(await stat(file)).size!==bytes)throw new Error('root extent');
const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);const sha256=hash.digest('hex');
if(sha256!==expected)throw new Error('root readback digest');
console.log(JSON.stringify({format:'diagnostic-rescue-root-readback-v1',status:'pass',bytes,sha256,
  scope:'failure-only rescue, independent C gates and immutable readback; NOT interactive-ready or signed package publication'},null,2));
