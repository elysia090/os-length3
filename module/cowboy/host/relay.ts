// A link carried by a relay, from a page: one WebSocket a link. Its first message is cowboy's first line (where
// to); the relay's first is one byte: 0, the link is made, else why not, as Linux numbers it. Then nothing but the
// bytes each way, a message whatever came at a time; what is said over it is sealed between the box and the host it
// reaches (TLS, SSH), and the relay reads none of it. An empty message says no more will be sent that way.
import type {Dial} from './outside.ts';

/** Dial through the relay at `url` (wss://…): a link is one WebSocket to it. */
export const relay = (url: string): Dial => (where, heard) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let made = false, over = false, receivedEnd = false, sentEnd = false;
  const fail = (errno: number) => { if (!over) { over = true; ws.close(); heard.failed(errno); } };
  ws.onopen = () => { if (!over) ws.send(new TextEncoder().encode(`${where}\n`)); };
  ws.onmessage = ({data}) => {
    if (over) return;
    if (!(data instanceof ArrayBuffer)) { fail(71); return; }
    const bytes = new Uint8Array(data);
    if (!made) {
      if (bytes.length !== 1 || bytes[0] !== 0) { fail(bytes[0] || 111); return; }
      made = true;
      heard.opened();
      return;
    }
    if (bytes.length) { if (receivedEnd) { fail(71); return; } heard.bytes(bytes); }
    else if (!receivedEnd) { receivedEnd = true; heard.ended(); }
  };
  ws.onerror = () => fail(made ? 104 : 101);
  ws.onclose = ({code, wasClean}) => {
    if (over) return;
    // The carrier disappearing is not a TCP FIN. Both explicit ends must have crossed first.
    if (made && receivedEnd && sentEnd && wasClean && (code === 1000 || code === 1005)) over = true;
    else fail(made ? 104 : 101);
  };
  return {
    send: (bytes) => { if (!over && !sentEnd && ws.readyState === WebSocket.OPEN) ws.send(bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : bytes.slice()); },
    finish: () => { if (!over && !sentEnd && ws.readyState === WebSocket.OPEN) { sentEnd = true; ws.send(new Uint8Array(0)); } },
    close: () => { over = true; ws.close(); },
  };
};

