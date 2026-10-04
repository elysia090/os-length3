import {checkStartup} from './startup-check.mjs';
import {diagnosticExtents} from './extent-reader.mjs';

self.onmessage = async ({data}) => {
  try {
    const fixture=data?.fixture ?? 'generated-startup';
    if (typeof fixture!=='string' || fixture.length>80 || !/^generated-startup(?:-[a-z0-9-]+)?$/.test(fixture))
      throw new Error('diagnostic fixture directory');
    const root=new URL(`./${fixture}/`,import.meta.url);
    const response=await fetch(new URL('manifest.json',root));
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.format !== 'bzimage-startup-diagnostic-v1') throw new Error('diagnostic manifest format');
    if (manifest.immutableImage && manifest.objects?.[5]?.bytes!==manifest.immutableImage.bytes)
      throw new Error('immutable image descriptor/object mismatch');
    const cache = new Map();
    const read = async name => {
      const row = manifest.files[name];
      if (!row || !/^[a-z0-9.-]+$/.test(name)) throw new Error('undeclared diagnostic fixture');
      if (!cache.has(name)) cache.set(name,(async () => {
        const response = await fetch(new URL(name,root));
        if (!response.ok) throw new Error(`fixture HTTP ${response.status}: ${name}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
        const hex = Array.from(digest,byte => byte.toString(16).padStart(2,'0')).join('');
        if (bytes.length !== row.bytes || hex !== row.sha256) throw new Error(`fixture integrity: ${name}`);
        return bytes;
      })());
      return cache.get(name);
    };
    const transport = diagnosticExtents(manifest.objects,root);
    const result = await checkStartup(read,await read('vm.wasm'),await read('wasm-compiler.wasm'),transport.read,
      {extended:data?.extended === true,onProgress:progress => self.postMessage(progress),
        immutableImage:manifest.immutableImage,
        decompression:JSON.parse(new TextDecoder().decode(await read('boot.decompression.json')))});
    self.postMessage({...result,secureContext:self.isSecureContext,isolated:self.crossOriginIsolated,
      fixtureIntegrity:'local diagnostic SHA-256; not signed production admission',
      objectTransport:transport.stats,
      sourceReceipt:new TextDecoder().decode(await read('source.sha256')).trim().split('\n')});
  } catch (error) {
    self.postMessage({format:'browser-bzimage-startup-v1',status:'fail',linuxBoot:'not-achieved',
      error:error.message,stack:error.stack,diagnostic:error.diagnostic});
  }
};
