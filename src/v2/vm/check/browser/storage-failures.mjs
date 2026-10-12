// The supervisor retains a fixture head across deliberately disposable Workers.
// No test reads, modifies or removes an existing user database.
const button = document.getElementById('run');
const output = document.getElementById('result');
const report = {
  format: 'browser-persistent-block-failures-v1', status: 'idle',
  scope: 'real IndexedDB; injected bounded quota; Worker loss before head publication',
  linuxBoot: 'not-tested', engineQuotaExhaustion: 'not-tested', hostRss: 'not-measured',
  cases: [], deletedDatabases: [], errors: [],
};
function show() {
  output.textContent = JSON.stringify(report, null, 2);
  output.dataset.status = report.status;
  document.title = `Isolated browser storage: ${report.status}`;
}
function runWorker(message, interrupt = false) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./storage-failures-worker.mjs', import.meta.url), { type: 'module' });
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`timeout: ${message.scenario}`)), 30000);
    worker.onerror = event => finish(new Error(event.message));
    worker.onmessage = ({ data }) => {
      if (interrupt && data.event === 'interruptible') {
        finish(null, { ...data, workerTerminatedWithoutClose: true });
      } else if (data.event === 'result') {
        finish(data.ok ? null : new Error(data.error), data.result);
      }
    };
    worker.postMessage(message);
  });
}
async function removeFixture(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`length3-block-${name}`);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('fixture cleanup blocked'));
  });
  report.deletedDatabases.push(name);
}
button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true;
  report.status = 'running';
  report.secureContext = window.isSecureContext;
  report.isolated = window.crossOriginIsolated;
  const prefix = `oracle-20261012-${crypto.randomUUID()}`;
  const fixtures = new Set();
  const nameFor = suffix => {
    const name = `${prefix}-${suffix}`;
    fixtures.add(name);
    return name;
  };
  show();
  try {
    if (!window.isSecureContext) throw new Error('secure context required');
    const count = await runWorker({ name: nameFor('count'), scenario: 'publication-count' });
    if (count.publicationPuts < 1 || count.publicationPuts > 16) throw new Error('unexpected fixture publication size');
    report.publicationPuts = count.publicationPuts;
    report.cases.push(count);
    show();
    for (let faultAt = 1; faultAt <= count.publicationPuts; faultAt++) {
      report.cases.push(await runWorker({ name: nameFor(`quota-${faultAt}`), scenario: 'quota', faultAt }));
      show();
    }
    for (const scenario of ['head-abort', 'corruption', 'quota-close']) {
      report.cases.push(await runWorker({ name: nameFor(scenario), scenario }));
      show();
    }
    const interruptedName = nameFor('worker-interrupt');
    const interrupted = await runWorker({ name: interruptedName, scenario: 'interrupt' }, true);
    const restored = await runWorker({ name: interruptedName, scenario: 'restore', trustedHead: interrupted.trustedHead });
    report.cases.push({ ...restored, persistedBeforeInterruption: interrupted.persistedObjects,
      workerTerminatedWithoutClose: interrupted.workerTerminatedWithoutClose });
    report.status = 'pass';
  } catch (error) {
    report.status = 'fail';
    report.errors.push(error.message ?? String(error));
  } finally {
    // Every name came from this run's random prefix. No inventory-wide deletion.
    for (const name of fixtures) {
      try { await removeFixture(name); }
      catch (error) { report.status = 'fail'; report.errors.push(`cleanup ${name}: ${error.message}`); }
    }
    show();
  }
});
show();
