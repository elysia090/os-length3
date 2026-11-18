# Managed read/exit diagnostic

`program.S` reads four bytes from preopened FD 3, checks for `abcd`, and exits
with status 0 or 1. `translated.wasm.base64` is a frozen translator-ABI fixture,
not a current-source distribution artifact or evidence that the normal Node
runtime has migrated.

The fixture was produced by the previously available `sods-065.wasm` translator.
The current source translator could not be rebuilt offline because its
`iced-x86` dependency was unavailable. Keeping this distinction is intentional.

SHA-256:

- translator: `bff4c80adf33aea34f93bc45605c7dce73a32dbad977ce6faf97045b3d6f9f0c`
- source ELF: `efbd3b6f4df48e47df36b3723ff8fefad9570317bb62d5d528415aa1db290069`
- decoded Wasm: `59a649efe5d7ccda0f918bce2c1a2663f1de9bc3f4d7b1baf02344ec942bdeaa`

The entry address is 4198400 and the declared minimum memory is 69 pages.
The test uses a fresh fixed-size memory, one runner, no start function, and
private imports/exports. It does not establish stack/auxv setup, path/open,
credentials, dynamic translation, threads, mapping, memory growth, signals,
Worker termination, or full Linux syscall compatibility. Base64 keeps the small
binary fixture reviewable and transportable without treating it as source code.
