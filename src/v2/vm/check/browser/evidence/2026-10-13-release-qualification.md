# Final candidate qualification and remaining distribution work

The tested descriptor is `e67a26ffd99d66d48c5f54d516e0402496067d2cbfc54eb4eb9950be7d4fabde`, served from `artifact/browser-cold-services-1013/release.json`. This is a local signed test candidate, not a qualified public release. The issuer public-key SHA-256 remains `872070838751f9ba52b49c4198277d071f91ce1a1e130e10df59a203de13271e`; no issuer, workspace key, permission or public release was changed.

`pass` means the stated case and conditions were observed. `fail` means an actual rejection, incorrect behavior or exceeded target was observed. `not-tested` means the required observation is absent, including paths that are not implemented. A passed CI job does not convert the latter two states to pass.

## Closed priority validation gaps

| Case | Result | Exact evidence and limits |
| --- | --- | --- |
| Executed native producers, fixed source/toolchain/conditions, final outputs | pass | [Producer binding](2026-10-13-final-producer-binding.json). Two clean native builds reproduce all five producers. Read-only opened ELF descriptors are the objects actually executed; compiler/verifier/stage/archive/audit calls are recorded. The expanded toolchain population contains 7,694 files. Kernel, initramfs and SquashFS match e67 byte for byte; the original native archive is reproduced exactly. Unsigned observations require the trusted local runner; consistency alone is not publisher authentication. |
| Real daemon permanently waiting, readiness absent and process failure, with Worker notification | pass | [Daemon observations](2026-10-13-final-daemon-validation.json). The signed e67 root is unchanged. A separate physical workspace fork receives the service-script faults. Real mdevd is stopped after checking `/proc/PID/exe`; another invocation omits `-D 3`; invalid `-Q` exits 100. The production Worker reports deadline/bootstrap failures and the console remains available. The baseline checkpoint restores the original script and real DAG completion. |
| Final e67 root **and** data rollback | pass | [Root/data rollback](2026-10-13-final-root-data-rollback.json). C selects comparison B, the saved file changes, then the retained C checkpoint restores the original root, ext4 UUID and file digest. This is not a promotion of the historical A/B result. |
| Current persistence implementation and resource failures | pass | [Resource observations](2026-10-13-final-resource-validation.json). Twelve current browser cases include seven ciphertext-put quota injections, an IndexedDB head transaction abort, corruption refusal and abrupt Worker loss before head CAS. Real 32 MiB ext4 ENOSPC, four 2 MiB `/run` tmpfs allocation/release cycles and guest RLIMIT_AS ENOMEM pass. Earlier `/tmp` page-cache cycles and a failed C compilation are not counted as these passes. |
| Actual browser engine and storage quota | pass | Same resource record. A core-valid 1,000,001-function module encounters the actual engine function limit; a control module compiles. A separate 1 MiB Storage Bucket reaches native QuotaExceededError after 1,032,192 bytes, and current authenticated publication retains its prior head. This is not full browser RSS or default-origin physical disk exhaustion. |
| Granted network disconnect/reconnect and concurrent guest HTTPS | pass | [Network observations](2026-10-13-final-network-validation.json). The receipt distinguishes successful traffic, bounded failures, same-grant binding and the isolated static IPv4/packet-host conditions. Historical DHCP remains a separate observation. |

The diagnostic daemon deadline is 60 seconds; the production default is 300 seconds. During an unfaulted boot with two concurrent production Workers, the short diagnostic deadline also expired before real DAG completion later changed the state to ready. No production deadline or startup performance guarantee is inferred from that diagnostic run.

After network testing, the primary workspace was restored to `final-e67-before-qualification`: the original file SHA-256, ext4 UUID, resolver configuration (`10.0.2.3`) and real DAG completion were observed again. Both production test Workers closed and flushed. The isolated packet QEMU exited with code 0 through its verified QMP lifecycle; the opaque relay exited and private test disks were retained. No user application was terminated.

## Candidate defect and source repair

In the ordinary e67 console, `command -v ip` chooses BusyBox's built-in applet despite `/usr/bin` leading PATH. `ip route replace default ...` produced a real general-protection fault in BusyBox. The installed `/usr/bin/ip` is the declared iproute2 provider and performed the same operation successfully. `ip -Version` through the applet also failed to return and was interrupted through the guest terminal.

`data/distribution/boot/console` now supplies an ash ENV profile selecting `ip=/usr/bin/ip`. The equivalent profile was tested on the actual e67 guest: a fresh interactive ash selected iproute2 7.2.0 and read the correct route. This source repair does **not** alter immutable e67. A rebuilt signed successor and its ordinary cold-console test remain required before claiming that the distributed candidate contains the repair. The underlying BusyBox applet fault has not been diagnosed as a producer, CPU backend or upstream BusyBox defect.

## Formal publication gates still open

The authoritative requirements are [DISTRIBUTION.md](../../../../docs/DISTRIBUTION.md#publication-gates) and [the product contract](../../../../README.md). These are implementation/acceptance tasks, not permission requests.

| Priority | Requirement | State | Remaining concrete work |
| --- | --- | --- | --- |
| P0 | Standard command/provider behavior on the distributed root | fail | Rebuild a signed successor with the console repair, then repeat cold default-console address/route configuration, native/Web namespace identity and necessary successor acceptance. e67 retains the observed defect. |
| P0 | Canonical Artifact word writer/reader and 75,000,000-byte `standard_release_size` | not-tested | Emit the complete accepted release word, reproduce it through the canonical reader and measure its unique uncompressed cells. `canonical-filesystem-bytes=252223611` is an upper-bound filesystem population, not an emitted release word. SquashFS (90,341,376), the native compressed archive (63,652,664), and Web transfer are not this measurement. |
| P0 | Web cold prompt target of 3 seconds | fail | Reduce and measure the ordinary cold execution path against the target. Prepared-cache observations were about 144–223 seconds under differing concurrency; they are not comparable performance cohorts and none meets 3 seconds. Zero artifact body fetches do not establish fast execution. |
| P0 | Same complete guest acceptance script on final native and Web projections | not-tested | Run the full common script on the candidate pair, including shell/C/make/git/apk/archive and granted Git/HTTPS/SSH/address configuration. Current manual Web and native receipts prove their named cases, not the entire paired script. The canonical filesystem namespace identity matches `e51726b70e1937e797f1176b188dd0a664e533a069c3a613ec96be77981fc799`. |
| P1 | Suspend/resume exact process continuation after clean-page eviction | not-tested | Implement and exercise process/CPU continuation and object eviction on the product path. Physical workspace checkpoint/rollback and browser close/open are separate passed data-persistence behaviors. |
| P1 | Native product resource manager and workspace lifecycle | not-tested | Qualify the intended host launcher, namespaces, cgroup v2 budgets, Landlock/seccomp and demand-object lifetime. An isolated QEMU/native-chroot acceptance does not establish this host product. |
| P1 | Paired ordinary-source versus optimized native workload performance | not-tested | Run fixed inputs/workloads/toolchain/resource conditions on both native populations; retain runtimes, variance and exact output checks. Structural proof work/span is not a runtime measurement. |
| P1 | `time-synced` / real clock synchronization | not-tested | Measure the declared clock service and its readiness separately. Successful TLS under the supplied clock is not an NTP synchronization test. |
| P1 | Integrated default Web Editor/Run/Files product | not-tested | Qualify the ordinary product UI and assets, not only the restricted Linux diagnostic server. |
| P2 | Whole-engine native-code/RSS exhaustion and default-origin disk exhaustion | not-tested | Define safe isolated budgets and acceptance conditions if these remain necessary. Module admission, a bounded Storage Bucket, ext4 ENOSPC and process ENOMEM do not substitute for them. No host disk fill or user-app shutdown was performed. |
| External | Production issuer/trust selection and Release publication | not-tested | These actions are excluded from the present authorization. The local issuer must not silently become production trust. |

Fixed upstream/service inputs, compiled DAG construction, signed package/ownership/closure checks, optimized ELF proof checks and the existing no-runtime-payload audit have their named local build receipts. The newly reproduced producer cut strengthens their artifact binding; it does not waive any open gate above. Formal qualification remains **failed/pending**, and Release publication remains untouched.

## Reproduction and evidence handling

The producer receipt names the source digest, GCC 15.2.0, `CFLAGS=-O2`, jobs 4, locale/time/SOURCE_DATE_EPOCH and exact tool population. Browser receipts name the descriptor, 512 MiB guest RAM, 32 MiB workspace, origin and generation. Long raw logs and test disks are retained in local scratch; their byte counts/digests appear in the committed receipts. Temporary network grants are not committed or printed.

Run the ordinary service and carrier regression checks with `node data/oracle/check-service-observation.mjs` and `node data/oracle/check-machine-network-reconnect.mjs`. They cover the protocol logic; the linked actual-browser receipts cover the real daemon and guest execution. The existing fifteen pre-task modified/untracked files are preserved byte for byte.
