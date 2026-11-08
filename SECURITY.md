# Security

## Reporting a vulnerability

Write to **security@length3.com** (also given at
`https://os.length3.com/.well-known/security.txt`, RFC 9116). In English or
Japanese, say what you found, how to reproduce it, and what it lets someone
do. Please do not open a public issue, and give us 90 days, or until a fix
ships if that is sooner, before you say it anywhere else.

You will hear back within 3 working days. When the issue is confirmed, the
report says when a fix is expected; the release that fixes it names the
issue and, if you want, you.

In scope:

- the Remote at `os.length3.com` (`os/remote`);
- the web app (`os/app`);
- the desktop app (`os/desktop`);
- `l3` and its core (`os/l3`, `os/core`), including the Prompt's sandbox and
  `l3 ssh`;
- the release workflows (`.github/workflows`).

Out of scope:

- denial of service by volume;
- reports from automated scanners with no shown impact;
- what a person runs inside their own Prompt against their own repo. The
  Prompt is a sandbox, so an escape from it is in scope.

Never test against another person's account or data. Testing against your own
is welcome, and so is a Remote of your own (`node os/remote/dev.ts`).

## Supported versions

Only the latest release is supported: the release `os/RELEASE` names, which
the web app at `os.length3.com` always is. Fixes go into the next release.
Older desktop apps and `l3` builds are asked to update. Nothing earlier is
patched.

## Threat model, in short

The whole model is in `os/DESIGN.md`, Part II:

- §5, "Names: who owns what, and what is trusted for it";
- §6, "The canonical copy is on the Remote" and "The Remote";
- the Prompt, under "One OS, two ways in".

The Remote's checks, item by item, are in `os/remote/README.md` ("What every
request passes, and the one secret") and are tested in
`os/remote/security.test.ts`.

- **Who someone is.** GitHub, Google or Apple say it once, and then a
  passkey does. Passkeys require user verification. A device is a session
  that a browser approved by its code (RFC 8628), and any other session can
  end it. In a browser a session is a `__Host-` cookie (HttpOnly: no script
  reads it; the Remote hands a page no token, ever), taken only from the
  app's own pages; on a device (the app, l3) it is a bearer token from the
  device flow, kept apart from everything the app's page reads
  (`os/core/src/device/vault.rs`), and the page asks the Remote through the core.
  Either is taken only signed with the Remote's secret.
- **Secrets on a device.** The session's bearer and the Agent's key are kept
  in the OS's keyring (the Keychain, Credential Manager without roaming, the
  Secret Service), never in Home's state, a repo or a dotfile; where there is
  no keyring that answers, in a file only the person reads (0600), and
  `l3 remote sign-in` says which. In a browser the Agent's key is sealed by
  the person's passkey (WebAuthn PRF, AES-256-GCM) and opened once a session;
  where no passkey can seal it, Runtime says it is kept as given. A program running as the person can still
  ask an unlocked keyring for them, as it can on every desktop; what limits
  that is a session's being seen and ended from any other device, and
  Prompts never seeing the folder they are kept in.
- **What is trusted for what.** The Remote holds one secret and derives one
  key a purpose from it (`os/remote/keys.ts`). A domain's name is trusted
  while its DNS names this Remote and account. A root is trusted only by the
  digest pinned in `os/core/src/root/pins.rs`, and so is the browser's copy of
  it: its index by the digest pinned beside it, each pack by the table of
  its files' digests that names it, each file read from a pack by its line
  of that table (`module/muk/runtime/table.ts`), before any of it is used.
- **What runs where.** A Prompt runs a distribution's root on the device's
  own kernel without privilege: user, mount, pid, ipc, uts and network
  namespaces, a read-only root, no_new_privs and a seccomp filter
  (`os/core/src/prompt/seccomp.rs`). Its network is a per-device grant. The desktop
  webview runs only the app's own files and may only listen for events and
  set its title.
- **What is out of reach.**
  - The Remote's database role reads and writes rows, and can change no
    schema.
  - No GET changes anything.
  - Every answer is data under a strict CSP, never framed.
  - The app's own files carry the whole CSP and `frame-ancestors 'none'` as
    headers.
- **How it is built.** Actions are pinned by commit, and tokens read by
  default. Releases come only from main; their assets have their SHA-256 in
  `SHA256SUMS` and an attestation of the run and commit that made them
  (`gh attestation verify`). Lockfiles are enforced, and Dependabot proposes
  updates; npm's, the app's crates' and the root's Rust and Go programs'
  dependencies are checked against published advisories with every change
  and, for the root, every week (`os/root/advisories.sh`).
- **How the root is built.** Every package from a source pinned by digest
  (`os/root/sources.env`), in one Alpine pinned by digest, by a compiler
  that hardens every unit it compiles (stack protector, stack clash
  protection, zeroed locals, `_FORTIFY_SOURCE=3`): each program and library
  is checked, unit by unit, to have been compiled so, and to be a static PIE
  with full RELRO and no executable stack; nothing is setuid or setgid
  (`os/root/build.sh`).
