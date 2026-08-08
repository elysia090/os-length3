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
      compile: {
        opt: options.opt || '-O2',
        listing_isa: compiled.listing.isa,
        toolchain: clang.describe().title,
      },
      toolchain: clang.describe(),
    }));
    const json = callPython('finish', [
      source, enriched, compiled.table, compiled.assembly,
    ]);
    const result = JSON.parse(json);
    result.compiled = { assembly: compiled.assembly, plan: compiled.plan };
    post('done', { result });
    return;
  }

  progress('extracting semantics with the built-in frontend…');
  const json = callPython('fallback', [source, optionsJson]);
  post('done', { result: JSON.parse(json) });
}

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

  const listing = await clang.assembly(prepared, {
    opt: options.opt || '-O2',
    target: options.source_target || 'x86-64',
  }, progress);
  progress(`clang ${options.opt || '-O2'} → ${listing.isa} listing…`);

  progress('clang -O2 → wasm32…');
  const wasm = await clang.wasm(prepared, { opt: options.opt || '-O2' },
                                progress);

  progress(`executing ${plan.values.length.toLocaleString()} inputs…`);
  const table = await evaluateWasm(
    wasm, plan.function, plan.values, plan.output_bits, plan.input_bits,
  );

  return { plan, assembly: listing.text, listing, table };
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
      // The lowered sequence never crosses this boundary, so running the
      // minimized program has to happen on the side that still holds it.
      post('evaluated', {
        result: JSON.parse(callPython('evaluate', [msg.target || '',
                                                   String(msg.value || '0')])),
      });
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
