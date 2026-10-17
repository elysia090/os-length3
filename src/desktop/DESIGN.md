# Design language

Plain and direct. Not luxurious, not "high tech", not boring: what you see
is what is there, and every control looks like what it does.

This document goes from what every page shares to what is one page's own:

- **Part I, common to every page**: the language (§1), its tokens (§2),
  the pieces every page is built from (§3), and what breaks the language,
  each with what to do instead (§4). A new page is made of §3's pieces; a
  piece that is not there is added to §3 first, never made up in one page.
- **Part II, what the OS is under the pages**: the first principles (§5),
  which a new feature asks before it asks anything else, and the one OS
  the GUI and the command line both reach (§6).
- **Part III, each place in turn**: the rail (§7), then each page (§8),
  written only as what that page adds to Part I.

# Part I. Common to every page

## 1. Language

One rule per thing, applied everywhere, with no exceptions made by eye.
Every value in `styles.css` comes from a token (§2).

- **Shapes.** A place you go to (rail item, card, tree row) is a rounded
  square. An action you press or a choice you make (button, template
  choice, repo chip, +) is round. A field
  you type into is slightly rounded and filled `raised`.
- **States.** Hover is a `raised` fill. The current or chosen thing is an
  `ink` fill with `ground` text: the rail item (File while its tree is
  out), the repo chip, the open repo in the tree, the chosen template, the primary button. A large place
  (a card, an issue row) is too big to fill with ink: it is current by an
  `ink` edge over `raised`, as a lit repo card is. Focus is a 2 px
  `ink` ring. Nothing else marks state (no underline, no bold-only).
- **Selection** is the current-thing state too: `ink` with `ground` text,
  for selected text and for search matches.
- **Lines.** 1 px, except the box of a file being edited in Forge, which is
  a little heavier (1.5 px `edge`) because it is the work itself. `rule` between regions and around places; `edge` around
  things you press or type into. A dashed `rule` means one thing: room for
  something that is not here yet. Headings never get a rule.
- **Words over symbols.** What a thing is reads off the screen as it is
  written: a TODO kind shows as "Fix：", a link in `/bin` shows as the
  command's name only, with no arrows.
- **Room outside.** Everything, the rail and its icons included, sits a
  little inward from the window's edges: about 3% of the width at the
  sides (24–64 px), against the instinct to run to the edges. There is
  less room above (1.5% of the height, 8–16 px) than below (5%, 24–56 px),
  so the weight of the whole sits a little high.
- **One top line.** Every page starts on the same top line: a page's
  header, Home's profile, Forge's band and search box. The rail starts one
  place below it, so Home is not first off the mark, and + stands a clear
  step (40 px) under the places, a little below the middle.
- **Motion.** 120 ms fades, and one movement: the terminal flying between
  the right pane and the prompt box, 280 ms. Reduced motion turns them off.
- No shadows, blur, glow or gradients.

Every page:

- Starts with its head (§3), on the top line. Home's head is the profile.
- Fills the window. Reading pages keep their content within
  1200 px; work pages (Forge) use the whole width, and nothing to the right
  of the center is made small by default.
- Is in sections: a 15/600 heading directly above its content, 40 px apart.
  No rule under headings: the content's own edge (a box, cards) is the
  only line, so lines never double up.
- Scrolls. Nothing is squeezed to fit one screen: the TODO box
  is tall and repo cards are large, about three across.
- On a phone (560 px and less) keeps 16 px from the rail's line,
  and the window's own gutter is its right edge, so the two never stack.

## 2. Tokens

| Role | Value | Use |
| --- | --- | --- |
| `ground` | `#DADAD5` | every surface: a touch lighter than the first `#D2D2CD`, still grey, so long hours stay easy |
| `ink` | `#292B2A` | text, icons, the current thing, primary action (10.2:1 on ground) |
| `rule` | `#989B96` | dividers, outlines of places; decorative only (2.0:1, kept as before) |
| `sub` | `#56595A` | secondary text (5.0:1) |
| `edge` | `#6B6E6B` | outlines of fields and controls, which must be seen (3.7:1) |
| `raised` | `#E4E4E0` | field fill, hover (the same small step above ground as before) |
| `done` | `#2F7D4F` | the done mark: a step of an issue's work is done |
| `marker` | `#F3E27A` | a line marked in review, as with a highlighter |
| `off` | `#B3412F` | a repo turned off: its switch |

No other colours; the last three each mean their one thing only.

Type: the system sans; monospace only for paths, code and the terminal.
Sizes 28 (identity), 24 (page title), 20 (card title, figures), 15 (body),
13 (meta).

Space: 4, 8, 12, 16, 24, 40. Radius: 8 fields, 12 places, round actions.
Heights: 40 controls, 32 list rows, 48 rail places. Icons 24 with a 1.6
stroke (the tree's triangle is the one 12 px icon).

## 3. Shared pieces

Every page is made of these, and each looks and behaves the same wherever
it is. A page's section in §8 names the pieces it uses, and says only
what is its own.

- **The page head.** Icon, title (24/700) and one short role line in
  `sub`, on the top line. Home's head is the profile. An overlay (File,
  Server) has no page head: it is laid over the page whose head is there.
  A step within a page that stands in the page's place (Server's gear, a
  repo shown in Server) has the same head: its title, a line in `sub`, and
  its way back (Done) at the right.
- **The band.** What is out to work on, on the top line: + first (round,
  an `edge` outline, `sub`), then each thing as a round chip, the current
  one an `ink` fill. Forge's repos, Server's servers.
- **Parts.** A page whose parts are unrelated shows them as a switch of
  round headings, each with a bare count, the chosen one `ink`; only its
  part is shown, so a page never becomes one long scroll. On a narrow
  window the switch slides sideways and keeps the chosen one in view.
  Remote's page, Server's gear.
- **Cards.** A place you go to or a thing you act on: a rounded square
  with a `rule` edge, its title (20/600) on top, a line or two in `sub`,
  what can be done at its foot (the main deed at the right). Home and
  Remote have large cards, about three across; Runtime and Server's gear
  small ones (15/600 title), about four across. Cards lie on the ground,
  never inside another box.
- **The dashed card.** Room for something that is not here yet, and the
  way to make it: a card with a dashed `rule` edge and a quiet word in its
  middle (New repo, Add someone you know). Pressed, it becomes the card it
  makes. A dashed box with a quiet line is also the empty state: nothing
  here yet, said once, in the place where it would be (the center), as
  wide as its words. A pane beside it with nothing to show says nothing:
  it is empty until there is something in it.
- **Asking in the card.** One way to ask before doing what cannot be
  undone at once or reaches past who sees it now: the card gives way to
  what will happen, in short lines broken where the sentence breaks
  (trip:notes として誰でも見られます。 / あなたの名前は出ません。), Not now at the
  left and the deed at the right (Show, Remove, Delete). The card keeps
  its size while it asks, and the answers come at its foot, where its own
  buttons were; the card comes back if the answer is no. Narrowing again (closing,
  turning a share off) is at once.
- **The switch.** A setting that is on or off: a round track with a knob,
  on at the left in `ink`, off at the right. Off as the usual state is
  quiet (`plain`); off as a repo turned off is `off` red. Its label is a
  word or two beside it; what turning it on will do is said in the ask.
  Things that reach past their owner have the same pair wherever they are:
  to the server's people, and to everyone (a repo shown in a server; a
  board, always its people's, has the second and guests). Nothing that
  starts by being used has a switch to start it (a Prompt starts when one
  writes to it, and says so in its place when it has ended).
- **Buttons.** Round, 15/400 on an `edge` outline; the primary one an
  `ink` fill. Small buttons (32 high) in cards and rows. Never a bare
  underlined word.
- **Fields.** Slightly rounded (8), filled `raised`, an `edge` outline,
  a placeholder that says what goes in it.
- **The box at the foot.** One field near the bottom of a work page,
  saying where what is written goes (notes で実行, 旅行 の人たちへ): Enter
  is a new line, Ctrl+Enter (⌘+Enter) sends, as in every box one writes in
  (Inbox too). Forge and Git run in it; Server posts.
- **The right pane.** Beside the center, past its one `rule`: on top what
  the center refers to (Forge's reference, Server's people and repos),
  headings 15/600 in `ink` as Prompt's, a list under each; with nothing to
  show, nothing (no line saying what will appear once a repo is open). It
  only shows; what changes it lives with the thing it changes.
- **Boxes side by side.** One thing at a time in full, its neighbours'
  edges showing with their mark only (# a board, + a new one), never a
  name cut short; ← → or an edge is the way to them. The current one has
  an `ink` edge, over `raised` when it holds no `raised` box of its own
  (Git's issues), on the ground when it does (Server's boards, which hold
  the TODO box). Git's issues, Server's boards.
- **One box in two panes.** A list at the left and what is chosen at the
  right, one `rule` between them, in a single box: Inbox, a repo shown in
  Server.
- **The TODO box.** Home's TODO and each Server board's, the same box:
  items written as "Kind：title", Enter for the detail, ○ when done, the
  date at the right whether a line has a kind or not. On Home it is tall;
  in a board, as tall as its items up to about a third of the board.
- **Overlays.** File and Server are operations, not pages: laid over the
  page that is showing, brought out by resting on the icon (it stays a
  while after the pointer leaves) or by a press (it stays), put away by
  Escape, a press outside, or a second press.

## 4. What breaks the language

Each of these has been made, and each is wrong wherever it appears. The
fix is always a piece from §3, not a new rule.

| Instead of | Do |
|---|---|
| Cards inside a card (the gear's sheet framed as one box) | Cards lie on the ground, under the page head |
| An underlined word as an action (Leave this server) | A round button, or a card with its deed at its foot |
| A rule under a heading, or between a heading and its list | Space; the content's own edge is the only line |
| Monospace for names (people, servers, repos) | The sans; monospace only for paths, code and the terminal |
| A sentence as a switch's label | A word or two; the sentence goes in the ask |
| Two ways to confirm (a button that changes its word, a box under the row) | Ask in the card |
| A name cut short at an edge (a neighbour's title) | Show the mark only, or nothing |
| + after what it adds to | + first, as the band has it |
| A small grey heading on one page, a 15/600 one on another | 15/600 `ink`, everywhere |
| An empty state as a plain line of text | The dashed box with a quiet line, where the thing would be |
| A dashed box as wide as the page around one line | As wide as its words |
| Every pane saying what will appear once something is done (repoを開くと出ます, 帯にrepoを出すと動きます) | Said once, where it is done (the center); the other panes are empty |
| A paragraph explaining the screen | The word on the thing; what will happen, in the ask |
| A sentence broken where the card ends (名前 / は出ません) | Short lines, each broken where the sentence breaks |
| Answers right under the question, high in a card that shrank to ask (やめる, 見せる) | The card keeps its size; the answers sit at its foot, where its own buttons were |
| The browser's own colour (a blue checkbox) | `ink`, as anything ticked or chosen |
| Words of two sizes centred in one row (sora and オーナー a pixel or two apart) | They share a baseline; a face or an icon beside them is centred |
| A hidden label beside a line taller than the line (a run's posts spaced 32, 37, 37) | Nothing beside a line is taller than it: one rhythm down a run |
| A button not centred on its row's title (Done below 旅行's middle) | The title and its line share a baseline; the row centres the button on them |
| One thing reaching past its owner in two different ways (a repo's lone "everyone" switch, a board's pair) | The same pair everywhere: to the server's people, to everyone |
| Enter sending in one box and making a line in another | Enter is a new line, Ctrl+Enter sends, in every box |
| A switch to start what starts by being used (the Prompt's) | None: using it starts it; an ended one says so in its place |
| Changing a shared piece to fit one place (the TODO box made boxless in a board) | The piece as it is; the place makes room for it |
| A colour, gradient, shadow or glow for emphasis | None: `ink`, `raised`, the edge, and size do it |
| A new piece made up for one page | The piece from §3; if none fits, add one to §3 first |
| Made-up names with random letters in examples and screenshots (sora4fdw) | Plain names (sora, trip, notes): names are first come and codes are unique, so nothing needs masking |

# Part II. What the OS is under the pages

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
  (30 days), a guest's code (10 minutes), a device's session.
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
| `system/<digest>` | each root held, `current` the one in use | while a repo's Prompt runs on it |
| `envs/<repo>`, `caches/<repo>` | the repo's environment and caches | as in the table above |

### Names: who owns what, and what is trusted for it

Trust is built up in steps, each resting on the one before, and each
trusted for one thing only:

1. **GitHub, Google or Apple** say who a person is, the first time.
2. **A passkey** is then the person's own key: from there on they sign in
   without the provider, and a turn-off or a new device asks for it. A
   device holds a lease on the person, never the person.
3. **The Remote** keeps what is theirs and gives them a name, `ren`: first
   come, theirs for five years at a time, renewed by them (a Renew near the
   end of the term; not renewed, it is held for them 30 days, then anyone's).
   It is a name on this Remote, not a domain anyone holds: it is kept as
   `ren@length3.com` only because that is where it is kept, and is shown
   alone. With it comes a **code**, six digits (`204816`), to be found by
   when a name is hard to say or spell: given once, never given again, so a
   code that reached someone goes on meaning them or no one. Most people stop
   here, and need nothing more.
4. **A server** is a group of people on a Remote, with a name and a code of
   its own in the same namespace (`trip`), on the same terms, renewed by its
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
the same namespace, so `ren` and `trip` cannot be the same name. A person may have several addresses: aliases of one principal, one
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
and writes nothing in it.

Written the same in l3 and in the app, owner first, as scp is:

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
| a name on the Remote (`ren`, `trip`) | its account, or the server's owner | its Remote, for five years at a time | not renewed, or let go: 30 days no one else can claim it; its owner may take it back |
| a name on a domain (`ren@ren.dev`) | its account, or the server | its domain's DNS | let go: 30 days held as above |
| a code (`204816`) | its principal | its Remote | never given again |
| a repo | a principal | its Remote, and the digests | turned off: 30 days, then gone |
| a server | its people (its owner removes it) | its Remote | removed, or its last person leaves: 30 days, then gone |
| a repo shown in a server | its owner, lent to the server | its Remote | taken off, or its owner leaves the server: at once |
| a repo's public name (`face:name`) | its owner, under a face | the face (the server, or the owner's address) | taken down, or the face goes: 30 days no one else's repo answers to it |
| a board, its talk and TODO | its server | its Remote | with its server, or removed |
| a copy on a device | the device | the digests | taken back whenever room is wanted (owned.rs) |
| a session, a code, a guest | the person, the address it was sent to | sign-in, mail | a lease: days for a session, minutes for a code, 30 days for a guest |

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
(`ren@ren.dev`); the name on the Remote stays theirs while they renew it.

### Another OS in a Prompt

l3 is to a Prompt what a machine monitor is to its guest: it lays out the
places above and stays outside. The guest sees a plain Linux (its own `/`,
`/proc`, `/dev`, its own package manager writing to its environment) and
nothing of l3 that it did not ask for. l3's own root is the rescue shell
and more (BusyBox, git, a compiler, l3 itself); under another OS (Ubuntu,
Debian, a root of one's own) all of that hands itself back: only the l3
command comes in, from outside the guest's tree, and the guest's tools,
names and `/etc/os-release` are its own.

## 6. One OS, two ways in

The GUI and the command line are two ways into the same things. `l3`'s
nouns and order are the rail's: Home (`todo`), Forge (`repo`, `prompt`),
File (`file`), Git (`issue`, `start`, `commit`, `push`, `change`, `reset`, `review`, `merge`, `log`), Runtime (`runtime`, `free`),
Remote (`remote`, `login`, `sync`); a path is written as File shows it (`/root/<repo>/…`). A line is
named the same way everywhere ("Fix：件名"), issues are the same numbered
files, and Home's state is the same files, so anything done in one shows in
the other. The Prompt's shell works on the repo itself: what it changes is
written back, and what is saved elsewhere comes in.

### The canonical copy is on the Remote

As with GitHub, the copy that counts is the Remote's, and work on a device
is not trusted until it is there; here that reaches to the whole OS. A
repo on the Remote (`service/`) has two things:

- **draft**: the working tree as it is now, path → the sha256 of the file.
  It has a version, and a change is a diff made on a version: one that
  names an older version is refused with the draft as it is, so nothing
  sent is ever overwritten.
- **head**: the last commit. Commit makes the draft at a version a commit, named
  by the sha256 of its record (tree, parent, words), and moves the head by
  compare-and-set.

So a device's copy is never the only copy, and history stays deliberate.
Every change made here (in Forge, by l3, by a Prompt) is sent as a diff
within half a second; the Remote's changes are seen within five seconds
and whenever the window comes back. Taking in is file by file against the
version last agreed: a file only changed there is written here, one only
changed here is sent, and one changed on both sides keeps this device's
and puts the other's beside it as "name (別の端末).ext", so neither is lost.
Files that cannot travel (a link, a file over 16 MB, a repo's own `.git`)
are named and never sent; a repo holding them is never let go. Home's
settings (profile, TODO) are kept there too, each changed only from the
version it was read at (two TODO lists are joined); the band is the
device's own.

What each host keeps, and when (lifecycle.ts):

|             | comes by itself | goes by itself |
|-------------|-----------------|----------------|
| OS          | web: l3, fetched each visit; app: the root, when installed | web: with the tab |
| repo        | the Remote's changes, as they happen; one only on the Remote, when opened | each change, to the Remote at once; web: the copy, with the tab, once the Remote has all of it |
| Home        | at start and when the window comes back | each change, at once |
| Prompt      | when a repo opens | its processes, when closed |

Room on a device is given back in Runtime (空ける): a repo that goes stays
on the Remote and comes back when opened.

**No sync verb.** Keeping in step is not something a person does: every
change goes to the Remote as a diff by itself, and the Remote's come in by
themselves (the app within seconds, l3 when a command reads the repo).
What a person does to the Remote is only taking a repo off it (with a
passkey, kept 30 days). Git's verbs (commit, push, review, merge) are
about history; none of them is how files get to the Remote, so the two
never mix in the words or the buttons.

**Who.** One signs in the usual way, with GitHub or Google, and then adds
a passkey for the device, so the next sign-in needs no provider; a lost
passkey is replaced by signing in with the provider again. The app and l3
do not hold passkeys: they show a code, a browser where the person is
signed in approves it on the Remote's page, and the device gets a session
of its own. Every device is a session, listed on the Remote page and ended
from any other. Sessions are bearer tokens, kept on the device (in the app
with its settings, 0600).

What leaves this system is kept to what is said here:

- **Network.** The Prompt's guests have no sockets: every socket call answers
  "not implemented", so a program in it can reach nothing. The page itself
  may reach its own origin and the Remote, nothing else: the web build
  carries that Content-Security-Policy, and the desktop's (Tauri's) says the
  same. The Remote answers only the app's origins.
- **The root.** In the app a Prompt is the distribution's root, run by this
  machine's kernel without privilege (`l3 prompt`, core/src/launch.rs): a user
  namespace makes the user root inside it only; its own mount, pid, ipc,
  uts and network namespaces (no network unless granted); the root
  read-only, the repo the only writable place of the person's, fresh
  `/tmp`, `/run` and a minimal `/dev`; an environment set, not inherited (no
  host home, keys, agent or variables). Pid 1 is a small init that reaps
  everything and ends what is left with the shell, and it dies with its
  supervisor. The root itself is installed only from a pinned release,
  checked by digest before it is read, unpacked refusing anything that
  would land outside, go through a link or be a device.
- **Host.** The app starts no host program for a repo: history is the
  Remote's, and a repo's own tools (git among them) run inside the root.
- **Files.** The data directory and its settings are the user's alone (0700,
  0600). Writes go to a new temporary next to the file and are renamed over
  it; `.git` is refused in every spelling and through any symlink, from the
  webview, from `l3` and from the Prompt's write-back.

# Part III. Each place in turn

## 7. The rail

- Icons only, top to bottom, the order of one's own work: **Home** (who
  you are, what you are doing) → **Forge** (where you work; a terminal
  icon) → **File** (the tree of "/") → **Git** (what happened outside) →
  **Runtime** (the environment) → **Remote** (the canonical copy) →
  **Server** (the people you know, on the Remote: the one purpose whose
  subject is people, not a repo; under the cloud, as it lives there) →
  **Inbox** (what was sent to you). **+** (a new repo)
  comes right under them, a step apart, and is round because it starts
  something rather than opening a place (§1, shapes).
- A name appears beside an icon on hover or keyboard focus. Choosing an
  icon replaces the whole page; nothing pushes in beside the rail. File and
  Server are the operations: each is laid over the page instead (below).
- The rail is 78 px wide: the icons keep 18 px to its line and 12 px to the
  window's side, so they do not crowd the line.
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke; + is a 40 px
  round button with an `edge` outline. States as everywhere (§1).
- The person's own icon sits at the foot of the rail, a 44 px circle a
  little larger than the items: their initials, or a head and shoulders
  (30 px, filling most of it) before there is a name. Touching it brings
  out the way into every setting, in groups under a small heading and with
  no rules between them: Profile (View, Edit), Account (Sign in; once
  signed in, Sign-in, Devices), This device (Room, Environment), Language.
  Each entry is a word or two, the group saying what it is about. There is
  no settings page: a setting is kept with what it is about, so each entry
  ends with the icon of the page it opens (its name in the tooltip), and
  opens that part of it. It goes on leaving, a press outside or Escape.

## 8. Pages

Each page below says only what is its own; the rest is Part I.

### Home

A profile, between a Twitter and a GitHub profile, that reads the same for
its owner and for anyone else; only the owner gets "edit". In order:
identity (avatar, name, @handle, bio, counts) → **TODO** → repos → posts.
TODO is the person's single list; repos do not carry their own inbox or
TODO files. An item is a first line named like an issue ("Fix：件名"),
then detail lines; Enter on an empty line starts the next item. Done
strikes through and fades the first line only.

### Forge

Where you work. The repos out to work on run as pills in a band on the top
line; the search box on the right sits on the
same line, with the reference's chips under it. ⊕ stands at the left end. One press brings every repo not on
the band out at once, on the right; this is not adding tabs one at a time.
Each pill comes off the band with its × (the repo itself is untouched).
With nothing left to bring out, ⊕ steps back. Opening a repo from File,
Home or a new repo puts it on the band. With every pill off, the
center says how to bring one out. The band is remembered on this device. Below the band the center is the open repo's files one after another,
an endless page scrolled like a browser and opened at the file chosen in
File. There are no tabs, no title, no index of links and no headings for
directories. The center is where editing happens: each file is a plain
text editor in its own roomy box (at least about half the window high, so
short files are not packed together; the page scrolls), a little heavier
line than the rest; a header with its place in "/" (`/root/<repo>/` quiet, the
rest plain), then line numbers in a quiet gutter beside the text, which is
itself the field (no box; the caret is the only sign). Typing saves on its
own a moment later, on leaving the file, or with Ctrl+S; the header says
something only when the file is not simply saved (未保存, or why it could
not be saved). A file read only in part (over 256 KB) or binary is never
written back, and says so. Tab types a tab; Escape leaves the text. In each directory README comes first, then the other
files, then the directories. The only line in Forge is the one between the
center and the right pane.

A prompt box, like the one for an LLM, sits at the foot of the center. What
is written there goes to the open repo's `sh` (Enter is a new line,
Ctrl+Enter sends). While the prompt is in use the terminal flies up from the
bottom of the right pane to just above the box (280 ms, one quick movement)
and the reference grows down into the room it leaves. The terminal's box
is labelled Prompt, after what one does there (the shell is BusyBox sh, so
it is not called Bash); leaving the prompt
(or Escape) sends it back the same way. The Prompt has no switch: writing
to it starts it, and one that ended says so in its place, with Start
again; stopping one is Runtime's.

The center takes three quarters of the width; the right pane takes one
quarter (at least 280 px) so it never gets in the way. Its bottom is the
terminal's home, and it starts above the middle (the reference takes 2
parts, the Prompt 3): the reference scrolls and the Prompt does not, so the
eye should not have to drop low to find it. On the band's line sits the search box for the open
repo: plain, case-insensitive, line by line; results are grouped by file,
and a line pressed opens the center there with the line selected. Below,
on the band line, one reference at a time, switched freely with chips: Issue (the repo's `issue/`, one file each), diff (the changes not yet
cut, file by file: added lines raised, removed lines quiet and struck,
following every save; desktop only, as git is) and 実行結果 (each line sent
from the prompt box, newest first: the line, how long it took or that it
is still running, and what came out until the prompt returned; the Prompt
itself scrolls on, this keeps the record). The Prompt's own status line is
empty while it simply runs; it speaks only when something is missing (large
files and binaries not copied in, what could not be written back). The chosen reference is remembered on this device.

The Prompt never goes silent while something takes time:

- **Coming up.** The first Prompt of a visit fetches l3 (2.7 MB) and says how far it
  is (`l3 を読み込み中 1.5 MB / 2.7 MB`). When the line goes quiet it counts
  the seconds (`応答待ち 4秒`); at ten it counts as broken and is taken up
  again from the byte it reached (`回線が止まりました。続きから読み込みます`),
  the same after a cut or a server error, a few times with growing waits.
  What came stays for もう一度起動, and later Prompts in the page use it at
  once. Nothing of it stays on the device: it is the OS, and its copy is
  the release's (the app has it beside itself).
- **Running.** A line done within two seconds says nothing. Past that, under
  the output: `実行中 N秒` with 中断 (Ctrl-C in the prompt box, when nothing
  is selected, does the same); `入力待ち` with 中断 when what runs reads
  input (whatever is typed in the box goes to it); `出力なし` after five
  quiet seconds; and after ten, 止めてやり直す, because a worker busy in a
  loop cannot hear 中断, and only a new shell is sure. 中断 ends what runs
  in front of the shell as SIGINT would, and the shell goes on (`$?` is
  130).

### Runtime

この端末 first, then what can go from it, then what is running, then the
environment actually in effect (what runs, not what was asked for). There
is no table of policies: what the device holds is shown as things, and
each thing says what can be done with it.

- **この端末**: one bar of the host's whole, with this OS's share darker
  (not an ink fill, which means current), and three figures: this OS, free,
  total. This OS is counted from allocated blocks, so a sparse file counts
  what it holds and a file with several hard links counts once; the host's
  free and total are marked 推定, because other programs change them too.
- Under it, **one list, largest first**, of everything this OS holds: each
  repo, each root of the distribution, each leftover, Home. A row is the
  thing, its size, and at its end what can be done:
  - **空ける**: it is not needed here. A repo whose copy is what the Remote
    has (it comes back when opened), a root that is not the one in use (the
    Remote has the release), a temporary this OS left half-written
    (`.<file>.length3-<pid>-<n>`, a setting's `<key>.json.<pid>`, older than
    a minute, one link, never inside `.git`), an install that died half way,
    a release bundle or partial download not in use.
  - **空ける** on a repo with changes the Remote does not have yet: the
    same word, since they would go there anyway; they are sent first, and
    the copy goes only once the Remote has every file of it (its row says
    so).
  - **空ける** on what a repo's Prompts wrote outside it (§5): its
    environment (what its package manager installed; the plain root comes
    back), its caches (made again when needed), and what is derived inside
    it (node_modules, target, a venv: made again by the tool that made it).
    Each is its own row under the repo's name, so a repo's sources are
    never weighed together with what can be made from them. A repo no
    longer on this device leaves its environment and caches without an
    owner, and they say so.
  - Otherwise, quietly, why it stays: a Prompt has it open, it holds what
    cannot be sent (a link, a file over 16 MB, a `.git`), there is no Remote
    yet, it is the root Prompts run on, it is Home's settings.
  Under the list, 空けられるもの with its total and 全部空ける. Freeing stays
  to say what happened: the bytes removed (counted before removal), the
  host's free space as it was seen to change and how long it took to show,
  and anything kept with the reason.
- **動いている Prompt** is shown while one runs, a small card each (the
  size of Home's cards, smaller, so a few do not stretch across the page):
  where it runs (root, with its process count, or l3), the memory its
  processes hold (Pss, from the host's /proc), and 止める at its bottom right. On the root, stopping ends everything in the
  Prompt's pid namespace and is called done only once the host shows none
  left; the row then says what was given back and how long it took
  (止めました · 2.5 MB を返しました · 11 ms), or how many are still there.
- **有効な環境**: the environments a Prompt can run on, a row each: l3,
  Ubuntu, Debian, Custom (a root of one's own, known by its digest). The
  one in effect is the place (an `ink` edge over `raised`): l3, with its
  version, what it is here (in the app, the root installed, on this
  device's kernel; in a browser, the whole root through xlat, or l3 and
  its BusyBox) and its digest. The others are not here yet and say so,
  quiet and dashed, with where each could run: their programs are linked
  as they run, which a browser does not do, so in the app only.
- **SSH**, once there is an Inbox address: a small card per address with
  the power switch at its bottom right, whether it may be reached over SSH.
- **Dotfiles**: a small card each (its name, its size), and a dashed one to
  make another. A card opens its text under the cards, `/root/` and its name
  above it, Remove at the left, Close and Save at the right. Every Prompt
  starts with them in `/root` (the app's root and the browser's alike), and
  the Remote keeps them in step across devices, as it does Home's settings.

In a browser the same list is the browser's copy of the repos (このブラウザ,
its share an estimate), and the same three answers apply.

### Git

What happens between a repo and the outside, in the mental model of the
issues: an issue hides its branch and worktree, and the operations are
Commit, Push, Change (with Reset), Review, Merge. It uses the same workbench
as Forge: the center (one centred column, 760 px at most) with the prompt
box at its foot, and the narrow right pane with the search box, the
reference and the Prompt. The page header, then the repo chips (one repo or
all); choosing a repo also points the right pane and the Prompt at it.

- **Issues**: every issue not merged yet, read straight from each repo's
  `issue/`, one numbered file each (001.md, 002.md, …, in the order
  written), so nothing is kept twice. Under the heading (its count, and
  「Issue を書く」) the issues are large boxes side by side, oldest first:
  one in full, its neighbours' edges showing at the sides. The current box
  is a large place, an `ink` edge over `raised`. An edge is a clear button
  over the neighbour, which lifts (`raised`) while hovered; pressing it, or
  ← →, slides the track there (280 ms, the one movement). The first box
  starts at the column's edge and the last ends at it.
- **The box**: the issue's number and name ("#1 Fix：件名"), where it lives
  (`repo · issue/001.md`, which opens the file), its detail, one quiet line
  of who started it and when, and Start (Continue here, if it was started)
  or, while it is worked on here, Back to main. Start gives the issue its own
  copy of the repo, which File, Forge and the Prompt show; the layout says
  this, no sentence explains it. A merged work is done: the repo shows main
  again on its own, and the copy goes.
- **Each issue is a column**: its card, and once it is pushed, its Review and
  Merge under it, so they slide with it; the neighbours show only their
  cards' heads. The card's weight sits a little high (less room above than
  below).
- **Inside the card**, right under its title once it is worked on here:
  **Commit** and **Push**, one row each, the button at the left; done, the
  button's place shows the same word with the done mark (a circle with a
  check, `done`), and the green says it is done. Beside Commit, what is not
  committed (▸ 5 files); its diff opens over what is under it, so neither
  button moves. Pushing hands the work to main as its change, again as the
  next version; Reset at the Push row's right end takes it back while it is
  undecided. A change received from someone else shows Commit and Push done.
- **The card's foot**: where the issue lives (`repo · issue/001.md`, which
  opens the file) and who started it and when, at the left; its action
  (Start, Continue here, Back to main) at the right.
- **A diff**, wherever it shows: each file a fold, its name (which opens it)
  and what was added and removed (+56 −2); each line with which line it is.
  The first three files are open, the rest wait closed, so a large change
  reads file by file; it scrolls inside its box.
- **Review**, shown once there is a change to review: a box of its own
  under the card, the same `raised` with an `ink` edge: the change's diff,
  where a reviewer marks lines as with a highlighter (`marker`); what was
  said, in order (an approval without words is not shown there); then a
  comment more, in a field tall from the start (Ctrl+Enter or Comment sends
  it with the marks), and beside Comment, Approve as a ○ that turns green
  when pressed.
- **Merge**, under the Review and not in it: its button at the left, primary
  once the version is approved, who approved it, and Reject at the other end.

Every change is already on the Remote (the draft, §6); Commit makes it
history there, the same from the app, a browser and `l3 commit`. Without a
Remote the issues are shown and one line says that history is kept there.

### Remote

Signed out, the page is the header and one place in the middle of what is
left, the first thing a person meets: an `ink` edge over `raised` as the
current issue card is, its weight a little high, at most 440 px wide. In
it: Sign in, one line on what the Remote is, the ways in one under another
as wide as the place (the first provider filled), and the line for a lost
passkey. A device's code opens the same place on a page of its own, for
each step: the code, signing in, letting the device in.

Signed in: the header, a short offer while there is no passkey (one line and its
button, no wider than they are), then the page's parts as a switch (the one
place a page is switched, because its parts are unrelated):

- **Repos**: every repo the Remote holds, as cards the size of Home's: name,
  size and when it last changed, where it stands; Forge at the bottom left
  and a power switch at the bottom right. On, the switch's knob is at the
  left; turning it off asks, in the card, for the account's name, the
  repo's name and the five-letter code, then a passkey. Off, the knob is at
  the right on `off` red and the card is quiet (dashed): the Remote keeps
  the repo 30 days, answering only that it is off, and pressing the switch
  again brings it back at once. Its copy on this device goes with it.
  Beside Forge, who sees it, in a word (Only you, In Trip, Everyone);
  pressing it asks in the card: Only you, Servers (which, ticked), or
  Everyone, and as what (a server it is in, so nothing ties it to you, or
  your own address), each said in a line before it is saved.
- **Sign-in**: passkeys, the code to turn a repo off (five letters or
  digits, set with a passkey; only its digest is kept), then the providers
  (the last way in stays).
- **Devices**: each session; this one says so and signs out.

### Inbox

Your address as a stub: a field-sized place about as wide as an address,
the address in it (pressing it copies it, and it says Copied for a moment
in the same place; there is no Copy button), its gear at the right end.
Before there is one, the stub is the name to claim, with `@domain` after
it; Enter claims. The gear opens, over what is under it (Escape or a press
outside closes it), your own domain: name `@` domain, then the
one DNS record that proves it (`_length3.<domain>` TXT
`v=length3; remote=<host>; proof=<…>`, each part copied by pressing it).
The proof is the Remote's keyed digest of the account and the domain, so
only the domain's holder can publish it and no other account can reuse it;
it is looked for while the gear is open, and the address is claimed the
moment it is found. The same record says which Remote holds the domain's
addresses, as MX does for mail. SSH is Runtime's. Then one tall box: conversations on
the left (requests apart, with Accept and Block), the chosen one on the
right. Writing is one line that grows as it is written: a message is named
the way an issue is ("Review：…", "Question：…"), and a `/root/…` path in it
says what it is about, so there is nothing else to choose. Enter is a new
line, Ctrl+Enter sends.

### Server

Every other purpose is about a repo: one edits it, walks it, decides on it,
keeps it, sends it. Server is the one whose subject is people: the people
you know, to talk with and get things done together. Inbox is one
person to one person, about something that asks for an answer; a server is
a group, and nobody in it is asked for anything. A repo belongs to a person,
who may show it in a server: there it is only seen, as it was last pushed
(§5, Names). A server's own repos are what comes next.

A server is a name and its people. Someone already in it adds people from
their own Inbox contacts, so a server is people who know each other; anyone
may leave, the owner may remove someone, and the last to leave takes it
with them. Its boards are what its people talk about, each one thing (a
trip, a release, a reading group), and each holds two things:

- **the talk**: short posts, read as a conversation. Deciding what to do
  is talk too; there is no document to write together.
- **its TODO**: the same list as Home's, in the same box, written the same
  way (Kind：title, Enter for the detail, ○ when done), kept by its people
  together. It goes to the Remote item by item and field by field, a moment
  after the writing stops, so two people writing different items, or one
  ticking what another is detailing, never undo each other; only the very
  same field written twice keeps the last. A new item takes a place between
  its neighbours'. What others change comes in every little while, and
  waits while one is writing in the box.

How far a board goes is chosen board by board, and only ever wider by
choice: its server's people always; if opened, anyone reads it (signed in
or not); and if it takes guests, an outsider may write in it once they have
shown an email address is theirs, by a six-digit code sent to it (one a
minute, ten minutes to use, five wrong tries spend it). Everything is kept
on the Remote, and any board can be taken home as one text (its TODO, its
talk, or both), in the app or with `l3 server get`.

Server is an overlay (§3), on the bench's shape. Its pieces, from §3:

- **The band**: + to make a server, then the servers one is in; the gear
  at the right end of the top line.
- **Boxes side by side**: its boards, the last box making a new one. A
  board holds **the TODO box** at its top and its talk under it, with
  nothing switched to see one or the other. Outside the server an open
  board's TODO is shown, not written, and not at all while empty.
- **The box at the foot** writes in the board on screen (旅行 の人たちへ).
- **The right pane**: who is in it (face, name, owner), then the repos
  they show in it (name and whose). A repo pressed takes the boards' place
  with the page head (its name, whose, Forge when one's own, Back) and one
  box in two panes: its files, the one chosen (its README first), as it
  was last pushed.
- **Behind the gear**, in the boards' place: the page head (the server's
  name, its name on the Remote and code, Done), then **parts** of **small
  cards**: People (a dashed card to add someone one knows; its owner
  removes someone), Repos (each of one's own with **the pair of
  switches**, to its people and to everyone, seen by everyone as the
  server's; others' shown here, whose, its owner may take them off),
  Boards (to everyone and guests, its owner's; Remove, its owner's; Take
  home, anyone's), This server (its name, code and term, Renew near its
  end; Leave; its owner's Delete). Whatever reaches past its people or
  cannot be taken back at once is **asked in the card**.

Escape from behind the gear, or from a repo shown, goes back to the boards
first. No Prompt is in Server: Server is for people, the Prompt for a
repo. Signed out, it shows the open boards (and no right pane, since whose
they are is not told), and where a board takes guests the box at the foot
asks for an email, then the code sent to it.

The talk reads as a conversation: oldest above and newest at the foot. No
rules: a run of one address's posts within five minutes shows the face
(the address's first letters in a circle), the name, the domain (or guest)
and the time once, then each text under it, and the day's name, quiet and
centred, marks where a day starts. A post's writer, and the server's owner,
may take it down: it comes out at its top right on hover, round, and asks
once more in its own place for a moment. Nothing is counted.

The talk has no end to reach and nothing to press. It opens at the newest;
scrolled near its top, the next older posts are read in above without
moving what is on screen, and at the very top it says it is every post.
What comes meanwhile is put at the foot: followed when the foot is in view
(and always after one's own post), otherwise with a small ink pill (↓ 3 new
posts), which goes down to them. And it lets go by itself: posts far out of
view are folded into an empty box of the height they had, so nothing on
screen moves, and further still they let go of their text too, read again
by their range of ids when they come back near.

### New repo (+)

A name on one line (the same field as the search box), the template as
chips like the reference's (one chosen, ink), and what will be made shown
exactly as File will show it: a card of tree rows under `root`, the new
repo's name bold, its folders open. Then 作成, the one primary action.

Under the form is the list of repos, the same cards as on Home. Once made,
the page stays where it is: the new repo's card joins the list and lights
for a moment, the preview card says it is in File under `/root/<name>`, and
where 作成 was there is "<name> を作りました" with the ways on: Forge で開く
(primary; it goes on the band) and 続けて作る (a fresh form).

### File

An operation, not a page. Hovering the File icon (or pressing it) lays the
tree of "/" over whatever page is showing as a card right beside the rail:
its corner concentric with its rows (a row's 8 px plus the 8 px between
them: 16 px), only as tall as what is in it, its first row level with the
File icon. It has no "/" label of its own: the rows are what is in "/". While it is out, File is the one filled icon in
the rail; the page's own icon steps back until it goes. Nothing under it
moves. Once out it stays for 8 seconds after the pointer leaves,
so reaching across the page and back does not lose it; a press outside or
Escape closes it at once. Each time it comes out it is read afresh.

"/" is the root of the whole system, the same tree the Terminal's shell
sees, and the tree shows where each part comes from: `/bin` is the fetched
distribution (配布), `/dev` and `/proc` are made by the kernel, `/root`
holds the person's repos, `/etc` and `/tmp` start empty. `/root` is open at
first. A folder's triangle comes before its name, ▷ closed and ▽ open (one
outlined shape, turned). Inside a repo a name opens that place in Forge
(in place when Forge is showing, and the tree stays out); elsewhere it
opens and closes the folder. Open folders are remembered while the app
runs.
