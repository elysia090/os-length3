import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as tcpServer, type Socket} from 'node:net';
import {mock, test} from 'node:test';
import type {Auth} from '../people/auth.ts';
import {FIRST_MS, MOST, OPEN_MS, PATH, QUIET_MS, admit, carry, held, type Far, type Heard} from './relay.ts';
import {links, tcp} from './relay.node.ts';
import {ERR, also} from './where.ts';

const line = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
/** A turn of the event loop: what a link does after it asked where (a promise) has been done. */
const turn = () => new Promise<void>((go) => setImmediate(go));

/** A link with both its sides stood in for: what went to the page, what the connection was asked, and its Heard to speak as the host. */
function stood(user = 'u', dns: Record<string, string[]> = {'example.org': ['93.184.216.34']}) {
  const near: (Uint8Array | 'closed')[] = [], far: (string | Uint8Array)[] = [];
  let heard: Heard | null = null;
  const open = (address: string, port: number, h: Heard): Far => {
    far.push(`open ${address}:${port}`);
    heard = h;
    return {send: (b) => { far.push(b); }, finish: () => { far.push('finish'); }, close: () => { far.push('close'); }};
  };
  const link = carry(user, {send: (b) => { near.push(b); }, close: () => { near.push('closed'); }},
    {open, resolve: async (name) => { if (!(name in dns)) throw new Error('no'); return dns[name]; }});
  return {link, near, far, host: () => heard!};
}

test('a link: where to, one byte back, then the bytes each way as they come, an empty message the end of one way', async () => {
  const l = stood();
  l.link.message(line('example.org:443\n'));
  await turn();
  // Dialled by the address the name was judged by; the page hears nothing until the host answers.
  assert.deepEqual(l.far, ['open 93.184.216.34:443']);
  assert.deepEqual(l.near, []);
  assert.equal(held('u'), 1);
  l.host().opened();
  assert.deepEqual(l.near, [Uint8Array.of(0)]);
  l.link.message(line('hello'));
  l.host().bytes(line('world'));
  assert.equal(text(l.far[1] as unknown as Uint8Array), 'hello');
  assert.equal(text(l.near[1] as unknown as Uint8Array), 'world');
  // The page sends no more: the host reads the end, and may still answer.
  l.link.message(new Uint8Array(0));
  assert.equal(l.far[2], 'finish');
  l.host().bytes(line('late'));
  assert.equal(text(l.near[2] as unknown as Uint8Array), 'late');
  // The host sends no more either: both ways are done, and the link is let go.
  l.host().ended();
  assert.deepEqual(l.near.slice(3), [new Uint8Array(0), 'closed']);
  assert.equal(l.far[3], 'close');
  assert.equal(held('u'), 0);
  // Nothing after it is anyone's.
  l.link.message(line('more'));
  l.host().bytes(line('more'));
  assert.equal(l.far.length, 4);
  assert.equal(l.near.length, 5);
});

test('a link not made says why in its one byte, and is over: the rule, the name, the host', async () => {
  const refused = async (first: string, then?: (l: ReturnType<typeof stood>) => void) => {
    const l = stood();
    l.link.message(line(first));
    await turn();
    then?.(l);
    return l;
  };
  let l = await refused('example.org:25\n');
  assert.deepEqual(l.near, [Uint8Array.of(ERR.ACCES), 'closed']);
  assert.deepEqual(l.far, []);
  l = await refused('10.0.0.1:443\n');
  assert.deepEqual(l.near, [Uint8Array.of(ERR.ACCES), 'closed']);
  l = await refused('nowhere.example:443\n');
  assert.deepEqual(l.near, [Uint8Array.of(ERR.HOSTUNREACH), 'closed']);
  l = await refused('example.org:443\n', (x) => x.host().failed(ERR.REFUSED));
  assert.deepEqual(l.near, [Uint8Array.of(ERR.REFUSED), 'closed']);
  assert.deepEqual(l.far, ['open 93.184.216.34:443', 'close']);
  // What is not a first line, text, and bytes sent before the link is made: let go with no word.
  l = await refused('GET / HTTP/1.1\r\n\r\n');
  assert.deepEqual(l.near, ['closed']);
  l = stood();
  l.link.message('example.org:443\n');
  assert.deepEqual(l.near, ['closed']);
  l = stood();
  l.link.message(line('example.org:443\n'));
  l.link.message(line('early'));
  await turn();
  assert.deepEqual(l.near, ['closed']);
  assert.deepEqual(l.far, []);
  // A link that breaks once made is let go; the page reads that as its end.
  l = await refused('example.org:443\n', (x) => { x.host().opened(); x.host().failed(ERR.REFUSED); });
  assert.deepEqual(l.near, [Uint8Array.of(0), 'closed']);
  assert.equal(held('u'), 0);
});

test('an account has so many links at once and no more; one let go makes room', async () => {
  const many = [];
  for (let i = 0; i < MOST; i++) { const l = stood('crowd'); l.link.message(line('example.org:443\n')); many.push(l); }
  await turn();
  assert.equal(held('crowd'), MOST);
  const over = stood('crowd');
  over.link.message(line('example.org:443\n'));
  await turn();
  assert.deepEqual(over.near, [Uint8Array.of(ERR.NOBUFS), 'closed']);
  assert.deepEqual(over.far, []);
  // Another account's are its own.
  const other = stood('alone');
  other.link.message(line('example.org:443\n'));
  await turn();
  assert.equal(held('alone'), 1);
  other.link.closed();
  // The page lets one go (its WebSocket closed): there is room for one.
  many[0].link.closed();
  assert.equal(held('crowd'), MOST - 1);
  const next = stood('crowd');
  next.link.message(line('example.org:443\n'));
  await turn();
  assert.deepEqual(next.far, ['open 93.184.216.34:443']);
  for (const l of [...many, next]) l.link.closed();
  assert.equal(held('crowd'), 0);
});

test('a link waits so long and no longer: for its first line, for the host, and with nothing moving on it', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  // No first line.
  let l = stood('slow');
  t.mock.timers.tick(FIRST_MS - 1);
  assert.deepEqual(l.near, []);
  t.mock.timers.tick(1);
  assert.deepEqual(l.near, ['closed']);
  // A host that does not answer: the box is told so, as a connect that timed out.
  l = stood('slow');
  l.link.message(line('example.org:443\n'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(l.far, ['open 93.184.216.34:443']);
  t.mock.timers.tick(OPEN_MS);
  assert.deepEqual(l.near, [Uint8Array.of(ERR.TIMEDOUT), 'closed']);
  assert.equal(l.far[1], 'close');
  // Made, and still: let go once nothing has moved for the time; every byte either way starts the time again.
  l = stood('slow');
  l.link.message(line('example.org:443\n'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  l.host().opened();
  t.mock.timers.tick(QUIET_MS - 1);
  l.host().bytes(line('x'));
  t.mock.timers.tick(QUIET_MS - 1);
  l.link.message(line('y'));
  t.mock.timers.tick(QUIET_MS - 1);
  assert.equal(l.near.at(-1) === 'closed', false);
  t.mock.timers.tick(1);
  assert.equal(l.near.at(-1), 'closed');
  assert.equal(held('slow'), 0);
  mock.timers.reset();
});

/** Sessions by their token or their cookie, as the Remote's sign-in would look them up. */
const auth = {api: {getSession: async ({headers}: {headers: Headers}) => {
  const named = headers.get('Authorization') === 'Bearer device-token' || headers.get('Cookie') === 'better-auth.session_token=page-cookie';
  return named ? {user: {id: 'mio', name: 'mio'}, session: {id: 's1', expiresAt: new Date(Date.now() + 3_600_000)}} : null;
}}} as unknown as Auth;
const APP = 'http://app.test';

test('a link is admitted to a session, from one of the app\'s own pages or by a device\'s token, and to nothing else', async () => {
  const ask = (headers: Record<string, string>, limiter?: {limit(o: {key: string}): Promise<{success: boolean}>}) =>
    admit(new Request(`http://remote.test${PATH}`, {headers}), {auth, origins: [APP], limiter});
  const status = async (headers: Record<string, string>) => { const r = await ask(headers); return r instanceof Response ? r.status : r.user; };
  const ws = {Upgrade: 'websocket'};
  // A page of the app's, with the session's cookie; a device, with its token and no Origin.
  assert.equal(await status({...ws, Origin: APP, Cookie: 'better-auth.session_token=page-cookie'}), 'mio');
  assert.equal(await status({...ws, Authorization: 'Bearer device-token'}), 'mio');
  // Not a WebSocket; no one; a session nobody has.
  assert.equal(await status({Origin: APP, Cookie: 'better-auth.session_token=page-cookie'}), 426);
  assert.equal(await status({...ws, Origin: APP}), 401);
  assert.equal(await status({...ws, Origin: APP, Cookie: 'better-auth.session_token=made-up'}), 401);
  assert.equal(await status({...ws, Authorization: 'Bearer made-up'}), 401);
  // A page elsewhere, which a browser would send the cookie for: its Origin is not the app's. And the cookie with no Origin is no browser's.
  assert.equal(await status({...ws, Origin: 'http://elsewhere.test', Cookie: 'better-auth.session_token=page-cookie'}), 403);
  assert.equal(await status({...ws, Origin: 'null', Cookie: 'better-auth.session_token=page-cookie'}), 403);
  assert.equal(await status({...ws, Cookie: 'better-auth.session_token=page-cookie'}), 403);
  assert.equal(await status({...ws, Origin: 'http://elsewhere.test', Authorization: 'Bearer device-token'}), 403);
  // Asked too often from one address: refused at the edge, by the address it came from.
  const counted: string[] = [];
  const r = await ask({...ws, Authorization: 'Bearer device-token', 'CF-Connecting-IP': '203.0.113.9'}, {limit: async ({key}) => { counted.push(key); return {success: false}; }});
  assert.equal(r instanceof Response && r.status, 429);
  assert.deepEqual(counted, ['203.0.113.9']);
});

test('a link carried on this machine, end to end: a WebSocket in, a TCP connection out, bytes both ways, each side\'s end told to the other', async () => {
  // A host: says hello, echoes in capitals, and when the page has sent its last says so and ends.
  const sockets = new Set<Socket>();
  const host = tcpServer({allowHalfOpen: true}, (s) => {
    sockets.add(s);
    s.write('hello\n');
    s.on('data', (b: Buffer) => s.write(b.toString().toUpperCase()));
    s.on('end', () => s.end('bye\n'));
  });
  await new Promise<void>((go) => host.listen(0, '127.0.0.1', go));
  const hostPort = (host.address() as {port: number}).port;
  const server = httpServer((_req, res) => { res.writeHead(404).end(); });
  const place = `127.0.0.1:${hostPort}`;
  links(server, 'http://127.0.0.1', {auth, origins: [APP], open: tcp, rule: also([place]),
    resolve: async (name) => (name === 'selftest.test' ? ['127.0.0.1'] : [])});
  await new Promise<void>((go) => server.listen(0, '127.0.0.1', go));
  const url = `ws://127.0.0.1:${(server.address() as {port: number}).port}${PATH}`;
  /** A link asked as a page's relay asks it: every message that came, until it closed. */
  const linked = (first: string, headers: Record<string, string>, say: (ws: WebSocket, got: Uint8Array[]) => void) => new Promise<{got: Uint8Array[]; opened: boolean}>((done) => {
    const ws = new WebSocket(url, {headers} as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const got: Uint8Array[] = [];
    let opened = false;
    ws.onopen = () => { opened = true; ws.send(line(first)); };
    ws.onmessage = ({data}) => { got.push(new Uint8Array(data as ArrayBuffer)); say(ws, got); };
    ws.onclose = () => done({got, opened});
    // (node's own WebSocket says a handshake that failed with this alone, and no close after it)
    ws.onerror = () => done({got, opened});
  });
  try {
    const page = {Origin: APP, Cookie: 'better-auth.session_token=page-cookie'};
    const a = await linked(`selftest.test:${hostPort}\n`, page, (ws, got) => {
      if (got.length === 2) ws.send(line('abc'));
      if (text(got.at(-1)!) === 'ABC') ws.send(new Uint8Array(0));
    });
    assert.deepEqual(a.got.map((b) => text(b)), ['\0', 'hello\n', 'ABC', 'bye\n', '']);
    // Refused by the rule, in its one byte; a port nothing listens on, as the host refuses it.
    assert.deepEqual((await linked('selftest.test:80\n', page, () => {})).got, [Uint8Array.of(ERR.ACCES)]);
    assert.deepEqual((await linked('127.0.0.1:443\n', page, () => {})).got, [Uint8Array.of(ERR.ACCES)]);
    const shut = tcpServer(); await new Promise<void>((go) => shut.listen(0, '127.0.0.1', go));
    const dead = (shut.address() as {port: number}).port; await new Promise((go) => shut.close(go));
    const s2 = httpServer();
    links(s2, 'http://127.0.0.1', {auth, origins: [APP], open: tcp, rule: also([`127.0.0.1:${dead}`]), resolve: async () => []});
    await new Promise<void>((go) => s2.listen(0, '127.0.0.1', go));
    const ws2 = new WebSocket(`ws://127.0.0.1:${(s2.address() as {port: number}).port}${PATH}`, {headers: page} as unknown as string[]);
    ws2.binaryType = 'arraybuffer';
    const refused = await new Promise<Uint8Array[]>((done) => { const got: Uint8Array[] = []; ws2.onopen = () => ws2.send(line(`127.0.0.1:${dead}\n`)); ws2.onmessage = ({data}) => got.push(new Uint8Array(data as ArrayBuffer)); ws2.onclose = () => done(got); });
    assert.deepEqual(refused, [Uint8Array.of(ERR.REFUSED)]);
    await new Promise((go) => s2.close(go));
    // Not admitted: no WebSocket is made at all.
    assert.equal((await linked(`selftest.test:${hostPort}\n`, {Origin: 'http://elsewhere.test', Cookie: page.Cookie}, () => {})).opened, false);
    assert.equal((await linked(`selftest.test:${hostPort}\n`, {Origin: APP}, () => {})).opened, false);
    assert.equal(held('mio'), 0);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((go) => host.close(go));
    server.closeAllConnections();
    await new Promise((go) => server.close(go));
  }
});
