const q=new URL(location.href).searchParams;
const worker=new Worker('./candidate-engine-worker.mjs',{type:'module'}),result=document.getElementById('result');
worker.onmessage=({data})=>{result.textContent=JSON.stringify(data,null,2);worker.terminate();};
worker.onerror=e=>{result.textContent=JSON.stringify({status:'fail',error:e.message});worker.terminate();};
worker.postMessage({workspace:q.get('workspace'),candidate:q.get('sha256')});
