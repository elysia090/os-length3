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

- the Remote at `os.length3.com` (`os/service`);
- the web app (`os/src`);
- the desktop app (`os/src-tauri`);
- `l3` and its core (`os/cli`, `os/core`), including the Prompt's sandbox and
  `l3 ssh`;
- the release workflows (`.github/workflows`).

Out of scope:

- denial of service by volume;
- reports from automated scanners with no shown impact;
- what a person runs inside their own Prompt against their own repo. The
  Prompt is a sandbox, so an escape from it is in scope.

Never test against another person's account or data. Testing against your own
is welcome, and so is a Remote of your own (`node os/service/dev.ts`).

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

The Remote's checks, item by item, are in `os/service/README.md` ("What every
request passes, and the one secret") and are tested in
`os/service/security.test.ts`.

- **Who someone is.** GitHub, Google or Apple say it once, and then a
  passkey does. Passkeys require user verification. A device is a session
  that a browser approved by its code (RFC 8628), and any other session can
  end it. Sessions are bearer tokens, or `__Host-` cookies that are taken only
  from the app's own pages.
- **What is trusted for what.** The Remote holds one secret and derives one
  key a purpose from it (`os/service/keys.ts`). A domain's name is trusted
  while its DNS names this Remote and account. A root is trusted only by the
  digest pinned in `os/core/src/root.rs`.
- **What runs where.** A Prompt runs a distribution's root on the device's
  own kernel without privilege: user, mount, pid, ipc, uts and network
  namespaces, a read-only root, no_new_privs and a seccomp filter
  (`os/core/src/seccomp.rs`). Its network is a per-device grant. The desktop
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
  default. Releases come only from main, and their assets have their
  SHA-256 in `SHA256SUMS`. Lockfiles are enforced, and Dependabot proposes
  updates.
