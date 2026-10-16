# Actual Linux console and memory boundary — 2026-10-10

The rebuilt kernel executes in the actual in-app browser through the C compiler
and C VM, with no QEMU/JS/Python product execution. The ordinary initial offline
service transition still times out. The separately identified rescue root
SHA256 `382c6f96b46e278d85f7692dfbf1d9b2ae82dba6da62e6e41ee04ee2dc16649c`
changes only its failure trap, explicitly prints NOT interactive-ready, and
opens a real Linux shell after failure. It is not a release or boot success.

Actual shell commands `ps`, `s6-rc -a list` and `/proc/*/{comm,wchan}` execute.
PID1 is/usr/bin/s6-svscan; the console shell is/bin/sh; Linux owns the observed
processes/files. Initial active services are s6rc-oneshot-runner and
mount-api-filesystems. Repeating the SAME10000ms transition first starts
mdevd-ready/coldplug, then a further warm transition returns RC0 and starts
root-and-workspace-ready/interactive-ready. Network services remain down.
This is warm manual recovery, NOT normal automatic cold-ready or the3s target.

A real `cc /root/hello.c -o /root/hello` then reaches520052835 retired and
fails at the host memory reservation, not an ISA fallback:
`WebAssembly.Memory.grow(): Maximum memory size exceeded`. Resident7567 pages,
memory33161216 bytes, pending physical0x2c49ff8/read8. The code source and CPU
were still live. Compiler completion/output and subsequent Git/make queries
are NOT claimed; the Worker terminates on this old harness failure.

Three independent reservation defects are corrected:

1. Payload quota8192 pages excluded private state/directory/construction, while
   the independent fixed512-page Wasm cap included all of them.
2. Initial memory had become32 pages, but initialization still subtracted16.
3. A final8-page growth batch could exceed the remaining6 pages.

The live coordinate population is now derived from declared RAM and immutable
device extents (54710 slots for128MiB RAM plus89874432-byte image). Per-slot
descriptor/index/version cost is52 bytes; a separate bounded8MiB private
envelope and a checked actual initial layout yield a single reservation3591
Wasm pages. This is a bound, NOT eager allocation: only C-requested payload
pages are read/supplied. The non-live regression quotas remain4096/8192 slots.
Growth clamps to remaining pages and subtracts the actual initial page count.
Real Wasm506->512 growth and the initial32->33 red models pass; the complete
2M-source-instruction startup regression also passes. Payload eviction is
still not implemented; increased coherent residency is not called mmap/GC.
The same root is under actual-browser re-test with the repaired reservation.
