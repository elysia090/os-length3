# What the OS is under the places

The first principles a new feature asks before it asks anything else (§5), and the one OS the window and the command
line both reach (§6). How the OS looks and moves is `DESIGN.md`; what each place does is `PLACES.md`. (This was Part
II of the design document until the design was written again; it is as it was, its sections numbered as they were, so
what refers to them by number still finds them.)

## 5. First principles

The ideas a language like Rust makes a programmer state about memory
(whose a value is, how long it lives, what still reaches it, what refers to
it) are what people manage by hand about everything else: files, packages,
caches, environments, posts. The OS states them itself, so nobody has to.

- **Ownership.** Every byte the OS holds has one owner: a repo, the
  person's Home, a Prompt, or the system. Nothing is "just there".
- **Lifetime.** The owner's lifetime bounds what it owns, and each kind of
  place says which lifetime it is (below). What outlives its owner is
  freed; nobody is asked to remember it.
- **Reachability.** What no live owner reaches goes: an old root, the
  environment and caches of a repo no longer on this device, a temporary
  whose writer is dead. What is reached stays, however old.
- **Reference by digest.** A name points at content, and content is known
  by its digest: roots, packs, blobs, translations (by the translator's and
  the program's). A reference is small and exact; the bytes come when they
  are wanted, from wherever has them.
- **Derived is never canonical.** What a tool makes from sources (a
  translation, node_modules, target, a venv, a pack) is a cache of that
  making: never sent, never what keeps anything, made again from its
  sources. Only sources travel.
- **By proof, not by name.** Something is let go only when it is proven
  disposable: a leftover by its dead writer and its age, a derived
  directory by the file it is made from or its cache tag, a repo copy by
  the Remote holding exactly it.
- **Authority is what is handed in.** A Prompt has its repo, its
  environment and its caches; no network unless granted; in a browser no
  socket of any family. Nothing ambient comes in.
- **Every change names the version it was made on.** Nothing sent
  overwrites; when both sides changed, both are kept side by side.
- **Leases.** What is held for a while says until when: a repo turned off
  (30 days), a guest's invitation (a week), a device's session.
- **Small before wide.** What reaches others starts with the few it is
  for and is opened further only by choice (a server's board: its people,
  then, if opened, anyone reading, outsiders writing), as a release goes to
  a few before everyone.
- **Measured, not assumed.** Every figure says how it is known, and room
  given back is observed on the host, not inferred.

### Where things live, and how long

| In a Prompt | Owner | Lifetime | On the host |
|---|---|---|---|
| `/root/<repo>` | the repo | canonical on the Remote | the repo's directory |
| `/usr`, `/etc`, `/var/lib` … | the repo's environment | the repo's Prompts; freed back to the plain root at will | `envs/<repo>/upper` |
| `/var/cache`, `/var/tmp`, `/var/log`, `~/.cache` | the repo's caches | made again when needed; go whenever room is wanted | `caches/<repo>/…` |
| `node_modules`, `target`, a venv … | derived from the repo | its sources'; not sent | inside the repo, listed apart |
| `/tmp`, `/run` | the Prompt | until it ends | memory |
| `/` | the system | while a repo's Prompt runs on it | `system/<digest>/root`, read-only |

Each owner is a directory of its own on the host, so what a guest frees is
freed on the host at once, and what a guest leaves (a package cache, logs,
a build tree) the host can take back from outside, without the guest's
help: there is no disk image whose freed blocks the host cannot see, and no
balloon or trim for a guest to forget. Runtime lists each owner's part by
size, with what can be done and why.

A repo's environment is a root of the repo's own: a copy of the installed
root, made the first time its `.packages` or `.setup` ask for one (the
installed root itself is never written), and lent to the repo's Prompts
to write. All of them run on it as programs run on one machine: what one
installs the others see at once, and one ending, being stopped, or stopped
for a network change, takes nothing from the others (#55). A repo that
asks for nothing runs on the installed root as it is, read-only.

The root itself is laid out the same way, by what each place is: `/usr`
is what the root is (programs, libraries, data; `/bin`, `/sbin` and `/lib`
are links into it, the merged layout of Fedora, Debian and Arch), `/etc` its
settings, `/var` what packages and the repo keep, `/root` home, and `/dev`,
`/proc`, `/sys`, `/tmp`, `/run` are made for each Prompt. Nothing of a
machine that boots is in it (no kernel, `/init`, service manager, DHCP or
clock daemon): a Prompt is started by the app, on the app's kernel. Its
records are `/usr/share/length3`, and its package database names exactly
the files there are.

On the host, the data directory is laid out by owner too:

| | What | Lifetime |
|---|---|---|
| `repos/<repo>` | each repo's copy | canonical on the Remote |
| `work/<repo>/<line>` | an issue's copy | until its change is merged |
| `sync/` | what sync last agreed and read (bases, digests) | the repo's here |
| `home/` | Home's settings: profile, TODO, band, language | this device's |
| `prompts/<pid>.json` | each Prompt, its repo and root, from its preparing to its end | its process's |
| `system/<digest>` | each root held, `current` the one in use | while a repo's Prompt runs on it |
| `envs/<repo>`, `caches/<repo>` | the repo's environment and caches | as in the table above |

### Names: who owns what, and what is trusted for it

Trust is built up in steps, each resting on the one before, and each
trusted for one thing only:

1. **GitHub, Google or Apple** say who a person is, the first time.
2. **A passkey** is then the person's own key: from there on they sign in
   without the provider, and a turn-off asks for it. A device holds a lease
   on the person, never the person: what would let someone in for good
   (another device let in, a passkey or a provider added) or shut the
   person out (one taken away) asks for a sign-in just now, by that very
   session, a passkey's or the provider's within five minutes. A session's
   token taken from a device, however long it lasts, does none of them, so
   whoever holds it is gone once it is ended, with nothing of theirs left
   behind on the account.
3. **The Remote** keeps what is theirs and gives them a name, `ren`, their
   **username**, at the first sign-in, as a username is given anywhere: made
   of what the provider calls them (`Zoë Ada` is `zoe-ada`; a handle written
   on Home first, where there is one), the next free one if it is taken
   (`ren2`). Nobody is asked to claim a name before being anyone: making a
   server, writing to someone or showing a repo never waits on one. It is
   theirs as long as the account is: nothing to renew, nothing that lapses.
   It is changed, never let go (Home's handle, `why name set`), at most twice
   an hour; the one it was is held for them 30 days, so nobody is taken for
   them meanwhile and they may change back, and what went public under it as
   their own goes on under the new one. Home's handle is this name: one name
   others find them by, kept on the Remote.
   It is a name on this Remote, not a domain anyone holds: it is kept as
   `ren@length3.com` only because that is where it is kept, and is shown
   alone, everywhere, as Home shows one's handle: nothing after an @ is the
   person's to think of; a name on a domain of one's own waits behind the
   gear of the name. With it comes a **code**, six digits (`204816`), to be found by
   when a name is hard to say or spell: given once, never given again, so a
   code that reached someone goes on meaning them or no one. Most people stop
   here, and need nothing more.
4. **A server** is a group of people on a Remote, with a name and a code of
   its own in the same namespace (`trip`), on the same terms, kept by its
   owner.
5. **A domain** is the last step, for a person or for a server: a name of
   one's choosing on it (`ren@ren.dev`), shown beside the name on the Remote,
   right because the domain's DNS names this Remote and this account (a TXT
   record, checked again whenever it matters). It has no term of its own:
   it answers while the record is there. Then the Remote is only a place:
   things are kept there, as mail is kept where a domain's MX says, and
   moving to another Remote moves where they are kept, not what they are
   called.

What is kept is checked by its name too: blobs and releases are named by
their sha256, so what comes from any Remote can be checked against it.

There is one kind of owner, a **principal**: a person (an account) or a
server (a group of people), named on its Remote (`ren`, `trip`) or on a
domain (`ren@ren.dev`), and found by its code as well. Both are claimed in
the same namespace, so `ren` and `trip` cannot be the same name. A person may have several names: aliases of one principal, one
of them shown. Everything else belongs to exactly one principal: a repo to
a person (a server's own repos come next; there is no fork), a board with
its talk and TODO to its server.

Who sees a repo is one of three: only its owner; the servers it is shown
in, whose people see whose it is; or everyone. Everyone sees it under the
name it went public as, its face: the server's (`trip@length3.com:hello`)
when it went public from one, so nothing it answers ties it to its owner;
its owner's own when they chose that. Its owner's name never opens it to
everyone: `ren@length3.com:hello` stays for Ren and the people of the
servers it is in, or one could find whose a server's public repo is by
trying names. Anyone but its owner only sees it, as it was last pushed,
and writes nothing in it. What is pushed of a repo is main's last commit:
a commit on main, and a merge into it, push it too, so what its owner
committed is what the others see, and what is only being written (main's
draft, a work not merged) is not.

Written the same in why and in the app, owner first, as scp is:

| | |
|---|---|
| `ren@length3.com:hello` | a person's repo (`trip@length3.com:hello`, a server's) |
| `…:hello/src/main.c` | a file in it |
| `…:hello#3` | its issue 3 |
| `trip@length3.com#general` | a server's board |

What is plain is left out: one's own domain (`trip:hello#3`), oneself
(`hello#3`, `hello/src`), the server one is in (`#general`).

Everything lives as long as its owner holds it. Let go, it is held a while
(a lease) and then goes, and a name let go is held as long again, so that
nobody else can take it and be taken for its owner:

| What | Owned by | Trusted for it | Let go |
|---|---|---|---|
| a domain | the person, or the server, it was proven for | its DNS (checked again on use) | its names stop answering when its record is gone; 30 days later they are let go |
| a username (`ren`) | its account | its Remote, as long as the account is | changed, never let go: the one it was is held 30 days, and theirs to change back to |
| another name on the Remote (`trip`, or a second of a person's) | its account, or the server's owner | its Remote, as long as they keep it | let go: 30 days no one else can claim it; its owner may take it back |
| a name on a domain (`ren@ren.dev`) | its account, or the server | its domain's DNS | let go: 30 days held as above |
| a code (`204816`) | its principal | its Remote | never given again |
| a repo | a principal | its Remote, and the digests | turned off: 30 days, then gone |
| a server | its people (its owner removes it) | its Remote | removed, or its last person leaves: 30 days, then gone (a day when its maker leaves it with nobody else in it) |
| a repo shown in a server | its owner, lent to the server | its Remote | taken off, or its owner leaves the server: at once |
| a repo's public name (`face:name`) | its owner, under a face | the face (the server, or the owner's address) | taken down, or the face goes: 30 days no one else's repo answers to it |
| a board, its talk and TODO | its server | its Remote | removed by its owner: 30 days, back at once until then, then gone; or with its server |
| a copy on a device | the device | the digests | taken back whenever room is wanted (why/core/src/prompt/writes.rs) |
| a session, a code | the person | sign-in | a lease: days for a session, minutes for a code |
| a guest's invitation | the one of its people who made it, lent to whoever they hand it | its Remote, and its digest | used, revoked, its maker leaves the server, or a week (at most 30 days) |
| a guest | the board, by an invitation | its token's digest | a lease of 30 days; removed (their posts with them), or the board stops taking guests: at once |

What goes, goes in one place, once a day (`why/remote/repos/sweep.ts`): nothing a
person asks for purges anything on the way, and a file no tree names any
more goes with the rest.

Names are the same problem as a language's memory and types, and are kept
by the same rules:

- **Ownership and borrowing.** Everything has one owner; everyone else
  borrows: a server's people, a guest, a device. A borrow never outlives
  what it borrows: a board not its server, a guest's token not its board, a
  device's copy not its repo.
- **Protection.** What may be read and written is a mapping: a board is its
  people's; opened, it is mapped read-only for anyone; a guest holds a
  capability to write in that one board and nothing else. A name whose
  domain lapsed is unmapped, and faults until it is mapped again.
- **No use after free.** A name let go is held before anyone else may have
  it, as an allocator holds freed memory back, so nobody is taken for its
  old owner. What is kept refers to a principal by its id, never by its
  name: the name is how a person writes it, and a link written long ago
  still means whom it meant.
- **Inference.** A name's kind is read from its shape and from where it is
  written (`name@domain` a principal, `x:hello` a repo, `#3` after a repo an
  issue, `#general` a board), and what is left out is filled from context:
  oneself, one's domain, the server one is in. What could mean two things is
  an error, never a guess.

**Without a domain of one's own** (step 3 and no further), a person has a
name and a code on the Remote, trusted to it, and that is all they need: it
is how they are written (`ren:hello`), found (`ren`, `204816`) and shown.
Proving a domain later adds a name of their choosing beside it
(`ren@ren.dev`); the name on the Remote stays theirs as before.

### why: the one base

Everything a Prompt runs comes from one artifact, **why**, and nothing else
is a dependency: not a BusyBox, a userland or a toolchain of its own. It is
the same thing for the desktop app and for the web.

- **Name and version.** `why X.Y.Z` is the release `os-length3-linux-vX.Y.Z`
  (the version in `module/ricebox/RELEASE`).
- **Digest.** Its identity is the sha256 of its root,
  `os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst`. One entry of
  `why/core/src/root/pins.rs` RELEASES pins it, for both ways in: `sha256` and
  `bytes`, the root; `web`, the sha256 of the index the browser reads the
  same root by. The release writes that entry (`scripts/pin-root.ts`) and
  it is committed; nothing else pins why.
- **What it holds.** Sixty-three packages, each made from the source this
  tree pins (`module/ricebox/pins/sources.env`) by its recipe
  (`module/ricebox/packages/NAME/recipe.sh`, made by `module/ricebox/make/build.sh` on
  Alpine 3.24 at one digest, with one libc: its musl, at the root's own
  musl's version and with the same security fixes; a package's own build
  tools are there for its build alone), and `/usr/bin/why`, put together by
  `module/ricebox/make/assemble.sh`: BusyBox (sh and the small tools), the C toolchain
  (GCC, binutils, make, musl with fortify-headers, Linux's headers; its
  `cc` makes a static PIE, hardened as the root's own programs are,
  unasked), git with delta and Git LFS, curl, wget, OpenSSL, OpenSSH's
  client, rsync, bash, the searches and finders a developer's hands know
  (GNU grep, ripgrep, fd, fzf, and `you`, this repository's own: z's
  memory of places, in `you`, one unit of C with no C library), jq
  and yq, sqlite3, tmux, htop, ncdu, lazygit, direnv, just, hyperfine,
  age, tldr with its pages, nano, apk and the rest, and `/etc`, where each
  tool is set up to work with the others (git's diffs through delta,
  lazygit's too; fzf's list from fd; the shell's cd teaching `you` and
  loading direnv). Every program, C, Rust or
  Go, is a static PIE with full RELRO, stripped, and nothing is done to it
  after the linker; every unit of C in it, and in every library, was
  compiled with the hardening the build machine's GCC is set to give
  everything it compiles, whatever a package's makefiles pass (the stack
  protector, stack clash protection, locals zeroed, fortify-headers' checks
  of sizes at `_FORTIFY_SOURCE=3`, libstdc++'s of bounds), checked unit by
  unit from what GCC recorded of each one's flags, and a package whose build
  turns any of it off says why (musl, freestanding, has no stack protector).
  Not CET: a static program is marked for it only if every part is, and
  musl's are not, so it would protect nothing. Nothing is setuid or setgid;
  every script is for sh or bash; a library comes with what building against it needs; no two
  packages give one path; each package is checked by doing what it is for
  before it is taken, and its database (`apk info`, `apk audit`) says every
  file as it was made. Each package is made again only when what it is made
  of changed (its recipe, pins, patches, the builder, the compiler and libc,
  what it builds against), so raising one pin makes that package and what
  is built against it. A Rust or Go program is built from its makers'
  lockfile, with what its recipe lifts: a crate or module its makers have
  fixed an advisory in, taken to that version where the program asks for
  it at all (`lifts=`, `module/ricebox/make/lift.sh`); what those programs are made of is
  asked of OSV with every change and every week (`module/ricebox/make/advisories.sh`), and
  what no lift answers is written down with why and until when
  (`module/ricebox/pins/advisories.toml`). For the web it also holds the translator
  (sods, as WebAssembly) and the translations of the hot programs made
  ahead of time.
- **On a device**, the app and `why` install the root by its digest: from the
  device's Remote, then the publisher's (each deploy mirrors every pinned
  root to its bucket), then the release itself.
- **In a browser**, the same root is read through muk (`public/webroot`, made
  from the root itself by `module/ricebox/make/layers.ts`, never from anything built
  beside it): `webroot.json` (which why: its version and the root's digest), an
  index of every path (type, mode, link target; where each file's bytes
  are), a pack per package of the root, each file a zstd frame, and blobs
  for the translator and the hot programs (BusyBox, why and git) with their
  translations. Everything but `webroot.json` is named by its digest; a pack by
  the digest of its table, the SHA-256 of each file it stores, at its head
  (`module/ricebox/layers/table.ts`), so a file read alone from it is checked as
  the whole pack would be, and one that is not what its table says is not
  used (its read fails with EIO, and says why). A Prompt fetches the index,
  the translator and BusyBox with its translation; every other file comes
  from its pack (one Range request, and its pack's table once) when a
  program first opens it, and every
  other program is translated when it first runs (why's and git's
  translations follow quietly once the first Prompt is up, and that Prompt
  and every one after runs them from its next run of why or git; each name of
  git, a hard link in the root, is the one file and runs the one
  translation). A program run again that reached much of its code later is
  translated again as one module only while the Prompt waits for its next
  line, so no run waits on that. What was
  fetched is kept by digest (Cache Storage; the packs in the browser's HTTP
  cache), checked whenever it is read, and only within a quarter of what
  the browser says this origin may hold, the least recently used going
  first; what the current why does not name goes. What is kept is joined,
  sealed with its digest and put there by the worker that checks why's files,
  never on the page's thread (a translation of tens of MB, copied and put
  there, held it 20–60 ms a time); a translation made ahead comes to the page
  moved, not copied. Runtime lists it under この端末 and frees it like
  anything derived.
- **The same content.** The web's tree is the root's: every path, type,
  mode, link target and sha256 the same as the root why installs
  (directories at least 0700, files without set-id bits, as the installer
  makes them). `module/ricebox/make/parity.ts` proves it on every release and in CI;
  a program that muk cannot run yet still ships, and
  `module/ricebox/make/runnable.ts` says which, against the same root run natively.
- **One release, one pin.** The release makes the root, then why for the
  browser from it (checked by the parity), pins both in one entry, and only
  then builds the web app and the desktop app, which both trust that entry.
  A web build that has only Node (Cloudflare's) takes why from the release
  (`os-length3-linux-X.Y.Z-webroot.tar`) only at the pinned index.

### Another OS in a Prompt

why is to a Prompt what a machine monitor is to its guest: it lays out the
places above and stays outside. The guest sees a plain Linux (its own `/`,
`/proc`, `/dev`, its own package manager writing to its environment) and
nothing of why that it did not ask for. why's own root is the rescue shell
and more (BusyBox, git, a compiler, why itself); under another OS (Ubuntu,
Debian, a root of one's own) all of that hands itself back: only the why
command comes in, from outside the guest's tree, and the guest's tools,
names and `/etc/os-release` are its own.

### Agents at work

An agent (Claude Code; Grok Build, DeepSeek Harness, Codex as they are set
up) works for the person in their repos. Three rules say when it moves, and
the person meets none of the machinery that keeps them:

- **It reads by itself; it writes only when handed.** A change handed in is
  read, and an issue's tests are run, without asking. Solving an issue, or
  making failing tests pass, is offered in the right pane and starts once
  the person hands it over.
- **It moves at the edges of the person's own work, never on a clock.**
  What it does is worth most where the person has just finished something,
  and their attention is free:

  | the edge (a deed done here) | what it sets off |
  |---|---|
  | an issue written | offered: take it, on its own copy |
  | a commit on an issue's work | its tests run in its Prompt (no agent) |
  | the tests fail | offered: make them pass |
  | a change handed in | read, top down, the hardest part first |
  | its question answered | it goes on, in the same session |
  | back on main | what was handed over and waited for it begins |
  | merged, or closed | what was for the issue is done with |

  A card comes into the pane only while the person is not typing.
- **The most complex first.** Units go goal (an issue), responsibility (a
  folder of the change: one part of the system), test, file, question.
  Waiting tasks run in that order, the heaviest first within one; a review
  reads a change in it, each part and file weighed by the lines changed and
  how tangled the file is now (its branches), and ends with what it found
  in the same order, then what only the person can answer.

A task goes offered → waiting → working → ready, or asking (its reply sends
it on), done (looked at, or its issue merged), dropped (later), stopped (it
could not run: why, and the one fix, such as `why network on REPO`). Those
are the core's words (`why/core/src/agent/tasks.rs`, `<data>/tasks/tasks.json`, never
sent). The person sees an offer to hand over, the work going on in its
issue's box, a question with a field to answer it, something to look at,
or what could not go on: no stage, queue, session or hook.

**Where it runs.** One task at a time per repo (`why agent run`, set off by
the deed), in the repo's Prompt: without privileges, with the repo's own
network grant, on the issue's copy for what writes (the repo shows it, as
the work the person would have started; while the repo shows another
issue's work, it waits until main), on the change's copy for a review. The
agent is the person's own command line (`why agent on claude`; a `.agent`
dotfile says another), told what to do by `$WHY_TASK` and ending with lines
why reads back (`FINDING`, `QUESTION`, `DONE`). What it prints is said on
its issue as it goes and kept whole in a log. Only deeds done on this
device set anything off: nothing the Remote says runs anything here.

**What agents say themselves.** An agent the person runs on their own
(in a terminal, in their editor) says what it does through its harness's
hooks: `why agent on` adds them beside the person's own (Claude Code's
settings; Grok Build's `~/.grok/hooks/why.json`), and each calls
`why agent hook HARNESS` with the event's JSON on standard input. It says
nothing and always ends well, so an agent is never held up by being
watched. Each report is one line of `<data>/agents.jsonl` (0600, never
sent): which harness and session, the repo and line its cwd is in, a kind
(start, prompt, tool, tool-done, waits, stop, end) and one line of words
without control characters. Past 512 KiB it keeps its latest half.

**In the app.** The core is asked (`agents`, with what was last read) every
second while a page that shows agents is on screen; it answers nothing
from two files' sizes while nothing moved. An issue's box says the agent at
it and what it does now; its dot breathes while it works, beats at each
tool, holds still in yellow while it waits; a neighbour's head carries the
dot too. The cards come into the pane (Forge's and Git's, Home's above
Lately).

### Compute, in time and in space

What a person runs (a Prompt, a task handed to an agent, a repo's tests) is
compute, and the OS treats it as one thing whatever runs it: a **Spec**
says what a run is made of, never where (`why/core/src/agent/spec.rs`): the root
by its sha256, the environment by the key of what set it up (the root's
sha256, `.packages`, `.setup`: `prompt::start::environment_key`), the repo and
its line, what runs and what it is told, whether it asks for the network,
and its **Budget** (wall and CPU time, memory held at once, processes).
This device builds the run from the Spec (`why agent inside`); a place
elsewhere that fetches by digest is given the same Spec and builds the
same run. What a run may use is checked where it runs, not where it was
asked for: the network only as the repo was given it there.

Time and space are counted as the kernel counts them, never assumed: CPU
in ms of every process ever in the run's namespace (the live ones' own,
and what each reaped; pid 1 reaps every orphan), wall time, and the most
memory and processes it held, sampled every quarter second. Past its
budget a run is stopped and says what it went past (an agent's task has
10 to 60 minutes by what it does, half the device's memory, 4096
processes). A Prompt paused (`why prompt pause`) keeps all it holds and
uses no CPU until it goes on. Every run is in the ledger
(`<data>/compute/runs.jsonl`, never sent): its Spec's digest, where it
ran, what it used, what it went past; `why runtime` says the last day's,
by repo.

**What scales worst, in order, and how each is solved:**

1. **A repo's tree on the Remote is whole, per save and per commit.** A
   draft save reads the repo's whole tree (every path and its blob) and
   writes it back; a commit keeps a whole copy; the daily sweep reads
   every tree to find blobs no one names. So a save costs the repo's
   size, storage grows as files × commits, and a repo stops at 20,000
   files. *Solution:* Merkle trees, as git's: a tree per folder, named
   by the sha256 of its entries and kept once; a draft or a commit is a
   root's name; a save names the paths it changes, and only the folders
   on those paths are written anew; commits share every folder they did
   not change; a diff skips folders of the same name; the sweep marks
   from the live roots down. The root's name is also how a place
   elsewhere fetches a copy. *Solved in part:* a draft is a row a path
   (0022 line_file, keyed byte by byte, so all under a folder is one
   range), and a save is asked about and written by the rows it touches
   alone: whether it makes a file and a folder of one name, what the
   draft would take (its paths, bytes and files' bytes, kept beside it as
   each save changes them), then those rows written. A save of one file
   to a repo of 20,000 was 90 ms of the database and 1.5 MB of its log
   (what Neon keeps as history); it is some 4 ms and 8 KB, as for a repo
   of ten. A device a few saves behind is told what each changed
   (line_change, `?since=`), not the draft whole. A commit's tree is
   nodes (0023 tree_node: a folder named by its entries' digest, kept
   once in its repo) and the commit names its root; a line's draft is
   laid on its head's root, its rows only what it changed from it (a path
   set, or the root's at a path and under it cut away). So work begun on
   an issue is its head's root and no rows (a repo of 5,000 files: 45 ms,
   not 172); a commit of the draft is its rows laid on the root, made anew
   only along them, the draft then laid on the commit with none (two
   files of 5,000: 38 ms, not 107); a merge compares the three roots
   folder by folder, looking only in those all three have apart, and
   carries main's draft onto what it makes by its rows. One path of a
   commit is its folders from the root (cut_path); two commits are
   compared folder by folder (a device asks what changed, not both trees
   whole); the sweep reads each folder once. Commits made before roots
   are read as they were kept. *To build next:* a draft read whole (a
   device's first sync) walks its root's folders, a little slower than
   reading rows (47 ms against 39 at 5,000 files).
2. **Compute runs only where the copy is.** *Solved:* the Spec above;
   runs here are built from it. A place elsewhere needs only what the
   Spec names: the root (already fetched by digest from the Remote, the
   publisher or the release), the environment (3), the copy (1); it
   streams what the run prints back as the journal's lines and returns
   the ledger's Run.
3. **An environment is one repo's, on one machine.** What `.packages`
   and `.setup` installed is a root of that repo's own, made of that root: two
   repos asking the same install it twice, and nothing moves. *Solved
   in part:* an environment is named by its key (the same key, the same
   environment, wherever it is made; set-up stamps by it). *To build:*
   what set-up made frozen as a read-only layer named by its key,
   shared by every repo giving the same key, the repo's own writes on a
   scratch layer above; a layer is a tar stream by digest, so a place
   elsewhere fetches it.
4. **A run held what it took until it ended, with no bound.** *Solved:*
   budgets, measured use, stopping past them, pause and resume, the
   ledger. *To build:* idle Prompts paused by themselves (their pane out
   of sight a while), hard limits by cgroup v2 where the host delegates
   them (memory.max, cpu.weight), a paused run checkpointed (CRIU) to
   move it.
5. **Accounting walks the disk.** Runtime and room made under pressure
   size what the OS holds by walking it. *Solved in part:* room is made
   only once the host says it is short (one statfs), and roots are sized
   once, as they are put in place. *To build:* sizes kept as things are
   made and freed; a repo's walk read from its stamps.
6. **A sync walks the copy.** Each sync looks at every file of the copy
   shown (what was read before is not read again: its digest is kept by
   length, time and inode). *To build:* the host's change notices
   (fanotify, FSEvents) say which paths changed; a whole walk only at
   start and now and then as a check.

## 6. One OS, two ways in

The GUI and the command line are two ways into the same things. `why`'s
nouns and order are the rail's: Home (`todo`, `profile`, `lang`), Forge
(`repo`, `band`, `prompt`), File (`file`), Git (`git`, `issue`, `start`,
`main`, `commit`, `push`, `reset`, `diff`, `log`, `review`, `reply`,
`merge`, `reject`), Runtime (`runtime`, `free`, `root`, `network`, `dotfile`,
`address`, `app`), Remote (`remote`, `login`, `logout`), Server (`server`), Inbox
(`inbox`, `name`); `why help` lists them in this order. `why address` is where
this device is reached over SSH, as `ip addr` answers with an address: one
`ssh -p PORT REPO@HOST` a line, the SSH user being the repo, and on
standard error who may connect, the keys let in and the host key (Runtime's
SSH, below); the names people find you by (name@domain, and your code) are `why
name`. A path is written as File shows it (`/root/<repo>/…`). A line is
named the same way everywhere ("Fix：件名"), an issue is called by its
number in both (#3), and Home's state is the same files, so anything done in one shows in
the other. The Prompt's shell works on the repo itself: what it changes is
written back, and what is saved elsewhere comes in.

The one way from the command line to the GUI is `why app`: it opens the
desktop app, or brings forward the one open (one on a device at a time,
never a second), or, on a device without it, says where the Remote hands
it out for this release (exit 4). A start is said as one only once the app
answers; one that ends, or cannot show a window, is said as such. `why app
close` closes it as its window's close button does, and nothing else: what
it saved stays, and what why runs (SSH, a Prompt in a terminal) goes on.
Opening it turns nothing on: no network listening, no SSH, no Remote. It is
reached through a socket in its own owner-only folder of the data
directory (`why/core/src/device/desktop.rs`).

### The command line without learning it first

The GUI asks nobody to learn it before using it: the rail shows the
purposes, a press shows the page, and the next deed is on the page. `why`
at a terminal is used the same way, and stays a command line:

- **`why` alone is the rail.** The purposes in the rail's order and words
  (Home, Forge, File, Git, Runtime, Remote, Server, Inbox, +), each with its
  role and what is there now (TODO open, repos, issues open, the root, where
  the Remote stands, servers, what is not read). It is a few lines under
  what is already in the terminal, never a screen taken over: it works over
  SSH and inside a Prompt, and the scrollback stays readable.
- **A purpose picked prints its page** as its commands print it, each said
  first as the command it is (`→ why git`), then **its things with their
  deeds**: each issue, TODO item, repo, conversation, board or thing by size
  is a row, and the focused row's deeds are under it, what the thing is for
  first, what goes against it or leaves it last (§3, Where a deed sits); the
  page's own deeds (Write an issue, Add a TODO, Sign in) are rows of their
  own. The deeds are where the thing stands: an issue not started offers
  Start; changed, Commit; committed and not in, Submit; handed in, Approve and Merge (Merge
  first once approved), Reply, Ask for changes, Reject.
- **A deed takes its words from the thing it is pressed on** and asks only
  for the rest, in place, one line each, as the app's fields ask: the name
  over the field, what goes in it beside (First line, Kind：title, as Fix：…),
  a repo or a template chosen in a row of their own (one repo is chosen
  without asking). What cannot be undone at once (Delete, Free, Reset, Sign
  out, Block) is asked first, Not now first and the deed beside it. Words
  the command refuses (a name taken) are said under the field, which is
  asked again with them in it, to be fixed. An empty line is Not now.
- **A field is a line editor**: it starts with what the thing says now
  (Edit a TODO: its line; a profile's name), or, asking a path, with the
  folder the menu is in (`notes/src/`); ←→, Home, End, Backspace and Delete
  move and take by whole characters, Japanese as English; only what is
  typed is kept, never a key's own bytes. Its keys are said under it.
- **Ctrl-C, Esc and Enter by place**, said where they act: in the rows q,
  Esc or Ctrl-C leave why and Backspace goes back to the rail; in a field
  Enter keeps, Esc is Not now (back to the rows, nothing done) and Ctrl-C
  leaves why as a program Ctrl-C ends does (130), with nothing half made; in
  a Prompt opened from the menu Ctrl-C is the program's, as at any shell,
  and `exit` comes back to the menu on the repo it was opened on (said as
  it opens). Whether Ctrl-C in a field should go back rather than leave is
  the person's to decide; it leaves, as it did.
- **Narrow terminals**: a row too wide is cut with … except the focused
  one, which is said whole over as many lines as it takes; the keys line
  wraps by whole phrases, the ways back or out (Backspace, q, Esc) first, so
  at 50 columns nothing that leaves is cut off. Past nine rows each keeps its
  number to be read by (1–9 still jump).
- **Every deed says the command it is** before it runs (`→ why start
  notes#1`), so the words are learned by seeing them and never needed. Its
  answer is why's own, and then the page's rows again, read anew, with the
  focus on what was just done or made (§1, What one was doing stays).
- **After a command typed by hand**, its next deeds are said in one line
  (`Next for notes#1  Submit · Open · Back to main`), and asked nothing: why
  reads no key, so all the person types next is the shell's (a row that
  waited for a key took the first character of the next command, which why
  cannot give back without replaying input). What a command just made comes
  first (the 13th TODO's Done, not the first twelve's), and what is left
  out past twelve is said. A page that listed its next deeds itself (an
  issue's card in full) is not followed by the same words again: only the
  quiet line that `why next` chooses one with the keys. `why next` opens them: the same row walked with
  ←→ and Enter, Enter alone or Esc going on, each deed done as its command
  and those after it offered again.
- **One table drives both.** A deed is a form of `why/cli/src/words/spec.rs` with what
  the menu needs beside it: its word in both languages, what it is pressed
  on, the facts it is offered under, the words it gives itself, what it
  asks, its weight. Each page notes its things and their facts while it is
  made (the issue's from the same reading that writes its card's `next:`
  line), so the menu, the help, the completion and the card cannot drift;
  the tests read every deed back through the parser as the form it is. An
  issue opened in full (`why issue notes#1`) ends with the same deeds as a
  list under Next, each the button's word beside the line that does it
  (`Approve  why review notes#1 approve`), what it is for first and what
  leaves it last, each said once: its Review and Merge say where they stand,
  not the commands again.
- **Keys** as a list has them: ↑↓ (Tab) to choose a row, ←→ a deed, Enter to
  do it, 1–9 or a letter to jump (again for the next with that letter),
  Backspace to the rail, q or Esc to leave. The focus is a › and brackets,
  so nothing depends on colour (NO_COLOR is honoured); the lines are drawn
  again only when a key is pressed, and what is left when a choice is made
  is plain text: the choice, the command, its answer.
- **Still a plain command.** With words after it (`why git`), why does and
  answers what it did, the short row only following at a terminal; through
  a pipe or a file (standard input or output not a terminal), with
  `--json`, with `TERM=dumb`, or with `WHY_PLAIN=1` (the one switch that keeps
  a terminal plain too, for a screen reader that prefers it or a recorded
  session), nothing is offered or asked, and what why writes and how it exits
  are byte for byte what they were (`why/cli/tests/plain/main.rs` keeps the
  transcripts; `why/cli/tests/menu/main.rs` drives the menu through a real pty).

### What why writes

The same few rules for every answer, so a line is read the same way
wherever it comes from:

- **`why help` starts with the work.** First the lines that take an issue
  from written to merged, in their order, as one would type them in a repo
  called notes (`why issue new notes "Fix：title"`, `why git`, `why start
  notes#1`, `why commit notes`, `why submit notes`, `why review notes#1 approve`,
  `why merge notes#1`); then every command by the rail; then the flags, the
  exit codes (0–5) and how names are written, each a line under its word.
  Every line fits 80 columns, Japanese counted two a character.
- **The table is data too, for an agent.** `why help all --json` is every
  form as a program reads it: its verb, its words in order (each a kind:
  repo, path, issue, text, number, choice with its choices, address,
  dotfile, many, argv; optional or not), its flags (and the value each
  takes), what it needs (the Remote, this device, or nothing more: it runs
  in a Prompt too) and how it keeps in step; beside its usage and its words
  as `why help` says them. One reading and any command can be written. The
  verbs are the same everywhere (new, ls, mv, rm, set, take; a list is
  `ls`, whatever it lists), and a refusal says the command that helps: a
  name not found says where the names are listed (`(why repo lists them)`),
  with `--json` as `{error: {kind, message}}` and the exit code.
- **A name and its facts in two columns.** A listing (`why repo`, `why
  remote`, `why file`, `why prompt ls`) writes each name, then its facts
  starting in one column, as wide as the widest name up to 24 (a longer one
  keeps two spaces after it alone); a folder with nothing to say is its name
  alone. Never a tab: a terminal puts what follows a tab at its next stop,
  out of line after a long name. A script reads `--json`.
- **A step is ○ until it is ✓**, on a card as in the TODO: `○ Commit`, `✓
  Submit`. Started and nothing changed, Commit says where the work is done, as
  the app's card does (edit in notes, with `why prompt notes` or `why file
  write`; what changes shows here).
- **What comes next runs as it is pasted.** A card's `next:` line is a
  command with every word in it and no brackets (`next: why commit notes`);
  a word only the person can write is the help's own (`why reply notes#1
  "text"`). When all that is left is leaving the work, the line says so as
  `back: why main notes`, never as what comes next. Starting an issue says
  both the way on (edit, then `why commit notes`) and the way back.
- **A log is two lines a commit**: its line, then id, when, the files and
  their lines, its issue, whether a merge; which folders it touched is
  `--json`'s.
- **A mistake says what to write, and with what.** Its form with the word
  that was missing in it, and what there is to put there (`Name a repo (why
  commit REPO [-m note]), or run it in one: notes, c1`); an issue is named as
  it is called (`notes#2`, never its work's line name `002`); something
  done already says where to see it (`notes#1 is merged already (why log
  notes shows it)`); nothing to commit says of which repo, and why.

### The canonical copy is on the Remote

As with GitHub, the copy that counts is the Remote's, and work on a device
is not trusted until it is there; here that reaches to the whole OS. A
repo on the Remote (`service/`) has two things:

- **draft**: the working tree as it is now, path → the sha256 of the file
  (and, beside it, each executable file's mode: "A file's mode" below).
  It has a version, and a change is a diff made on a version: one that
  names an older version is refused with the draft as it is, so nothing
  sent is ever overwritten.
- **head**: the last commit. Commit makes the draft at a version a commit, named
  by the sha256 of its record (tree, parent, words), and moves the head by
  compare-and-set.

#### A file's mode

A tree is path → digest; beside it, a draft and each commit keep **modes**:
path → the file's permission bits (`{"run.sh": 493}`, 0755), only for a
file the tree names that has an execute bit. A path not there is a plain
file. One representation everywhere, for the app's native sync (core), why
and the web's writeback alike: it is not folded into the tree's values, so
a tree stays path → digest for everyone who reads one (an old client, the
sweep, the log's counts), and a commit's id changes only when it has modes.

- **GET** `/v1/repos/:name` says `modes` beside `draft`; a Remote from
  before modes says none, and a client takes that as "this Remote keeps no
  modes".
- **PATCH** `…/draft` takes `modes` beside `set`: each path set that has an
  execute bit, with its bits; a path set and not in `modes` is a plain file
  there. A mode alone is a change: the path is set again with the same
  digest and its mode. A client that sends no `modes` (one from before)
  cannot say, so what it sets keeps the mode it had: an execute bit is never
  dropped for not being known of. A mode on a path not set, without an
  execute bit, or beyond 0777 is refused.
- **Commits** keep the draft's modes; work on an issue starts with its
  commit's; a merge merges them as trees are merged (one both changed keeps
  main's: a mode never refuses a merge); a path removed takes its mode.
- **Taking in** writes each file with the Remote's mode, and a mode changed
  there only (the file's bytes as agreed) is taken as a file changed there
  only is; one changed here is sent. A file rewritten here keeps its mode.
- **Expand only** (migration 0010): both columns default to `{}`, so the
  Worker before reads past them and every client before keeps working.
- Where the Remote keeps no modes yet, an execute bit here is named among
  what cannot be sent (`why repo`'s `unsendable`), and **the last copy that
  has one is never freed**: Free asks the Remote's modes to be this copy's.
  Owner, ACLs and extended attributes are not carried.

So a device's copy is never the only copy, and history stays deliberate.
Every change made here (in Forge, by why, by a Prompt) is sent as a diff
within half a second; the Remote's changes are seen within five seconds
and whenever the window comes back. Taking in is file by file against the
version last agreed: a file only changed there is written here, one only
changed here is sent, and one changed on both sides keeps, at its name,
the version that reached the Remote first, and puts this device's beside it
named after this device ("README (ren-laptop).md", "README (Chrome
Linux).md"), so neither is lost and the name says whose it is on every
device.
Files that cannot travel (a link, a file over 16 MB, a repo's own `.git`)
are named and never sent; a repo holding them is never let go. Nor does a
file that holds a secret (why/core/src/device/secrets.rs): a model maker's API key, a
Stripe live key, a GitHub token, or this device's own sign-in. A Prompt has
the Agent's key in its environment, so whatever runs there could write it
into a file; read before it goes, as a push is read by GitHub's push
protection, that file stays here unsent, said as `secret sk-ant-…a9AA`, and
Commit says which until it is taken out. Home's
settings (profile, TODO, dotfiles) are kept there too, by the app and why
alike (why/app/remote/settings.ts, why/core/src/home/: one protocol, one record of what was
agreed), each changed only from the version it was read at: unchanged
here, the Remote's is taken; changed on both sides, two TODO lists are
joined item by item, and any other setting is the Remote's. The band, the
language and the network grant are the device's own.

What each host keeps, and when (lifecycle.ts):

|             | comes by itself | goes by itself |
|-------------|-----------------|----------------|
| OS          | web: why, fetched each visit; app: the root, when installed | web: with the tab |
| repo        | the Remote's changes, as they happen; one only on the Remote, when opened | each change, to the Remote at once; web: the copy, with the tab, once the Remote has all of it |
| Home        | at start and when the window comes back; why: before a command that reads it | each change, at once; why: after the command |
| Prompt      | when a repo opens | its processes, when closed |

Room on a device is given back in Runtime (空ける): a repo that goes stays
on the Remote and comes back when opened.

**No sync verb.** Keeping in step is not something a person does: every
change goes to the Remote as a diff by itself, and the Remote's come in by
themselves (the app within seconds, why when a command reads the repo).
What a person does to the Remote is only taking a repo off it (with a
passkey, kept 30 days). Git's verbs (commit, push, review, merge) are
about history; none of them is how files get to the Remote, so the two
never mix in the words or the buttons.

**Who.** One signs in the usual way, with GitHub or Google, and then adds
a passkey for the device, so the next sign-in needs no provider; a lost
passkey is replaced by signing in with the provider again. The app and why
do not hold passkeys: they show a code, a browser where the person is
signed in approves it on the Remote's page, and the device gets a session
of its own. What a passkey or a provider does is the browser's for the
same reason, yet the app does all of it too, the same page in the same
place: Remote's Sign-in lists and removes passkeys and unlinks providers
in the app itself, and adding a passkey, linking a provider and setting
the code (Add, Link, Set in the browser) open the Remote's own page there
at Sign-in; a repo's switch and Discard ask in its card as on the web, and
Continue in the browser opens that repo's card there with its ask already
open (`why/core/src/remote/account.rs` app_page names only that page, of the Remote's
own app, the way a sign-in's page is checked). Done there, the page says
to go back; the app reads again what changed when its window comes back.
Every device is a session, listed on the Remote page and ended
from any other. What proves a session is held where no page reads it. In a
browser it is the session's cookie (`__Host-`: Secure, HttpOnly,
SameSite=Lax), which the browser sends and no script reads, so a script
that should not be on the page cannot carry the session off: the Remote
hands a page no token, ever (`why/remote/people/auth.ts`), and the browser's core
sends the cookie with its own requests. A device (the app, why) holds a
bearer from the device flow, kept apart from everything a page reads
(`why/core/src/device/vault.rs`, never in Home's state, which a page reads and which
is synced): in the OS's own keyring (the Keychain, Credential Manager on
this computer alone, the Secret Service over D-Bus from Rust alone, so the
static why reaches it as the app does), encrypted at rest with what the
person signs in with and in no file a backup or a token-hunting program
comes across; where there is none that answers within a minute (a server,
SSH, a locked keyring), or `WHY_KEYRING=off`, a file only the person
reads (`<data>/secrets/`, 0600). `why remote sign-in` says which. The
app's page asks its Remote through the core (`remote_ask`), which sends
it. Home's state says only which session the
device is (its token unsigned) and whose. Either is taken only signed
(`token.signature`) with the Remote's secret: the token the database keeps
is no way in by itself, so a copy of the database opens no session. Which
Remote a device is on is changed only by signing in or out, never by a
page setting it. What a provider hands over at sign-in (its access and
refresh tokens) is kept encrypted with the same secret; nothing reads it.

What leaves this system is kept to what is said here:

- **Network.** The Prompt's guests have the network of a machine with only
  its loopback, as the device's Prompt has in its own network namespace: a
  program in it can reach nothing but its own processes. Local sockets
  (AF_UNIX: socketpair, a name on a path or in the abstract namespace,
  descriptors passed between processes) and TCP, UDP and ICMP to this
  machine's own addresses (127.0.0.0/8, ::1; a server and its client, as
  `openssl s_server` and curl are; ping) are channels inside its kernel
  (module/sods/runtime/linux/sys-net.ts), and what it is told of its network (netlink as
  `ip` and `ss` read it, the interface ioctls, /proc/net) is that machine's:
  lo alone (module/sods/runtime/linux/net-view.ts). Every other address is no one's to
  bind (EADDRNOTAVAIL) and unreachable (ENETUNREACH), and every other family
  is refused as a host without it refuses it (EAFNOSUPPORT).
  module/sods/test/runtime/boundary.test.ts holds the line, and module/sods/test/programs/inet.c and
  icmp.c compare with native. The page itself
  may reach its own origin, the Remote and, for the box's Agent, the APIs of
  the models' makers whose keys it knows (agent/makers.ts), nothing else: the
  web build carries that Content-Security-Policy, and the desktop's (Tauri's)
  says the same. The Agent's key goes only to its own maker, from the page. A page the Remote names to go to (a provider's, Checkout, the
  portal) is followed only when it is a web page: https, or http on this
  machine (connection.ts leaveFor); the desktop opens only Stripe's or the
  Remote's own (account.rs). The Remote answers only the app's origins. From the host (the app
  and why: the Remote, a release, a distribution's root) it goes one way
  (why/core/src/device/net.rs), taking of the host only what the machine already
  decided: its proxy (HTTPS_PROXY, minus NO_PROXY, never for the machine
  itself) and the certificates it trusts (its store or SSL_CERT_FILE,
  beside the bundled ones).
- **The root.** In the app a Prompt is the distribution's root in a box
  muk makes (`why prompt` says what it lends, why/core/src/prompt/start.rs;
  ricebox writes the bundle and runs `muk run` on it, module/ricebox/src; module/muk), by this machine's
  kernel without privilege: a user namespace makes the user root inside
  it only; its own mount, pid, ipc, uts and network namespaces (no
  network unless granted); the root read-only, the repo the only
  writable place of the person's, fresh `/tmp`, `/run` and a minimal
  `/dev` with terminals of its own (a devpts made for each Prompt,
  holding only the ptys opened in it, none of the host's sessions); an
  environment set, not inherited (no host home, keys, agent or
  variables); and muk's filter (module/muk/src/filter.h) over all of it,
  from its program's first instruction, so the kernel answers none of what a
  sandboxed program has no use for and escapes are found through: ptrace,
  mounting, new namespaces, modules, kexec, bpf, perf, keys, userfaultfd,
  io_uring, typing into the terminal it was started from (TIOCSTI) (strace and gdb do not run in a Prompt; a shell, compilers,
  package managers and a granted network do). A program that opens a
  terminal of its own (posix_openpt, openpty, `/dev/ptmx`) gets one of the
  Prompt's, which works as a terminal does (a session of its own, job
  control, Ctrl-C, Ctrl-D): apt runs dpkg on one, so it says nothing of a log
  it could not write; `script` and `tmux`, where the root has them, run a
  shell on theirs. What is not there is the host's: no pty of another
  session is in the Prompt, TIOCSTI is refused on these as on the terminal it
  was started from, and vhangup is refused (a getty or login that hangs a
  terminal up does not run). Pid 1 is a small init that reaps
  everything and ends what is left with the shell, and it dies with its
  supervisor. The root itself is installed only from a pinned release,
  checked by digest before it is read, unpacked refusing anything that
  would land outside, go through a link or be a device. It is fetched from
  the Remote this device uses, then the publisher's Remote, which each of
  its deploys fills with every root pinned in `why/core/src/root/pins.rs`
  (`why/remote/bytes/mirror.ts`), and last from the GitHub release, which answers
  only while the repository is public; when none has it, the error says
  what each said.
- **Host.** The app starts no host program for a repo: history is the
  Remote's, and a repo's own tools (git among them) run inside the root.
- **Files.** The data directory and its settings are the user's alone (0700,
  0600). Writes go to a new temporary next to the file and are renamed over
  it; `.git` is refused in every spelling and through any symlink, from the
  webview, from `why` and from the Prompt's write-back.

### The Remote

However the OS is reached, in a browser, the desktop app or why, some of it
is the Remote's and stays so: who someone is (a provider's identity, then
passkeys; the app and why come in by a code a browser approves, each device a
session any other can end), the canonical copy of each repo and its
history, Home's settings, names, the Inbox and servers, and which devices
listen for SSH (that they do, and to whom; never where). Running natively moves the OS onto the device, not these:
they are what every device agrees through. Its rows and its files are
apart: Postgres holds everything said here, the bucket only file contents,
and a Remote without a bucket does all the rest and says plainly that it
cannot hold files now, so a device keeps its work until it can. Each part,
its routes and tables, and what the app and why need of it that a page does
not: `why/remote/README.md`.

### The plan: the Remote decides what an account may do

Billing lives on the Remote. The Remote alone decides what an account may
do (`why/remote/plan/plan.ts`); every client, the web app, the desktop app and why,
only shows what it says (Remote → Plan, `why remote plan`) and asks. No
client counts, guesses or greys out on its own.

Free, and three tiers one pays for (`PAID`), each keeping more than the
last; what any tier adds to free is the same three things:

| | Free | Go, $7 a month | Pro, $14 a month | Max, $19 a month |
|---|---|---|---|---|
| repos on a device | never limited | never limited | never limited | never limited |
| what the Remote keeps | 3 repos and 100 MB (the deployment's `FREE_REPOS`, `FREE_MB`) | 50 GB, repos as many as fit | 256 GB, repos as many as fit | 512 GB, repos as many as fit |
| servers | joining when asked, writing in them | making them too | making them too | making them too |
| names | one on the Remote (`ren`) | 5 on the Remote, and names on one's own domain (`ren@ren.dev`) | 10, and on one's own domain | 20, and on one's own domain |

Every account is bounded by its room as well (`QUOTA_MB`), whatever its
tier: a deployment that sells the tiers sets it at or above the largest.

What counts is read from what the Remote holds, never counted beside it:
the account's repos on the Remote (those turned off among them, still kept)
and its room (`room.used`: its files, every version history names, its
trees and reviews), kept by the database's triggers in the same statement
as each row, and counted again from the rows by the daily sweep, so it
cannot drift. Each rule is one function, called by the one route it guards:
a new repo and a draft that grows (PATCH draft), making a server, claiming
a name. Going over never loses or blocks local work: the Remote refuses
only what would exceed (a new repo past the allowance; a change that makes
a draft larger while the account keeps more than the allowance), with 402,
the rule, the tier it is about and the way to the plan, and the app and why
keep the work on the device and say it waits (it is asked again every few
minutes, and goes the moment there is room or the plan is paid, or goes up
a tier). A change that does not make a draft larger (an edit of the same
size, a removal, a commit) is always taken, however much is kept.

**When a subscription ends, or goes down a tier**, nothing is taken away
and nothing is made read-only: servers go on with their people, boards and
talk; names on a domain go on answering while its DNS says so, and names on
the Remote stay theirs; every repo the Remote holds stays, read
and written. Only what would be new is refused: a server (ended), a name, a
repo past the allowance, a draft growing while over it. This is the least
surprising rule: what a person made while paying is theirs as it was;
paying again, or more, lets it grow.

**A payment that fails** leaves the plan paid for 14 days from the first
failure (`GRACE_DAYS`; Stripe retries meanwhile), and the Plan says until
when; then it reads as free until a payment goes through. A subscription
whose period ended more than that long ago without word of its renewal
reads as free too.

**Stripe** sells it, when the Remote has its keys: a price for each tier
(`STRIPE_PRICE_GO`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_MAX`; a tier without
one is not sold there), a Checkout session for the tier chosen, the
customer portal to change the card, see the invoices and cancel, opened at
the step that changes the tier when another is chosen on the Plan (Stripe
says there what it costs now, and asks), and a webhook
(`/v1/stripe/webhook`) whose every event is checked against the webhook
secret, taken once by its id (one sent again changes nothing) and in the
order Stripe made them (an older one arriving later changes nothing). Which
tier an account is on is read from its subscription's price as each event
comes, so a change made in the portal is its allowance at once; one
subscription an account, so another tier is always a change of it, never a
second Checkout. Without the keys and a price billing is off: the free
allowance still holds, and the Remote says paid features cannot be bought
here yet. A Remote given no plan (a Remote of one's own, development unless
asked, a Remote for research) has no allowance at all.

**Stripe's stand-in** (`why/remote/plan/devbilling.ts`), on a Remote of one's own
asked for the plan (`WHY_PLAN=1`) and the selftest's, looks and does as
Stripe's pages do in test mode, so the way from the Plan to paying and back
is the one people meet; it is Stripe's look, not this language's, and says
on each page that it is a stand-in and nothing is charged. Checkout: the
tier, its price and what it keeps at the left; email, the card (its number
in groups as it is typed, an expiry, a CVC, each checked as Stripe checks
them), the cardholder's name and country at the right, under a TEST MODE
badge; Stripe's test cards (4242 4242 4242 4242 pays; 4000 0000 0000 0002 is
declined, said under the card, and nothing is sent; 4000 0025 0000 3155 asks
for 3-D Secure first, a page with Complete and Fail as Stripe's test page
has); Back is the app's cancel page. The portal: the tier and the next
payment, changing the tier (up, the rest of the period charged; down,
credited), the card (the same form and test cards), the invoices, cancelling
at the period's end and Renew plan to keep it, and, marked as not Stripe's,
test controls (a payment fails, a payment goes through, it ends now). Each
step sends the Remote the events Stripe would, signed, before the page goes
on. The development sign-in provider (`why/remote/people/devoauth.ts`) asks as a real
one does: a name, then what why asks of it (your name and email), Allow
or Cancel; Cancel comes back with the error a provider sends then.

