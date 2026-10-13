// A static, loopback-only launcher for the downloaded Web distribution.
// It serves public packaged files; workspace authority stays in the browser.
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=await realpath(path.dirname(fileURLToPath(import.meta.url)));
const [portText='63710',...extra]=process.argv.slice(2),port=Number(portText);
if(extra.length||!/^[0-9]+$/.test(portText)||!Number.isInteger(port)||port<1024||port>65535)throw new Error('usage: node serve.mjs [PORT 1024..65535]');
const manifest=JSON.parse(await readFile(path.join(root,'web-bundle.json'),'utf8'));
if(manifest.format!=='web-distribution-bundle-v1'||!/^[a-f0-9]{64}$/.test(manifest.releaseSha256)||!manifest.files||typeof manifest.files!=='object')throw new Error('Web bundle manifest required');
const allowed=new Set(['web-bundle.json',...Object.keys(manifest.files)]);
for(const name of allowed)if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw new Error('public packaged filename required');
const host=`127.0.0.1:${port}`;
const entry='/web/index.html?'+new URLSearchParams({focus:'terminal','linux-release':'../artifact/release/release.json',
  'linux-release-sha256':manifest.releaseSha256,'linux-workspace':'os-length3-0.1.0','linux-workspace-bytes':'33554432'});
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.md':'text/plain; charset=utf-8'};
const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==host||!['GET','HEAD'].includes(req.method)){res.writeHead(403).end();return;}
    const parsed=new URL(req.url,'http://'+host);
    if(parsed.pathname==='/'){res.writeHead(302,{Location:entry,'Cache-Control':'no-store'}).end();return;}
    const name=decodeURIComponent(parsed.pathname).slice(1);
    if(!allowed.has(name)){res.writeHead(404).end();return;}
    const file=await realpath(path.join(root,name)),info=await stat(file);
    if(!file.startsWith(root+path.sep)||!info.isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes');
    let start=0,end=info.size-1,status=200;
    if(req.headers.range){const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      start=range?Number(range[1]):-1;end=range?Number(range[2]):-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=info.size||end-start+1>65536){
        res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();return;}
      status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${info.size}`);}
    res.setHeader('Content-Length',info.size===0?0:end-start+1);res.writeHead(status);
    if(req.method==='HEAD'||info.size===0){res.end();return;}
    const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }catch{if(!res.headersSent)res.writeHead(404);res.end();}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port already in use; choose another fixed port without stopping that application.':'Web static server failed.');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://'+host+'/',releaseSha256:manifest.releaseSha256,
  scope:'packaged public static files; no gateway, workspace API, telemetry or cloud upload'})));
