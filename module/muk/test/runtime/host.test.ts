import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {began, builtin, canRunApart, epoch, isNode, isShared, kept, mayWait, memory, nodeThreads, processors, random, range, roomLater, roomNow, said, sha256, steady} from '../../../sods/runtime/host.ts';
import {randomBytes, uuid} from '../../runtime/flow.ts';

// The host as sods answers for it (sods/runtime/host.ts), here where the host is node: what the runtime asks in place
// of looking for itself.
test('node is known for node: its threads, its own modules, what was said to it', async () => {
  assert.equal(isNode, true);
  assert.equal(typeof (await nodeThreads())?.Worker, 'function');
  assert.equal(typeof builtin<typeof import('node:os')>('os')?.totalmem, 'function');
  assert.equal(builtin('no-such-module'), null);
  process.env.SODS_HOST_TEST = 'said';
  assert.equal(said('SODS_HOST_TEST'), 'said');
  process.env.SODS_HOST_TEST = '';
  assert.equal(said('SODS_HOST_TEST'), undefined, 'said empty is not said');
  delete process.env.SODS_HOST_TEST;
  assert.equal(said('SODS_HOST_TEST'), undefined);
});

test('memory shared between threads is told from memory that is not, and threads run apart and wait here', () => {
  assert.equal(isShared(new SharedArrayBuffer(8)), true);
  assert.equal(isShared(new ArrayBuffer(8)), false);
  assert.equal(isShared(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer), true);
  assert.equal(canRunApart(), true);
  assert.equal(mayWait, true);
  const n = processors();
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 64, String(n));
});

test('the clocks: the steady one counts milliseconds and never goes back, and with when it began tells the calendar\'s time', async () => {
  const a = steady();
  let last = a;
  for (let i = 0; i < 1000; i++) { const t = steady(); assert.ok(t >= last); last = t; }
  await new Promise((go) => setTimeout(go, 30));
  const waited = steady() - a;
  assert.ok(waited >= 25 && waited < 2000, String(waited));
  assert.ok(began > Date.UTC(2020, 0) && began <= epoch(), String(began));
  // (The calendar's clock may have been set since the host began: within a minute here, where it was not.)
  assert.ok(Math.abs(began + steady() - epoch()) < 60_000);
});

test('random bytes: as many as asked for, up to the most a browser gives at once, and not the same twice', () => {
  assert.equal(random(0).length, 0);
  assert.equal(random(65536).length, 65536);
  const a = random(32), b = random(32);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.ok(a.some((x) => x !== 0));
  // What muk makes of them: bytes each given once out of what was drawn ahead, and the UUIDs /proc says.
  assert.notDeepEqual(randomBytes(16).slice(), randomBytes(16).slice());
  const id = uuid();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(uuid(), id);
});

// What has been taken on is asked of host.ts and nowhere else: muk's runtime never looks at the host's own clocks,
// nor at its source of random bytes, its digests, what it keeps, how it fetches, or how many processors it has.
test('muk\'s runtime asks the time, random bytes, digests, what is kept and what is fetched of host.ts: none of it reads the host\'s own', () => {
  const dir = new URL('../../runtime/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const found = /\bperformance\b|\bDate\.now\b|\bnew Date\b|\bcrypto\.(?:getRandomValues|randomUUID|subtle)\b|\bMath\.random\b|\bcaches\b|\bfetch\(|\bXMLHttpRequest\b|\bnavigator\b/.exec(readFileSync(new URL(name, dir), 'utf8'));
    assert.equal(found?.[0], undefined, `${name}: ${found?.[0]}`);
  }
});

test('a digest, what is kept and a range fetched are the host\'s to answer: SHA-256 as node\'s own says it, nothing kept where a host keeps nothing, a range as a server sends it', async () => {
  const {createHash} = await import('node:crypto');
  const {createServer} = await import('node:http');
  const bytes = new TextEncoder().encode('what is kept, and what is fetched');
  assert.deepEqual([...await sha256(bytes)], [...createHash('sha256').update(bytes).digest()]);
  // node has no Cache Storage: nothing is kept, said to every address rather than thrown.
  assert.equal(await (await kept('root3-test'))('https://example.invalid/x'), null);
  // A server that sends ranges, and one that ignores them and sends the whole.
  const body = Uint8Array.from({length: 100}, (_, k) => k);
  const server = createServer((q, r) => {
    const m = /bytes=(\d+)-(\d+)/.exec(q.headers.range ?? '');
    if (q.url === '/ranges' && m) { r.writeHead(206); r.end(body.subarray(Number(m[1]), Number(m[2]) + 1)); return; }
    r.writeHead(q.url === '/none' ? 404 : 200);
    r.end(q.url === '/none' ? '' : body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const at = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  try {
    const part = await range(`${at}/ranges`, 10, 5);
    assert.deepEqual([part.status, [...part.bytes]], [206, [10, 11, 12, 13, 14]]);
    const whole = await range(`${at}/whole`, 10, 5);
    assert.deepEqual([whole.status, whole.bytes.length], [200, 100]);
    assert.equal((await range(`${at}/none`, 0, 1)).status, 404);
  } finally { server.close(); }
});

test('the machine\'s memory and the room for files are the host\'s to say: node says both at once, and nothing later', async () => {
  const os = await import('node:os');
  assert.equal(memory(), os.totalmem());
  const room = roomNow('/');
  assert.ok(room && room.total > 0 && room.free >= 0 && room.free <= room.total);
  assert.equal(roomNow('/no/such/directory/here'), null);
  assert.equal(await roomLater(), null);
});
