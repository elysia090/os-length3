# Browser development execution and packet transport

The actual in-app browser executes the rebuilt Linux 7.2.7 kernel, immutable
root and toolchain through the cold C compiler and C VM. C compilation,
four concurrent compiler jobs, local Git and ordinary filesystem operations
complete. Normal service startup, persistent workspace recovery and the C
virtual NIC are still required for the complete product.

## Actual Linux operations

The diagnostic rescue root changes only the failure trap to permit inspection.
It preserves the service graph, 10-second deadlines, CPU contract and guest
clock policy. Its shell is not interactive-ready acceptance.

The actual guest completed:

- `cc /root/browser-check.c -o /root/browser-check`, then the executable,
  with success checked by `&&` before `C_RUN_OK`.
- Four separate `cc` commands followed by four program executions under
  `make -j4`; all four executable files exist before
  `PARALLEL_C_BUILD_VERIFIED`.
- Local Git init, add, commit and empty porcelain status before
  `MAKE_GIT_VERIFIED`.
- File write, tar creation, remove, tar extraction and exact content comparison
  before `VFS_TAR_VERIFIED`.
- Git 2.55.0, GNU Make 4.4.1 and the installed musl 1.2.6 package inspection.

The first make test had incorrectly quoted newlines and failed. Its bare
`MAKE_GIT_OK` marker is not evidence. The corrected test uses literal shell
escape sequences and chained success conditions. It retains the distinct
`VERIFIED` markers above.

The normal root times out before shell readiness. A same-deadline rescue retry
starts mount-api-filesystems and mdevd-ready, then times out at coldplug.
After the development commands, another same-deadline warm retry starts
coldplug and root-and-workspace-ready, then times out at interactive-ready.
These observations establish functional development operations in the rescue
profile, not normal boot latency or service correctness in every context.
The latest observed Wasm linear memory is112656384 bytes; this is not renderer
RSS, a paired benchmark or a resident high-water certificate.

Kernel identity remains
`7206ac5f64fcfae50d17d090fad4de4ad83e048222d509807d93af951d9929ff`.
The run uses compiler
`c6d10e6abd303d16490210a0a2c401069611a3371ae6b19fb51942832d011b67`
and profile-enabled C VM
`cf7aca4bdbf88cf387b526af3cc437d322f60c06e385694d5789938e238ec1b1`.
The source/assembler population and CPU profile are unchanged.

## Common entrance and region publication

The fixed339960-byte make ELF, SHA256
`dd0023829f36b764b9ba537a0c4965bba1d54b20beaebc5681e27ea56c25cd14`,
now admits all233455 final executable-byte coordinates. Missing valid cuts,
fault cuts, source fetches and capacity refusals are zero. Direct outside-image
edges remain832: this inventory is not a linked dependency closure proof.
The CLI explicitly keeps `publicationAllowed:false`.

MASKMOVQ and MASKMOVDQU lower to complete write preflight followed by ordered
selected-byte stores. They never read old target payload. Zero masks follow
the declared complete-extent checking representative; Intel permits addressing
and page exceptions for an all-zero mask. See
[Intel SDM instruction reference](https://cdrdv2-public.intel.com/835757/325383-sdm-vol-2abcd.pdf).
Independent CPU tests retain actual `maskmovq` and `maskmovdqu` opcodes, not a
compiler-substituted SSE2 implementation of the MMX intrinsic.

There are4480 constructors and26880 malformed refusals,65792 physical memory
observations,131584 C-MMU state/RAM models and12 complete-fault models. The
physical data tests do not prove exception ordering or complete FPU state.
The C model's FPU tag/TOP fields retain their separate owner and proof scope.

The first emitted masked-store modules exposed a generic measure/write hazard:
discovering memory extent after measurement changed the later prologue length.
Region geometry is now selected before measuring, and a backend that changes
it is refused. All four emitted modules validate after the repair. The new
compiler SHA256 is
`6d330c05f97a785f5702349b4c37c9aa72c3417fe44f6fa9698525921f8286e3`;
the unchanged476838-record ordinary population still admits every record with
zero invalid modules, false faults, extent or interface errors.

Independent Linux full C and ASan/UBSan checks pass with frozen source archive
`8d512d85742fd7db1f96720a1456faf0bb25c057b67ef67b31d2f8ccedc3ee31`,
196695.9389ms. The archive predates the additional physical masked-store oracle
and subsequent gateway-only refinements; the tested product C is unchanged.
Windows full `make check` needs Linux mmap/ELF assembly and is not a Windows
gate. The official independent Linux oracle supplies that environment.

## Packet transport

The [local gateway](../../../../network/gateway/README.md) passes actual-browser
pinned WebTransport datagrams:1514-byte payload,1068-byte stride,2 fragments,
reverse ordering and duplicate input. A real Go client/server QUIC test also
passes with generation `18446744073709551615`, preserved as a decimal control
string and uint64 binary coordinate. Race detection, boundary checks and
1572781 fuzz executions pass. The first handshake red was missing HTTP/3 ALPN;
the independent QUIC test detected it and the shared server configuration
repaired it. No certificate checks or browser security flags were disabled.

The portable backend is explicitly diagnostic echo. The Linux TAP backend
needs an independently authorized interface and route policy. This transport
test does not supply a C virtual NIC, guest DNS/HTTPS, an Internet route or
permanent filesystem storage. The old product Worker still needs migration
to the current C machine/Artifact/Storage owner. Native release bytes and the
human-facing UI remain unchanged.
