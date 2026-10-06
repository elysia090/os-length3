import {readFile,open,stat} from 'node:fs/promises';
import path from 'node:path';
import {checkStartup} from '../../src/v2/vm/check/browser/startup-check.mjs';
import {decompressionOracle} from './decompression-oracle.mjs';
import {waitForClock} from '../../src/v2/web/idle-clock.mjs';
import {progressLog} from './progress-log.mjs';

const [providerFile,compilerFile,directory,...flags] = process.argv.slice(2);
if (!directory || flags.some(flag=>!['--extended','--progress','--idle'].includes(flag)
      && !flag.startsWith('--segments=') && !flag.startsWith('--image=') && !flag.startsWith('--warm-cuts=') && !flag.startsWith('--progress-file='))
    || new Set(flags).size!==flags.length
    || ['--segments=','--image=','--warm-cuts=','--progress-file='].some(prefix=>flags.filter(flag=>flag.startsWith(prefix)).length>1))
  throw new Error('usage: check-wasm-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY [--extended] [--progress] [--progress-file=NEW-LOG] [--idle] [--segments=INDEPENDENT-SEGMENT-FIXTURE] [--image=IMMUTABLE-SYSTEM-IMAGE] [--warm-cuts=1..64]');
const segmentFile=flags.find(flag=>flag.startsWith('--segments='))?.slice('--segments='.length);
const imageFile=flags.find(flag=>flag.startsWith('--image='))?.slice('--image='.length);
const progressFile=flags.find(flag=>flag.startsWith('--progress-file='))?.slice('--progress-file='.length);
if (segmentFile==='' || imageFile==='' || progressFile==='') throw new Error('empty independent fixture path');
const warmFlag=flags.find(flag=>flag.startsWith('--warm-cuts='))?.slice('--warm-cuts='.length);
if(warmFlag!==undefined && (!/^[1-9][0-9]?$/.test(warmFlag) || Number(warmFlag)>64))
  throw new Error('usage: --warm-cuts=1..64');
const warmCuts=warmFlag===undefined?1:Number(warmFlag);
const immutableImage=imageFile ? {address:'0x30000000',bytes:(await stat(imageFile)).size} : undefined;
const log=flags.includes('--progress') || progressFile!==undefined ? progressLog(progressFile) : null;
const onProgress=log ? progress=>log.write({
  status:progress.status,retired:progress.retired,admissions:progress.admissions,nextRip:progress.nextRip,
  residentPages:progress.residentPages,memoryBytes:progress.memoryBytes,consoleBytes:progress.console?.acceptedBytes,
  engineReuse:progress.engineReuse,compilerOutput:progress.compilerOutput,timingMs:progress.timingMs,
  sourceReuse:progress.sourceReuse,
  sourceProfile:progress.sourceProfile,
  idleEvents:progress.idleEvents,idleNanoseconds:progress.idleNanoseconds,
}) : undefined;
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
try{
  log?.write({status:'running',phase:'starting',pid:process.pid,warmCuts,idle:flags.includes('--idle')});
  console.log(JSON.stringify(await checkStartup(name => readFile(name==='boot.segments' && segmentFile
    ? segmentFile : path.join(directory,name)),
  await readFile(providerFile),await readFile(compilerFile),extent,
  {extended:flags.includes('--extended'),onProgress,immutableImage,warmCuts,idleWait:flags.includes('--idle')?waitForClock:undefined,
    decompression:decompressionOracle(await readFile(path.join(directory,'boot.kernel-object')))}),null,2));
}finally{log?.close();}
