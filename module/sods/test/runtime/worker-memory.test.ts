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
      assert.equal(host.workerEvidence(execution).resourcesRetired, false);
      assert.throws(() => host.seek(3, 1n), /admission/);
      host.close(3);
      assert.equal(host.open(replacement), 3);
      host.seek(3, 2n);
      if (failure) source.reject(new Error('late source failure'));
      else source.resolve(bytes('WXYZ'));
      finished = true;
      await host.workerSettled(execution);
      assert.equal(host.workerEvidence(execution).pendingRequest, false);
      assert.equal(host.workerEvidence(execution).resourcesRetired, true);
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

function startup() {
  const wasm = Buffer.from(readFileSync(new URL('../fixtures/managed-startup/translated.wasm.base64', import.meta.url), 'utf8'), 'base64');
  const [section] = WebAssembly.Module.customSections(new WebAssembly.Module(wasm), 'sods.facts');
  const facts = JSON.parse(new TextDecoder().decode(section)) as {entry: number; imageEnd: number; phdr: number; phent: number; phnum: number};
  const low = Math.ceil(facts.imageEnd / 65536) * 65536, top = low + 65536;
  return {wasm, pages: top / 65536, stack: {low, top, facts,
    credentials: {uid: 11, euid: 12, gid: 13, egid: 14, secure: true},
    execfn: bytes('/bin/startup'), argv: [bytes('alias'), new Uint8Array([255, 254])],
    env: [bytes('A=1'), bytes('A=2')], random: new Uint8Array(16).fill(7)}};
}
function startupHost() {
  const host = memoryHost(new WebAssembly.Module(readFileSync(artifact!)), 3, 8);
  host.prepareFiles({inodes: 2, entries: 2, fileBytes: 32, tables: 1, descriptions: 2, slots: 2, reads: 2});
  host.sealFiles(2);
  return host;
}
test('real guest reads Rust initial stack and independently checks argv, env and auxv', {skip: !artifact, timeout: 15_000}, async () => {
  const host = startupHost(), input = startup();
  const preparing = host.workerExecution(input.wasm, input.pages, input.stack);
  // Physical preparation uses its accepted snapshot, not later caller mutation.
  input.stack.argv[0].fill(120); input.stack.random.fill(0);
  const execution = await preparing;
  try {
    assert.deepEqual(await host.runWorker(execution, BigInt(input.stack.facts.entry)), {status: 0, sourceFailures: 0});
    assert.equal(host.workerEvidence(execution).exited, true);
    assert.equal(host.workerEvidence(execution).resourcesRetired, true);
  } finally { host.stopWorker(execution); await host.workerSettled(execution); }
});
test('initial stack rejects overlap and malformed bytes before guest publication', {skip: !artifact}, async () => {
  for (const bad of ['overlap', 'nul', 'random'] as const) {
    const host = startupHost(), input = startup();
    if (bad === 'overlap') input.stack.low = 0;
    if (bad === 'nul') input.stack.argv[1] = new Uint8Array([1, 0, 2]);
    if (bad === 'random') input.stack.random = new Uint8Array(15);
    await assert.rejects(host.workerExecution(input.wasm, input.pages, input.stack));
  }
});

test('zero-length image data inside the stack region is not an overlap', {skip: !artifact, timeout: 10_000}, async () => {
  const leb = (n: number): number[] => n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)];
  const section = (id: number, data: number[]) => [id, ...leb(data.length), ...data];
  const name = (s: string) => [s.length, ...bytes(s)];
  const imports = [[...name('env'), ...name('memory'), 2, 1, 1, 1],
    ...['syscall', 'trap', 'div128', 'clock', 'fpu', 'trace', 'miss', 'time'].map(n => [...name('env'), ...name(n), 0, 0])];
  // Minimal engine-valid guest with a mutable i64 r4 and one empty active segment
  // at address 1. Its empty run is not a translated Linux program.
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 1, 0x7e, 0]),
    ...section(2, [imports.length, ...imports.flat()]),
    ...section(3, [1, 0]),
    ...section(6, [1, 0x7e, 1, 0x42, 0, 0x0b]),
    ...section(7, [2, 3, 114, 117, 110, 0, 8, 2, 114, 52, 3, 0]),
    ...section(10, [1, 2, 0, 0x0b]),
    ...section(11, [1, 0, 0x41, 1, 0x0b, 0]),
  ]);
  const host = startupHost(), {stack} = startup();
  const execution = await host.workerExecution(wasm, 1, {...stack, low: 0, top: 65536,
    facts: {entry: 0, phdr: 0, phent: 0, phnum: 0}});
  assert.equal(host.workerEvidence(execution).resourcesRetired, false);
  host.stopWorker(execution);
  assert.equal(host.workerEvidence(execution).resourcesRetired, false);
  // Await actual Node exit, not merely the source request queue.
  const deadline = Date.now() + 5000;
  while (!host.workerEvidence(execution).exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(host.workerEvidence(execution).exited, true);
  // Exit listeners run in an observed microtask before the next timer turn.
  assert.equal(host.workerEvidence(execution).resourcesRetired, true);
});
