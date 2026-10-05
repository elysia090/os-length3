import {readFile,open,stat} from 'node:fs/promises';
import path from 'node:path';
import {checkStartup} from '../../src/v2/vm/check/browser/startup-check.mjs';
import {decompressionOracle} from './decompression-oracle.mjs';

const [providerFile,compilerFile,directory,...flags] = process.argv.slice(2);
if (!directory || flags.some(flag=>!['--extended','--progress'].includes(flag)
      && !flag.startsWith('--segments=') && !flag.startsWith('--image=') && !flag.startsWith('--warm-cuts='))
    || new Set(flags).size!==flags.length
    || ['--segments=','--image=','--warm-cuts='].some(prefix=>flags.filter(flag=>flag.startsWith(prefix)).length>1))
  throw new Error('usage: check-wasm-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY [--extended] [--progress] [--segments=INDEPENDENT-SEGMENT-FIXTURE] [--image=IMMUTABLE-SYSTEM-IMAGE] [--warm-cuts=1..64]');
const segmentFile=flags.find(flag=>flag.startsWith('--segments='))?.slice('--segments='.length);
const imageFile=flags.find(flag=>flag.startsWith('--image='))?.slice('--image='.length);
if (segmentFile==='' || imageFile==='') throw new Error('empty independent fixture path');
const warmFlag=flags.find(flag=>flag.startsWith('--warm-cuts='))?.slice('--warm-cuts='.length);
if(warmFlag!==undefined && (!/^[1-9][0-9]?$/.test(warmFlag) || Number(warmFlag)>64))
  throw new Error('usage: --warm-cuts=1..64');
const warmCuts=warmFlag===undefined?1:Number(warmFlag);
const immutableImage=imageFile ? {address:'0x30000000',bytes:(await stat(imageFile)).size} : undefined;
const onProgress=flags.includes('--progress') ? progress=>console.error(JSON.stringify({
  status:progress.status,retired:progress.retired,admissions:progress.admissions,nextRip:progress.nextRip,
  residentPages:progress.residentPages,memoryBytes:progress.memoryBytes,consoleBytes:progress.console?.acceptedBytes,
  engineReuse:progress.engineReuse,compilerOutput:progress.compilerOutput,timingMs:progress.timingMs,
  sourceReuse:progress.sourceReuse,
})) : undefined;
async function extent(kind,offset,bytes) {
  const fileName = kind === 2 ? path.join(directory,'boot.kernel-object')
    : kind === 3 ? path.join(directory,'boot.initramfs-object') : kind===5 ? imageFile : null;
  if (!fileName || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes)
      || bytes < 1 || bytes > 4096) throw new Error('C extent shape');
  const file = await open(fileName,'r');
  try {
    const result = Buffer.alloc(bytes);
    const {bytesRead} = await file.read(result,0,bytes,offset);
    if (bytesRead !== bytes) throw new Error('short C extent');
    return result;
  } finally { await file.close(); }
}
console.log(JSON.stringify(await checkStartup(name => readFile(name==='boot.segments' && segmentFile
    ? segmentFile : path.join(directory,name)),
  await readFile(providerFile),await readFile(compilerFile),extent,
  {extended:flags.includes('--extended'),onProgress,immutableImage,warmCuts,
    decompression:decompressionOracle(await readFile(path.join(directory,'boot.kernel-object')))}),null,2));
