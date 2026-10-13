# Signed root rebuild and browser workspace recovery

The local candidate with `base-services-r3` and `linux-boot-r2` passes native runtime, development,
certificate-verified curl/Git HTTPS and native cold boot. Its read-only
SquashFS projection has the same C-measured namespace identity as the native
installed root. The browser passes ordinary syslog/privsep DHCP, a prepared
software-root update and an actual root-plus-data rollback. The startup repair
also completes a fresh browser boot, with no manual transition retry and zero
network body fetches from the prepared cache. The earlier r2 timeout remains
recorded as historical diagnostic evidence.

The final browser root also passes normal syslog/privsep DHCP with the actual
type-5 ACK, address, default route and DNS. Its ordinary curl call to
`https://www.kernel.org/` returns HTTP 200, certificate verification result 0,
exit 0 and the expected kernel archive title in a 19,148-byte body. This call
uses no special curve override. The original saved file hash and filesystem
UUID remain unchanged after selecting this root.
Reloading the normal terminal page also recovers that selected root and original
file, despite a deliberately different configured catalog pin. It observes
service completion and then closes and flushes its Worker.

After the user returns from the requested full browser/app exit and restart,
the browser has no previous tabs and the local server is no longer listening.
A read-only check finds the existing non-extractable key, exact trusted head,
selected release and authenticated physical tree. The normal terminal then
remounts the same UUID, reads the original saved file hash, runs PID1 s6-svscan,
and completes the offline services. The legacy retained authority also survives
and authenticates its original tree. No replacement master key or formatting
is used. [Restart evidence](2026-10-13-browser-process-restart.json) records the
user-driven process restart separately from the measured recovery results.

These observations do not qualify a public release. Browser process exit and
restart recovery has passed, while the native runtime receipt deliberately keeps
producer source binding `unknown` and product qualification `pending`.
The separate source/build witnesses record the actual reconstructed inputs;
they do not recover the original defective binary's unavailable build inputs.

## Causes, repairs and evidence

| Boundary | Observed problem | Repair and completed evidence |
| --- | --- | --- |
| Producer and daemon | The old shipped daemon has an invalid secondary `printf %n` dispatch target. | Two clean native producer builds agree on all four executable hashes. Fresh linked toolchain providers and post-linked dhcpcd pass normal syslog and privsep DHCP. The browser receives address, default route and DNS with exit 0. |
| Signed package root | `/var/run -> ../run` lacks its installed target. BusyBox's fragment also differs from its existing resolved lock. | Include empty `/run` in the signed `base-services` payload; reject conflicting files/links and leave the source checkpoint unchanged. Restore the seven lock-required BusyBox options. The standard root/runtime/development checks pass without weakening their gates. |
| Toolchain checkpoint | The system-tools consumer expects an obsolete one-line assembly marker. | Use the same package-set content and namespace verifier for supplied and internally assembled sysroots. The fresh complete linked toolchain and signed native build pass. |
| Native/Web projection | Final identity revalidation rejects SquashFS links that report unsupported xattrs. | Reuse the initial xattr reader and compare the complete expected names and values. Native and mounted read-only SquashFS identities agree. CI models unsupported links and separately rejects I/O errors. |
| Startup | The global 10-second transition expires before a healthy daemon's readiness and first coldplug finish. | The console remains available. Remove that global deadline from startup `s6-rc change`, retain real DAG readiness and fatal exit reporting. The newly signed root passes real cold browser startup without retry. |
| Boot archive | Two full builds differ only in six newc member mtimes. | Fix member times to epoch zero in a fresh signed-package payload inode. Both actual archives normalize to the same digest; all 210 regular ELF members remain unchanged. Advance `linux-boot` to r2 and bind the normalizer's source digest in the publication key. |
| Completion display | `s6-rc -a list` itself prints the service name `interactive-ready`. | Observe the distinct `boot-offline-complete` line emitted by successful bootstrap. A service listing cannot complete the startup observation. |
| Browser authority | A legacy page retains its only workspace key in memory. | Explicitly retain the existing non-extractable key/context/head in origin authority; generate no replacement key and copy no physical objects. A fresh normal terminal recovers the same UUID and marker file. Wrong key/head/context/generation cases are refused. |
| Update and rollback | Software root and workspace data must not be selected independently. | Bind both to one authenticated head. Actual A-to-B selection advances sequence 93 to 94. After changing data on B, restore A and data A in sequence 116; Linux reads the original file hash and `base-services-r0` again. |

## Actual records

- [Rebuilt native candidate, same namespace and normal Web DHCP](2026-10-13-rebuilt-signed-candidate.json)
- [Final signed candidate, reproducible initramfs and cold services](2026-10-13-cold-service-repair.json)
- [Browser process restart and saved workspace recovery](2026-10-13-browser-process-restart.json)
- [Actual release and Linux filesystem rollback](2026-10-13-release-rollback.json)
- [Existing legacy key retention and refusal cases](2026-10-13-legacy-retention.json)
- [Fresh Web producer source/toolchain reproduction](2026-10-12-web-producer-reproduction.json)
- [Old daemon fault and available producer comparison](2026-10-12-dhcp-syslog-root-cause.json)
- [Prepared public-body cache and durable-head checks](2026-10-12-prepared-workspace.json)

The existing issuer remains the local test issuer whose public SHA-256 is
`872070838751f9ba52b49c4198277d071f91ce1a1e130e10df59a203de13271e`.
No production issuer was created or selected. Authorized RSA/Ed25519/localhost
TLS test keys are temporary scratch/tmpfs fixtures, with cleanup and no raw
key output. The temporary CA is passed only to the tested curl/Git calls.

The native 1 GiB cold run and a separate `mem=512M` run both complete the
installed service/development checks. The latter still has a 1 GiB physical
oracle geometry; it is not a sole-RAM causal comparison. The browser diagnostic
workspace is 32 MiB and retains the same ext4 UUID across the measured update
and rollback. Fresh-document recovery and the subsequent user-driven full
browser restart are separate measured cases.

## Referenced upstream behavior

[s6-rc's documented timeout behavior](https://skarnet.org/software/s6-rc/s6-rc.html)
explains why an expired transition can leave its recorded state behind work
that finishes later. Completion must follow readiness and successful
transitions. [s6-rc-init](https://skarnet.org/software/s6-rc/s6-rc-init.html)
has a separate supervisor-initialization guard, which remains in the bootstrap.
[mdevd readiness](https://skarnet.org/software/mdevd/mdevd.html) is reported when
the daemon listens, while [mdevd-coldplug](https://skarnet.org/software/mdevd/mdevd-coldplug.html)
can wait for completion of the generated events.

The export investigation also encountered Node's uncaught paused-parser
assertion described in [Undici issue 5360](https://github.com/nodejs/undici/issues/5360).
Using core HTTP for this bounded loopback export succeeds with the same bytes;
it does not require changing TLS validation or replacing the installed Node.
The export accepts only the eight declared public product roles and checks
their lengths, SHA-256 digests and flushed owner writes.

The source fixes and regression checks passed both push and PR Linux CI at
[c3dd9fe](https://github.com/elysia090/libqm-prototype/actions/runs/38287774054),
including the boot archive normalizer and its package/source-preservation checks.
CI success is independent of the actual cold-browser and full browser-restart
recovery results.
