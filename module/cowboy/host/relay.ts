// A link carried by a relay, from a page: one WebSocket a link. Its first message is cowboy's first line (where
// to); the relay's first is one byte: 0, the link is made, else why not, as Linux numbers it. Then nothing but the
// bytes each way, a message whatever came at a time; what is said over it is sealed between the box and the host it
// reaches (TLS, SSH), and the relay reads none of it. An empty message says no more will be sent that way.
import type {Dial} from './outside.ts';

/** Dial through the relay at `url` (wss://…): a link is one WebSocket to it. */
export const relay = (url: string): Dial => (where, heard) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let made = false, over = false;
  const fail = (errno: number) => { if (!over) { over = true; heard.failed(errno); } };
  ws.onopen = () => ws.send(new TextEncoder().encode(`${where}\n`));
  ws.onmessage = ({data}) => {
    const bytes = new Uint8Array(data as ArrayBuffer);
    if (!made) {
      if (bytes.length !== 1 || bytes[0] !== 0) { fail(bytes[0] || 111); ws.close(); return; }
      made = true;
      heard.opened();
      return;
    }
    if (bytes.length) heard.bytes(bytes); else heard.ended();
  };
  ws.onerror = () => fail(made ? 104 : 101);
  ws.onclose = () => { if (made && !over) { over = true; heard.ended(); } else fail(101); };
  return {
    send: (bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); },
    finish: () => { if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(0)); },
    close: () => { over = true; ws.close(); },
  };
};
