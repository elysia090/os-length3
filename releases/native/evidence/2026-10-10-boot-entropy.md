# Standard boot entropy, not a syscall substitute — 2026-10-10

The ordinary first service transition times out, while the same warm s6
transition completes after Linux logs crng init done around85 virtual seconds.
Official skalibs2.15.1.0 random_buf uses blocking getrandom(...,0) on Linux.
The pinned kernel config has no hardware random device; the fixed CPU contract
is not changed to advertise RDRAND. This is a concrete missing-input hypothesis,
not yet a proven sole cause or permission to enlarge a service timeout.

Official Linux7.2.7 arch/x86/kernel/setup.c accepts SETUP_RNG_SEED=9 in the
standard setup_data list, calls add_bootloader_randomness, then explicitly
erases the seed and its length. drivers/char/random.c defaults
random.trust_bootloader=true; no command-line or kernel-code change is made.
These source files are read directly from the locked official archive; the
[standard boot protocol](https://docs.kernel.org/arch/x86/boot.html) is the ABI,
not a private guest operation.

The browser supervisor obtains fresh64 bytes from crypto.getRandomValues.
The C cold loader accepts one seed before any projection/pinning; setup_data
at boot_params+0x250 points to physical0x7000. That page is one standard node
(next0,type9,len64,data), committed as bootstrap RAM before execution. It is
never held across an asynchronous page reservation or reconstructed from a
cache. The supervisor scratch and private C copy are erased, the seed's second
projection is refused without touching output, and Linux erases guest data.
Closing the provider explicitly wipes any unprojected private seed as well.

The host CSPRNG and privileged boot-input adapter are entropy TCB. Generated
guest modules receive no boot-entropy import. Linux remains the sole authority
for getrandom, mixing/credit, VFS, timers and services. Deterministic synthetic
test bytes do not constitute a cryptographic quality claim. No seed is saved
in fixtures, digest receipts, release artifacts, storage or logs.

Native C boot/refusal and existing supply gates pass; actual C-Wasm loader
tests cover16 malformed/replay/freeze/close refusals, node spelling and output
immutability. Existing startup/relocation regression and49152 full MIN/MAX
C-VM/native states pass with this provider.
Provider bytes120471, SHA256
`714f1a0e8cde951e3cc76d351c17e8f636ea5d2a14f20ef9e425df9f1f7b03c1`.
The old unseeded strict Node fixture is unchanged; actual browser Workers
require the explicit fresh entropy contract, with no insecure fallback.

The normal rebuilt root (NOT the rescue root), same kernel/init/root, CPU
profile, clock and10000ms deadlines, logs crng init done at0.000000 rather than
around85 seconds. The entropy starvation input is fixed, but the subsequent
mdevd event subscription still times out at251569785 retired /389406ms wall.
This is NOT automatic ready/cold3s; remaining execution cost must be reduced,
not hidden by relaxing deadlines. Full independent C/ASan/UBSan pass146437ms,
source `ed49f5a1996bb3941e3ce4d3b2bb1a5faed08f3f071cc287177ddce304156ed6`.
Native publication and human index UI remain unchanged.
