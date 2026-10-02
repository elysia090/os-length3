# Browser boundary observations

`2026-10-02-ordinary-worker.json` is the result supplied by the user from
`http://127.0.0.1:8080/src/v2/vm/check/browser/index.html`. It is a manual
browser observation, not an automated Codex browser run. The browser name,
version and process RSS were not supplied. Cross-origin isolation and shared
memory were disabled. Two successive Worker generations passed the same
small fixture; this establishes neither Linux boot nor physical RSS release.

The separate `--isolated` server configuration is checked by the Node/HTTP
test, but no isolated **browser** result has been recorded. Do not turn server
header checks into a shared-memory browser claim.

`2026-10-02-c-provider.json` is the subsequent user-supplied observation from
`provider.html` on the same loopback server. An actual generated memory cut
calls the C-Wasm MMU/access export directly, not a JavaScript memory test
double: 512 native-x86 comparisons pass in one ordinary-memory Worker,
generation 9, 589,824 linear-memory bytes. That observed provider is 3,920
bytes, SHA-256 `19ed2814a339526e3856ad2fd099d68d6a3dedf356b981db1323b40fe68528a9`.
Later builds are not retroactively substituted into this receipt. No browser
name/version, isolated run, process RSS or Linux boot result was supplied.
The diagnostic manifest binds these small test extents; it is not the
production authenticated release root or a distribution closure certificate.

The previous `provider.html` emitted format `browser-c-provider-probe-v2` and
uses C table dispatch as well as C MMU access. Its updated source-page/metadata
fixture manifest is versioned separately. The Node driver
`data/oracle/check-provider-worker.mjs` checks that setup, not an actual browser
Worker or permission result. No v2 browser receipt has been supplied yet.

The prior cold-compiler checkpoint emitted `browser-c-provider-probe-v3`. It first constructed
the memory cut with the 400,394-byte cold C-Wasm compiler, compares its bytes
with native C emission, and then runs the generated function through the C
VM/MMU/table. Its Node setup test passes 512 comparisons; this is not a new
browser observation. Cold compiler memory is separate from VM static/stack
memory, and has no WASI/host decoder imports. Source/output/reopen guards and
130 byte-identical native/Wasm emission checks are described in BROWSER.md.
The actual bundle still stops at memory ADD `0x1000232` after fourteen retired
instructions. Browser-control kernel initialization still fails before JS;
neither a v3 real-browser pass nor Linux boot was recorded at that checkpoint.

The later [segment/startup checkpoint](2026-10-02-segments.md) uses a distinct
10,820-byte provider. It advances the actual shipped startup to fourteen source
instructions in Node/C-Wasm and preserves the earlier browser receipts. It is
not a new browser result; Linux boot is still unachieved.

The [current RMW/control checkpoint](2026-10-02-rmw-control.md) uses a distinct
15,329-byte provider and 403,325-byte cold compiler. The standard in-app browser
route now succeeds: `2026-10-02-c-provider-v3.json` records 512 actual-browser
native comparisons; `2026-10-02-startup.json` records 26 actual shipped startup
instructions, 23 rows and seven admissions, stopping at MOV CR4,RAX
`0x100024d`. Full CPU/cache state is checked in ordinary memory. These results
do not replace historical receipts or claim Linux boot, isolation or RSS release.

The [subsequent common control-read checkpoint](2026-10-02-control-read.md)
records 28 instructions in the actual browser, through the CR4 read/AND, with
CR4 write red at `0x1000255`. Its distinct 404,071-byte cold compiler and
`2026-10-02-startup-control-read.json` do not replace the prior builds/JSON.
Linux boot is still unachieved; the read/write display-order clarification is
included in that checkpoint.

Reproduce the transport/Node checks with:

```
node data/oracle/check-browser-boundary.mjs
```

Reproduce the actual browser observation with:

```
node data/oracle/serve-browser.mjs --port=8080
```

Open the URL above and retain its JSON. The fixture is only 100 bytes; its
memory/table/Worker tests are independent of the shipped Linux bundle.
