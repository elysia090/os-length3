# Shared build tools

`build.sh SOURCE.c OUTPUT` builds a freestanding, static x86-64 Linux
executable. The C sources share a small set of headers for Linux system
calls, basic types, output and an arena. They do not link a C library.

From the repository root:

```sh
sh ricebox/toolchain/build.sh ricebox/muk/src/muk.c target/muk
```

Use a C compiler that targets x86-64 Linux and create the output directory
first. Pass `CC` to select the compiler. These tools are not used by the guest
at runtime.
The local npm build scripts also share the TypeScript package emitter here.
It is build-only; it is not included in the generated packages.
