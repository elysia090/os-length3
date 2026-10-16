# Design language

Plain and direct. Not luxurious, not "high tech", not boring: what you see
is what is there, and every control looks like what it does.

The rules below follow the order a person meets the app: the rail from the
top, then the page each icon leads to.

## 1. The rail

- Icons only, top to bottom in the order of the work:
  **Home** (who you are, what you are doing) → **Forge** (where you work;
  a terminal icon) → **File** (the tree of "/") → **Git** (what happened
  outside) → **Runtime** (the environment) → **Remote** (sync) →
  **Topic** (posts) → **Inbox** (what was sent to you). **+** (a new repo)
  comes right under them, a step apart, and is round because it starts
  something rather than opening a place (§3, shapes).
- A name appears beside an icon on hover or keyboard focus. Choosing an
  icon replaces the whole page; nothing pushes in beside the rail. File is
  the one operation: it lays its tree over the page instead (below).
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke; + is a 40 px
  round button with an `edge` outline. States as everywhere (§3).
- The rail starts 24 px down, so its weight sits a little low.
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

Where you work. The repos out to work on run as pills in a band set low at
the top: they line up between Home and the next rail icon, lower than one
would first put them, and the reference's chips on the right sit on the
same line. ⊕ stands at the left end. One press brings every repo not on
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

The whole of Forge sits a little inward: its outer sides get extra room
(about 3% of the width, 24–64 px) on top of the usual padding, against the
instinct to run to the window's edges.

The center takes three quarters of the width; the right pane takes one
quarter (at least 280 px) so it never gets in the way. Its bottom is the
terminal's home. Above the band line sits the search box for the open
repo: plain, case-insensitive, line by line; results are grouped by file,
and a line pressed opens the center there with the line selected. Below,
on the band line, one reference at a time, switched freely with chips: Issue (the repo's `issue/`, one file each), diff and 実行結果 (each
says plainly that it is not connected yet). The chosen reference is remembered on this device.

### File

An operation, not a page. Hovering the File icon (or pressing it) lays the
tree of "/" over whatever page is showing, right beside the rail; nothing
under it moves. Once out it stays for 8 seconds after the pointer leaves,
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

## 3. Language

One rule per thing, applied everywhere, with no exceptions made by eye.
Every value in `styles.css` comes from a token below.

- **Shapes.** A place you go to (rail item, card, tree row) is a rounded
  square. An action you press or a choice you make (button, template
  choice, repo chip, +) is round. A field
  you type into is slightly rounded and filled `raised`.
- **States.** Hover is a `raised` fill. The current or chosen thing is an
  `ink` fill with `ground` text: the rail item (File while its tree is
  out), the repo chip, the open repo in the tree, the chosen template, the primary button. Focus is a 2 px
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
- **Motion.** 120 ms fades, and one movement: the terminal flying between
  the right pane and the prompt box, 280 ms. Reduced motion turns them off.
- No shadows, blur, glow or gradients.

## 4. Tokens

| Role | Value | Use |
| --- | --- | --- |
| `ground` | `#D2D2CD` | every surface |
| `ink` | `#292B2A` | text, icons, the current thing, primary action (9.4:1 on ground) |
| `rule` | `#929590` | dividers, outlines of places; decorative only (2.0:1) |
| `sub` | `#56595A` | secondary text (4.7:1) |
| `edge` | `#6B6E6B` | outlines of fields and controls, which must be seen (3.4:1) |
| `raised` | `#DCDCD8` | field fill, hover |

No other colours.

Type: the system sans; monospace only for paths, code and the terminal.
Sizes 28 (identity), 24 (page title), 20 (card title, figures), 15 (body),
13 (meta).

Space: 4, 8, 12, 16, 24, 40. Radius: 8 fields, 12 places, round actions.
Heights: 40 controls, 32 list rows, 48 rail places. Icons 24 with a 1.6
stroke (the tree's triangle is the one 12 px icon).
