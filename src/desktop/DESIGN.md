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

What this device holds and why, what can be given back, what is running,
then the environment actually in effect (what runs, not what was asked for).

- **持ち方**: one table of what comes by itself, what closing ends, and what
  goes to the Remote, as it is on this host (§3).
- **この端末**: one bar of the host's whole, with this OS's share darker
  (not an ink fill, which means current), and three figures: this OS, free,
  total. This OS is counted from allocated blocks, so a sparse file counts
  what it holds and a file with several hard links counts once; the host's
  free and total are marked 推定, because other programs change them too.
  Under it two cards of rows: each repo with its size and how much of that
  is history (`.git`), and the settings; then each root of the
  distribution with why it is here: 使用中 (Prompts run on it), 戻すために残す
  (the one before, kept so a bad update can be undone), 空けられる.
- **空けられるもの** is shown only when there is something, each named for
  what it is: the temporaries this OS itself left half-written (named
  `.<file>.length3-<pid>-<n>`, or a setting's `<key>.json.<pid>`, older than
  a minute, one link, never inside `.git`); older roots; an install that
  died half way; a release bundle or partial download not in use (fetched
  again from the Remote when wanted). Nothing else is ever offered. 空ける
  removes them and stays to say what happened: the bytes removed (counted
  before removal), and the host's free space as it was seen to change, with
  how long it took to show. What could not be removed is named with the
  reason.
- **動いている Prompt** is shown while one runs: where it runs (root, with
  its process count, or l3), the memory its processes hold (Pss, from the
  host's /proc), and 止める. On the root, stopping ends everything in the
  Prompt's pid namespace and is called done only once the host shows none
  left; the row then says what was given back and how long it took
  (止めました · 2.5 MB を返しました · 11 ms), or how many are still there.
- **有効な環境**: in the app with a root installed, that root (name,
  version, size, files, digest), run by this machine's kernel. Otherwise
  l3, the one thing the browser's Prompt depends on, as one place: its
  version, size, digest; inside it, a step in, what it carries (the
  distribution's BusyBox, the l3 command, the xlat translator). In the app
  that row ends with 入れる: fetching the root from the Remote, saying how
  far it is. Then Dotfiles as differences from the root (none yet, and it
  says so).

In a browser only the origin's share is known, and it says so (このブラウザ,
推定); nothing there is the OS's to give back.

### Git

What happens between a repo and the outside, in the mental model of the
issues. It uses the same workbench as Forge: the center (one centred
column, 760 px at most, so the form, the rows and the prompt box line up)
with the prompt box at its foot, and the narrow right pane with the search
box, the reference and the Prompt. The page header, then chips to look at
one repo or all; choosing a repo also points the right pane and the Prompt
at it.

- **Issue** is the unit of work and talk. The list is read straight from
  each repo's `issue/`, one file per issue, so nothing is kept twice. Each
  row is a place (a rounded box): the first line names it the way TODO
  items are named, kind and title ("Fix：件名"), then quietly where it lives
  (`repo · issue/001.md`) and the first line of its detail. Pressing a row
  makes it the current issue (an ink edge, as a large place is current): it shows in
  full on the right, with the way into its file in Forge, and the sections
  below turn to its repo. Pressing it again lets it go. 「Issue を書く」
  writes a new file in the chosen repo's `issue/`, numbered in the order
  written (001.md, 002.md, …; dates go in the text). A repo without
  `issue/` cannot take one and says so.
- **変更**: what is not yet cut into history, in the repo looked
  at, folder by folder (the folder first, so a reader enters from the area
  they look after), each file by a word (追加, 変更, 削除, 名前変更) and its
  lines added and removed; a file opens in Forge. It is a card of rows like
  the File tree. Under it, with an issue current, a note and the one
  primary action, 区切る: everything not yet cut becomes one cut named after
  the issue ("Fix：件名") and tied to its file (an `Issue: issue/001.md`
  line), so the history reads as the issues. The layout says this; no
  sentence explains it.
- **区切り**: the cuts so far, newest first, the current issue's only when
  one is chosen, one row each: name, folders, when.
- A section with nothing in it is not shown; counts are bare numbers.
- **提出された変更**: cuts handed to someone else (提出) and received,
  settled by Merge or Reject; Close is for issues only. Handing out between
  accounts is not built yet, so there is no 提出 button, and this says so
  in a dashed box instead of showing anything made up.

区切る is also the push (§3): in the app it is a commit in the repo's git
and then the same cut on the Remote; a cut that did not reach the Remote is
said once, under the button, and the repo stays 未 push. In the browser,
which has no git, the two sections appear once a Remote is joined: changes
are this copy against the cut it came from, and the cuts are the Remote's.

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
nouns are the rail's: `repo`, `file`, `issue` / `git`, `todo` (Home),
`runtime`; a path is written as File shows it (`/root/<repo>/…`). A line is
named the same way everywhere ("Fix：件名"), issues are the same numbered
files, and Home's state is the same files, so anything done in one shows in
the other. The Prompt's shell works on the repo itself: what it changes is
written back, and what is saved elsewhere comes in.

### The canonical copy is on the Remote

As with GitHub, the copy that counts is the Remote's, and work on a device
is not trusted until it is there; here that reaches to the whole OS. The
Remote (`remote/`) names everything by its content: a file by its sha256,
a cut by the sha256 of its record (the repo's whole tree, its parent, its
words). A repo there is only a head pointing at one cut, and it moves by
compare-and-set: a push whose parent is not the head is refused with the
head, so nothing pushed is ever overwritten. A device checks what comes
from the Remote against those names. Home's settings (profile, TODO) are
kept there too, each changed only from the version it was read at; the
band is the device's own.

A device holds a checkout. For each repo it knows the cut it came from (its
base), so a repo is always in one of four states, shown on Home's cards and
on the Remote page: **push 済み** (nothing here the Remote lacks), **未 push**
(with how many files: the only state that can be lost), **Remote が先**
(another device pushed; 取り込む takes it in) and **ここだけ** (never
pushed). Taking in is file by file against the base: a file only the
Remote changed is taken, one only changed here is kept, and when one
changed on both sides nothing is taken and those files are named.

What each host keeps, and when (lifecycle.ts, and Runtime's 持ち方):

|             | comes by itself | closing ends | goes to the Remote |
|-------------|-----------------|--------------|--------------------|
| OS          | web: l3, fetched each visit; app: the root, fetched once when installed | web: nothing of it is kept; app: stays | — (it is the release) |
| repo        | taken in at open (and when the app's window comes back) | web: its copy goes if pushed; app: stays | at each 区切る |
| Home        | taken in at open | web: goes if pushed; app: stays | on each change |
| Prompt      | when a repo opens | ends | — |

Unpushed work is never let go: in the browser it waits in this browser's
storage (asked to be kept) until it is pushed. An account is a token made
by the Remote and shown once; the Remote keeps only its digest. The token
is kept on the device (in the app with its settings, 0600).

What leaves this system is kept to what is said here:

- **Network.** The Prompt's guests have no sockets: every socket call answers
  "not implemented", so a program in it can reach nothing. The page itself
  may reach its own origin and the Remote, nothing else: the web build
  carries that Content-Security-Policy, and the desktop's (Tauri's) says the
  same. The Remote answers only the app's origins.
- **The root.** In the app a Prompt is the distribution's root, run by this
  machine's kernel without privilege (`l3 open`, core/src/launch.rs): a user
  namespace makes the user root inside it only; its own mount, pid, ipc,
  uts and network namespaces (no network unless granted); the root
  read-only, the repo the only writable place of the person's, fresh
  `/tmp`, `/run` and a minimal `/dev`; an environment set, not inherited (no
  host home, keys, agent or variables). Pid 1 is a small init that reaps
  everything and ends what is left with the shell, and it dies with its
  supervisor. The root itself is installed only from a pinned release,
  checked by digest before it is read, unpacked refusing anything that
  would land outside, go through a link or be a device.
- **Host.** Besides l3, git is the one program the desktop runs, and it runs with an
  empty environment (only PATH, HOME, LC_ALL and git's own switches), no
  global or system configuration, no prompts, and every setting that could
  make it run something else turned off (hooks, fsmonitor, pager, editor,
  ssh, credential helpers, external diff, signing, every remote protocol).
  A repo's own config cannot change that.
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

No other colours.

Type: the system sans; monospace only for paths, code and the terminal.
Sizes 28 (identity), 24 (page title), 20 (card title, figures), 15 (body),
13 (meta).

Space: 4, 8, 12, 16, 24, 40. Radius: 8 fields, 12 places, round actions.
Heights: 40 controls, 32 list rows, 48 rail places. Icons 24 with a 1.6
stroke (the tree's triangle is the one 12 px icon).
