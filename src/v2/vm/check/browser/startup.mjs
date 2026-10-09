// The restricted diagnostic server permits external same-origin modules only.
const result = document.getElementById('result');
function failure(message) {
  result.textContent = JSON.stringify({status:'fail',linuxBoot:'not-achieved',error:message},null,2);
  document.title = 'bzImage startup: fail';
}
try {
  const parameters = new URL(location.href).searchParams;
  const fixture = parameters.get('fixture');
  const warm = parameters.get('warm-cuts'), idle = parameters.get('idle');
  if ((warm !== null && (!/^[1-9][0-9]?$/.test(warm) || Number(warm) > 64))
      || (idle !== null && !['0','1'].includes(idle)))
    throw new Error('diagnostic warm/idle selection');
  const worker = new Worker('./startup-worker.mjs',{type:'module'});
  const consoleView=document.getElementById('console'),phase=document.getElementById('phase'),load=document.getElementById('compiler-load');
  const inputForm=document.getElementById('input-form'),compilerForm=document.getElementById('compiler-form');
  const interactive=parameters.get('interactive')==='1';
  inputForm?.addEventListener('submit',event=>{event.preventDefault();const line=document.getElementById('input-line');
    worker.postMessage({type:'input',text:line.value+'\n'});line.value='';});
  compilerForm?.addEventListener('submit',event=>{event.preventDefault();worker.postMessage({type:'compiler',fixture:document.getElementById('compiler-fixture').value});});
  worker.onmessage = ({data}) => {
    if(data.status==='input-refused'||data.status==='input-backpressure'){if(phase)phase.textContent=data.status;return;}
    result.textContent = JSON.stringify(data,null,2);
    if(consoleView&&data.console?.text)consoleView.textContent=data.console.text;
    if(phase)phase.textContent=data.awaiting==='compiler-update'?`Compiler needs ${data.refusal?.source?.map(byte=>byte.toString(16).padStart(2,'0')).join(' ')??data.error??'an update'}`:
      `${data.status} · ${data.retired??0} retired · ${data.nextRip??''}`;
    if(load)load.disabled=data.awaiting!=='compiler-update';
    document.title = `bzImage startup: ${data.status}`;
    if (data.status !== 'running') worker.terminate();
  };
  worker.onerror = event => {
    failure(event.message);
    worker.terminate();
  };
  // Explicit long diagnostic only; the default boundary regression stays small.
  worker.postMessage({extended:parameters.get('budget') === 'extended',...(fixture!==null?{fixture}:{}),
    ...(interactive?{interactive:true}:{}),
    ...(warm!==null?{warmCuts:Number(warm)}:{}),...(idle!==null?{idle:idle==='1'}:{})});
} catch (error) {
  failure(error.message);
}
