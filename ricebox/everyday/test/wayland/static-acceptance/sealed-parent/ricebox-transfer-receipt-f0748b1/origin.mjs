// Direct controlled loopback HTTP only. Count outgoing entity bytes, not headers.
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';

export const receiptHeader='x-ricebox-receipt';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const revalidate='public, max-age=0, must-revalidate';
export const immutable='public, max-age=31536000, immutable';
const rangeFor=(value,size)=>{
  const m=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!m || (!m[1]&&!m[2])) return null;
  const start=m[1] ? Number(m[1]) : Math.max(0,size-Number(m[2]));
  const end=m[1] && m[2] ? Math.min(size-1,Number(m[2])) : size-1;
  return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end ? [start,end] : null;
};

export async function serveRoutes(routes) {
  let base, rows=[], phase='setup';
  const routesByURL=new Map(Array.from(routes,([url,asset])=>{
    const body=Buffer.from(asset.body);
    return [url,{...asset,body,etag:'"sha256-'+hash(body)+'"'}];
  }));
  const server=createServer((req,res)=>{
    const method=req.method, url=new URL(req.url,base).href, id=randomUUID();
    const path=new URL(url).pathname+new URL(url).search;
    const range=req.headers.range??null, conditional=req.headers['if-none-match']??null;
    const asset=routesByURL.get(path);
    let status=200, body=asset?.body??Buffer.alloc(0);
    const headers={[receiptHeader]:id};
    if(!['GET','HEAD'].includes(method)) status=405;
    else if(!asset) status=404;
    if(status===200) {
      Object.assign(headers,{
        'content-type':asset.mime, 'cache-control':asset.cacheControl,
        etag:asset.etag, 'accept-ranges':asset.ranges?'bytes':'none',
      },asset.extraHeaders);
      if(conditional==='*'||conditional?.split(/,\s*/).some(x=>x.replace(/^W\//,'')===asset.etag)) {
        status=304;
      } else if(method==='GET' && range && asset.ranges &&
        (!req.headers['if-range']||req.headers['if-range']===asset.etag)) {
        const limits=rangeFor(range,body.length);
        if(limits) {
          const [start,end]=limits;
          headers['content-range']='bytes '+start+'-'+end+'/'+body.length;
          status=206; body=body.subarray(start,end+1);
        } else {
          status=416; headers['content-range']='bytes */'+body.length;
        }
      }
    }
    if(status!==200&&status!==206) body=Buffer.alloc(0);
    if(status!==304) headers['content-length']=body.length;
    if(method==='HEAD') body=Buffer.alloc(0);
    const row={phase,id,url,method,status,range,conditional,
      requestCacheControl:req.headers['cache-control']??null,
      cacheControl:headers['cache-control']??null,etag:headers.etag??null,
      contentRange:headers['content-range']??null, encoding:headers['content-encoding']??null,
      bytes:null, completed:false};
    rows.push(row);
    res.on('finish',()=>{row.completed=true;row.bytes=body.length;});
    res.writeHead(status,headers);res.end(body);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  base='http://127.0.0.1:'+server.address().port;
  return {base,rows,setPhase(value){phase=value;},close:()=>new Promise((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
  })};
}
