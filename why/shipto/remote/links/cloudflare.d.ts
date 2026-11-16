// What Workers has of its own that a link uses (relay.worker.ts), as much of it as is used: a TCP connection out
// (https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) and the two ends of a WebSocket.

declare module 'cloudflare:sockets' {
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    /** Resolves once the connection is made; rejects where it is not. */
    readonly opened: Promise<unknown>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(address: {hostname: string; port: number}, options?: {secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean}): Socket;
}
