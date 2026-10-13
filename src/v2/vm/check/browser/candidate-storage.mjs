const query=new URL(location.href).searchParams;
const workspace=query.get('workspace'),release=query.get('sha256');
if(workspace!=='fixture-linux-recovery-1012'||!/^[a-f0-9]{64}$/.test(release??''))throw new Error('existing diagnostic workspace and exact candidate required');
const report={format:'candidate-storage-failures-v1',status:'running',candidate:release,
  workspace,newKeys:false,sourceWrites:false,databaseDeletion:false,
  engineGlobalQuota:'not-tested',indexedDbPhysicalQuota:'not-tested',cases:[]};
const result=document.getElementById('result'),show=()=>result.textContent=JSON.stringify(report,null,2);
show();let worker=new Worker('./candidate-storage-worker.mjs',{type:'module'});
function bind(){worker.onmessage=({data})=>{if(data.event==='case'){report.cases.push(data.result);show();}
  else if(data.event==='interruptible'){
    worker.terminate();worker=new Worker('./candidate-storage-worker.mjs',{type:'module'});bind();
    worker.postMessage({workspace,release,namespace:data.namespace,restoreOnly:true,
      branch:data.branch,expectedHashes:data.expectedHashes,publicationPuts:data.publicationPuts,retainedBranches:data.retainedBranches});
  }else{if(data.result.interruption)report.cases.push(data.result.interruption);Object.assign(report,data.result);show();worker.terminate();}};
worker.onerror=e=>{report.status='fail';report.error=e.message;show();worker.terminate();};}
bind();
worker.postMessage({workspace,release,namespace:'qualification-20261013-'+crypto.randomUUID()});
