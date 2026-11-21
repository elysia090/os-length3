// Single Node isolate / inline backend, diagnostic-only. Install before any instance acquisition.
import {Session} from 'node:inspector/promises';
import {Writable} from 'node:stream'; import {Console} from 'node:console';import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
export const hash=x=>createHash('sha256').update(x).digest('hex');
const observerURL=import.meta.url;
export function makeObserver(Task,{Process,selected=()=>true,maxSpans=1000000,phaseOf=(_t,target)=>target.role}={}){
 const dst=new Writable({write(b,e,cb){cb()}}),log=new Console(dst), meta=[],targets=new WeakMap(), ids=new WeakMap();let frame, ni=0,open=false;
 const mark=x=>log.count('rxcc|'+x);
 const scope=(kind,data,fn)=>{if(meta.length>=maxSpans)throw Error('RXCC diagnostic span limit');const n=meta.length;meta.push({n,kind,...data});mark('b|'+n);try{return fn()}finally{mark('e|'+n)}};
 const oid=o=>{if(!ids.has(o))ids.set(o,++ni);return ids.get(o)};
 const generations=new WeakMap(),nest=new WeakMap(),exec=Process.prototype.execve;
 Process.prototype.execve=function(...args){const depth=nest.get(this)??0;nest.set(this,depth+1);try{const v=exec.apply(this,args);if(depth===0)generations.set(this,1+(generations.get(this)??0));return v}finally{nest.set(this,depth)}};
 const getImports=Task.prototype.imports;
 Task.prototype.imports=function(){const r=getImports.call(this);for(const [name,v] of Object.entries(r.env)){
   if(typeof v!=='function'||name==='fpu')continue;
   if(!['syscall','trap','div128','clock','trace','miss','time'].includes(name))throw Error('unknown import: '+name);
   r.env[name]=(...a)=>{if(!frame)return v(...a);return scope('import',{of:frame,nm:name,nr:name==='syscall'?String(a[0]):null},()=>v(...a))};}return r};
 const session=new Session();session.connect();
 return {scope:(_k,_d,fn)=>fn(),meta,
   // Bind only after an independently verified ELF+prepared module / load receipt in this very run.
   bind(mod,{elf,wasm,role,epoch,node,revision}){if(!/^[0-9a-f]{64}$/.test(elf)||!/^[0-9a-f]{64}$/.test(wasm)||!role||!epoch||!node||node.version!==revision||targets.has(mod))throw Error('bad module binding');targets.set(mod,{elf,wasm,role,epoch,node,revision})},
   dispatch(t,x){const target=targets.get(t.image.module);if(!open||!target||!selected())return x.run(t.resumeAt);
     if(t.proc.exeAt?.node!==target.node||target.node.version!==target.revision)throw Error('target ELF binding changed');const {node,revision,...id}=target;
     const last=frame;frame={...id,phase:phaseOf(t,target),revision,fileObject:oid(node),execGeneration:generations.get(t.proc)??0,pid:t.proc.pid,tid:t.tid,proc:oid(t.proc),image:oid(t.image),instance:oid(t.instance),exe:t.proc.exe};
     try{return scope('dispatch',frame,()=>x.run(t.resumeAt))}finally{frame=last}},
   async start(us=250){await session.post('Profiler.enable');await session.post('Profiler.setSamplingInterval',{interval:us});mark('p0l');await session.post('Profiler.start');mark('p0r');open=true;},
   async finish(where,extras={}){open=false;mark('p1l');const {profile}=await session.post('Profiler.stop');mark('p1r');
     // NEVER enable the Debugger during the profiled work. Use retained script IDs afterward.
     const scripts=[];session.on('Debugger.scriptParsed',({params})=>{if(params.scriptLanguage==='WebAssembly'||params.url===observerURL)scripts.push(params)});
     await session.post('Debugger.enable');const bindings={};let observer=null;
     const needed=new Set(profile.nodes.map(n=>n.callFrame.scriptId));for(const s of scripts){if(!needed.has(s.scriptId))continue;
       if(s.url===observerURL){const {scriptSource}=await session.post('Debugger.getScriptSource',{scriptId:s.scriptId});const own=readFileSync(new URL(observerURL));if(scriptSource===own.toString('utf8')||scriptSource===own.toString('utf8')+'\n\n//# sourceURL='+observerURL){const row=own.toString('utf8').split('\n').findIndex(x=>x.includes("try{return scope('dispatch',frame,"));observer={id:s.scriptId,sha256:hash(own),callbackLine:row};}continue;}try{const {bytecode}=await session.post('Debugger.getScriptSource',{scriptId:s.scriptId});if(!bytecode)throw Error('no bytecode');
         const bytes=Buffer.from(bytecode,'base64');bindings[s.scriptId]={sha256:hash(bytes),n:bytes.length,url:s.url,engineHash:s.hash};
       }catch(e){bindings[s.scriptId]={unknown:String(e)}}};
     writeFileSync(where,JSON.stringify({format:'rxcc1-v1',node:process.version,v8:process.versions.v8,execArgv:process.execArgv,pid:process.pid,meta,bindings,profile,observer,extras})+'\n');session.disconnect();
   }
 };
}
