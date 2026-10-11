# Non-UI acceptance gates and distribution accounting

Observed on 2026-10-11 after storage cleanup repair `ec70bdd` on
`codex/native-release-wasm-1002`. This receipt separates current completed
checks from earlier browser observations and work still blocked. The inherited
eleven modified files and four untracked scripts remain separate from this
change. Existing build-host, browser servers and long x87 remainder checker
were not stopped or replaced.

## Acceptance status

| Gate | Status | Evidence and remaining scope |
| --- | --- | --- |
| Storage sparse/cross-page commits and cleanup | Pass in isolated Node store model | Existing persistence checks plus quota injection at seven object writes, abandoned dirty state, aborted head, corruption refusal and terminal/repeated close. Repair `ec70bdd`; push and PR adapter CI passed. This is not browser quota or guest filesystem crash recovery. |
| Browser normal storage persistence | Earlier pass only | Earlier 135 file hashes, metadata and flush → Worker termination → cold restoration receipt. Not repeated in this session. |
| Browser quota, interrupted write and reopen | Unconfirmed, blocked | Neither `@Browser` nor `@Chrome` is available to this task. Browser inventory is empty and both tab creation requests returned `Browser is not available`. Required connection request remains pending. No real disk was filled and no existing volume was changed. |
| RAM reservations and cleanup errors | Pass in isolated Node model | Memory-budget and machine-device close checks passed. Reservations do not measure resident host memory. |
| Browser long RAM cycles and post-Worker residue | Unconfirmed, blocked | Needs isolated browser workload with guest free RAM, Wasm buffer capacity and attributable host process metrics recorded separately. Existing Chrome processes cannot be attributed to this guest from aggregate RSS. |
| Normal DHCP one-shot | Earlier pass only | Existing ACK/IP/route/DNS/exit-0 receipt. Not repeated here. |
| DHCP TEST and ordinary TLS | Unresolved failures in earlier records | TEST exit 139; default and latest explicit-X25519 TLS exit 28. Shutdown/timer explanation remains a hypothesis. No diagnostic ELF transfer/execution was retried here. |
| Disconnect/reconnect and concurrent network sessions | Unconfirmed | Requires permitted isolated end-to-end browser validation. |
| Current C and sanitizer gates | Pass | Independent pinned Alpine oracle, source archive SHA below; full-C-and-sanitizers receipt, exit 0. Does not certify browser Linux/userland acceptance. |
| Current rebuilt Wasm boundaries | Pass | Source admission, source cohort and RTC tests below; finite C-Wasm tests, not Linux boot. |
| Web directory payload ownership | Reproduced bug, repaired | Actual site recipe formerly expanded four hardlink aliases into four owners. New isolated fixture keeps exact bytes and one independent output owner. |
| Published Release/product root | Unconfirmed for latest source | Published baseline remains October 2 `os-length3-linux-v0.1.0-rc.1`; no new native bundle or product root published by this session. |

UI/UX-only work is **not yet ready**: real-browser storage/RAM gates and the
unresolved network failures remain. No full VM checkpoint or balloon mechanism
was added. The existing execution checkpoint is not a CPU/RAM/device snapshot.

## Current source and C receipt

`data/oracle/pack-source.mjs` packed 1,813 inventory entries into
`temp/nonui-gates-1011/source.tar` (32,000,000 bytes):

`837d7d3923787a63c4423fdd34d19bab12f54f85788ffc1cb488ae6d5add182f`

The independent `check-linux-selfhost.mjs` invocation used no custom guest
gate, no SSH and no outside routing. It completed in 776,536.9459 ms with
`status=pass`, `reason=null`, `cCoreTests=full-C-and-sanitizers`, exit 0.
Pinned oracle image SHA-256:
`6e2e6fe0572b6632527f268d3659e8fccebda4e1ee470fafe2c4d7b85b6a4df6`.

Local receipt: `temp/nonui-gates-1011/casan-result.json`.
Serial log: `temp/nonui-casan-1011/serial.log`, 364,361 bytes,
SHA-256 `136dd60ee0516c6aad36f26824ab4a027f7ec9abb469b6b974634fe70f51ecb3`.
The archive was created before this site-copy repair and new evidence/tests;
no C source changed after packing. This is a pinned source receipt, not a claim
that the final documentation/Makefile commit has the same whole-archive hash.

## Rebuilt Wasm boundary receipt

WASI SDK 34 Windows clang; production VM `WASM_PROFILE=0`. Fresh temporary
outputs were used without replacing any published objects or running inputs.

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `temp/nonui-gates-1011/vm.wasm` | 144,156 | `4a14da3a861d5b877a77db9334e2db20baf19eb06b5d43310e75e16703a9dccc` |
| Default-layout `compiler.wasm` (`COLD_STATIC_MIN=131072`) | 1,137,372 | `70d7994088d65cd724c6678078c4138aef13f39ebb10a8d65d289d88179a6da3` |
| Web-layout `compiler-web.wasm` (`COLD_STATIC_MIN=2097152`) | 1,137,376 | `263e444dc64d0cd93a52a9413e1046e9379ae5ad8a7900c87129b8289849e565` |

The VM exactly matches the unpublished `browser-walk-frontier-1011` VM object.
The default-layout compiler is a separately instantiated boundary-test input;
it must not replace the Web compiler in the single shared Memory. Inspection of
the actual Web object reports `compiler_static_min()=2097152`, not the default
131072 or an older 524288 placement. With this value the rebuilt compiler
matches the Web object exactly. Its arena begins at 2686976; the VM's private
arena begins at 1122304. The layout difference explains the default-build SHA
difference. Both Web VM/compiler bytes are reproduced from current C sources;
kernel/initramfs/system source provenance and full browser acceptance remain
separate gates.

The following tests passed both with the current VM/default compiler and with
the exactly reproduced Web VM/compiler pair (each invocation exit 0):

- `check-source-admission.mjs`: 536 cold emissions, 512 cold + 512 hot complete
  CPU dispatch comparisons, write/remap/stale/NX/residency/grow regressions.
- `check-source-cohort.mjs`: 233 emissions, 69,772 retirements, 42 full CPU
  comparisons, 47 demand checks, write revocation and continuations.
- `check-rtc-provider.mjs`: 11 modules, 4,479 comparisons, 168 faults,
  1,426 waits, 1,907 refusals and 1,425 replays.

## Cost measurements and low-risk copy repair

These metrics describe different owners and must not be combined as RAM or
startup claims. All sizes below are bytes.

| Measurement | Result | Scope |
| --- | ---: | --- |
| October 2 native `.tar.zst` | 63,219,311 | Historical compressed bundle on disk; not a fresh HTTP transfer measurement. |
| Native regular-file payload total | 251,416,342 | Streaming `tar -tvf`: 6,296 entries / 4,503 regular files. Excludes allocated directory/metadata cost and filesystem accounting. |
| Unpublished Web manifest + object lengths | 95,646,733 | Manifest 98,833 + payload 95,547,900; actual object SHA/lengths match the manifest. Not compressed HTTP bytes. |
| Web immutable system image | 90,329,088 | 94.5% of payload; largest individual Web cost. |
| Guest declared RAM | 536,870,912 | 512 MiB guest configuration; not initial Wasm allocation or browser RSS. |
| Browser startup, steady and peak host RAM | Unconfirmed | Requires paired real-browser measurement; earlier boot samples are not this acceptance run. |

Historical native archive SHA-256:
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
Its largest regular-file payloads are GCC `cc1` (38,750,776), `libcrypto.a`
(13,104,352), `magic.mgc` (10,793,952), Git remote HTTP helpers (~10.1 MB each),
OpenSSL CLI (8,100,056), apk (7,878,680) and curl (7,787,704). No capability,
compatibility path or diagnostic program was removed based on these sizes.

Local artifact tree accounting by file `dev:ino` found 225 regular-file paths,
2,335,649,219 apparent bytes. Object aliases account for 2,175,909,513 apparent
bytes versus 1,216,562,924 bytes across 55 distinct object owners. The extra
959,346,589 alias bytes would become independent copies under `cp -R`. This is
local site assembly storage amplification, not bytes fetched for one release.

`src/v2/Makefile` now uses `cp -a` for the artifact tree so hardlinks remain
shared **inside an independently owned output copy**. The new
`check-site-hardlinks.mjs` invokes the real recipe only on a fresh absent target
below its own temporary directory. Before repair it failed with four owners.
After repair it passes: four aliases, 1,048,576 apparent bytes, 262,144 unique
bytes (75% less fixture storage), identical SHA-256
`d30eb241f95e7c37c033251a78eae1610ac9b02dc99625442158180d35818c1b`, separate
source/output owners and unchanged source link count. CI includes this check.

Per-release transfer, expanded native storage and RAM/startup optimizations
remain future measured decisions. The preferred delivery plan remains a
version-pinned verified Release synchronized to the Web's same origin; actual
CORS/redirect/MIME/cache behavior and final artifact/source identity still need
deployment-specific checks before publication.
