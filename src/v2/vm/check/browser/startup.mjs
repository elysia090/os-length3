// The restricted diagnostic server permits external same-origin modules only.
const result = document.getElementById('result');
const worker = new Worker('./startup-worker.mjs',{type:'module'});
worker.onmessage = ({data}) => {
  result.textContent = JSON.stringify(data,null,2);
  document.title = `bzImage startup: ${data.status}`;
  worker.terminate();
};
worker.onerror = event => {
  result.textContent = JSON.stringify({status:'fail',linuxBoot:'not-achieved',error:event.message},null,2);
  document.title = 'bzImage startup: fail';
  worker.terminate();
};
worker.postMessage({});
