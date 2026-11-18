# Managed initial-stack diagnostic

`program.S` is freestanding x86-64 code with no libc. It inspects its entry stack
and exits 0 only when all requested conditions hold; mismatches exit 1:

- RSP is 16-byte aligned; argc is 2 and argv ends with NULL.
- argv is `alias`, then the two raw bytes `ff fe` (each NUL-terminated).
- env is exactly `A=1`, `A=2`, then NULL, preserving duplicate keys and order.
- AT_UID/EUID/GID/EGID are 11/12/13/14 and AT_SECURE is 1.
- AT_EXECFN is `/bin/startup`, separately stored from argv[0].
- AT_RANDOM points to sixteen bytes of value 7.
- AT_PHENT is 56 and AT_ENTRY is the program's `_start` address.

The required aux entries must all appear before AT_NULL. Other aux entries are
allowed. The fixture does not itself perform credential transitions or prove
entropy quality: those inputs are deliberately fixed for verification.

## Provenance

`translated.wasm.base64` is a frozen **historical translator-ABI fixture**, built
with the existing `sods-065.wasm` artifact via `loadTranslator(...).whole(elf)`.
It is not a current-source translator build, distribution artifact, or evidence
that the normal Node startup path or guest execve has migrated.

ELF compilation used the already-installed compiler, without native execution:

```sh
cc -nostdlib -static -no-pie -Wl,--build-id=none -Wl,-e,_start program.S -o startup.elf
```

SHA-256:

- assembly source: `b68edc5fde14b8064b0c86631c3828f359c346fcce5f0144f7162d3ea5a321bd`
- ELF: `5eaed744ef3d353143b20f9ffc39ea72920a7ad038c8cfe68d89fb74d177f49c`
- decoded Wasm: `a04b3cb982d6157ff089a0dd5c8a9ee80b935269284d2d805f34ac00eb943f64`
- translator artifact: `bff4c80adf33aea34f93bc45605c7dce73a32dbad977ce6faf97045b3d6f9f0c`

Translator facts: entry `4198400`, imageStart `4194304`, imageEnd `4468736`,
phdr `4194368`, phent `56`, phnum `3`. The module imports memory with minimum
69 pages, maximum 65536 pages; the caller must allocate additional space for its
validated stack region rather than mistake minimum image memory for stack room.
Decoded Wasm size: 4515 bytes. There is no Wasm start section.

Producing this fixture compiles and translates only. Passing the runtime test
requires the caller to install the Rust-produced stack and set RSP before run.
It does not establish path lookup, program loading policy, full Linux startup,
threads, dynamic linking, signals, or generic exec compatibility.
