// Loopback-only browser oracle. No guest execution or filesystem emulation.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../src/v2/vm/check/browser/fixture.mjs';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const isolated = process.argv.includes('--isolated');
const portOption = process.argv.find(value => value.startsWith('--port='));
const port = portOption ? Number(portOption.slice(7)) : 8080;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm' };

function rangeOf(header, bytes) {
  if (!header) return bytes ? [0, bytes - 1] : [0, -1];
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : bytes - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start <= end && start < bytes ? [start, Math.min(end, bytes - 1)] : null;
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; "
    + "connect-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (isolated) {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);
    const inline = path === '/probe.wasm';
    // Only the diagnostic/product files and published receipts/assets can be
    // served. No source cache, build-host key, scratch disk or Git internals.
    if (!inline && (!/^\/(src\/v2\/(vm\/check\/browser|web)\/|artifact\/)/.test(path)
        || path.split('/').some(part => part === '..' || part.startsWith('.'))
        || path.includes('\\'))) { response.writeHead(404).end(); return; }
    const file = inline ? null : await realpath(resolve(root, path.slice(1)));
    if (file && !file.startsWith(root + sep)) { response.writeHead(404).end(); return; }
    const info = inline ? { size: fixture.length, isFile: () => true } : await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', inline ? 'application/wasm' : mime[extname(file)] || 'application/octet-stream');
    const extent = rangeOf(request.headers.range, info.size);
    if (!extent) {
      response.setHeader('Content-Range', `bytes */${info.size}`);
      response.writeHead(416).end(); return;
    }
    const [start, end] = extent;
    response.setHeader('Content-Length', end - start + 1);
    if (request.headers.range) response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    response.writeHead(request.headers.range ? 206 : 200);
    if (request.method === 'HEAD' || !info.size) { response.end(); return; }
    if (inline) { response.end(fixture.subarray(start, end + 1)); return; }
    const stream = createReadStream(file, { start, end });
    response.once('close', () => stream.destroy());
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  } catch { if (!response.headersSent) response.writeHead(404).end(); else response.destroy(); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/src/v2/vm/check/browser/index.html isolated=${isolated}`);
});
