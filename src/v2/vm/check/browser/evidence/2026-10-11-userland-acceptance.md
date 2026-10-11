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
these new bytes require a separate package publication. The candidate's
actual browser execution and cold restoration pass below.

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

### Exact body lifetime and production provider

The module byte index and the construction directory previously had independent
eviction lifetimes. A construction could retain a live instance after its
exact byte index had been removed, so an identical emission compiled another
instance. `check-code-owners.mjs` reproduces that failure with64 unrelated cold
bodies. Coordinated ownership now preserves the retained instance, with one
compilation of that body. Entry and byte pressure, all-alias removal, foreign
handles, last-alias replacement and close are checked separately.

The quotas remain8192 module entries/4MiB and16384 construction keys/4MiB.
Unreferenced bodies are preferred eviction victims. When the hard quota wins,
every dependent construction key is removed with its body index. Already
admitted C table placements remain subject to their own source lease; the host
index does not admit code or mutate those handles. Exact whole-byte comparison
remains required after every hash match. These quotas bound encoded witnesses,
not engine-native code or immediate renderer RSS reclamation.

The separately packaged production provider has no source/system profile
exports:143446 bytes, SHA256
`f9cb405c932a7ffaa9f5103e87c1eb5be2d75ca4ae0ea85c4c3a03b9dbd3ccb5`.
The profiled provider is146587 bytes, a3141-byte difference, not a distribution
compression or Linux speedup claim. Release manifest
`0f1df54f4eb2a8af4606a5aa45579ae988ab7ec654a024fddafc2bd97137fc16`
in `artifact/browser-production-vm-1011b` retains the same kernel, init,
system root and compiler. Its total delivery including directory is95646023
bytes. It is an unpublished verification projection, not a new signed native
release or an installed-package repair.

The actual production Worker reaches normal PID1/console and reports matching
retained body counts in both owners. Its baseline boot formatted a fresh
volume, whereas the updated boot restored it. Different checkpoints and boot
work prevent a paired speedup claim. Auxiliary cold service readiness still
times out under the unchanged deadline.

The source-cohort/admission and RTC tests now use the current64-page private
bootstrap envelope. Cohort demands check every C-selected bank/rank, including
both32-bit halves of a full64-rank word. Page-table changes pass through the
real C store observer, rather than silently modifying retained walk evidence
with a host DataView. The production provider passes233 emissions/42 complete
CPU models/47 demand checks,536 admission emissions/512 cold and512 hot CPU
comparisons, and4479 RTC comparisons with168 faults/1426 waits/1907 refusals.
These finite boundary gates are distinct from Linux boot.

Changing `WASM_PROFILE` at the same output path previously left Make's old
provider untouched. A timestamp-only command stamp also failed a rapid switch
on Windows. The build now compares the exact compiler/flags command, retaining
the output only for an unchanged command. `check-vm-wasm-rebuild.mjs` passes
real0/1/0 builds, exact diagnostic export removal, deterministic production
bytes and two unchanged-command mtime checks. No compiler/provider filename
change is required to apply new flags.

### Repaired shadow execution and cold restoration

The same production Worker imports the179896-byte candidate into the test-only
directory `/run/workspace/browser-check/su-1011` through the guest UART,
base64 and gzip programs. All91 input rows are acknowledged before completion.
Guest restoration exits0 and its SHA256 matches the externally held
`d8d362e886e64101bcd83d77887ee6dbb71fd7de610cfd30d20885d5b4e58995`.
The candidate executes as existing `nobody`, UID/GID65534, and exits0.

A root-owned600 file is actually read through that candidate: `cat` exits1,
stdout is empty and stderr contains Permission denied. After chmod644 the
same non-root read matches the expected content and exits0. The combined
denial assertion is0. The installed `/usr/bin/su` is not overwritten.

Guest sync, host flush and Worker termination complete before generation3
starts the ordinary kernel/PID1 again. Linux journal recovery mounts the same
ext4 UUID `855e59f3-c3f7-41c7-91f5-3792f9b2bd4a`. The stored candidate's hash,
UID65534 and permission-file content all match; the complete restoration
assertion exits0. Receipts and the visible cold result are retained in
`temp/browser-repaired-su-1011.json`,
`temp/browser-repaired-su-cold-1011.json` and
`temp/browser-repaired-su-cold-1011.jpg`. This confirms candidate execution
and storage recovery, not optimize-before-package republication. Initial
service readiness and default TLS negotiation remain red.

### Direct retained-page write frontier

The production revision owner already rejects never-observed physical pages.
The remaining collision is an observed page with no currently retained code
row: the low8 page bits can still select banks holding unrelated live rows.
The C source owner now derives one bit per possible32-bit physical4KiB page
from its sole live rows. A negative bit rejects that bank search; a positive
bit still requires the existing exact extent checks. The serialized unpublished
reservation always bypasses this rejection, including a noncontiguous tail.

The derived bitmap uses128KiB, no source payload copy or new execution format.
Every8192 successful publications rebuilds it and the old bank candidates from
the live rows, removing historical positives with bounded amortized work.
Every observed-page write still advances its physical construction revision.
No source/engine quotas, permission rules, clock policy or deadlines change.

`benchmark-source-writes.mjs` retains8192 actual C-admitted source rows and
performs4096 C-MMU stores per sample into a separately observed, unretained
page deliberately256 pages away. Seven alternating rounds give median
40.8291ms before and0.4002ms after, ratio0.00980183. The stored value, all8192
source admissions and all28800 revision advances remain exact. This is a
collision-specific write benchmark, NOT a whole-Linux or cold-boot speedup.

The native VM `make check` passes, including131072 all-bank invalidation
comparisons, pending/cross-page/last-page/overflow extents and two full
publication epochs. The Windows RTC test keeps its year9999 boundary by an
independent fixed UTC expectation where host libc cannot represent it; no
required test is skipped and product RTC behavior is unchanged. The final
responsibility-boundary grep now also rejects tool errors, rather than negating
any failure or relying on a standalone shell `!` on Windows.
Production and UBSan-trapping Wasm providers pass source cohort, admission
and RTC boundary models. This is not a new full independent Linux ASan receipt.

Provider144710 bytes, SHA256
`f5289167dd4c656d92f4921e07150c60e488193351e956320f133a27d83ab279`:
1264 additional wire bytes, in exchange for the128KiB derived private bitmap.
Manifest `20c3af3157564fab77ce44e5e327142ac95bfed33e35f2cf0d5f2fa2ef418cec`
in `artifact/browser-page-frontier-1011` has95647287 delivery bytes including
directory, with unchanged kernel/init/root/compiler. It is unpublished.

Actual browser generation4 starts the ordinary kernel/PID1 and console,
recovers the same volume UUID and verifies the retained candidate ELF hash,
UID65534 and permission-file content: `frontier-cold-restore-exit:0`.
Receipt/screenshot: `temp/browser-page-frontier-cold-1011.{json,jpg}`.
Initial service readiness still times out. Different restoration work and
concurrent tests prevent a paired Linux speed claim. Default TLS and candidate
optimize-before-package republication remain unresolved.

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
