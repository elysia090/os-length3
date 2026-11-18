// Artifact locations shared by Sods' runtime tests, not by its runtime.
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sods = fileURLToPath(new URL('../../', import.meta.url));
const userlandDir = process.env.SODS_TEST_USERLAND_DIR;
const stage = userlandDir === undefined ? null : resolve(userlandDir);
const userland = stage === null ? null : {
  busybox: join(stage, 'busybox'),
  translated: join(stage, 'busybox.wasm'),
  translator: join(stage, 'sods.wasm'),
};
if (userland && !Object.values(userland).every(path => existsSync(path))) throw new Error(`Incomplete Sods userland fixture: ${stage}`);
export const hasUserland = userland !== null;
export function requireUserland() {
  if (!userland) throw new Error('Set SODS_TEST_USERLAND_DIR to a staged BusyBox fixture directory');
  return userland;
}

export const nativeTranslator = resolve(process.env.SODS_NATIVE ?? join(sods, 'target/release/sods'));
export const translatorWasm = resolve(process.env.SODS_TRANSLATOR_WASM ?? join(sods, 'target/wasm32-unknown-unknown/release/sods.wasm'));
