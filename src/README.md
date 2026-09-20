# src

* `v1/` — the original research prototype. `SPEC.md` is the product
  specification; `qm-prototype-observation.py` is the solver study it came from,
  and `x86_oracle.py` is its native execution oracle.
* `v2/` — the product built to that spec: a C post-link compiler that reduces
  a linked x86-64 ELF (including the Linux kernel image) to an equivalent,
  ordinary, optimized ELF, plus the Wasm projection and browser that execute
  the same accepted output. The end target is the fixed
  `development-standard-v1` distribution, assembled and booted as one root.
  Start at `v2/README.md`; the distribution contract is
  `v2/docs/DISTRIBUTION.md`.

v2 is self-contained: it does not import from v1.
