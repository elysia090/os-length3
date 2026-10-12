// Trust starts at an independently pinned release digest, never a fetched
// catalog. Bounded delivery authenticates before any C boot-page admission.
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const digest=async b=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
async function boundedResponse(reply,length){if(!reply.ok||!reply.body)throw new Error(`artifact HTTP ${reply.status}`);
  const reader=reply.body.getReader(),out=new Uint8Array(length);let at=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;if(value.length>length-at)throw new Error('oversized artifact response');out.set(value,at);at+=value.length;}}
  finally{await reader.cancel();reader.releaseLock();}if(at!==length)throw new Error('short artifact response');return out;}
export function decodeMachineManifest(raw){
  const manifest=JSON.parse(new TextDecoder().decode(raw)),names=['kernel','initramfs','system','vm','compiler'];
  if(manifest.format!=='linux-release-v1'||manifest.cpu!=='x86-64-v2'||!Number.isSafeInteger(manifest.ramBytes)||manifest.ramBytes<67108864||manifest.ramBytes>1073741824||manifest.ramBytes%4096
    ||typeof manifest.command!=='string'||manifest.command.length>3000||manifest.command.includes('\0'))throw new Error('release machine contract');
  for(const name of names){const r=manifest.objects?.[name];if(!r||r.file!==`${name}.object`||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>268435456||r.chunkBytes!==65536
    ||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)
    ||!Array.isArray(r.chunks)||r.chunks.length!==Math.ceil(r.bytes/65536)||!r.chunks.every(x=>/^[a-f0-9]{64}$/.test(x)))throw new Error(`release object ${name}`);}
  return manifest;
}
export async function openMachineArtifact(url,expectedDigest){
  if(typeof expectedDigest!=='string'||!/^[0-9a-f]{64}$/.test(expectedDigest))throw new Error('independently pinned release SHA-256 required');
  const manifestUrl=new URL(url,import.meta.url),response=await fetch(manifestUrl,{cache:'no-cache'}),length=Number(response.headers.get('Content-Length'));
  if(!Number.isInteger(length)||length<1||length>1048576)throw new Error('bounded release descriptor required');
  const raw=await boundedResponse(response,length);if(await digest(raw)!==expectedDigest)throw new Error('release identity mismatch');
  const manifest=decodeMachineManifest(raw);
  let closed=false,cache=new Map(),cachedBytes=0;const stats={fetches:0,fetchedBytes:0,cacheHits:0};
  async function chunk(name,rank){if(closed)throw new Error('artifact owner closed');const key=`${name}:${rank}`;
    if(cache.has(key)){const raw=cache.get(key);cache.delete(key);cache.set(key,raw);++stats.cacheHits;return raw;}
    const r=manifest.objects[name],at=rank*65536,n=Math.min(65536,r.bytes-at),reply=await fetch(new URL(r.file,manifestUrl),{headers:{Range:`bytes=${at}-${at+n-1}`},cache:'force-cache'});
    if(reply.status!==206||reply.headers.get('Content-Range')!==`bytes ${at}-${at+n-1}/${r.bytes}`){await reply.body?.cancel();throw new Error('exact bounded delivery range required');}
    const raw=await boundedResponse(reply,n);if(await digest(raw)!==r.chunks[rank])throw new Error('artifact chunk authentication failed');
    ++stats.fetches;stats.fetchedBytes+=n;while(cachedBytes+n>262144&&cache.size){const k=cache.keys().next().value;cachedBytes-=cache.get(k).length;cache.delete(k);}cache.set(key,raw);cachedBytes+=n;return raw;}
  async function read(name,at,n){const r=manifest.objects[name];if(!r||!Number.isSafeInteger(at)||!Number.isInteger(n)||at<0||n<1||n>4194304||at>r.bytes-n)throw new Error('bounded artifact extent');
    const out=new Uint8Array(n);for(let done=0;done<n;){const pos=at+done,raw=await chunk(name,Math.floor(pos/65536)),within=pos%65536,take=Math.min(n-done,raw.length-within);out.set(raw.subarray(within,within+take),done);done+=take;}return out;}
  return {manifest,raw:raw.slice(),identity:expectedDigest,read,stats,close(){closed=true;cache.clear();cachedBytes=0;}};
}
