# Design language

Plain and direct. Not luxurious, not "high tech", not boring: what you see
is what is there, and every control looks like what it does.

The rules below follow the order a person meets the app: the rail from the
top, then the page each icon leads to.

## 1. The rail

- Icons only, top to bottom in the order of the work:
  **Home** (who you are, what you are doing) → **Forge** (where you work;
  a terminal icon) → **File** (the tree of "/") → **Git** (what happened
  outside) → **Runtime** (the environment) → **Remote** (the canonical copy) →
  **Topic** (posts) → **Inbox** (what was sent to you). **+** (a new repo)
  comes right under them, a step apart, and is round because it starts
  something rather than opening a place (§4, shapes).
- A name appears beside an icon on hover or keyboard focus. Choosing an
  icon replaces the whole page; nothing pushes in beside the rail. File is
  the one operation: it lays its tree over the page instead (below).
- The rail is 78 px wide: the icons keep 18 px to its line and 12 px to the
  window's side, so they do not crowd the line.
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke; + is a 40 px
  round button with an `edge` outline. States as everywhere (§4).
- The person's own icon (initials in a circle) sits at the foot of the
  rail. Touching it brings out what comes before settings: the name, see
  the profile, edit the profile, this device's storage, and 設定 (not
  there yet, and it says so). It goes on leaving, a press outside or
  Escape.

## 2. Pages

- Every page starts with the same header: icon, title, and one short role
  line. Home is the exception: its header is the profile.
- A page fills the window. Reading pages keep their content within
  1200 px; work pages (Forge) use the whole width, and nothing to the right
  of the center is made small by default.
- Sections: a 15/600 heading directly above its content, 40 px apart.
  No rule under headings: the content's own edge (a box, cards) is the
  only line, so lines never double up.
- The page scrolls. Nothing is squeezed to fit one screen: the TODO box
  is tall and repo cards are large, about three across.

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
center shows Topic. The band is remembered on this device. Below the band the center is the open repo's files one after another,
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
is written there goes to the open repo's `sh` (Enter sends, Shift+Enter is
a new line). While the prompt is in use the terminal flies up from the
bottom of the right pane to just above the box (280 ms, one quick movement)
and the reference grows down into the room it leaves. The terminal's box
is labelled Prompt, after what one does there (the shell is BusyBox sh, so
it is not called Bash); leaving the prompt
(or Escape) sends it back the same way.

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
  - **同期して空ける**: a repo with changes the Remote does not have yet;
    they are sent first, and the copy goes only once the Remote has every
    file of it.
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
- **有効な環境**: in the app with a root installed, that root (name,
  version, size, files, digest), run by this machine's kernel. Otherwise
  l3, the one thing the browser's Prompt depends on, as one place: its
  version, size, digest; inside it, a step in, what it carries (the
  distribution's BusyBox, the l3 command, the xlat translator). In the app
  that row ends with 入れる: fetching the root from the Remote, saying how
  far it is.
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
- **Inside the box**, once it is worked on here, its steps from the top,
  one row each, the button at the left (its done mark, a circle with a check
  in `done`, in its place once done) and what it is about beside it:
  **Changes** (what is not committed; its diff opens over what is under it,
  so nothing moves), **Commit**, and **Push** (pushing hands the work to
  main as its change, again as the next version; Reset at its right end
  takes it back while it is undecided). A change received from someone else
  shows Commit and Push done already.
- **Review**, a box of its own under the issue's, as wide as it and lined up
  with it: the change's diff, scrolling inside it, where a reviewer marks
  lines as with a highlighter (`marker`); what was said, in order; then the
  procedure in its order: a comment more, in a field tall from the start
  (Ctrl+Enter or Comment sends it with the marks), and under it the verdict,
  Reject at the left and Approve at the right (once approved, its done mark
  in Approve's place).
- **Merge**, under the Review and not in it: its button at the left, primary
  once the version is approved, and who approved it.

Every change is already on the Remote (the draft, §3); Commit makes it
history there, the same from the app, a browser and `l3 commit`. Without a
Remote the issues are shown and one line says that history is kept there.

### Remote

The header, a short offer while there is no passkey (one line and its
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
says what it is about, so there is nothing else to choose. Enter sends,
Shift+Enter is a new line.

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

## 3. One OS, two ways in

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

Room on a device is given back in Runtime (空ける, 同期して空ける): a repo
that goes stays on the Remote and comes back when opened.

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

## 4. Language

One rule per thing, applied everywhere, with no exceptions made by eye.
Every value in `styles.css` comes from a token below.

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

## 5. Tokens

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
