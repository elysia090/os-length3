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
import { decodeArtifact, evaluate as runArtifact } from './vm.js';

const PYODIDE_VERSIONS = [
  'https://cdn.jsdelivr.net/npm/pyodide@314.0.3/',
  'https://unpkg.com/pyodide@314.0.3/',
  'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/',
];

let pyodide = null;
let clang = null;
let manifest = null;

function post(type, payload) {
  self.postMessage(Object.assign({ type }, payload || {}));
}

function progress(message) {
  post('progress', { message });
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
  pyodide = await loadPyodide_();
  await installPackage();

  clang = new ClangDriver(config);
  const capabilities = JSON.parse(pyodide.runPython('qmb.capabilities()'));
  post('ready', { capabilities, clang: clang.describe() });
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
  const { source, options } = request;
  const optionsJson = JSON.stringify(options || {});

  // SPEC §2 has two arrows into QM: C through Clang, and optimized assembly
  // straight in.  Ask which one this paste is before starting a compiler.
  const route = JSON.parse(callPython('route', [source]));
  if (route.kind === 'asm') {
    progress(`reading the ${route.dialect} listing…`);
    post('done', {
      result: JSON.parse(callPython('fallback', [source, optionsJson])),
    });
    return;
  }

  // --- SPEC §2: compile with Clang -------------------------------------
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
    progress('quotienting and synthesizing…');
    const enriched = JSON.stringify(Object.assign({}, options || {}, {
      function: compiled.plan.function,
      input_bits: compiled.plan.input_bits,
      output_bits: compiled.plan.output_bits,
      signature: compiled.plan.signature,
      other_functions: compiled.plan.other_functions,
      compile: { opt: ORACLE_OPT, toolchain: clang.describe().title },
      toolchain: clang.describe(),
    }));
    post('done', {
      result: JSON.parse(callPython('finish', [source, enriched,
                                               compiled.table, ''])),
    });
    return;
  }

  progress('extracting semantics with the built-in frontend…');
  const json = callPython('fallback', [source, optionsJson]);
  post('done', { result: JSON.parse(json) });
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
    const err = new Error(plan.error.text || plan.error.message);
    err.stderr = plan.error.hint || '';
    throw err;
  }

  // What Clang actually compiles: includes stripped, the freestanding prelude
  // and the intrinsics the paste uses put in.  Python decides this so the
  // browser and the native path cannot disagree about it — handing the raw
  // text over is what made QM's own `_pdep_u64` output fail to compile.
  const prepared = callPython('prepare', [source]);

  await clang.load(progress);

  progress(`clang ${ORACLE_OPT} → wasm32…`);
  const wasm = await clang.wasm(prepared, { opt: ORACLE_OPT }, progress);

  progress(`executing ${plan.values.length.toLocaleString()} inputs…`);
  const table = await evaluateWasm(
    wasm, plan.function, plan.values, plan.output_bits, plan.input_bits,
  );

  return { plan, table };
}

// ---------------------------------------------------------------------------
// Run
//
// Python normalizes the minimized program into one rSUBLEQ artifact and this
// runs it on the compiled machine.  The lowered sequence never crosses the
// boundary and does not need to: whichever of C, x86-64 or wasm32 came in, the
// thing that runs is `pack(code(z))`.
// ---------------------------------------------------------------------------

async function runMinimized(msg) {
  const parsed = JSON.parse(callPython('parse_input',
                                       [String(msg.value || '0')]));
  if (!parsed.ok) return parsed;

  const built = JSON.parse(callPython('artifact', [msg.target || '']));
  if (!built.ok) return built;

  try {
    const out = await runArtifact(decodeArtifact(built.artifact),
                                  parsed.feed, built.out_bytes);
    return {
      ok: true,
      input: parsed.value,
      input_bits: built.input_bits,
      output: out.toString(),
      target: built.target,
      artifact_bytes: built.bytes,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------------------------------------------------------------------------

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'boot') {
      await boot(msg.config || readConfig(msg.search));
    } else if (msg.type === 'solve') {
      await solve(msg);
    } else if (msg.type === 'evaluate') {
      post('evaluated', { result: await runMinimized(msg) });
    } else if (msg.type === 'load-clang') {
      await clang.load(progress);
      post('clang-state', { clang: clang.describe() });
    }
  } catch (err) {
    post('fatal', {
      message: String((err && err.message) || err),
      stack: err && err.stack ? String(err.stack) : null,
    });
  }
};
