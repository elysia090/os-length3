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
  **Topic** (posts) → **Inbox** (what was sent to you). **+** (a new repo)
  comes right under them, a step apart, and is round because it starts
  something rather than opening a place (§3, shapes).
- A name appears beside an icon on hover or keyboard focus. Nothing else
  opens next to the rail: choosing an icon replaces the whole page.
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke; + is a 40 px
  round button with an `edge` outline. States as everywhere (§3).

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
page (a 40 px edge marked "/") and opens when the pointer rests on it or
keyboard focus is in it. Once out it stays for 8 seconds after the pointer
leaves, so reaching across the page and back does not lose it; a press
outside or Escape closes it at once. The center and the right never move
or shrink; switching repo from the tree changes them in place and leaves
the tree open. A folder's
triangle comes before its name, ▷ closed and ▽ open (one outlined shape,
turned). Inside a repo a name scrolls the center to that place; elsewhere it
opens and closes the folder. Open folders are remembered while the app
runs.

The repo strip runs across the top of the center and right; the selected
repo is read top to bottom, directory index first, then each directory and
file in order. The right half holds the reference (top) and the terminal
(bottom) at the same weight as the center.

## 3. Language

One rule per thing, applied everywhere, with no exceptions made by eye.
Every value in `styles.css` comes from a token below.

- **Shapes.** A place you go to (rail item, card, repo tab, tree row) is a
  rounded square. An action you press (button, choice, +) is round. A field
  you type into is slightly rounded and filled `raised`.
- **States.** Hover is a `raised` fill. The current or chosen thing is an
  `ink` fill with `ground` text: the rail item, the repo tab, the open repo
  in the tree, the chosen template, the primary button. Focus is a 2 px
  `ink` ring. Nothing else marks state (no underline, no bold-only).
- **Lines.** 1 px. `rule` between regions and around places; `edge` around
  things you press or type into. A dashed `rule` means one thing: room for
  something that is not here yet. Headings never get a rule.
- **Words over symbols.** What a thing is reads off the screen as it is
  written: a TODO kind shows as "Fix：", a link in `/bin` shows as the
  command's name only, with no arrows.
- **Motion.** 120 ms fades only. Reduced motion turns them off.
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
