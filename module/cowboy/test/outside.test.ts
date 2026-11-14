import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {test} from 'node:test';
import {Kernel, Vfs, mountTarget, provide} from '../../sods/runtime/linux.ts';
import {loadTranslator} from '../../sods/runtime/translate.ts';
import {mountPack} from '../../ricebox/layers/mount.ts';
import {openWeb} from '../../ricebox/make/tree.ts';
import {outside, type Dial} from '../host/outside.ts';

// cowboy with a real program on sods' Linux in node: the root's own curl asks a name, is given an address of
// cowboy's own, connects to it, and the link is dialled by the name it was meant for (here: a socket of node's, to
// a server of this test's; in a page, a relay). Needs the web root this tree builds with (public/webroot) and cowboy
// built as wasm (cargo build --release --target wasm32-unknown-unknown, in module/cowboy).

const web = new URL('../../../public/webroot/', import.meta.url).pathname;
const wasm = new URL('../target/wasm32-unknown-unknown/release/cowboy.wasm', import.meta.url);
const have = existsSync(`${web}webroot.json`) && existsSync(wasm);

/** `argv` run on the root with cowboy as its outside, every link dialled to `port` of this machine whatever its name: what it wrote, how it ended, and where it dialled. */
async function run(argv: string[], port: number): Promise<{out: string; status: number | null; dialled: string[]}> {
  const w = openWeb(web);
  const translate = await loadTranslator(w.blob(w.index.translator!));
  const vfs = new Vfs();
  mountPack(mountTarget(vfs), w.index, {
    range: (pack, at, len) => { const b = Buffer.alloc(len); w.readRange(pack, at, len, b); return new Uint8Array(b); },
    decode: (b) => new Uint8Array(w.unzstd(b)), sha256: (b) => new Uint8Array(createHash('sha256').update(b).digest()),
  });
  const ready = (w.index.translations ?? []).map((t) => {
    const f = w.index.files.find((x) => x.path === t.path);
    provide(vfs, {path: t.path, bytes: new Uint8Array(w.blob(t.elf)), mode: f?.mode ?? 0o755, root: true});
    return {path: t.path, wasm: new Uint8Array(w.blob(t.wasm))};
  });
  // The resolver a box is told of is cowboy's own.
  vfs.writeFile('/etc/resolv.conf', 'nameserver 198.18.0.1\n');
  let out = '';
  let woken: (() => void) | null = null;
  const wake = () => { woken?.(); woken = null; };
  const dialled: string[] = [];
  const dial: Dial = (where, heard) => {
    dialled.push(where);
    const s = connect({host: '127.0.0.1', port});
    s.on('connect', () => heard.opened());
    s.on('data', (b) => heard.bytes(new Uint8Array(b)));
    s.on('end', () => heard.ended());
    s.on('error', () => heard.failed(111));
    return {send: (b) => { s.write(b); }, finish: () => { s.end(); }, close: () => { s.destroy(); }};
  };
  const kernel = new Kernel({vfs, translate, outside: await outside(readFileSync(wasm), dial, wake),
    console: {write: (_, b) => { out += new TextDecoder().decode(b); }, read: () => new Uint8Array(0), ready: () => true}});
  for (const r of ready) { const {wasm: m, segments} = kernel.prepare(r.wasm); kernel.prebuilt(vfs.file(r.path), new WebAssembly.Module(m), segments); }
  kernel.start(argv[0], argv, ['PATH=/usr/bin:/bin', 'HOME=/root'], '/');
  const until = Date.now() + 60_000;
  for (;;) {
    const r = kernel.pump();
    if (!r.waiting) return {out, status: r.status ?? null, dialled};
    assert.ok(Date.now() < until, `it did not end; it wrote: ${out}`);
    // It waits: for what the outside brings (woken), or for its own time.
    await new Promise<void>((go) => { woken = go; setTimeout(go, r.until !== undefined ? Math.max(0, r.until - performance.now()) : 50); });
  }
}

test('the root\'s curl reaches a host by its name: asked of cowboy, dialled by that name, its bytes both ways', {skip: !have}, async () => {
  const asked: string[] = [];
  const server = createServer((req, res) => { asked.push(`${req.method} ${req.url} ${req.headers.host}`); res.end(`hello from ${req.headers.host}\n`); });
  await new Promise<void>((go) => server.listen(0, '127.0.0.1', go));
  const port = (server.address() as {port: number}).port;
  try {
    const got = await run(['/usr/bin/curl', '-sS', `http://Example.test:${port}/a?b=1`], port);
    assert.equal(got.out, `hello from Example.test:${port}\n`);
    assert.equal(got.status, 0);
    // Dialled by the name, as cowboy keeps it (lower case), not by the address the program was given for it.
    assert.deepEqual(got.dialled, [`example.test:${port}`]);
    assert.deepEqual(asked, [`GET /a?b=1 Example.test:${port}`]);
    // More than a stream holds at a time, each way: what one side cannot take yet waits, and all of it arrives.
    const big = 'x'.repeat(300_000);
    server.removeAllListeners('request');
    server.on('request', (req, res) => { let n = 0; req.on('data', (b: Buffer) => { n += b.length; }); req.on('end', () => res.end(`${n}:${big}`)); });
    const sent = await run(['/bin/sh', '-c', `head -c 200000 /dev/zero | curl -sS --data-binary @- http://upload.test:${port}/ | wc -c`], port);
    assert.equal(sent.out.trim(), String(`200000:${big}`.length));
    assert.deepEqual(sent.dialled, [`upload.test:${port}`]);
  } finally { server.close(); }
});

test('a host that is not there is refused as Linux says it, and an address as it stands is dialled as it stands', {skip: !have}, async () => {
  // Nothing listens: the link fails, and curl says it could not connect (7).
  const none = await run(['/usr/bin/curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'http://nobody.test:9/'], 9);
  assert.equal(none.status, 7 << 8);
  const server = createServer((_, res) => res.end('ok\n'));
  await new Promise<void>((go) => server.listen(0, '127.0.0.1', go));
  const port = (server.address() as {port: number}).port;
  try {
    const got = await run(['/usr/bin/curl', '-sS', `http://203.0.113.7:${port}/`], port);
    assert.equal(got.out, 'ok\n');
    assert.deepEqual(got.dialled, [`203.0.113.7:${port}`]);
  } finally { server.close(); }
});
