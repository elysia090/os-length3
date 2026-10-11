# Browser Linux userland acceptance

Acceptance requires the normally booted product Worker, exact guest results
and a pinned release. Native oracle results, command inventory, rescue-shell
results and protocol transmission alone cannot substitute for browser results.

## Current results

Release `f2cfd24093ad1abcb0f9c6b9cb5868e4f97d2414e14a28b423d12a5a88b45adf`
passes the complete normal-browser userland script: separated streams and
exit seven, pipefail, exact text output, space filenames,128 small files,
nonzero1MiB, existing non-root UID access denial at600/access at644,
hardlink/symlink shared updates, distinct waited exits and TERM/trap,
tar/gzip contents/modes/links, compiled stored ELF and sync. Each of its
eight groups returns zero. Independent host reconstruction matches all135
data hashes and the five metadata rows; the compiled ELF SHA256 is
`725ef35141238c231f815a042b1dd3e4271de91cb257f3870f80e087e7e5f2d3`.

The dedicated ext4 workspace is `/run/workspace/browser-check/userland-1011`,
on volume `383a9c49-47f6-455b-9d7a-38d9a56a7a62`. After guest sync, the
verification page reports host flush/Worker termination as `closed`, then
starts a fresh Worker and the ordinary kernel/PID1 again. All135 hashes,
metadata/link counts and the ELF match the externally retained receipt;
the restored ELF exits seven. An initial attempt at `/workspace` failed
because that alias did not exist. Only the subsequent run on the mounted
ext4 path contributes to the successful evidence.

The normal browser also passes signed local package dependency resolution,
install, execution, removal and rejection with another public key. Its
isolated test root is `/run/workspace/browser-check/apk-1011`; the final
foreground job exits zero. Release trust keys and signature checks remain
unchanged. Independent native results are a separate witness.

Actual console Ctrl-Z stops that own package-check job; `jobs -l` reports
the stopped PID, `bg %1` reports Running and `fg %1` resumes it to completion.
For a separate own `sleep 120`, a console Ctrl-Shift-C key event reaches the
guest line discipline, produces SIGINT exit130 and restores the shell. Plain
Ctrl-C through the browser automation API is intercepted as copying and does
not reach the page; the successful shifted key is not evidence for that route.
Interactive `read -r` retains `left \\ right` exactly. Actual console key
events type `echo ac`, move left, insert `b` and press Enter; Linux executes
the edited line and prints `abc`. The already shipped BusyBox `resize` uses
its standard ANSI cursor query and Linux `TIOCSWINSZ`: exit0 and `stty size`
match17x153, then18x132 after a1024x768 viewport, then17x153 after reset.
The viewport-derived protocol replies and guest ioctl observations agree;
this is an explicit standard `resize` invocation, not automatic SIGWINCH
delivery for every running application. A redundant C helper compilation
was stopped, not claimed as passing, and its unneeded source was removed.

The expanded normal-browser make script now completes on this same volume:
four distinct live recipes start before compilation; each compiler and each
product returns zero; maximum live jobs is4. The changed-source rebuild
preserves the other three hashes, and the two-object link executes correctly.
Workspace `/workspace/parallel-build.XXGHGEDF`, final foreground exit0.
`check-browser-parallel-receipt.mjs` accepts the retained actual console; its
two positive/nine negative tests separately validate rejection of bad receipts.

The shipped optimized `su` exits139 on both native CPU and browser. Rebuilding
official shadow4.19.4/libxcrypt4.5.2 gives a pristine `su` exit0 and postlinked
`su` exit132. Its shared-base dispatch table at input coordinate0x27ea8 was
absent from the table projection, leaving an old target inside a relocated
instruction. General equality propagation across established indirect joins,
private spills and linked leaf preservation now recovers its eight rows.
The independent Linux oracle with source digest
`fea9bbf73e53e62344af1862bcd228cc5062e8c93115f4993774a00c18822a8a`
passes original/optimized `su` exit0, generic two-table execution exit42,
register-clobber, escaped-spill and middle-instruction callee refusals.
The optimized `su` is179896 bytes
(original1810528), digest
`d8d362e886e64101bcd83d77887ee6dbb71fd7de610cfd30d20885d5b4e58995`.
Encoding recovery is not a closed control-domain proof: its eight-row table
remains `domain_closed=0` because an opaque callee can alias the spill.
The already distributed browser root still contains the broken old `su`;
these new bytes require a separate package publication and browser execution.

The full independent C/sanitizer oracle subsequently passes with source
digest `db4d8267f3578ed6e67efbaafd9fc67e069746f5b3ae0d0d77809c7f7fd02bf6`
in294675ms. Adding postlink ASan/UBSan to the full gate first exposed a
misaligned u64 CFG workspace array and the diagnostic CLI's early-return
allocation leak. Both are fixed, with sanitizer options unchanged. This gate
tests the compiler and VM, not Linux browser boot or complete ELF equivalence.

One post-restart profile while testing packages reports cold41595.5ms,
engine89846.9ms and execution241124.2ms,590746 compilations and582554 quota
evictions in the unchanged8192-entry/4MiB module cache. These are one evolving
execution profile, not a fixed benchmark or achievement of the3s target.

### Earlier release

Release `c588c7920ecec616ae9311ed009353b321007b95bc63814242cdfd1e3532cdd9`
boots the ordinary PID1-supervised console. Four independent C make targets
start while all four recipe processes are alive, compile, execute and return
the expected text. The incremental build changes one target, preserves the
other three ELF hashes and exits zero. Workspace:
`/workspace/parallel-build.XXCOLFiP`. Explicit per-target exit/end receipts and
the separate multi-source link are additional requirements in the current
script; they were not present in that completed run.

The first shell assertion fails because the locked BusyBox configuration
disabled `ASH_BASH_COMPAT`, including pipefail. A direct ordinary-console
probe reports `illegal option -o pipefail`; this is not a successful pipeline
failure test. The configuration now enables it, and publication requires both
the original and optimized BusyBox ELF to return seven for a failed pipeline.
The latest release above passes the complete shell test.

Certificate-verified browser TLS 1.3 with explicit X25519 reaches kernel.org:
curl exit zero, HTTP 200, OpenSSL verification zero, hostname match and
19137-byte expected HTML. Default hybrid TLS and a separate TLS 1.2 probe
still end in peer EOF and are not accepted by that successful witness.

## Required checks

| Area | Exact acceptance | Current browser evidence |
| --- | --- | --- |
| Shell | separated stdout/stderr; child 7; exact pipeline; intermediate failure | pass |
| Files | space names, copy/move/remove; 128 files; nonzero 1 MiB; independent hashes | pass, independent host hashes |
| Permissions and links | existing non-root UID denied at 600, allowed at 644; shared inode/update; symlink | pass; shipped su remains separately red |
| Process and jobs | distinct waited exits; own TERM/trap; interactive stop/bg/fg | pass, including actual Ctrl-Z/jobs/bg/fg |
| Text | exact grep/sed/awk/find output and failure status | pass |
| Archive | normal-boot tar/gzip content, mode and links | pass |
| Development | four targets, overlap and exit/end logs; multi-source and incremental link | pass, all compiler/product exits0, maximum live4, final job0 |
| Package | signed local dependency install/run/remove; wrong signature refused | pass, actual browser and separate native witness |
| Restart | external expected bytes/mode/links; sync/flush/Worker destruction/cold boot/ELF run | pass,135 hashes/metadata/ELF and fresh normal boot |
| Network | actual guest DNS/TCP and verified HTTPS response | explicit X25519 HTTPS pass; default negotiation red |
| Terminal | real keys, own Ctrl-C exit/shell return, read-r, editing, guest winsize | shifted Ctrl-C/SIGINT130, read-r, line editing and standard resize pass; plain API Ctrl-C remains intercepted |

## Reproduction

Run `data/oracle/browser-userland-check.sh` in the normal guest. Retain its
dedicated workspace and copy the complete console receipt outside the guest.
`check-browser-userland-receipt.mjs` independently constructs all expected
bytes and checks 135 hashes and mode/link-count rows. Its two positive and16
negative unit tests validate the checker, not Linux execution.

After the guest's sync completes, request host flush and Worker close. Cold
boot a new Worker with the same trusted key and expected root. Run
`browser-userland-restore.sh WORKSPACE`, then compare the retained external
receipt, not just a manifest read back from the same guest storage.

`browser-parallel-build.sh` records each start, compiler exit and program exit.
All four recipe PIDs must be alive before any compiler starts. Four independent
products, one changed-source rebuild and a separate two-object link are
required. `make -j4` with only one target is insufficient.

`browser-apk-check.sh` creates a test-only signed local repository and isolated
trust/database root in its dedicated volume directory. It installs an app via
its declared dependency, executes it, removes the app/dependency and verifies
that a different public key refuses the valid signed package. It neither uses
`--allow-untrusted` nor changes the release trust directory.

The verification terminal transports control and editing bytes through the
same UART owner. `TerminalReplies` answers bounded ANSI size queries only.
The fixed official BusyBox `console-tools/resize.c` implements the guest
query/ioctl path; a new helper is unnecessary. Host JavaScript never
implements ioctl or fabricates SIGWINCH. Resize, Ctrl-C and job-control
success require subsequent guest observations.

Non-LF prompts/ANSI queries now use a bounded2048-byte `ConsoleStream` batch,
flushed on the next host task instead of waiting for another million guest
instructions. Its first browser run exposed a WebIDL-only `clearTimeout`
receiver error (`Illegal invocation`), absent with Node's permissive timer.
The default cancellation hook now calls the global timer directly. The
regression models the strict receiver and checks byte-exact query/prompt,
newline cancellation and binary fragments. Worker failures, including
cleanup, are reported independently of console flushing, and the diagnostic
page serializes i64 observations explicitly. These transport tests are not
a substitute for the guest editing/winsize acceptance.

Interrupting boot before its first block write also exposed a creation-resume
bug. The authenticated revision1/empty-directory root now retains initial
creation authority across Worker disposal; a revision2 empty root after a
committed zero write does not. No filesystem magic or unauthenticated tier is
used. The actual network-ungranted browser then formats/mounts ext4 UUID
`9b42f812-e3f5-45f8-8132-19824d10a3f1` and reaches normal PID1/console.

Auxiliary service cold readiness and the three-second cold-shell target
remain unresolved. A functioning console does not prove the whole service DAG.
The same live DB, unchanged10000ms deadline and explicit verbose offline
transition now isolate the remaining wait: oneshot-runner, API mounts and
mdevd-ready start successfully; coldplug starts, then the transition times
out with exit2. This warm retry is not a cold readiness pass. An additional
diagnostic found `pidof` absent from the current root; the process ID was
obtained from `ps` instead, without substituting another guest implementation.
The standard standalone coldplug then exits0, with guest `time` reporting
real2.52s/user0.13s/sys1.20s (not browser wall time). A further same-DB,
same10000ms transition starts only the unfinished coldplug/root/interactive
services and exits0. This confirms warm convergence, not initial cold
readiness. Readiness markers now require an entire newline-terminated line;
`service interactive-ready: starting` cannot falsely publish readiness.
