// Worker: Pyodide runs the Quotient Minimizer; Clang/WASM compiles and executes
// the pasted kernel.
//
// The split matters.  Everything that decides something — quotients, synthesis,
// lowering, verification — is Python, because that is where the engine lives and
// where it can be tested.  The one thing that must not be Python is *evaluating*
// the kernel over 2^16 inputs, so that is done by calling the compiled wasm.
//
// The UI thread stays responsive because all of this happens here.

import { ClangDriver, ClangUnavailable, evaluateWasm, readConfig } from './clang.js';
import { compile as compileVm, decodeArtifact } from './vm.js';

const PYODIDE_VERSIONS = [
  'https://cdn.jsdelivr.net/npm/pyodide@314.0.3/',
  'https://unpkg.com/pyodide@314.0.3/',
  'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/',
];

let pyodide = null;
let clang = null;
let clangConfig = null;
let clangDescription = null;
let manifest = null;
const runCache = new Map();
const RUN_CACHE_LIMIT = 8;

function post(type, payload) {
  self.postMessage(Object.assign({ type }, payload || {}));
}

function progress(message) {
  post('progress', { message });
}

// The compiler core and its resource filesystem dominate residency. Keep
// them in a child worker so the browser and Python/QM can remain alive while
// those WebAssembly memories are physically released after compilation.
const COMPILER_IDLE_MS = 15_000;
let compilerWorker = null;
let compilerIdleTimer = null;
let compilerRequest = 0;
const compilerPending = new Map();

function describeClang() {
  return clangDescription || clang.describe();
}

function disposeCompilerWorker() {
  if (compilerIdleTimer) clearTimeout(compilerIdleTimer);
  compilerIdleTimer = null;
  if (compilerWorker) compilerWorker.terminate();
  compilerWorker = null;
  for (const pending of compilerPending.values()) {
    pending.reject(new ClangUnavailable('compiler worker was released'));
  }
  compilerPending.clear();
}

function compilerError(raw) {
  const error = raw && raw.unavailable
    ? new ClangUnavailable(raw.message)
    : new Error((raw && raw.message) || 'compiler worker failed');
  if (raw && raw.stderr) error.stderr = raw.stderr;
  return error;
}

function ensureCompilerWorker() {
  if (compilerWorker) return compilerWorker;
  const worker = new Worker(new URL('./compile-worker.js', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event) => {
    const message = event.data || {};
    const pending = compilerPending.get(message.id);
    if (!pending) return;
    if (message.type === 'progress') {
      progress(message.message);
      return;
    }
    if (message.type !== 'result') return;
    compilerPending.delete(message.id);
    if (message.ok) {
      if (message.result && message.result.clang) {
        clangDescription = message.result.clang;
      }
      pending.resolve(message.result);
    } else {
      pending.reject(compilerError(message.error));
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'compiler worker failed');
    for (const pending of compilerPending.values()) pending.reject(error);
    compilerPending.clear();
    if (compilerWorker === worker) compilerWorker = null;
  };
  compilerWorker = worker;
  return worker;
}

async function callCompiler(action, payload = {}) {
  if (compilerIdleTimer) clearTimeout(compilerIdleTimer);
  compilerIdleTimer = null;
  const worker = ensureCompilerWorker();
  const id = ++compilerRequest;
  const result = await new Promise((resolve, reject) => {
    compilerPending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({
      id, action, config: clangConfig,
    }, payload));
  });
  compilerIdleTimer = setTimeout(disposeCompilerWorker, COMPILER_IDLE_MS);
  return result;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadPyodide_() {
  // This is a module worker, so the runtime is imported rather than pulled in
  // with importScripts, which module scopes do not have.
  let lastError = null;
  for (const indexURL of PYODIDE_VERSIONS) {
    try {
      progress(`loading Python runtime from ${new URL(indexURL).host}…`);
      const mod = await import(/* webpackIgnore: true */ `${indexURL}pyodide.mjs`);
      return await mod.loadPyodide({ indexURL });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    'no Pyodide build could be loaded (' +
      String((lastError && lastError.message) || lastError) + ')',
  );
}

async function installPackage() {
  manifest = await (await fetch('./qm-manifest.json', { cache: 'no-cache' })).json();
  progress(`installing ${manifest.files.length} engine modules…`);

  const root = '/home/pyodide/qm_pkg';
  pyodide.FS.mkdirTree(root);
  const seen = new Set();

  const texts = await Promise.all(
    manifest.files.map((rel) =>
      fetch(`${manifest.base}/${rel}`, { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
        return r.text();
      }),
    ),
  );

  manifest.files.forEach((rel, i) => {
    const path = `${root}/${rel}`;
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (!seen.has(dir)) {
      pyodide.FS.mkdirTree(dir);
      seen.add(dir);
    }
    pyodide.FS.writeFile(path, texts[i]);
  });

  pyodide.runPython(`
import sys
if '/home/pyodide/qm_pkg' not in sys.path:
    sys.path.insert(0, '/home/pyodide/qm_pkg')
import qm.browser as qmb
`);
}

async function boot(config) {
  // Boot only the engine needed to classify and minimize a paste.  The
  // compiler reserves the dominant working set and vm.wasm reserves 32 MiB of
  // linear memory; neither belongs in the initial resident set.  C compilation
  // starts clang on demand, and an executable artifact starts the VM on demand.
  clangConfig = config;
  clang = new ClangDriver(config);
  pyodide = await loadPyodide_();
  await installPackage();
  const capabilities = JSON.parse(pyodide.runPython('qmb.capabilities()'));
  post('ready', { capabilities, clang: describeClang() });
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

function callPython(fn, args) {
  const scope = pyodide.toPy({ args });
  try {
    pyodide.globals.set('_qm_args', scope);
    return pyodide.runPython(`qmb.${fn}(*_qm_args["args"])`);
  } finally {
    pyodide.globals.delete('_qm_args');
    scope.destroy();
  }
}

async function solve(request) {
  disposeExecutionWorker();
  const options = request.options;
  const optionsJson = JSON.stringify(options || {});

  // A paste may carry a `main` that drives the kernel. The minimizer must not
  // see it — `main` reads a stream rather than a domain, so minimizing it
  // would report the driver's function — and Run needs exactly the whole file.
  // Python splits it, once, so the two halves cannot disagree.
  const split = JSON.parse(callPython('split', [request.source]));
  const source = split.kernel;
  const hasMain = Boolean(split.has_main);

  // C enters through Clang; optimized assembly enters directly. Determine
  // which input this is before starting a compiler.
  const route = JSON.parse(callPython('route', [source]));
  if (route.kind === 'asm') {
    progress(`reading the ${route.dialect} listing…`);
    post('done', {
      has_main: hasMain,
      run_ready: false,
      result: JSON.parse(callPython('fallback', [source, optionsJson])),
    });
    return;
  }

  // --- Compile C with Clang --------------------------------------------
  let compiled = null;
  if (options.frontend !== 'cfront') {
    try {
      compiled = await compileWithClang(source, options, optionsJson);
    } catch (err) {
      if (err instanceof ClangUnavailable) {
        post('notice', {
          message:
            'Clang/WASM is not available, falling back to the built-in C ' +
            'subset frontend. ' + err.message,
        });
      } else {
        post('notice', { message: `Clang: ${err.message}` });
        if (err.stderr) post('compile-error', { stderr: err.stderr });
        post('done', {
          has_main: hasMain,
          result: {
            ok: false,
            stage: 'frontend',
            error: { message: err.message, text: err.stderr || err.message },
          },
        });
        return;
      }
    }
  }

  if (compiled) {
    if (compiled.planError) {
      const runReady = hasMain
        ? await prepareStandaloneMain(request.source) : false;
      post('done', {
        has_main: hasMain,
        run_ready: runReady,
        result: runReady
          ? standaloneMainResult(compiled.planError)
          : { ok: false, idle: compiled.idle, error: compiled.planError },
      });
      return;
    }
    progress('quotienting and synthesizing…');
    const enriched = JSON.stringify(Object.assign({}, options || {}, {
      function: compiled.plan.function,
      input_bits: compiled.plan.input_bits,
      output_bits: compiled.plan.output_bits,
      signature: compiled.plan.signature,
      other_functions: compiled.plan.other_functions,
      compile: { opt: ORACLE_OPT, toolchain: describeClang().title },
      toolchain: describeClang(),
    }));
    const result = JSON.parse(callPython('finish', [source, enriched,
                                                    compiled.table, '']));
    const runReady = hasMain && result.ok
      ? await prepareRunSnapshot(request.source) : false;
    post('done', {
      has_main: hasMain,
      run_ready: runReady,
      result,
    });
    return;
  }

  progress('extracting semantics with the built-in frontend…');
  const json = callPython('fallback', [source, optionsJson]);
  let result = JSON.parse(json);
  if (!result.ok && hasMain) {
    const directReady = await prepareStandaloneMain(request.source);
    if (directReady) result = standaloneMainResult(result.error);
  }
  const runReady = hasMain && result.ok
    ? (result.standalone_main || await prepareRunSnapshot(request.source))
    : false;
  post('done', { has_main: hasMain, run_ready: runReady, result });
}

function base64Bytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

function normalizeCompiledWasm(wasm, label) {
  const normalized = JSON.parse(callPython('normalize_wasm', [base64Bytes(wasm)]));
  if (!normalized.ok) throw new Error(`${label}: ${normalized.error}`);
  if (normalized.replaced) {
    progress(
      `QM ${label}: ${normalized.replaced} wasm bodies, `
      + `${normalized.saved_body_bytes} bytes removed…`,
    );
  }
  return decodeArtifact(normalized.wasm);
}

async function analyzeCompiledMain(source, optionsJson) {
  try {
    progress('compiling main to an explicit wasm state machine…');
    const prepared = callPython('prepare_state', [source || '']);
    const compiled = await callCompiler('wasm', {
      source: prepared, opt: ORACLE_OPT,
    });
    const wasm = normalizeCompiledWasm(compiled.wasm, 'main state machine');
    progress('closing the reachable main/VM states…');
    const report = JSON.parse(callPython(
      'stateful_wasm', [base64Bytes(wasm), 'main', optionsJson],
    ));
    if (!report.ok) {
      post('notice', {
        message: `state-machine frontend: ${report.error.message}`,
      });
    }
    return report;
  } catch (err) {
    const message = (err && err.stderr)
      ? err.stderr.split('\n')[0] : String((err && err.message) || err);
    post('notice', { message: `state-machine frontend: ${message}` });
    return { ok: false, exact: false, stage: 'state-compile',
             error: { message } };
  }
}

// Clang compiles once, to wasm32, and only so the kernel can be *evaluated*
// over its domain.  There was a second compile producing an x86 listing for a
// pane to show, with a target and an optimization level to choose; the pane is
// gone and so is the choice.  The oracle's level is fixed because nothing
// downstream depends on it: what QM analyses is the table, and -O3 and -O1
// compute the same function.
const ORACLE_OPT = '-O2';

async function compileWithClang(source, options, optionsJson) {
  progress('reading the function signature…');
  const plan = JSON.parse(callPython('plan', [source, optionsJson]));
  if (!plan.ok) {
    return { planError: plan.error, idle: Boolean(plan.idle) };
  }

  // What Clang actually compiles: includes stripped, the freestanding prelude
  // and the intrinsics the paste uses put in.  Python decides this so the
  // browser and the native path cannot disagree about it — handing the raw
  // text over is what made QM's own `_pdep_u64` output fail to compile.
  const prepared = callPython('prepare', [source]);

  progress(`clang ${ORACLE_OPT} → wasm32…`);
  const compiled = await callCompiler('wasm', {
    source: prepared, opt: ORACLE_OPT,
  });
  const wasm = normalizeCompiledWasm(compiled.wasm, 'kernel oracle');

  progress(`executing ${plan.values.length.toLocaleString()} inputs…`);
  const table = await evaluateWasm(
    wasm, plan.function, plan.values, plan.output_bits, plan.input_bits,
  );

  return { plan, table };
}

// ---------------------------------------------------------------------------
// Running the paste's own `main`
//
//     paste -> QM -> codec -> run
//
// `prepare_run` keeps `main`, globals and unrelated helpers, but replaces the
// selected kernel definition with a declaration. The kernel is therefore an
// *import*, and what answers it is the artifact — running `main` runs the
// minimized function rather than Clang's compilation of that function, which
// would be testing the compiler.
//
// `-nostdlib`, so the other two imports are one byte in and one byte out.
// ---------------------------------------------------------------------------

const RUNNER_IDLE_MS = 15_000;
let executionWorker = null;
let executionIdleTimer = null;
let executionRequest = 0;
let executionReady = null;
let executionReadyResolve = null;
const executionPending = new Map();

function disposeExecutionWorker() {
  if (executionIdleTimer) clearTimeout(executionIdleTimer);
  executionIdleTimer = null;
  if (executionWorker) executionWorker.terminate();
  executionWorker = null;
  if (executionReadyResolve) executionReadyResolve();
  executionReady = null;
  executionReadyResolve = null;
  for (const pending of executionPending.values()) {
    pending.resolve({ ok: false, error: 'execution worker was released' });
  }
  executionPending.clear();
}

function ensureExecutionWorker() {
  if (executionWorker) return executionWorker;
  const worker = new Worker(new URL('./run-worker.js', import.meta.url), {
    type: 'module',
  });
  executionReady = new Promise((resolve) => {
    executionReadyResolve = resolve;
  });
  worker.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === 'ready') {
      if (executionWorker === worker && executionReadyResolve) {
        executionReadyResolve();
        executionReadyResolve = null;
      }
      return;
    }
    const pending = executionPending.get(message.id);
    if (!pending) return;
    executionPending.delete(message.id);
    pending.resolve(message.result);
  };
  worker.onerror = (event) => {
    const error = event.message || 'execution worker failed';
    for (const pending of executionPending.values()) {
      pending.resolve({ ok: false, error });
    }
    executionPending.clear();
    if (executionWorker === worker) {
      executionWorker = null;
      if (executionReadyResolve) executionReadyResolve();
      executionReady = null;
      executionReadyResolve = null;
    }
  };
  executionWorker = worker;
  return worker;
}

async function primeExecutionWorker() {
  const worker = ensureExecutionWorker();
  const ready = executionReady;
  await ready;
  if (executionWorker !== worker) {
    throw new Error('execution standby failed to start');
  }
}

function releaseExecutionMemory() {
  // Termination is the deterministic way to release WebAssembly.Memory. Keep
  // only an empty module Worker warm afterwards; it has imported the tiny JS
  // wrappers but has not instantiated vm.wasm.
  disposeExecutionWorker();
  ensureExecutionWorker();
}

async function runInExecutionWorker(payload) {
  const started = performance.now();
  if (executionIdleTimer) clearTimeout(executionIdleTimer);
  const worker = ensureExecutionWorker();
  const ready = executionReady;
  await ready;
  if (executionWorker !== worker) {
    return {
      ok: false,
      error: 'execution worker failed to start',
      total_ms: performance.now() - started,
    };
  }
  const id = ++executionRequest;
  const result = await new Promise((resolve) => {
    executionPending.set(id, { resolve });
    worker.postMessage(Object.assign({ id, type: 'exec' }, payload));
  });
  executionIdleTimer = setTimeout(releaseExecutionMemory, RUNNER_IDLE_MS);
  if (result && typeof result === 'object') {
    result.total_ms = performance.now() - started;
  }
  return result;
}

function rememberRun(source, prepared) {
  runCache.delete(source);
  runCache.set(source, prepared);
  while (runCache.size > RUN_CACHE_LIMIT) {
    runCache.delete(runCache.keys().next().value);
  }
}

function standaloneMainResult(scalarError) {
  return {
    ok: true,
    standalone_main: true,
    scalar_error: scalarError || null,
    frontend: {
      frontend: { title: describeClang().title },
      function: { name: 'main', signature: 'main' },
      other_functions: [],
    },
    targets: [],
    primary_target: null,
    residual_freedom: 0,
    derivation: [],
    recognition: [],
    note: 'main runs as compiled wasm without requiring a scalar kernel',
  };
}

async function prepareStandaloneMain(source) {
  try {
    progress('compiling main to wasm…');
    const prepared = callPython('prepare_state', [source || '']);
    const compiled = await callCompiler('wasm', {
      source: prepared, opt: ORACLE_OPT,
    });
    const wasm = normalizeCompiledWasm(compiled.wasm, 'standalone main');
    rememberRun(source, { wasm, plan: null, artifact: null });
    await primeExecutionWorker();
    return true;
  } catch (err) {
    if (err && err.stderr) post('compile-error', { stderr: err.stderr });
    const message = (err && err.stderr)
      ? err.stderr.split('\n')[0] : String((err && err.message) || err);
    post('notice', { message: `main: ${message}` });
    return false;
  }
}

async function prepareRunSnapshot(source) {
  try {
    progress('preparing Run from the minimized artifact…');
    const driver = callPython('prepare_run', [source || '']);
    const compiled = await callCompiler('wasm', {
      source: driver, opt: ORACLE_OPT,
    });
    const wasm = normalizeCompiledWasm(compiled.wasm, 'Run driver');

    // Read these while this solve still owns qmb's exact minimized result.
    // A later solve in another tab must not replace this Run snapshot.
    const plan = JSON.parse(callPython('run_plan', []));
    const built = plan.ok ? JSON.parse(callPython('artifact', [''])) : null;
    if (!plan.ok || !built || !built.ok) {
      const error = (built && built.error) || plan.error || 'no artifact';
      throw new Error(typeof error === 'string' ? error : error.message);
    }
    const artifact = decodeArtifact(built.artifact);
    // Keep only compiled VM code in the analysis worker. A WebAssembly.Module
    // is cheaply cloned into each runner; its 32 MiB linear memory still
    // belongs exclusively to that disposable child Worker.
    const vmModule = await compileVm();
    rememberRun(source, { wasm, plan, artifact, vmModule });
    await primeExecutionWorker();
    return true;
  } catch (err) {
    const message = (err && err.stderr)
      ? err.stderr.split('\n')[0] : String((err && err.message) || err);
    post('notice', { message: `Run preparation: ${message}` });
    return false;
  }
}

async function execMain(msg) {
  const prepared = runCache.get(msg.source || '');
  if (!prepared) {
    return {
      ok: false,
      stale: true,
      error: 'Run snapshot expired; analysing this source again',
    };
  }
  rememberRun(msg.source || '', prepared);
  const { wasm, plan, artifact, vmModule } = prepared;
  return runInExecutionWorker({
    source: msg.source || '',
    stdin: msg.stdin == null ? '' : msg.stdin,
    wasm,
    plan,
    artifact,
    vmModule,
  });
}


// ---------------------------------------------------------------------------

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'boot') {
      await boot(msg.config || readConfig(msg.search));
    } else if (msg.type === 'solve') {
      await solve(msg);
    } else if (msg.type === 'exec') {
      const result = await execMain(msg);
      post('ran', { result });
    } else if (msg.type === 'analyze-main') {
      const result = await analyzeCompiledMain(
        msg.source || '', JSON.stringify(msg.options || {}),
      );
      post('state-machine', { result });
    } else if (msg.type === 'load-clang') {
      const result = await callCompiler('load');
      post('clang-state', { clang: result.clang || describeClang() });
    }
  } catch (err) {
    post('fatal', {
      message: String((err && err.message) || err),
      stack: err && err.stack ? String(err.stack) : null,
    });
  }
};
