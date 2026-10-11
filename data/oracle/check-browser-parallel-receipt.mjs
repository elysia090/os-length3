// Check the actual browser console receipt, not a command inventory or a
// native build. The guest script asserts hashes and executes every product.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function checkParallelReceipt(raw){
  const text=raw.replaceAll('\r',''),marker='browser-four-compilers:pass\n';
  const at=text.lastIndexOf(marker);assert(at>=0,'four-compiler receipt');
  const events=text.slice(0,at).trimEnd().split('\n').slice(-12);
  const names=['one','two','three','four'],started=new Set(),compiled=new Set(),ended=new Set(),pids=new Set();
  let live=0,maximum=0;
  for(const line of events){
    const row=/^(start|compile|end) (one|two|three|four) ([0-9]+)$/.exec(line);
    assert(row,'exact twelve-event receipt');const [,kind,name,value]=row;
    if(kind==='start'){
      assert(!started.has(name)&&!compiled.size&&!ended.size,'all starts precede compilation');
      assert(Number(value)>0&&!pids.has(value),'distinct live recipe PIDs');
      started.add(name);pids.add(value);maximum=Math.max(maximum,++live);
    }else if(kind==='compile'){
      assert(started.size===4&&started.has(name)&&!compiled.has(name)&&value==='0','successful unique compiler exit');
      compiled.add(name);
    }else{
      assert(compiled.has(name)&&!ended.has(name)&&value==='0','successful unique product exit');
      ended.add(name);--live;
    }
  }
  assert.equal(maximum,4);assert.equal(live,0);
  assert.deepEqual([...ended].sort(),names.sort());
  const after=text.slice(at+marker.length);
  assert(/^browser-multisource-link:pass$/m.test(after),'actual multi-source link');
  assert(/^browser-parallel-products:\/workspace\/parallel-build\.[A-Za-z0-9]+$/m.test(after),'dedicated workspace');
  assert(/^expanded-build-final-exit:0$/m.test(after),'final foreground job exits zero after incremental assertions');
  return {targets:4,maximumLive:maximum,compilerExits:4,programExits:4,incremental:'pass',multiSource:'pass'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3)throw new Error('usage: check-browser-parallel-receipt.mjs CONSOLE-LOG');
  console.log(JSON.stringify(checkParallelReceipt(readFileSync(process.argv[2],'utf8'))));
}
