// Host reservation policy only. C still authorizes and supplies guest pages.
export function memoryBudget(ramBytes,imageBytes,live,extended){
  for(const n of [ramBytes,imageBytes])if(!Number.isSafeInteger(n)||n<0)throw new RangeError('declared physical extent');
  if(!ramBytes)throw new RangeError('nonempty RAM');
  const capacity=live?Math.ceil(ramBytes/4096)+Math.ceil(imageBytes/4096):extended?8192:4096;
  if(capacity<1||capacity>0x100000)throw new RangeError('physical coordinate population');
  //52 bytes/slot: page descriptor32 + binary index16 + version4.
  // Private construction/lifecycle has a separate bounded8MiB envelope.
  return {capacity,maximumPages:Math.ceil((capacity*(4096+52)+8*1024*1024)/65536)};
}
export function memoryGrowth(currentPages,targetPages,maximumPages,batch=8){
  for(const n of [currentPages,targetPages,maximumPages,batch])if(!Number.isInteger(n)||n<0)throw new RangeError('memory page count');
  if(!batch||currentPages>maximumPages||targetPages>maximumPages)throw new RangeError('memory reservation exceeded');
  return Math.min(Math.max(0,targetPages-currentPages),batch,maximumPages-currentPages);
}
