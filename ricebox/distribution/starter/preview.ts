import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join} from 'node:path';
import {pipeline} from 'node:stream';

const host = '127.0.0.1';
const types: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function byteRange(header: string, size: number): {start: number; end: number} | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return;
  if (!match[1]) {
    const length = Number(match[2]);
    if (Number.isSafeInteger(length) && length > 0) return {start: Math.max(0, size - length), end: size - 1};
    return;
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start)
    return {start, end: Math.min(end, size - 1)};
}

/** Serve only the files from this verified, private staging snapshot. */
export async function preview(directory: string, files: ReadonlyMap<string, number>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  let authority: string;
  const server = createServer((request, response) => {
    if (request.headers.host !== authority || !request.url?.startsWith('/')) {
      response.writeHead(400).end();
      return;
    }
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, {Allow: 'GET, HEAD'}).end();
      return;
    }
    const file = request.url.slice(1).split('?', 1)[0] || 'index.html';
    const size = files.get(file);
    if (size === undefined) {
      response.writeHead(404).end();
      return;
    }
    const header = method === 'GET' ? request.headers.range : undefined;
    const range = header === undefined ? undefined : byteRange(header, size);
    if (header !== undefined && !range) {
      response.writeHead(416, {'Content-Range': `bytes */${size}`}).end();
      return;
    }
    const length = range ? range.end - range.start + 1 : size;
    response.writeHead(range ? 206 : 200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(range && {'Content-Range': `bytes ${range.start}-${range.end}/${size}`}),
    });
    if (method === 'HEAD' || !length) response.end();
    else pipeline(createReadStream(join(directory, file), range), response, () => {});
  });
  const disconnect = () => server.closeAllConnections();
  try {
    server.once('listening', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        authority = `${host}:${address.port}`;
        console.log(`Ricebox preview: http://${authority}/`);
        console.log('Press Ctrl+C to stop.');
      }
    });
    const stopped = once(server, 'close');
    server.listen({port: 0, host, signal});
    signal.addEventListener('abort', disconnect, {once: true});
    await stopped;
  } finally {
    signal.removeEventListener('abort', disconnect);
  }
}
