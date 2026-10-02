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

The refreshed `provider.html` emits format `browser-c-provider-probe-v2` and
uses C table dispatch as well as C MMU access. Its updated source-page/metadata
fixture manifest is versioned separately. The Node driver
`data/oracle/check-provider-worker.mjs` checks that setup, not an actual browser
Worker or permission result. No v2 browser receipt has been supplied yet.

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
