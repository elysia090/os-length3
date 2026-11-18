// Artifact locations shared by Sods' runtime tests, not by its runtime.
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const sods = fileURLToPath(new URL('../../', import.meta.url));
const userlandDir = process.env.SODS_TEST_USERLAND_DIR;
const stage = resolve(userlandDir ?? fileURLToPath(new URL('../../../../target/userland/', import.meta.url)));
export const userland = {
  busybox: join(stage, 'busybox'),
  translated: join(stage, 'busybox.wasm'),
  translator: join(stage, 'sods.wasm'),
};
export const hasUserland = Object.values(userland).every(path => existsSync(path));
if (userlandDir !== undefined && !hasUserland) throw new Error(`Incomplete Sods userland fixture: ${stage}`);

export const nativeTranslator = resolve(process.env.SODS_NATIVE ?? join(sods, 'target/release/sods'));
export const translatorWasm = resolve(process.env.SODS_TRANSLATOR_WASM ?? join(sods, 'target/wasm32-unknown-unknown/release/sods.wasm'));
