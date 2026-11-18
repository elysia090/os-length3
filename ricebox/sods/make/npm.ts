#!/usr/bin/env node
// Local, private package of the existing four sods entrances. No artifact fetch,
// install hook, ricebox dependency or new runtime. Node 24 is the build tool.
import {packageTypeScript} from '../../toolchain/package-typescript.ts';
import {writeFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error('usage: node ricebox/sods/make/npm.ts NEW_DIRECTORY');
if (existsSync(out)) throw new Error(`Refusing to replace an existing directory: ${out}`);
const entries = ['translate', 'linux', 'host', 'targets'];
packageTypeScript(root, out, entries.map(entry => `runtime/${entry}.ts`), path => {
  if (!path.startsWith('runtime/') || !path.endsWith('.ts')) throw new Error(`Dependency outside sods runtime: ${path}`);
});
writeFileSync(join(out, 'package.json'), JSON.stringify({name:'sods', version:'0.0.0-local', private:true, type:'module',
  engines:{node:'>=24'}, exports:Object.fromEntries(entries.map(name=>[`./${name}`,{types:`./runtime/${name}.ts`,import:`./runtime/${name}.js`}])), files:['runtime','README.md']}, null, 2)+'\n');
writeFileSync(join(out, 'README.md'), `# sods (local package)\n\nFour entrances: sods/translate, sods/linux, sods/host and sods/targets.\nNo ricebox, OCI bundle, package registry, guest root or product is required.\nProvide a trusted translator artifact to loadTranslator. Provide a separately selected trusted file-store artifact to prepareFileStore/loadFileScope when Rust-owned regular-file payloads are wanted; scope.createVfs() opts into path-created regular payloads for a finite-lifetime tree; normal Vfs, memfd and anonymous mappings are unchanged. Unlinked/replaced inodes remain held until scope disposal, so this is not automatic reclamation for long-lived kernels. Artifacts are not bundled or downloaded.\nThe caller owns acquisition/integrity, the Vfs, input/output policy, kernel completion and final scope disposal. A scope must outlive all kernels, mappings and embedding references using its files. maxFileBytes limits each logical file, not total memory.\nFor a finite Node caller, keep passOn disabled and do not expose the raw graph to other users. Await spawn, copy and acknowledge the wanted results, and check execution/cleanup failures separately. For RemoteKernel, close only requests termination: await snapshotWorkerStops and require no unconfirmed Workers or failures before explicit scope disposal. A failedPreparations root blocks that disposal. An exit code (including zero) is not a Worker-stop or sink-completion receipt. Missing evidence means retain the scope, not retry arbitrary cleanup. This is a caller-owned finite example, not automatic long-lived graph reclamation.\nBrowser use needs a module-Worker-aware bundler and appropriate shared-memory headers for parallel execution. Package checks are not evidence of browser compatibility.\nThe native translator CLI and runtime/run.ts development runner are not npm exports. Target verification labels describe repository evidence, not tests of this package on every target.\n`);
