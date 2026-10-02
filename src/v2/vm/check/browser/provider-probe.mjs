const output = document.querySelector('#result');
const worker = new Worker(new URL('./provider-worker.mjs', import.meta.url), { type: 'module' });
const deadline = setTimeout(() => {
  worker.terminate(); output.dataset.status = 'fail';
  output.textContent = JSON.stringify({ status: 'fail', linuxBoot: 'not-tested', error: 'Worker timeout' }, null, 2);
}, 30000);
worker.onmessage = ({ data }) => {
  clearTimeout(deadline); worker.terminate();
  output.dataset.status = data.status; output.textContent = JSON.stringify(data, null, 2);
  document.title = `C VM boundary: ${data.status}`;
};
worker.onerror = event => {
  clearTimeout(deadline); worker.terminate(); output.dataset.status = 'fail';
  output.textContent = JSON.stringify({ status: 'fail', linuxBoot: 'not-tested', error: event.message }, null, 2);
};
worker.postMessage({ generation: 9 });
