# Design language

Plain and direct. Not luxurious, not "high tech", not boring: what you see
is what is there, and every control looks like what it does.

The rules below follow the order a person meets the app: the rail from the
top, then the page each icon leads to.

## 1. The rail

- Icons only, top to bottom in the order of the work:
  **Home** (who you are, what you are doing) → **File** (what a repo
  contains) → **Git** (what happened outside) → **Forge** (your own work in
  progress) → **Runtime** (the environment) → **Remote** (sync) →
  **Topic** (posts) → **Inbox** (what was sent to you). **□+** (a new repo)
  sits apart at the bottom because it starts something rather than opening
  a place.
- A name appears beside an icon on hover or keyboard focus. Nothing else
  opens next to the rail: choosing an icon replaces the whole page.
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke.
  Rest: ink icon. Hover: `raised` fill. Selected: `ink` fill, `ground`
  icon. Focus: 2 px `ink` ring.

## 2. Pages

- Every page starts with the same header: icon, title, and one short role
  line. Home is the exception: its header is the profile.
- A page fills the window. Reading pages keep their content within
  1200 px; work pages (File) use the whole width, and nothing to the right
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

### File

"/" is the root of the whole system, the same tree the Terminal's shell
sees, and the tree shows where each part comes from: `/bin` is the fetched
distribution (配布), `/dev` and `/proc` are made by the kernel, `/root`
holds the person's repos, `/etc` and `/tmp` start empty. `/root` is open at
first.

The tree is an operation, not a column: it lies over the left edge of the
page (a 28 px edge marked "/") and opens while the pointer is on it or
keyboard focus is in it, after a short delay so passing across does not
open it. The center and the right never move or shrink. A folder's
triangle comes before its name, ▷ closed and ▽ open (one outlined shape,
turned). Inside a repo a name scrolls the center to that place; elsewhere it
opens and closes the folder. Open folders are remembered while the app
runs.

The repo strip runs across the top of the center and right; the selected
repo is read top to bottom, directory index first, then each directory and
file in order. The right half holds the reference (top) and the terminal
(bottom) at the same weight as the center.

## 3. Tokens

| Role | Value | Use |
| --- | --- | --- |
| `ground` | `#D2D2CD` | every surface |
| `ink` | `#292B2A` | text, icons, selection, primary action (9.4:1 on ground) |
| `rule` | `#929590` | dividers, card outlines; decorative only (2.0:1) |
| `sub` | `#56595A` | secondary text (4.7:1) |
| `edge` | `#6B6E6B` | borders of inputs and controls, which must be seen (3.4:1) |
| `raised` | `#DCDCD8` | input fill, hover, the current tab |

No other colours. No shadows, blur, glow or gradients. State is carried by
shape and words as well as colour: a dashed outline means "not connected
yet" or "create"; a strike-through means done.

Type: the system sans; monospace only for paths, code and the terminal.
Sizes 28 (identity), 24 (page title), 17 (card title), 15 (body), 13 (meta).

Space: 4, 8, 12, 16, 24, 40. Radius: 8 controls, 12 cards and rail items,
20 pill buttons. Lines are 1 px.
