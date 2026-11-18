# Prepared-path startup guest

This freestanding x86-64 guest is compiled and translated during the test, never
executed natively. Like the diagnostic initial-stack fixture it checks raw argv,
duplicate environment entries, RSP alignment, original `/bin/startup` execfn,
random bytes and ELF aux facts. Unlike that caller-supplied-credentials diagnostic,
this guest requires UID/EUID/GID/EGID and SECURE all zero, derived by Rust from the
initial-root execution and ordinary executable metadata.

CI uses the current-source translator artifact. Local tests may explicitly supply
a historical translator through `SODS_PATH_TRANSLATOR_WASM`; that result is not
reported as current-source evidence. No generated ELF/Wasm is committed here.
The profile has no standard devices and uses only exit(60); it does not establish
full Node/Linux startup, dynamic loading, fork, or exec replacement.
