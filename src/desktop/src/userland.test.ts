import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {digest} from './fetch.ts';
import {unpack} from './userland.ts';

const pack = (index: object, blob: Uint8Array) => {
  const json = Buffer.from(JSON.stringify(index));
  const head = Buffer.alloc(12);
  head.write('L3BUNDLE', 0, 'latin1');
  head.writeUInt32LE(json.length, 8);
  return new Uint8Array(gzipSync(Buffer.concat([head, json, blob])));
};

test('a bundle unpacks into its index and the bytes it points at', async () => {
  const {index, bytes} = await unpack(pack({files: [{path: '/etc/x', at: 2, size: 3}]}, Buffer.from('abcdefg')));
  const f = (index.files as {at: number; size: number}[])[0];
  assert.equal(new TextDecoder().decode(bytes.subarray(f.at, f.at + f.size)), 'cde');
});

test('what is not a bundle is refused', async () => {
  await assert.rejects(unpack(new Uint8Array(gzipSync(Buffer.from('not a bundle at all')))), /not a bundle/);
});

// The built l3, when there is one: what l3.json says is what the bundle is.
const at = new URL('../public/userland/', import.meta.url);
test('l3.json names the bundle beside it, and the bundle holds the root', {skip: !existsSync(new URL('l3.json', at))}, async () => {
  const about = JSON.parse(readFileSync(new URL('l3.json', at), 'utf8'));
  const packed = new Uint8Array(readFileSync(new URL(about.bundle.path, at)));
  assert.equal(packed.length, about.bundle.size);
  assert.equal(await digest(packed), about.bundle.sha256);
  const {index, bytes} = await unpack(packed);
  const files = index.files as {path: string; at: number; size: number}[];
  const file = (p: string) => { const f = files.find((x) => x.path === p)!; return bytes.subarray(f.at, f.at + f.size); };
  assert.equal(await digest(file('/bin/busybox')), about.base.sha256);
  assert.equal(await digest(file('/bin/l3')), about.l3.sha256);
  assert.match(new TextDecoder().decode(file('/etc/os-release')), new RegExp(`VERSION_ID=${about.root.version}`));
  assert.equal((index.links as unknown[]).length, about.base.applets);
});
