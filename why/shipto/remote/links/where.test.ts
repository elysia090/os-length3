import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ERR, LINE, RULE, addressOf, also, asked, isName, isPublic, overHttps, where, type Address} from './where.ts';

const line = (text: string) => new TextEncoder().encode(text);

test('a first line is a name or an address in dots, a colon, a port and the end of the line, whole, and nothing else is one', () => {
  assert.deepEqual(asked(line('example.org:443\n')), {name: 'example.org', port: 443});
  assert.deepEqual(asked(line('93.184.216.34:22\n')), {address: [93, 184, 216, 34], port: 22});
  assert.deepEqual(asked(line(`${'a'.repeat(61)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}:65535\n`))?.port, 65535);
  for (const not of ['example.org:443', 'example.org\n', ':443\n', 'example.org:\n', 'example.org:0\n', 'example.org:65536\n', 'example.org:0443\n',
    'example.org:44 3\n', 'example.org:443\n\n', 'exa mple.org:443\n', 'example.org:443\r\n', 'Example.org:443\n', 'localhost:443\n', 'example..org:443\n',
    '-a.org:443\n', 'a-.org:443\n', 'a_b.org:443\n', '1.2.3:80\n', '1.2.3.4.5:80\n', '0x7f.0.0.1:80\n', '127.1:80\n', '256.1.1.1:80\n', '01.2.3.4:80\n',
    '[::1]:80\n', 'example.org:443\n#', `${'a'.repeat(64)}.org:443\n`, 'é.org:443\n', '']) {
    assert.equal(asked(line(not)), null, JSON.stringify(not));
  }
  // No line longer than cowboy writes one is read at all.
  assert.equal(asked(line(`${'a.'.repeat(130)}org:443\n`)), null);
  assert.equal(LINE, 260);
  assert.ok(isName('xn--bcher-kva.example'));
  assert.deepEqual(addressOf('0.0.0.0'), [0, 0, 0, 0]);
});

test('a public address is one in no block kept for something else, to the edge of each block', () => {
  const pub = (text: string) => isPublic(addressOf(text) as Address);
  for (const [first, last] of [['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'], ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'], ['192.0.0.0', '192.0.0.255'], ['192.0.2.0', '192.0.2.255'],
    ['192.88.99.0', '192.88.99.255'], ['192.168.0.0', '192.168.255.255'], ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'],
    ['203.0.113.0', '203.0.113.255'], ['224.0.0.0', '239.255.255.255'], ['240.0.0.0', '255.255.255.255']]) {
    assert.equal(pub(first), false, first);
    assert.equal(pub(last), false, last);
  }
  for (const yes of ['1.0.0.0', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '203.0.112.255', '203.0.114.0',
    '223.255.255.255', '93.184.216.34']) {
    assert.equal(pub(yes), true, yes);
  }
});

test('a link goes to a port of the three at a public address, a name by every address it has, and is dialled by the address judged', async () => {
  const asks: string[] = [];
  const dns = (table: Record<string, string[]>) => async (name: string) => { asks.push(name); if (!(name in table)) throw new Error('no'); return table[name]; };
  const to = async (text: string, table: Record<string, string[]> = {}) => where(asked(line(text))!, dns(table));
  assert.deepEqual(await to('93.184.216.34:443\n'), {address: '93.184.216.34'});
  assert.deepEqual(await to('example.org:22\n', {'example.org': ['93.184.216.34', '93.184.216.35']}), {address: '93.184.216.34'});
  // Not a port of the three: refused before anyone is asked the name.
  asks.length = 0;
  for (const port of [25, 8080, 3306, 23, 1]) assert.deepEqual(await to(`example.org:${port}\n`, {'example.org': ['93.184.216.34']}), {errno: ERR.ACCES});
  assert.deepEqual(asks, []);
  // An address that is not public, as it stands or behind a name; one such among a name's addresses refuses it whole.
  for (const a of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '198.18.0.16', '0.0.0.0']) {
    assert.deepEqual(await to(`${a}:80\n`), {errno: ERR.ACCES}, a);
    assert.deepEqual(await to('inside.example:80\n', {'inside.example': [a]}), {errno: ERR.ACCES}, a);
    assert.deepEqual(await to('both.example:80\n', {'both.example': ['93.184.216.34', a]}), {errno: ERR.ACCES}, a);
  }
  // A name with no address, one nobody answers for, and an answer that is no address.
  assert.deepEqual(await to('none.example:80\n', {'none.example': []}), {errno: ERR.HOSTUNREACH});
  assert.deepEqual(await to('gone.example:80\n'), {errno: ERR.HOSTUNREACH});
  assert.deepEqual(await to('odd.example:80\n', {'odd.example': ['2001:db8::1']}), {errno: ERR.HOSTUNREACH});
  assert.deepEqual([RULE.port(80), RULE.port(443), RULE.port(22), RULE.port(8443)], [true, true, true, false]);
});

test('a Remote on this machine may be told of places besides the rule, each one address at one port and no wider', async () => {
  const rule = also(['127.0.0.1:4567']);
  const dns = async (name: string) => (name === 'selftest.test' ? ['127.0.0.1'] : ['93.184.216.34']);
  assert.deepEqual(await where(asked(line('selftest.test:4567\n'))!, dns, rule), {address: '127.0.0.1'});
  assert.deepEqual(await where(asked(line('127.0.0.1:4567\n'))!, dns, rule), {address: '127.0.0.1'});
  assert.deepEqual(await where(asked(line('127.0.0.1:4568\n'))!, dns, rule), {errno: ERR.ACCES});
  assert.deepEqual(await where(asked(line('127.0.0.2:4567\n'))!, dns, rule), {errno: ERR.ACCES});
  assert.deepEqual(await where(asked(line('selftest.test:80\n'))!, dns, rule), {errno: ERR.ACCES});
  // The rule itself still holds beside them, and the place's port is no port for any other address.
  assert.deepEqual(await where(asked(line('example.org:443\n'))!, dns, rule), {address: '93.184.216.34'});
  assert.deepEqual(await where(asked(line('example.org:4567\n'))!, dns, rule), {errno: ERR.ACCES});
});

test('a name\'s addresses are asked over HTTPS once a minute a name: its A records and nothing else of the answer', async () => {
  let now = 1_000_000;
  const asks: string[] = [];
  const answers: Record<string, unknown> = {
    'example.org': {Status: 0, Answer: [{type: 5, data: 'cdn.example.net.'}, {type: 1, data: '93.184.216.34'}, {type: 1, data: '93.184.216.35'}]},
    'none.example': {Status: 3},
  };
  const f = (async (url: string | URL | Request) => {
    const name = new URL(String(url)).searchParams.get('name')!;
    asks.push(name);
    return name in answers ? Response.json(answers[name]) : new Response('', {status: 500});
  }) as typeof fetch;
  const resolve = overHttps(f, () => now);
  assert.deepEqual(await resolve('example.org'), ['93.184.216.34', '93.184.216.35']);
  assert.deepEqual(await resolve('example.org'), ['93.184.216.34', '93.184.216.35']);
  assert.deepEqual(await resolve('none.example'), []);
  assert.deepEqual(asks, ['example.org', 'none.example']);
  now += 60_001;
  await resolve('example.org');
  assert.deepEqual(asks, ['example.org', 'none.example', 'example.org']);
  // A resolver that does not answer is said, and nothing is kept of it.
  await assert.rejects(resolve('down.example'), /DNS 500/);
  await assert.rejects(resolve('down.example'), /DNS 500/);
});
