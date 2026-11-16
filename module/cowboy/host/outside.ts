// cowboy where a box runs on sods' Linux: what answers for the outside of the machine's network (sods' port:
// linux({outside})). What decides is cowboy itself (../src, Rust, as wasm): a name asked for is answered on the
// device, and a connection is known by the name it was meant for. What carries a link's bytes is the host's, and
// is handed in (`dial`): in a page a relay's WebSocket (relay.ts), in node a socket.
//
//   a datagram to port 53    a query: answered by cowboy, at once, from its own table. Nothing leaves the device
//   a stream                 its first line from cowboy (`name:port`), the link dialled to it; then bytes each way,
//                            as much as each side has room for (the stream's own pipes on the machine's side, the
//                            link's own on the other): nothing is kept here but what one side could not yet take
import type {Far, Outside} from '../../sods/runtime/linux.ts';

/** A link the host carries: opened or refused, bytes each way, and its ends. */
export interface Link {
  /** Send bytes to the far side. */
  send(bytes: Uint8Array): void;
  /** No more will be sent (the far side reads the end); the link stays open the other way. */
  finish(): void;
  /** Let go of it, both ways. */
  close(): void;
}
/** What a link tells whoever dialled it. */
export interface Heard {
  /** It is made. */
  opened(): void;
  /** It is not made, or broke: why, as Linux numbers it (111 refused, 101 no way there, 110 no answer in time, 113 no such host). */
  failed(errno: number): void;
  /** Bytes came. */
  bytes(bytes: Uint8Array): void;
  /** The far side sends no more. */
  ended(): void;
}
/** Dial a link to `where` (`name:port`, as cowboy's first line says it without its end). */
export type Dial = (where: string, heard: Heard) => Link;

interface Cowboy { memory: WebAssembly.Memory; cowboy_passed(): number; cowboy_answer(len: number): number; cowboy_line(address: number, port: number): number }

/**
 * The outside, answered by cowboy: `module` is cowboy as wasm, `dial` carries a link, `wake` has the kernel look
 * again after anything here that a waiting call may be waiting for (the host's own: a kernel does not run itself).
 */
export async function outside(module: WebAssembly.Module | BufferSource, dial: Dial, wake: () => void): Promise<Outside> {
  const made = module instanceof WebAssembly.Module ? module : await WebAssembly.compile(module);
  const cowboy = (await WebAssembly.instantiate(made, {})).exports as unknown as Cowboy;
  const at = cowboy.cowboy_passed();
  const passed = () => new Uint8Array(cowboy.memory.buffer, at, 2048);
  return {
    datagram(to, bytes, reply) {
      // A query, to whatever resolver the box was told of: cowboy's to answer. Anything else has nowhere to go.
      if (to.port !== 53 || bytes.length > 1024) return;
      passed().set(bytes);
      const n = cowboy.cowboy_answer(bytes.length);
      if (!n) return;
      reply(passed().slice(1024, 1024 + n));
      wake();
    },
    connect(far: Far, to) {
      // (IPv6 has no way yet: cowboy gives no name such an address)
      const n = to.ip.length === 4 ? cowboy.cowboy_line(((to.ip[0] << 24) | (to.ip[1] << 16) | (to.ip[2] << 8) | to.ip[3]) >>> 0, to.port) : 0;
      if (!n) { far.refused(113); return; }
      const where = new TextDecoder().decode(passed().subarray(0, n - 1));
      let open = false, over = false;
      // What came from the far side and the machine's side had no room for yet, in the order it came.
      const waiting: Uint8Array[] = [];
      let ended = false;
      const give = () => {
        while (waiting.length) {
          const head = waiting[0], took = far.give(head);
          if (took < head.length) { waiting[0] = head.subarray(took); break; }
          waiting.shift();
        }
        if (ended && !waiting.length) { ended = false; far.finish(); }
      };
      const take = () => {
        if (over) return;
        if (far.closed) { over = true; link.close(); return; }
        if (!open) return;
        for (let b = far.take(); b.length; b = far.take()) link.send(b);
        if (far.gone) { over = true; link.finish(); }
      };
      const link = dial(where, {
        opened: () => { open = true; far.opened(); take(); wake(); },
        failed: (errno) => { if (open) far.close(); else far.refused(errno); over = true; wake(); },
        bytes: (b) => { waiting.push(b); give(); wake(); },
        ended: () => { ended = true; give(); wake(); },
      });
      far.onwrote = take;
      far.onroom = () => { if (waiting.length || ended) { give(); wake(); } };
    },
  };
}
