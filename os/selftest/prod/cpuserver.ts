// The Worker's own fetch (service/worker.ts, as selftest/prod/worker.ts
// wraps it) in a Node process of its own, served over HTTP, each answer
// saying the CPU time it took: workerd's clock does not move with CPU, so
// what a request costs the Worker in CPU is measured here, on the same V8,
// the same code, the same driver over the same bridge (measure.ts). Its
// requests must come one at a time: the process's CPU is the request's.
//
//   node selftest/prod/cpuserver.ts PORT   (env: the Worker's vars and secrets, as JSON in WORKER_ENV)
//
// Prints `cpuserver PORT` once it listens on 127.0.0.1.

import {createServer} from 'node:http';
import worker from './worker.ts';

const port = Number(process.argv[2]);
const env = JSON.parse(process.env.WORKER_ENV ?? '{}');
const base = env.BASE_URL as string;

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const waiting: Promise<unknown>[] = [];
  const began = process.cpuUsage();
  const r = await worker.fetch(new Request(`${base}${req.url}`, {method: req.method, headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks)}), env, {waitUntil: (p) => { waiting.push(p); }});
  const bytes = Buffer.from(await r.arrayBuffer());
  // What it hands to waitUntil (its connection let go) counts as the request's too, as on Workers.
  await Promise.all(waiting);
  const used = process.cpuUsage(began);
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? r.headers.getSetCookie() : v; });
  headers['server-timing'] = `${r.headers.get('server-timing') ?? ''}, cpu;dur=${((used.user + used.system) / 1000).toFixed(2)}`;
  res.writeHead(r.status, headers);
  res.end(bytes);
}).listen(port, '127.0.0.1', () => console.log(`cpuserver ${port}`));
