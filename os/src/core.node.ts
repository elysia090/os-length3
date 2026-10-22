// For tests: the core a browser runs (core/web), in a worker thread of this process over files in memory,
// as core.worker.ts runs it in a page. Its requests go to this thread's fetch (a test's own Remote, often
// in this process too): the core waits for each, as it waits for a page's XHR. Not part of the app.

import {readFileSync} from 'node:fs';
import {isMainThread, MessageChannel, parentPort, receiveMessageOnPort, Worker, workerData, type MessagePort} from 'node:worker_threads';
import type {Answer, Ask} from './core-client.ts';
import {Core} from './core-abi.ts';
import {MemoryFS, WASI} from './wasi.ts';

interface Asked { id: number; name: string; args: unknown }
interface Fetch { url: string; method: string; headers: [string, string][]; body: Uint8Array | null }
interface Fetched { status: number; body: Uint8Array }

/** A core of this test's own, from the module at `wasm` (scripts/core-wasm.ts builds it), told `env`. */
export function nodeCore(wasm: string, env: Record<string, string>): Ask {
  const {port1: here, port2: there} = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), {workerData: {wasm, env, port: there, signal}, transferList: [there]});
  // The core asked for a request: this thread makes it, then wakes the core with its answer.
  here.on('message', (f: Fetch) => {
    void (async (): Promise<Fetched> => {
      try {
        const r = await fetch(f.url, {method: f.method, headers: f.headers, body: f.body && f.body.length ? f.body as BodyInit : undefined});
        return {status: r.status, body: new Uint8Array(await r.arrayBuffer())};
      } catch (e) { return {status: 0, body: new TextEncoder().encode(e instanceof Error ? e.message : String(e))}; }
    })().then((answer) => {
      here.postMessage(answer);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
  });
  // Listening refs the port: only a question asked keeps the process up (the worker, while it answers).
  here.unref();
  let next = 1;
  const waiting = new Map<number, {resolve(v: Answer): void; reject(e: Error): void}>();
  worker.on('message', ({id, ...answer}: {id: number} & Answer) => {
    const p = waiting.get(id)!;
    waiting.delete(id);
    p.resolve(answer);
  });
  worker.on('error', (e: Error) => { for (const p of waiting.values()) p.reject(e); waiting.clear(); });
  // Listening refs the worker too: only a question asked keeps the process up.
  worker.unref();
  return (name, args) => new Promise<Answer>((resolve, reject) => {
    const id = next++;
    waiting.set(id, {resolve, reject});
    worker.ref();
    worker.postMessage({id, name, args} satisfies Asked);
  }).finally(() => { if (!waiting.size) worker.unref(); });
}

if (!isMainThread) {
  const {wasm, env, port, signal} = workerData as {wasm: string; env: Record<string, string>; port: MessagePort; signal: Int32Array};
  const module = new WebAssembly.Module(readFileSync(wasm));
  const fs = new MemoryFS();
  const send = (head: {method: string; url: string; headers: [string, string][]}, body: Uint8Array): Fetched => {
    Atomics.store(signal, 0, 0);
    port.postMessage({url: head.url, method: head.method, headers: head.headers, body} satisfies Fetch);
    Atomics.wait(signal, 0, 0);
    return (receiveMessageOnPort(port)!.message) as Fetched;
  };
  let core: Core | null = null;
  parentPort!.on('message', async (q: Asked) => {
    try {
      core ??= await Core.start(module, new WASI({fs, env, out: () => {}}), send);
      const a = core.call(q.name, q.args);
      parentPort!.postMessage({id: q.id, ...a});
    } catch (e) {
      // A trap ends that instance; the files stay, and the next question starts another.
      core = null;
      parentPort!.postMessage({id: q.id, error: e instanceof Error ? e.message : String(e)});
    }
  });
}
