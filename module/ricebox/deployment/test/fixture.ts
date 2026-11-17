import type {TestContext} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {packOf} from '../../distribution/pack.ts';

export function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'ricebox-assets-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'blobs')); mkdirSync(join(root, 'packs'));
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const blob = (text: string) => { const bytes = Buffer.from(text), sha256 = hash(bytes); const path = `blobs/${sha256}.bin`; writeFileSync(join(root, path), bytes); return {path, sha256, size: bytes.length}; };
  const translator = blob('translator'), muk = blob('maker');
  const pack = packOf([Buffer.from('file contents')], b => createHash('sha256').update(b).digest());
  writeFileSync(join(root, 'packs', pack.name), pack.bytes);
  const index = {sha256: 'root', version: '0.0.1', translator, translations: [], packs: [{name:pack.name,bytes:pack.bytes.length}], files: [{pack:0,at:pack.at[0],len:13}]};
  const bytes = Buffer.from(JSON.stringify(index)), sha256 = hash(bytes), path = `index-${sha256}.json`;
  writeFileSync(join(root, path), bytes);
  writeFileSync(join(root, 'webroot.json'), JSON.stringify({sha256:'root', version:'0.0.1', index: {path, sha256, size:bytes.length}}));
  writeFileSync(join(root, 'muk.json'), JSON.stringify(muk));
  writeFileSync(join(root, '.env'), 'must never be deployed');
  return {root, translator, pack};
}

