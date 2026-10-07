const output=document.querySelector('#result');
const worker=new Worker(new URL('./image-admission-worker.mjs',import.meta.url),{type:'module'});
function finish(data){
  clearTimeout(deadline);worker.terminate();output.dataset.status=data.status;
  output.textContent=JSON.stringify(data,null,2);document.title=`C image admission: ${data.status}`;
}
const deadline=setTimeout(()=>finish({status:'fail',linuxBoot:'not-tested',error:'Worker timeout'}),30000);
worker.onmessage=({data})=>finish(data);
worker.onerror=event=>finish({status:'fail',linuxBoot:'not-tested',error:event.message});
worker.postMessage({generation:1});
