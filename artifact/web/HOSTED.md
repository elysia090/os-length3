# Hosted Linux Web preview

`os.length3.com` uses the existing `libqm-prototype` Cloudflare Worker and its
GitHub Workers Builds connection. The root opens the Terminal, with the
independently pinned `7ae8a85018b49656c8212e4984baf9500656ee3a2ef642a149752954924729f9`
release and the normal `os-length3-0.1.0` origin-local workspace.

The Worker build downloads the official Web ZIP from `os-length3-linux-v0.1.0`,
verifies its externally recorded archive and manifest hashes, and verifies all
63 packaged files. Its UI code is the accepted `90ea11b242be33c9daf2a35808f5089fca0f9c08`
snapshot. It does not replace that snapshot with a newer UI paired with an old
root, rebuild signed packages, introduce credentials, or configure cloud sync.

Cloudflare assets have a 25 MiB individual-file limit. The 90,337,280-byte system
object has six parts of at most 16 MiB for streaming full reads, and separate
content-addressed 64 KiB chunks for bounded reads. The delivery Worker serves
the original bytes and original object identity, including exact bounded Range
responses. ASSETS does not supply the required partial responses in the local
runtime, so the Worker fetches at most two 64 KiB chunks per bounded Range. It
never loads a whole 16 MiB part for that request. Full reads stream the parts.

Versioned `/releases/<descriptor SHA-256>/artifact/release/` paths are immutable.
The unversioned aliases, UI, and `/deployment.json` have `no-store` responses so
an update cannot silently reuse an older descriptor or Web module. COOP/COEP,
CORP and Wasm MIME are supplied for browser isolation. Unknown objects return
404, broken asset Range responses return 503, and write methods are refused.
The deployment receipt identifies the build commit and the accepted Web/root
identities separately. The hosted shell is separate from the accepted runtime
Web snapshot, and its exact file hashes are recorded in `/deployment.json`.

The first deployment keeps `redirectQm` false while os startup/persistence is
checked. Only after os qualification does a second deployment redirect the old
qm root to os. `https://qm.length3.com/legacy/?focus=files` remains on the old
origin for recovery, with the original editor and an explicit JSON export.
The os Files importer retains names/content and gives colliding names an
`import-N-` prefix. It commits successfully before claiming the import is saved.

qm and os have different IndexedDB/localStorage and non-extractable key
authority. A redirect does not migrate Linux data or its keys. Editor files can
be exported/imported; a portable Linux guest-file export/import interface is not
connected. Old Linux data must be reopened on qm with its original workspace
configuration. The redirect makes it unavailable through the ordinary qm root;
the legacy URL and unchanged browser site data are the recovery path.

The shell follows issue #15's light Length³ frame, dark work surface, real
editor-file sidebar, three work contexts and collapsed boot diagnostics. Run
can boot the Linux backend, compile the selected C file and execute it without
separate preparation buttons. The newer proposed scrolling sequence of file
diffs and execution results is a subsequent design task, not implemented here.

The data and recovery authority remain in the user's browser profile/origin,
using `IndexedBlockStore`. The Worker has no workspace-write or cloud-sync API.
Close flushes the workspace before Resume or browser restart. Hosting does not
qualify the preview's missing three-second cold-prompt target, full granted
network workload, Editor/Run frontend, exact process suspension, or independent
whole-program semantic checker. Existing site data is not cleared or migrated.

To build and check locally with Node.js 24 and unzip (Windows: system tar):

```
node data/distribution/prepare-cloudflare-web.mjs
node data/oracle/check-cloudflare-web.mjs
npx wrangler deploy --dry-run
```

`LENGTH3_WEB_ZIP` may name an already downloaded archive; the same fixed hashes
are still mandatory. Workers Builds on the existing development branch is the
deployment path. CLI deployment needs the operator's existing Cloudflare login;
this work does not create a temporary account or API token. Previous Cloudflare
versions remain available for rollback without deleting browser workspaces.
