// Direct, lazy Clang/LLVM compiler-core driver.
//
// Only the multi-call llvm.core.wasm module and its standard resource tar are
// downloaded. The generated @yowasp/clang JavaScript bundle and its three
// component-model adapter modules are not used.

import { MemoryFileSystem, parseTar, WasiExit, WasiPreview1 } from '../wasi-preview1.js';

const DEFAULT_VERSION = '22.0.0-git20542-10';
const DEFAULT_HASHES = {
  core: '24fbed474c7b5b4968fd73fc4827440b93fb351c1b6264516130300eff3e7bf5',
  resources: '79eef0c336fe55cf03ff8f5b42b784c8168f929a3603138b2c6301f4601e4c86',
};
const CDNS = [
  (version, file) => `https://cdn.jsdelivr.net/npm/@yowasp/clang@${version}/gen/${file}`,
  (version, file) => `https://unpkg.com/@yowasp/clang@${version}/gen/${file}`,
];

export const info = {
  name: 'compiler-core',
  title: 'Clang/LLD compiler core',
  package: '@yowasp/clang',
  version: DEFAULT_VERSION,
  approximateBytes: 75532134 + 29665280,
  listingTriple: null,
  listingIsa: 'wasm32',
  note: 'the compiler core and standard resources are fetched directly on the first compile',
};

let assets = null;
let loading = null;

function config() {
  const global = globalThis.QM_CLANG || {};
  return {
    version: global.compilerVersion || global.yowaspVersion || DEFAULT_VERSION,
    coreUrl: global.compilerCoreUrl || null,
    resourcesUrl: global.compilerResourcesUrl || null,
    coreHash: global.compilerCoreSha256 || null,
    resourcesHash: global.compilerResourcesSha256 || null,
  };
}

async function fetchBytes(url, label, onProgress, expectedHash = null) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !onProgress) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyHash(bytes, label, expectedHash);
    return bytes;
  }

  const reader = response.body.getReader();
  // Fetch exposes decoded bytes. A compressed response can retain the encoded
  // Content-Length, so only use it as an allocation size when no content
  // encoding is present.
  const allocated = total && !response.headers.get('content-encoding')
    ? new Uint8Array(total) : null;
  const chunks = allocated ? null : [];
  let length = 0;
  let lastAmount = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (allocated) allocated.set(value, length);
    else chunks.push(value);
    length += value.length;
    const amount = total
      ? `${Math.min(100, Math.floor((100 * length) / total / 5) * 5)}%`
      : `${Math.floor(length / 4194304) * 4} MiB`;
    if (amount !== lastAmount) {
      lastAmount = amount;
      onProgress(`fetching ${label} ${amount}`);
    }
  }
  let bytes = allocated;
  if (!bytes || length !== bytes.length) {
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks || [allocated.subarray(0, length)]) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  await verifyHash(bytes, label, expectedHash);
  return bytes;
}

async function verifyHash(bytes, label, expectedHash) {
  if (!expectedHash) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expectedHash.toLowerCase()) throw new Error(`${label}: SHA-256 mismatch`);
}

async function load(onProgress) {
  if (assets) return assets;
  if (loading) return loading;
  const { version, coreUrl, resourcesUrl, coreHash, resourcesHash } = config();
  const pinnedDefaults = !coreUrl && !resourcesUrl && version === DEFAULT_VERSION;
  const candidates = coreUrl || resourcesUrl
    ? [[
        coreUrl || CDNS[0](version, 'llvm.core.wasm'),
        resourcesUrl || CDNS[0](version, 'llvm-resources.tar'),
      ]]
    : CDNS.map((cdn) => [cdn(version, 'llvm.core.wasm'), cdn(version, 'llvm-resources.tar')]);

  loading = (async () => {
    let lastError = null;
    for (const [candidateCore, candidateResources] of candidates) {
      try {
        if (onProgress) onProgress('loading the compiler core and standard resources…');
        const [coreBytes, tarBytes] = await Promise.all([
          fetchBytes(candidateCore, 'compiler core', onProgress,
                     coreHash || (pinnedDefaults ? DEFAULT_HASHES.core : null)),
          fetchBytes(candidateResources, 'compiler resources', onProgress,
                     resourcesHash || (pinnedDefaults ? DEFAULT_HASHES.resources : null)),
        ]);
        const [module, resourceNodes] = await Promise.all([
          WebAssembly.compile(coreBytes),
          Promise.resolve(parseTar(tarBytes, '/usr')),
        ]);
        assets = { module, resourceNodes };
        return assets;
      } catch (error) {
        lastError = error;
      }
    }
    loading = null;
    throw new Error(`could not load compiler core ${version}: ${lastError?.message || lastError}`);
  })();
  return loading;
}

function parseCommands(text) {
  const commands = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(' "')) continue;
    const command = Array.from(
      line.matchAll(/ (?:([^ "\n]+)|"((?:[^"\\$]|\\["\\$])*)")/g),
      (match) => match[1] ?? match[2].replaceAll(/\\["$\\]/g, (item) => item[1]),
    );
    if (command.length) commands.push(command);
  }
  return commands;
}

async function runCore(module, fs, args, output) {
  const host = new WasiPreview1({
    args,
    fs,
    env: { PATH: '/usr/bin', PWD: '/' },
    stdout: (bytes) => output.stdout.push(bytes),
    stderr: (bytes) => output.stderr.push(bytes),
  });
  const instance = await WebAssembly.instantiate(module, host.imports);
  host.setMemory(instance.exports.memory);
  try {
    instance.exports._start();
    return { status: 0, host };
  } catch (error) {
    if (error instanceof WasiExit) return { status: error.code, host };
    throw error;
  }
}

function joined(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Compile with already loaded assets. Exported so the direct host can be regression-tested. */
export async function compileWithAssets(module, resourceNodes, args, files, options = {}) {
  const fs = new MemoryFileSystem(resourceNodes);
  for (const [name, contents] of Object.entries(files || {})) {
    const path = `/${name.replace(/^\/+/, '')}`;
    fs.writeFile(path, typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);
  }

  const planOutput = { stdout: [], stderr: [] };
  const plan = await runCore(module, fs, [args[0], '-###', ...args.slice(1)], planOutput);
  const planText = new TextDecoder().decode(joined([...planOutput.stdout, ...planOutput.stderr]));
  if (plan.status !== 0) {
    if (options.stderr) options.stderr(new TextEncoder().encode(planText));
    return { status: plan.status, stderr: planText, files: {} };
  }
  const commands = parseCommands(planText);
  if (!commands.length) throw new Error('clang produced no executable cc1/linker commands');

  const output = { stdout: [], stderr: [] };
  for (const command of commands) {
    const result = await runCore(module, fs, command, output);
    if (result.status !== 0) {
      const stderr = new TextDecoder().decode(joined(output.stderr));
      if (options.stderr) options.stderr(new TextEncoder().encode(stderr));
      return { status: result.status, stderr, files: {} };
    }
  }

  const produced = {};
  for (const [path, node] of fs.nodes) {
    if (parentName(path) === '/' && node.type === 'file') produced[path.slice(1)] = node.data.slice();
  }
  const stderr = new TextDecoder().decode(joined(output.stderr));
  if (stderr && options.stderr) options.stderr(new TextEncoder().encode(stderr));
  return { status: 0, stderr, files: produced };
}

function parentName(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export async function init(onProgress) {
  await load(onProgress);
  return Object.assign({}, info, { version: config().version });
}

export async function compile(args, files, onProgress) {
  const loaded = await load(onProgress);
  return compileWithAssets(loaded.module, loaded.resourceNodes, ['clang', ...args], files, {});
}
