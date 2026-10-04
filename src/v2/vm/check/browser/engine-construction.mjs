const result=document.getElementById('result');
const worker=new Worker('./engine-construction-worker.mjs',{type:'module'});
worker.onmessage=({data})=>{result.textContent=JSON.stringify(data,null,2);worker.terminate();};
worker.onerror=event=>{result.textContent=JSON.stringify({status:'fail',linuxBoot:'not-tested',error:event.message});worker.terminate();};
worker.postMessage({});
