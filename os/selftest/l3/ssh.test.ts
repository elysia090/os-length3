import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {connect, createServer} from 'node:net';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {remote, type Ran} from './harness.ts';

// SSH into a repo's Prompt, as far as it shows from outside the device: who
// the listener lets reach its port in each scope, what it says when reached,
// and what the Remote learns of it (that it listens, and to whom; never an
// address, a port or a repo). The sessions themselves need a root, which a
// test device has not; README.md (SSH) has the run with one.
//
//   npm run selftest:l3

const r = await remote();
const kai = await r.browser('Kai Selftest');
const d = r.device();
assert.equal((await d.login(kai)).code, 0);

/** A port nothing listens on now. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const p = (s.address() as {port: number}).port; s.close(() => resolve(p)); });
});
/** What a TCP connection to `host`:`port` meets: the first line it is sent, or why it got none (ECONNREFUSED: nothing listens there). */
const reach = (host: string, port: number) => new Promise<string>((resolve) => {
  const c = connect({host, port, timeout: 3000});
  let got = '';
  c.on('data', (b) => { got += b.toString('latin1'); if (got.includes('\n')) { c.destroy(); resolve(got.split('\n')[0].replace(/\r$/, '')); } });
  c.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  c.on('timeout', () => { c.destroy(); resolve('timeout'); });
  c.on('close', () => resolve(got || 'closed'));
});
const ok = (x: Ran) => { assert.equal(x.code, 0, `${x.out}${x.err}`); return x; };
/**
 * Whether the same network too listens on an address of an interface, as the listener decides (core ssh::listened):
 * a LAN's (RFC 1918, link-local) on any interface but a bridge or a container's, or 100.64/10 on a VPN's.
 */
const lanV4 = (a: string) => /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const sharedV4 = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);
const bridge = (n: string) => /^(docker|br-|virbr|veth|ve-|vb-|lxcbr|lxdbr|incusbr|cni|flannel|cali|cilium_|podman|vmnet|vboxnet)/.test(n);
const vpn = (n: string) => /^(tailscale|wg|zt|nebula|wt|CloudflareWARP)/.test(n);
const v4 = Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((i) => i.family === 'IPv4').map((i) => ({name, addr: i.address})));
const listened = new Set(v4.filter((i) => !bridge(i.name) && (lanV4(i.addr) || (sharedV4(i.addr) && vpn(i.name)))).map((i) => i.addr));
const priv = (a: string) => listened.has(a);
const others = [...new Set(v4.map((i) => i.addr).filter((a) => !a.startsWith('127.')))];

interface Here { on: boolean; scope: string; port: number; bound: string[]; interfaces: {addr: string; interface: string}[]; destinations: string[]; fingerprint: string; keys: number }
const here = () => ok(d.l3(['address', '--json'])).json as Here;

test('SSH: on from this device only, then the same network too, then back; the Remote hears the scope alone; a page turns it off', {skip: spawnSync('ssh-keygen', ['-?']).error ? 'no ssh-keygen' : false}, async () => {
  const port = await freePort();
  (d.env as Record<string, string>).LENGTH3_SSH_PORT = String(port);
  // The Remote asked every half second, not every 30 s: an off said on a page is heard within the test's wait.
  (d.env as Record<string, string>).LENGTH3_SSH_BEAT_MS = '500';
  ok(d.l3(['repo', 'new', 'notes', '-t', 'empty']));
  const key = join(d.home, 'key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'kai@selftest', '-f', key]).status, 0);
  ok(d.l3(['dotfile', 'write', '.authorized_keys'], readFileSync(`${key}.pub`, 'utf8')));
  try {
    // On, with no scope said: this device only, at first.
    const on = ok(d.l3(['address', 'ssh', 'on']));
    assert.match(on.out, /^SSH is on\nFrom this device only \(127\.0\.0\.1\): no other PC finds it\n1 key let in \(\.authorized_keys\)\nHost key SHA256:[A-Za-z0-9+/]{43} \(ssh shows it/);
    assert.match(on.out, new RegExp(`\\nssh -p ${port} notes@127\\.0\\.0\\.1\\n$`));
    let h = here();
    assert.deepEqual([h.on, h.scope, h.port, h.keys, h.destinations], [true, 'device', port, 1, [`ssh -p ${port} notes@127.0.0.1`]]);
    assert.ok(h.bound.every((a) => a === '127.0.0.1' || a === '::1') && h.bound.includes('127.0.0.1'), h.bound.join());
    // l3 address: the destinations on standard output, one a line; what to check of them on standard error.
    const shown = ok(d.l3(['address']));
    assert.equal(shown.out, `ssh -p ${port} notes@127.0.0.1\n`);
    assert.match(shown.err, /^l3: From this device only \(127\.0\.0\.1\)[^\n]*\nl3: 1 key let in \(\.authorized_keys\)\nl3: Host key SHA256:/);
    // Reached on loopback it says the protocol and a plain name; on any other address of this host nothing listens at all.
    assert.equal(await reach('127.0.0.1', port), 'SSH-2.0-length3');
    for (const a of others) assert.equal(await reach(a, port), 'ECONNREFUSED', a);
    // The Remote hears that this device listens, and to whom: no address, port or repo.
    const seen = (await r.api(kai, 'GET', '/v1/ssh')).json as {device: string; scope: string}[];
    assert.deepEqual(seen.map((s) => s.scope), ['device']);
    for (const never of [String(port), '127.0.0.1', 'notes', ...others]) assert.ok(!JSON.stringify(seen).includes(never), never);

    // The same network too: each private address of this host besides, and never a public one.
    const wide = ok(d.l3(['address', 'ssh', 'on', 'network']));
    assert.match(wide.out, /^SSH stays on; who may connect changed\nFrom PCs on the same network too/);
    h = here();
    assert.equal(h.scope, 'network');
    assert.deepEqual(h.bound.filter((a) => a !== '127.0.0.1' && a !== '::1').sort(), others.filter(priv).sort());
    // Each named with its interface, as l3 address and the card say it.
    assert.deepEqual(h.interfaces.map((t) => `${t.interface} ${t.addr}`).sort(), v4.filter((i) => priv(i.addr)).map((i) => `${i.name} ${i.addr}`).sort());
    for (const a of others) assert.equal(await reach(a, port), priv(a) ? 'SSH-2.0-length3' : 'ECONNREFUSED', a);
    // The Remote hears the new scope as soon as it is chosen.
    for (let i = 0; i < 100 && ((await r.api(kai, 'GET', '/v1/ssh')).json as {scope: string}[])[0]?.scope !== 'network'; i++) await new Promise((w) => setTimeout(w, 100));
    assert.deepEqual(((await r.api(kai, 'GET', '/v1/ssh')).json as {scope: string}[]).map((s) => s.scope), ['network']);
    // Kept on this device: on, said again with no scope, stays as chosen; then back to this device only.
    assert.equal((ok(d.l3(['address', 'ssh', 'on', '--json'])).json as {ssh: Here}).ssh.scope, 'network');
    ok(d.l3(['address', 'ssh', 'on', 'device']));
    h = here();
    assert.equal(h.scope, 'device');
    assert.ok(h.bound.every((a) => a === '127.0.0.1' || a === '::1'), h.bound.join());
    for (const a of others) assert.equal(await reach(a, port), 'ECONNREFUSED', a);

    // A page cannot turn it on, and can turn it off: the listener hears so within a beat and the port closes.
    const id = ((await r.api(kai, 'GET', '/v1/ssh')).json as {device: string}[])[0].device;
    assert.equal((await r.api(kai, 'PUT', '/v1/ssh/this', {scope: 'network'})).status, 403);
    assert.equal((await r.api(kai, 'POST', `/v1/ssh/${id}/off`)).status, 200);
    let off: Ran = d.l3(['address']);
    for (let i = 0; i < 150 && off.code !== 5; i++) { await new Promise((w) => setTimeout(w, 100)); off = d.l3(['address']); }
    assert.equal(off.code, 5, off.err);
    assert.equal(await reach('127.0.0.1', port), 'ECONNREFUSED');
  } finally {
    d.l3(['address', 'ssh', 'off']);
  }
});
