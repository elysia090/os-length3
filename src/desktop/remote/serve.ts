// The Remote on this machine, over a directory: for development and the
// end-to-end checks. Not for anything else: it trusts its directory.
//
//   node remote/serve.ts DIR [PORT] [ORIGIN…]
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync, existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {dirname, join} from 'node:path';
import {handle, type Bucket} from './remote.ts';

const [dir, port = '8790', ...origins] = process.argv.slice(2);
if (!dir) { console.error('usage: serve.ts DIR [PORT] [ORIGIN…]'); process.exit(2); }

const file = (key: string) => join(dir, ...key.split('/').map((p) => encodeURIComponent(p)));
const tag = (b: Uint8Array) => `"${createHash('sha256').update(b).digest('hex').slice(0, 16)}"`;
const bucket: Bucket = {
  async get(key) { const f = file(key); if (!existsSync(f)) return null; const bytes = new Uint8Array(readFileSync(f)); return {bytes, etag: tag(bytes)}; },
  async head(key) { return existsSync(file(key)); },
  async put(key, bytes, onlyIf) {
    const f = file(key);
    // One process, and these steps do not yield: the check and the write are one.
    const now = existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
    if (onlyIf?.absent && now) return null;
    if (onlyIf?.etag !== undefined && (!now || tag(now) !== onlyIf.etag)) return null;
    mkdirSync(dirname(f), {recursive: true});
    writeFileSync(`${f}.tmp`, bytes);
    renameSync(`${f}.tmp`, f);
    return {etag: tag(bytes)};
  },
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method!) ? undefined : Buffer.concat(chunks),
  });
  const r = await handle(request, bucket, {origins});
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(port), '127.0.0.1', () => console.log(`remote on http://127.0.0.1:${port} (${dir})`));
