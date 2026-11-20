// One display-only projection of the worker's ordered output and flush epochs.
export function terminalStream(write: (text: string) => void, discardPartial: () => void) {
  let epoch = 0, lastTag = 0, received = 0, decoder = new TextDecoder(), sealed = false, closed = false;
  function cut(sentBytes: number): void {
    if (closed || sealed || sentBytes !== received) throw new Error('Terminal output boundary does not match');
  }
  return {
    accept(bytes: Uint8Array, tag: number): boolean {
      if (closed) return false;
      if (sealed || !Number.isSafeInteger(tag) || tag < lastTag || tag > epoch) {
        throw new Error('Invalid terminal output order');
      }
      lastTag = tag;
      received += bytes.byteLength;
      if (!Number.isSafeInteger(received)) throw new Error('Terminal output byte count overflow');
      if (tag < epoch) return false;
      const text = decoder.decode(bytes, {stream: true});
      if (!text) return false;
      write(text);
      return true;
    },
    flush(): number {
      if (closed || sealed) throw new Error('Terminal stream is closed');
      decoder = new TextDecoder();
      discardPartial();
      return ++epoch;
    },
    // A geometry cut checks the prefix without flushing UTF-8 or ANSI carry.
    cut,
    seal(sentBytes: number): void {
      cut(sentBytes);
      sealed = true;
    },
    get sealed() { return sealed; },
    close(): void {
      if (closed) return;
      closed = true;
      const text = decoder.decode();
      if (text) write(text);
      discardPartial();
    },
  };
}
