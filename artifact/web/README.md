# OS Length3 Linux 0.1.0 — Web distribution

This Web asset runs the same accepted Linux root as the initial native 0.1.0
bundle, through the production Wasm VM/compiler and Linux Worker. The exact
five-role descriptor SHA-256 is
`7ae8a85018b49656c8212e4984baf9500656ee3a2ef642a149752954924729f9`.
Kernel, initramfs and SquashFS bytes are identical to the qualified native
projection; the canonical filesystem namespace is
`13a2b910a90971ed2e4f8d9f1ab3a1edeb1e3fdfaffd1978bb69908ea1f1c8fd`.

## Open the distribution

Authenticate the ZIP with its exact SHA-256 obtained through the approved
GitHub publisher channel. `WEB-SHA256SUMS` is an identity list, not a detached
signature. Extract the ZIP into a new directory. With Node.js 24 or later:

```sh
node serve.mjs
```

Open `http://127.0.0.1:63710/` in a desktop Chromium browser with WebAssembly,
WebCrypto, IndexedDB and Web Locks. The entry URL fixes the release digest and
opens the Terminal surface. The local server binds only to loopback, serves
only packaged public files, and supplies exact bounded HTTP Range responses.
It has no package/workspace write endpoint, external gateway or cloud upload.
Opening the HTML as `file://` or using a server without Range support will not
work. HTTPS hosting is possible when the same layout and response headers are
preserved; this download does not deploy a hosted service.

The first start authenticates and retains approximately 95.7 MB of immutable
release bodies, then cold-boots Linux with 512 MiB guest RAM and a 32 MiB writable
workspace. The shared offline acceptance covers shell/files/permissions/links,
processes/archive/ELF, C/make/Git/AES/APK. Tools can be slow on the current engine.
Network access requires an explicit separately provisioned grant, which is not
included. Installed APK inspection is offline; online package mutation is a
separate repository/system-root operation.

Use **Close** to flush and release the Worker, then **Resume** to cold-boot the
same committed workspace. Close before reloading or exiting the browser; an
unclean exit retains only the last successfully committed head. Recovery
retains the non-extractable key, volume context, generation and authenticated
head in this browser profile and origin. Site-data deletion loses that authority.
The fixed host and port are part of the origin: keep the same profile, host and
port for future recovery. `node serve.mjs 63711` chooses another fixed port
without stopping an application using 63710, but creates a different origin.
No private signing key or existing user workspace is included in the ZIP.

## Scope and remaining work

This asset is a **Web preview** in the stable native Release. The same-root
offline workload, storage fault injections, actual engine/bucket quota, ext4
ENOSPC and bounded tmpfs cycles have their candidate-specific passed receipts.
The prior measured cold prompt was 160,397.6 ms and fails the three-second
target. The new root's full granted network workload, real clock synchronization,
exact process suspend/resume and complete semantic ELF checker remain separate
unqualified requirements. The normal Editor/Run frontend is not connected;
use the Linux Terminal for C compilation and execution. The browser-side Files
surface is not a qualified Linux filesystem browser.

`WEB-MANIFEST.json` / internal `web-bundle.json` record the exact Web code commit,
public files and object/chunk identities. The ZIP contains no diagnostics that
terminate Workers, no stored browser key, no network credentials and no cloud
configuration. The separately downloadable native source/evidence assets retain
the fixed producer/upstream inputs and paired guest acceptance. The Web source
files and launcher source are included directly in this archive.

Bootstrap trust and the optional future object fetch/push contract are in
`DELIVERY.md`. Origin-local persistence remains the configured storage path.
