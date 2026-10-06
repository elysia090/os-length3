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
  worker.onmessage = ({data}) => {
    result.textContent = JSON.stringify(data,null,2);
    document.title = `bzImage startup: ${data.status}`;
    if (data.status !== 'running') worker.terminate();
  };
  worker.onerror = event => {
    failure(event.message);
    worker.terminate();
  };
  // Explicit long diagnostic only; the default boundary regression stays small.
  worker.postMessage({extended:parameters.get('budget') === 'extended',...(fixture!==null?{fixture}:{}),
    ...(warm!==null?{warmCuts:Number(warm)}:{}),...(idle!==null?{idle:idle==='1'}:{})});
} catch (error) {
  failure(error.message);
}
