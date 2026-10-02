# C-Wasm cold-loader checkpoint — 2026-10-02

Linux/browser boot is **not achieved** by this checkpoint. The ordinary-browser
512-comparison result in `2026-10-02-c-provider.json` is user supplied and refers
to the earlier 3,920-byte provider, not the build below.

The subsequent freestanding C provider is 6,602 bytes, SHA-256
`21d5df749501e48bb8ea112fdb3ff60aa1b2e972245f2b8b70f821d2fdfa49b1`.
Its sole import is `machine.memory`; guest memory access is C MMU code.
It was built with the digest-pinned Windows WASI SDK described in
`data/oracle/wasm-tools.ps1`, without WASI libc/runtime imports.

Verified separately, with generated records/logs under ignored `temp/`:

* Full `make -C src/v2 -k -j2 check` passes in the build guest.
* VM ASan/UBSan checks pass, including the exact shipped kernel/initramfs
  initial-page/state check. The MMU matrix covers 49,152 permission cases;
  this is not hardware/QEMU exception-delivery equivalence.
* 83 pure cut modules match 42,496 native-x86/Node-Wasm cases. The shipped
  BusyBox entry contributes a three-instruction prefix, not whole-image
  execution.
* 22 memory and 11 stack/control modules match 16,896 native-x86 cases through
  the actual C-Wasm provider. Faults/stale generations do not retire a cut.
* Native C and C-Wasm match initial metadata/state from the shipped bzImage
  and initramfs; the C MMU fetches the real entry bytes at `0x1000200`.
  No kernel instruction is executed by that loader check.
* The shipped kernel's generated required CPU mask exposes missing PAE/PGE
  (`0x2040`) in the v1 CPU contract. The independently versioned v2 contract
  passes the mask check. The frozen published v1 bundle is not retroactively
  certified under v2; a future publication must reconcile both projections.

The published native download remains byte-identical, SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
The human UI is unchanged. Uniform executable dispatch, fetch/generation
admission, actual kernel startup operations, exception delivery and devices
remain the next browser-boot gates.
