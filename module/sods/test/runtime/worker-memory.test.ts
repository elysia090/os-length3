import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

const artifact = process.env.SODS_LINUX_WASM;
const bytes = (s: string) => new TextEncoder().encode(s);
const fixture = () => Buffer.from(readFileSync(new URL('../fixtures/managed-read-exit/translated.wasm.base64', import.meta.url), 'utf8'), 'base64');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}
async function reader(lazy: boolean) {
  const host = memoryHost(new WebAssembly.Module(readFileSync(artifact!)), 3, 8);
  const root = host.prepareFiles({inodes: 8, entries: 8, fileBytes: 32, tables: 1, descriptions: 8, slots: 8, reads: 8});
  const file = lazy ? host.lazyFile(root, bytes('data'), 1, 0) : host.file(root, bytes('data'), bytes('abcd'));
  const replacement = host.file(root, bytes('replacement'), bytes('1234'));
  host.sealFiles(8);
  for (let fd = 0; fd < 4; fd++) assert.equal(host.open(file), fd);
  const execution = await host.workerExecution(fixture(), 69);
  assert.throws(() => host.replaceImage(execution, new Uint8Array()), /replacement/);
  assert.throws(() => host.beginManagedRead(execution, 3, 0, 1), /owns its reads/);
  return {host, execution, file, replacement};
}
for (const kind of ['resident', 'lazy', 'failed-source'] as const) {
  test(`real Node Worker uses the same Rust authority for ${kind}`, {skip: !artifact, timeout: 15_000}, async () => {
    const {host, execution} = await reader(kind !== 'resident');
    let calls = 0;
    try {
      const outcome = await host.runWorker(execution, 4198400n, async source => {
        assert.equal(source, 1); calls++;
        assert.throws(() => host.replaceImage(execution, new Uint8Array()), /replacement|Worker/);
        assert.throws(() => host.beginManagedRead(execution, 3, 0, 1), /owns|Worker/);
        await assert.rejects(host.runWorker(execution, 4198400n), /active|unavailable/);
        await Promise.resolve();
        if (kind === 'failed-source') throw new Error('source unavailable');
        return bytes('abcd');
      });
      assert.deepEqual(outcome, {status: kind === 'failed-source' ? 1 : 0, sourceFailures: kind === 'failed-source' ? 1 : 0});
      assert.equal(calls, kind === 'resident' ? 0 : 1);
      assert.equal(host.offset(3), kind === 'failed-source' ? 0n : 4n);
      assert.equal(host.workerEvidence(execution).exited, true);
      assert.equal(host.workerEvidence(execution).pendingRequest, false);
    } finally { host.stopWorker(execution); await host.workerSettled(execution); }
  });
}
for (const failure of [false, true]) {
  test(`Worker exit retains a Rust source attempt until late ${failure ? 'failure' : 'success'}`, {skip: !artifact, timeout: 15_000}, async () => {
    const {host, execution, file, replacement} = await reader(true);
    const entered = deferred<void>(), source = deferred<Uint8Array>();
    let finished = false;
    const running = host.runWorker(execution, 4198400n, () => { entered.resolve(); return source.promise; });
    // Attach the rejection observer before requesting termination.
    const rejected = assert.rejects(running);
    try {
      await entered.promise;
      assert.throws(() => host.seek(3, 1n), /admission/);
      host.stopWorker(execution);
      await rejected;
      assert.equal(host.workerEvidence(execution).exited, true);
      assert.equal(host.workerEvidence(execution).pendingRequest, true);
      assert.throws(() => host.seek(3, 1n), /admission/);
      host.close(3);
      assert.equal(host.open(replacement), 3);
      host.seek(3, 2n);
      if (failure) source.reject(new Error('late source failure'));
      else source.resolve(bytes('WXYZ'));
      finished = true;
      await host.workerSettled(execution);
      assert.equal(host.workerEvidence(execution).pendingRequest, false);
      assert.ok(host.workerEvidence(execution).ownerFailure);
      assert.ok(host.workerEvidence(execution).transportFailure);
      assert.equal(host.offset(3), 2n); // late cleanup never touches the reused fd
      const memory = host.create(1, 1);
      const next = host.execution(memory, new Uint8Array());
      const fd = host.open(file), read = host.beginManagedRead(next.execution, fd, 0, 4);
      assert.equal(host.readResult(read).state, 'load-ready'); // late bytes were not adopted
      const load = host.startLoad(read);
      host.finishLoad(read, load.attempt, bytes('abcd'));
      assert.equal(host.copyRead(read), 4);
      host.retireRead(read);
    } finally {
      if (!finished) source.resolve(bytes('abcd'));
      host.stopWorker(execution);
      await rejected;
      await host.workerSettled(execution);
    }
  });
}
