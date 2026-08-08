# libqm-prototype

Quotient Minimizer — a local-first machine-code minimizer.

> Paste a small C function and see how little machine computation its
> observable meaning actually requires.

QM does not merely shorten assembly. It removes distinctions that no declared
observer or future computation can detect, then chooses the cheapest remaining
physical representative — and verifies the result.

```
C / C++  →  Clang -O2  →  semantics  →  quotient  →  normalized action
         →  minimum physical representative  →  verification
```

## Contents

| path | what it is |
| --- | --- |
| [`src/v1/SPEC.md`](src/v1/SPEC.md) | the product specification |
| [`src/v2/`](src/v2/) | **the interactive product**: open a URL, paste C |
| [`src/v1/`](src/v1/) | the original research prototype and its x86 execution oracle |

## Quick start

```sh
cd src/v2
python3 tools/serve.py              # the browser product
python3 -m qm.cli examples/ranks8.c # the same pipeline on a terminal
python3 tests/run.py                # the suite
```

```sh
npx wrangler deploy                 # deploy to qm.length3.com
```

`src/v2/README.md` covers the architecture, how the browser runs Clang and
Python side by side, and what is deliberately not built yet.

## What it produces

For the 14-line `ranks8` from the spec:

```
Quotient Minimizer    2 core operations      PDEP ; IMUL
Residual freedom      502 solutions
Verification          exact exhaustive, 256 / 256
Artifact              13,586 bytes           pack(code(z))
```
