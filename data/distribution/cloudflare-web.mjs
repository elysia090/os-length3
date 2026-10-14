import release from './cloudflare-release.generated.json' with {type:'json'};
export const securityHeaders={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
  'Cross-Origin-Resource-Policy':'same-origin',
};
const entry='/os/index.html?'+new URLSearchParams({focus:'source',
  'linux-release':`..${release.versionPrefix}/artifact/release/release.json`,
  'linux-release-sha256':release.releaseSha256,'linux-workspace':'os-length3-0.1.0','linux-workspace-bytes':'33554432'});
const publicPaths=new Set([...release.files,'/deployment.json']);
const legacyPaths=new Set(release.legacyFiles);
function finish(response,{immutable=false,mime=null,fixedBody}={}){
  const headers=new Headers(response.headers);for(const [k,v] of Object.entries(securityHeaders))headers.set(k,v);
  headers.set('Cache-Control',immutable?'public, max-age=31536000, immutable, no-transform':'no-store, no-transform');
  headers.set('X-Length3-Release',release.releaseSha256);headers.set('X-Length3-Web-Commit',release.webSourceCommit);
  headers.set('X-Length3-Runtime-Commit',release.runtimeOverlayCommit??release.webSourceCommit);
  if(mime)headers.set('Content-Type',mime);
  return new Response(fixedBody??response.body,{status:response.status,headers,encodeBody:'manual'});
}
function error(status,message,extra={}){return finish(new Response(message,{status,headers:{'Content-Type':'text/plain; charset=utf-8',...extra}}));}
export default {async fetch(request,env){
  try{
    const url=new URL(request.url);
    if(!['GET','HEAD'].includes(request.method))return error(405,'Read-only release delivery',{'Allow':'GET, HEAD'});
    if(url.hostname==='qm.length3.com'&&url.pathname==='/'&&release.redirectQm){
      const next=new URL('https://os.length3.com/');next.search=url.search;
      return finish(new Response(null,{status:302,headers:{Location:next.href}}));
    }
    const legacy=url.hostname==='qm.length3.com'&&(url.pathname.startsWith('/legacy/')
      ||(!release.redirectQm&&!url.pathname.startsWith('/releases/')&&!url.pathname.startsWith('/os/')&&!url.pathname.startsWith('/artifact/release/')&&url.pathname!=='/deployment.json'));
    if(legacy){let relative=url.pathname.startsWith('/legacy/')?url.pathname.slice(8):url.pathname.slice(1);
      if(!relative)relative='index.html';if(!legacyPaths.has(relative))return error(404,'Legacy file not found');
      return finish(await env.ASSETS.fetch(new Request(new URL('/legacy-ui/'+relative,url.origin),{method:request.method})));}
    if(url.pathname==='/'){const next=new URL(entry,url.origin);if(url.searchParams.has('focus'))next.searchParams.set('focus',url.searchParams.get('focus'));
      return finish(new Response(null,{status:302,headers:{Location:next.pathname+next.search}}));}
    const versioned=url.pathname.startsWith(release.versionPrefix+'/');
    const pathname=versioned?url.pathname.slice(release.versionPrefix.length):url.pathname;
    if(!publicPaths.has(pathname))return error(404,'Release file not found');
    const object=release.objects[pathname];
    if(object){
      let start=0,end=object.bytes-1,status=200;const range=request.headers.get('Range');
      if(range){const match=/^bytes=(\d+)-(\d+)$/.exec(range);start=match?Number(match[1]):-1;end=match?Number(match[2]):-1;
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=object.bytes||end-start+1>1048576)
          return error(416,'Exact bounded Range required',{'Content-Range':`bytes */${object.bytes}`});status=206;}
      const headers={'Content-Type':'application/octet-stream','Content-Length':String(end-start+1),
        'Accept-Ranges':'bytes','ETag':`"${object.sha256}"`};
      if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${object.bytes}`;
      if(request.method==='HEAD'){const body=globalThis.FixedLengthStream?new FixedLengthStream(end-start+1).readable:null;
        return finish(new Response(body,{status,headers}),{immutable:versioned});}
      // ASSETS may ignore Range. Public chunk assets bound each fetch to 64 KiB.
      if(status===206){const pieces=[],unit=end-start+1>65536?1048576:65536,paths=unit===65536?object.rangeChunks:object.rangeTransfers;
        for(let at=start;at<=end;){const rank=Math.floor(at/unit),offset=rank*unit;
        const last=Math.min(end,offset+unit-1),response=await env.ASSETS.fetch(new Request(new URL(paths[rank],url.origin),{headers:{'Accept-Encoding':'identity'}}));
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(response.status!==200||bytes.length!==Math.min(unit,object.bytes-offset))throw new Error('Release chunk unavailable');
        pieces.push(bytes.subarray(at-offset,last-offset+1));at=last+1;}
        return finish(new Response(new Blob(pieces),{status,headers}),{immutable:versioned});}
      if(globalThis.FixedLengthStream){
        // Native stream piping avoids a JavaScript callback for every 64 KiB
        // of a full 90 MB response, within the existing Worker's CPU budget.
        const fixed=new FixedLengthStream(object.bytes);
        (async()=>{for(const part of object.parts){
          const response=await env.ASSETS.fetch(new Request(new URL(part,url.origin),{headers:{'Accept-Encoding':'identity'}}));
          if(response.status!==200||!response.body)throw new Error('Release part unavailable');
          await response.body.pipeTo(fixed.writable,{preventClose:true});
        }const writer=fixed.writable.getWriter();await writer.close();writer.releaseLock();})().catch(e=>fixed.writable.abort(e).catch(()=>{}));
        return finish(new Response(fixed.readable,{status,headers}),{immutable:versioned});
      }
      let rank=0,reader;
      const body=new ReadableStream({async pull(controller){
        try{for(;;){if(!reader){if(rank===object.parts.length){controller.close();return;}
          const response=await env.ASSETS.fetch(new Request(new URL(object.parts[rank++],url.origin),{headers:{'Accept-Encoding':'identity'}}));
          if(response.status!==200||!response.body)throw new Error('Release part unavailable');reader=response.body.getReader();}
          const {value,done}=await reader.read();if(done){reader.releaseLock();reader=null;}else {controller.enqueue(value);return;}}
        }catch(e){controller.error(e);}},async cancel(){await reader?.cancel();}});
      return finish(new Response(body,{status,headers}),{immutable:versioned});
    }
    const target=new URL(pathname,url.origin);target.search=url.search;
    const response=await env.ASSETS.fetch(new Request(target,{method:request.method}));
    const mime=pathname.endsWith('.wasm')?'application/wasm':pathname.endsWith('.json')?'application/json':null;
    if(request.method==='GET'&&pathname.endsWith('.json')&&response.status===200){const bytes=new Uint8Array(await response.arrayBuffer());
      const headers=new Headers(response.headers);headers.set('Content-Encoding','identity');headers.set('Content-Length',String(bytes.length));
      return finish(new Response(null,{status:200,headers}),{immutable:versioned,mime,fixedBody:bytes});}
    return finish(response,{immutable:versioned,mime});
  }catch{return error(503,'Release delivery failed; retry this immutable release');}
}};
