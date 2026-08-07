# src

* `v1/` — the original research prototype. `SPEC.md` is the product
  specification; `qm-prototype-observation.py` is the solver study it came from,
  and `x86_oracle.py` is its native execution oracle.
* `v2/` — the interactive product built to that spec: a browser page that
  compiles pasted C with Clang/WASM, quotients and minimizes it locally, and
  verifies the result. Start at `v2/README.md`.

v2 is self-contained: it does not import from v1.
