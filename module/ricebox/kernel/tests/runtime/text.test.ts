import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/process.ts';

// Text the kernel reads out of a process's memory, where that memory is shared (its threads run apart, each in a
// Worker of its own, as a cross-origin isolated page runs them): a browser's TextDecoder refuses a view of a
// SharedArrayBuffer, where Node's takes it, so here it is made to refuse one as a browser does. Before, a name set
// by prctl, a host name, a socket's or an interface's, and what a faulting thread left in its channel each halted the
// kernel in the browser (git, faulting in the web Prompt: "Failed to execute 'decode' on 'TextDecoder'").

/** TextDecoder's decode as a browser's: a shared view refused. */
function asBrowser(): () => void {
  const decode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function (this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
    const buffer = input && 'buffer' in input ? input.buffer : input;
    if (buffer instanceof SharedArrayBuffer) throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.");
    return decode.call(this, input, options);
  };
  return () => { TextDecoder.prototype.decode = decode; };
}

function sharedGuest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}

test('a name set in a shared memory is read as the browser can read it: prctl PR_SET_NAME, sethostname', () => {
  const back = asBrowser();
  try {
    const p = sharedGuest();
    assert.ok(p.bytes.buffer instanceof SharedArrayBuffer);
    p.bytes.set(new TextEncoder().encode('git-worker\0'), 100);
    assert.equal(p.syscall(157n, 15n, 100n, 0n, 0n, 0n, 0n), 0n); // prctl(PR_SET_NAME)
    assert.equal(p.syscall(157n, 16n, 200n, 0n, 0n, 0n, 0n), 0n); // prctl(PR_GET_NAME)
    assert.equal(new TextDecoder().decode(p.bytes.slice(200, 210)), 'git-worker');
    p.bytes.set(new TextEncoder().encode('box'), 300);
    assert.equal(p.syscall(170n, 300n, 3n, 0n, 0n, 0n, 0n), 0n); // sethostname
  } finally { back(); }
});

test('every text the kernel reads is read by flow.ts utf8, which copies a shared view first', () => {
  const dir = new URL('../../runtime/', import.meta.url);
  // The translator's own memory (translator.ts, sods') is never shared; the kernel's every other file reads through utf8.
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'flow.ts' && f !== 'translator.ts')) {
    const source = readFileSync(new URL(file, dir), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\.decode\(/.test(source.replace(/\bdecode\(stored, f\.size\)/g, '')), `${file} decodes text itself`);
  }
});
