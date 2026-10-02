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
