# Acquisition and composition

ricebox composes an explicitly selected package cache into a distribution. It
does not resolve catalogs or download packages during composition. The caller
may acquire packages through [otter](../../otter/), another trusted provider or
an existing local cache. Otter’s repository entry is
[`catalog/artifacts.ts`](../../otter/catalog/artifacts.ts); Ricebox does not
include it in its npm package.

## Local artifacts

`ricebox/distribution/RELEASE` supplies `0.0.1` for newly built artifacts. From
the checkout, assemble a native archive using a prepared package selection:

```sh
sh ricebox/distribution/build/assemble.sh SELECTED_PACKAGES NEW_NATIVE_DIR
```

The output contains `ricebox-0.0.1-x86_64-<sha256>.tar.zst`, `SHA256SUMS`,
and `manifest`. The archive contains the selected guest tree and its manifest.
The assembler does not add a launcher or site/demo files from the checkout.
The `length3-root-v3` format and guest inventory
paths are compatibility identifiers, not release names. Why uses its own
composition step to add its overlay; that is not a Ricebox artifact.

For browser use, `prepareDistribution` builds static layers from a supplied
package cache and pinned tools without acquisition. To derive layers from an
existing archive instead, use `build/distribution.sh ARCHIVE NEW_LAYER_DIR`
with the local Rust/C toolchain and dependencies already available. The generated
`webroot.json` records the source archive's version, exact size and SHA-256.
Serve its files at a caller-chosen URL; the archive itself is a separate output.

These are local build instructions, not a download URL for Ricebox 0.0.1.
Verify an externally supplied artifact against a digest and size from a trusted
source. Do not rename or repin old OS Length3 artifacts under the Ricebox name.
Public release remains subject to the target readiness check:
`node ricebox/sods/runtime/targets.ts --owed`.

## Prerequisites

The generated local npm package declares Node `>=22.18`. Use Node 24 to generate
that package from repository sources, as shown in the [setup guide](../README.md#setup).
Composition also requires Linux shell tools, GNU tar and zstd. ricebox does not
install these prerequisites.

Supply either integrity-pinned `tools` for the translator, native sods executable
and muk, or an explicit source `toolchain` for development. Source builds require
the corresponding Rust/C toolchains and Wasm target. Translator and AOT artifacts
provide executable code, not alternate file ownership; regular guest payloads
remain in sods' TypeScript Vfs.

## Acquire, then compose

```ts
import {prepareDistribution} from 'ricebox/prepare';

// acquirePackages belongs to the caller's selected acquisition provider.
const selected = await acquirePackages({
  catalog: pinnedCatalog,
  packages: ['app'],
  cache: downloadCache,
});
const distribution = await prepareDistribution({
  ...selected,
  output: newOutputDirectory,
});
```

The selected value supplies `packages`, `packageCache` and, when available,
pinned `tools`. If it supplies no tools, add them or a source `toolchain` explicitly.
`prepareDistribution` rejects a `catalog` field: acquisition must finish before
composition. It does not silently choose another cache or provider.

For Vite, use the same inputs in an async configuration:

```ts
import ricebox from 'ricebox/vite';

// selected is the acquired package/cache/tool selection above.
export default {
  plugins: [ricebox({build: {...selected, output: newOutputDirectory}})],
};
```

Alternatively pass `distribution: existingDistributionDirectory` to stage an
already prepared distribution. Do not pass both `build` and `distribution`.
Serving these assets is distinct from running guest programs and from deploying
a service.

### Use a staged browser shell

Put the complete staged shell directory at any URL prefix (such as
`/tools/linux/`) on an HTTPS static host. Link directly to its `index.html`,
or mount the same page in an existing site with ordinary HTML:

```html
<iframe src="./linux/index.html" title="Ricebox Linux shell" width="640" height="400" loading="lazy"></iframe>
```

No npm, app code, CSS, TypeScript, or framework is required to host or embed an
already staged directory. The dedicated page starts one temporary Linux guest
when it loads without moving focus; an outer site that wants opt-in startup
can link to the page or insert the iframe only when requested. Run
`printf 'hello from Ricebox\n'` when the guest is ready. The server only serves
files. **End shell** closes guest admission; **Start a new shell** starts a fresh
guest after a clean close. The page keeps recent output scrollable and leaves
the input field focused between commands if you are using it. This is a
bounded line console, not a full terminal emulator or persistent home. No drawing or relay is staged by the template.

Copy the complete staged directory together; no base URL configuration or
rewrites are needed. Serve modules as JavaScript and do not rewrite missing
assets to the HTML page. Use a shell-only prepared root for the smallest
transfer and do not include secrets or host files in it: the selected
root is staged as verified layers. The starter does not warm other guest
programs. Layer transport and browser caching affect guest bytes; use the
[pack transport check](#verify-the-static-hosts-pack-transport) for efficient range reads.

### Stage a browser shell from a prepared root

The staging command is for the kit producer, not the person embedding an
already staged kit. There is no public kit download or npm release yet.

Use a trusted, prepared **Ricebox** distribution of the same version as the
local npm tarball, with executable `/usr/bin/busybox`. Obtain the SHA-256 of
that release's `webroot.json` and `muk.json` from your trusted release build
or its publisher. Matching checksums establish byte integrity against those
pins, not who supplied the pins or an unsigned kit. Do not treat hashes of
unverified downloads as release pins. See [local artifacts](#local-artifacts)
to prepare your own.

From a new directory, with Node 22.18 or newer and the tarball already built
([use Node 24 to build it](../README.md#setup)):

```sh
npm init -y
npm install --offline --ignore-scripts --no-audit --no-fund /path/to/ricebox-0.0.1.tgz
mkdir preview
npm exec --offline -- ricebox-stage-shell /path/to/prepared-root ./preview/site \
  "$WEBROOT_JSON_SHA256" "$MUK_JSON_SHA256"
python3 -m http.server 8000 --bind 127.0.0.1 --directory ./preview
```

Preview at `http://127.0.0.1:8000/site/index.html` (loopback HTTP is supported).

The staging command verifies and copies an existing release into a new
directory; it does not acquire tools, build a root, or publish. Never mix
files from different stages. Use a new URL prefix for each staged generation
so cached modules and guest assets do not mix. Stage verifies the selected
bytes and the shell entry; it does not prove that a given root boots in a browser.
If a disk-write error leaves an incomplete directory, discard that partial output
or choose a different destination.

To qualify the starter with real guest execution, use the repository's locked
JavaScript dependencies, an installed sandboxed Google Chrome on Linux and the
same trusted prepared root/pins. The test packs and installs a clean consumer,
serves loopback only, then checks a real prompt and two computed command outputs
in one nested iframe:

```sh
RICEBOX_STARTER_PREPARED_ROOT=/path/to/prepared-root \
RICEBOX_STARTER_WEBROOT_PIN="$WEBROOT_JSON_SHA256" \
RICEBOX_STARTER_MUK_PIN="$MUK_JSON_SHA256" \
RICEBOX_STARTER_CHROME=/path/to/installed/google-chrome \
  node --test ricebox/distribution/verification/test/starter-browser.integration.ts
```

### Stage a static site without the Vite adapter

If you already have a prepared distribution, use `ricebox/assets` from Node.
`distributionAssets` verifies the release index and the assets it names, including
Muk. `browserModules` copies the browser JavaScript listed at package build
time, including the module Workers, with their relative paths intact. Neither
acquires packages, builds a distribution, starts guests, or publishes the site.
Save this as `stage-ricebox.mjs` beside your local npm installation:

```js
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {browserModules, distributionAssets} from 'ricebox/assets';

const [prepared, newSiteDirectory] = process.argv.slice(2);
if (!prepared || !newSiteDirectory) {
  throw new Error('Usage: node stage-ricebox.mjs PREPARED_DISTRIBUTION NEW_SITE_DIRECTORY');
}
const assets = [...distributionAssets(prepared), ...browserModules()];
mkdirSync(newSiteDirectory);
for (const [name, bytes] of assets) {
  const file = join(newSiteDirectory, name);
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, bytes, {flag: 'wx'});
}
```

```sh
node stage-ricebox.mjs /path/to/prepared-distribution ./new-site
```

Put your HTML beside `new-site/ricebox/` and `new-site/ricebox-js/`. Load your
app with `<script type="module" src="./app.js"></script>`. At the top of `app.js`,
import `createRoot` from `./ricebox-js/distribution/runtime/root.js`, not the
Node-only `ricebox/assets` module. Use HTTPS (loopback HTTP for local previews),
serve `.js` files as JavaScript and `.json` files as JSON, and keep the directory
layout. Stage the full JavaScript tree from one package build; these paths are
not content-addressed, so revalidate them or use a new site prefix per build.
Set `createRoot`'s `base` to the URL of the `ricebox/` layers, including the
final slash (for example, `/ricebox/` at your domain root). The root loader
fetches and checks the guest assets when the app requests a load; no separate
browser preflight is needed.

The app still owns the shell UI and Worker admission; importing the entry
does not start a guest or show a prompt. If the app needs guest frames, stage
with `browserModules({display: true})` and import the separate presenter from
`./ricebox-js/everyday/src/surface.js` only when wanted. The default staged
modules do not include it. Serving the layers on your domain is not a guest
execution relay.

### Verify the static host's pack transport

Local staging verifies bytes, not the serving host's HTTP behavior. To check
range efficiency on a preview or an authorized deployment, send a `GET` with
`Accept-Encoding: identity` and `Range: bytes=START-END` to one actual staged
`ricebox/packs/<digest>.pack` URL, under the same site prefix as the app. Choose
a nonempty proper subrange from the verified local pack. A passing response
is `206` with `Content-Range: bytes START-END/TOTAL`, where `TOTAL` is the
indexed pack size, no content transformation, and bytes that match the same
staged slice. `HEAD` and `Accept-Ranges` alone do not establish this.

A `200` means this request was not served as a range. The runtime supports a
valid whole pack in that case, but may have to transfer and buffer the whole
pack for a small read. Close the probe response without reading the rest; it
does not verify full-body fallback integrity or measure browser cache reuse.
Run this check outside the app. No visitor-side preflight is needed.

## Ownership and failure

The caller owns the downloaded cache and tool inputs and must keep them stable
while preparation reads them. Composition checks integrity again because prior
acquisition does not make host files immutable. It does not provide a transactional
snapshot against concurrent mutation.

Use a new output directory. A complete output is renamed into place only after
composition succeeds. On failure, ricebox removes its temporary build directory,
not the provider's cache or earlier acquisition results.

Asset collection retains the selected stored bytes and enforces a per-asset limit,
not a total memory budget. Translation, archive construction and compression have
separate work and retention costs; the composition interface makes no speedup or
fixed syscall-count promise.
