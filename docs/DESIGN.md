# Design

How why\* looks, where its things lie, how they move and how they sound: written so that someone who has never seen
it could make it again and arrive at the same one. Every rule here is a number, a formula or a sentence that can be
checked, and §12 names the check. A rule with no check is a wish; a value that is not here is not part of the design.

What the OS is under its places is `OS.md`; what each place does is `PLACES.md`.

Contents: 1 the stance · 2 the world · 3 measures · 4 the frame · 5 pieces and the hand · 6 the row · 7 what one
does · 8 motion · 9 sound · 10 each place · 11 what is not yet so · 12 how it is checked.

---

## 1. The stance

why\* is a desk to work at. It is drawn by one hand and it is not like other software on purpose; it is also a
place to spend a working day, so nothing in it is there for its own sake.

**Four things it is made of, and why each.**

| What it gives | Where it comes from | Why |
|---|---|---|
| The skeleton | Swiss typography: a grid that is law, asymmetry, few sizes, one left edge | A workplace has to be predictable. A grid is the one thing that lets what is out of sight be known from what is in sight. |
| The material | Stationery: squared paper, a sheet, ink, a note. A shadow means "in the hand" and nothing else | This is where it is its own. Most software is panes of glass; this has a material world, and the material behaves honestly. |
| The voice | The poster and the page of a magazine: one large thing a screen, and the large thing is words | Where it moves a person. It works because there is only one. |
| The movement | Physics: a thing moved by a hand and stopped, with no bounce; a world that goes on past the window's edge | When movement explains where things are, nothing else has to. |

**It is known by what it will not do.** Its marks are few: the squared desk that is the world itself; paper and
ink, with fill and shadow for the one thing in the hand; a name in heavy black capitals; plain words. Everything
else is held back. It never has:

- a colour, a shadow or an angle that means nothing;
- a thing that is there only while a pointer is over it;
- a layout set in the middle of the window, or one mirrored left and right;
- blur or transparency as decoration (blur is depth: what is behind what was called up in front, and only that);
- a picture of a material (paper's grain, leather). A material is shown by how it behaves, not by how it looks;
- a second way to do a thing for a narrow window or a finger. A phone has the same rules with a smaller number.

**What its sources ask, kept as rules.** The skeleton is not a taste; it is what the Swiss school's own manuals say to
do, and each is a rule here with a number:

| The source says | Here |
|---|---|
| A grid drawn from the line spacing (Vignelli, *Canon*: "one can draw a grid based on the leading size") | the cell is the line: 24 px (§3) |
| "Stick to one or two type sizes", the large about twice the small, white between them (*Canon*) | on one sheet: its name, its words, and one small size beside them (§3) |
| A subhead is the text's size in bold, "a line space above and none below" (*Canon*) | who speaks, over what they said (§10, a transcript) |
| Flush left; centred only for what is lapidary (*Canon*; Bringhurst 2.1.3) | one left edge; nothing is set in the middle (§1) |
| Vertical space is added in whole intervals of the leading (Bringhurst 2.2.2) | every gap is a cell or half a cell |
| A comfortable measure (Bringhurst 2.1.2); read fastest long, preferred at 45 to 72 letters, slow under 35 | a line of what is said is 36 to 72 letters at every width (§10) |
| Outside margins small, for tension between the edge and what is on the page (*Canon*) | 6 px from the window (§4) |

**The test of anything expressive.** It must answer, at the same time as it pleases, one of: *where am I*, *what is
in my hand*, *what can I do next*. The size of words answers by rank, movement by where things are, material by
state. What answers none of the three is decoration, and on a desk decoration only takes the eye from the work.

**The test of a screen.** A film of it being used must be one unbroken take: every change is one of the three moves
of §8. A screen that needs a cut, or a fourth kind of move, is a screen whose use is not plain.

**What a person is and what a person sees.** What a person wants comes one thing at a time (go there, open that);
what a person sees never jumps. So the state of the window is whole numbers (which place, which piece is at the
edge) and the window travels between them.

---

## 2. The world

One world, and the window looks at it.

- **Down: the places.** The places lie one under another in the order of the rail (§4). To go to a place further
  down the rail is to go down.
- **Along, past the row: a place's far side.** Three pages are not places of their own but the far side of one: Git
  of Forge, the Remote of Home, Inbox of Server. A far side is a whole screen, a step along from its place, reached
  through the door (§4) and left through it.
- **Along: the pieces.** What is in a place lies in a row from the desk's left edge, left to right (§6).
- **In front: what is called up from the frame.** A search's finds, File's tree, the person's menu: they come in front
  of the world, and the world behind them goes out of focus (blurred) until they are put away. A thing's own menu (a
  repo's gear, a row's deeds) is not in front of the world: it is a sheet laid on the thing that called it (paper, an
  ink edge, its shadow), and nothing behind it changes.
- **Fixed to the window: the frame.** The rail and the band (§4) are the window's instruments. They do not move; the
  world goes by under them.

**The ground.** The world's ground is one sheet of squared paper: the ground colour with a dot in the middle of every
cell, everywhere, under every place and under the frame. It is never covered by a plain strip. When the world moves
the dots move with it, and at every rest they stand exactly where they stood (every rest is a whole number of
cells).

**What is out of sight is known.** Because the desk rests only with a piece at its edge (§6) and the places lie in
the rail's order, what is past any edge of the window follows from what is in it: the next piece starts a piece's
width and two cells along; the place below is the next one down the rail.

---

## 3. Measures

All lengths are CSS px. The grid's cell is **u = 24**. Everything on a desk has its edges on lines of the grid
(multiples of 24 from the window's top left) unless a rule here says otherwise.

### Colour

Colour is material or state, never ornament. `styles/tokens.css` holds the values.

| Name | Value | What it is |
|---|---|---|
| ground | `#dcd9d4` | the desk |
| dot | `#96938e`, radius 1.5 | the grid's dots, one a cell |
| paper | `#fbfaf7` | a sheet in the hand; a place that is one sheet |
| ink | `#171614` | words; an edge in the hand; a shadow; the terminal in the hand |
| sub | `#55524e` | words a step quieter: a piece not in the hand, what is said beside a thing |
| edge | `#6f6d68` | the line round a piece not in the hand |
| quiet | `#8f8c87` | a line's number; a control at rest |
| rule | `#9c9995` | a line inside a sheet |
| note | `#f2cf52` (its quiet words `#8a7a3c`) | Home's note: what is one's own to do |
| green | `#9be0bf` | the machine speaking: the terminal's words and its shadow, in the hand only |
| off | `#7f2b3c` | not answering, removed, refused |
| done | `#0e7c5e` | a step done |

Fill, shadow and colour belong to the piece in the hand (§5). Hover adds no colour: a thing under a pointer goes from
quiet to ink, or takes paper under it.

### Words

Three faces: **sans** (the system's), **mono** (the system's), **display** (Inter Display Black, weight 900, for
names only; its capitals are .727 of its size, and in a line as tall as its size their feet stand .1245 of the size
above the line's foot).

Seven sizes and no others:

| Size | Face | On a line of | For |
|---|---|---|---|
| 11 | mono | 16 or 24 | a line's number, a key's name |
| 13 | mono 700 (lowercase) or sans | 24 | what is said beside: a label over a piece, a count, a time, a day, what the band and a menu say |
| 15 | sans | 24 (in the note, 36) | what is read on a sheet; an item of the note (700) |
| 17 | mono | 24 | what is written: a file's text, the terminal |
| 20 | sans 700 | 24 | a title inside a sheet |
| 33.01 (= u / .727) | display | — | a name: a repo, a file in the hand, a place. Its capitals are one cell tall |
| 66.02 (= 2u / .727) | display | — | the person's name. Its capitals are two cells tall |

**On one sheet, three.** Its name (33), its words (15, or 17 where they are written), and one small size (13) for
what stands beside them: a time, a day, a label, a hint. 11 is for a line's number and a key's name only, 20 for a
title inside a sheet that has parts, 66 for the person's name alone.

Why 17 for what is written: on an ordinary screen at a desk's distance one px is about .023°, and reading stops
slowing when a small letter is about a fifth of a degree tall. A small letter of 17 px mono is .21°; of 14 px, .17°.

**A name in Japanese** is a cell tall too. A kanji's face fills .92 of its square where a capital of the display face
is .727 of its size, so at the name's size it would stand 30 px tall beside capitals of 24 (measured). It is set in
the heaviest gothic the system has at 80 % of the size (`Display JP`, `styles/base.css`): its face is then 24 px.
A name of both writings is one height. (What a screen says must hold when it is said in another language: the
letters get longer or taller, the room does not.)

A name's capitals stand on a line of the grid: a name `c` cells tall (c = 1 or 2) is set in a box of its own size
with a top margin of `−.2043·c·u` and a bottom margin of `−.1713·c·u`, so it takes exactly `c` cells of the column.
Its ink, not its box, stands on the left edge.

### Lines, corners, shadow

- A line is 1 px. A piece's edge is an outline of 1 px inside its box.
- Corners: a key 4, a field 8, a sheet 10, a pill 999. Nothing else.
- **A shadow is hard, ink (the terminal's: green), 12 px right and 12 px down (u/2), and only the piece in the hand
  has one.** One light, the same on every desk.

### Widths

| Thing | Width |
|---|---|
| a piece on a desk (a file, the terminal, Home's pieces, the band's bar) | **24 cells** = 576: fifty letters of 17 px mono (50 × 17 × .602), a margin of a cell and a half for the numbers before them and half a cell after, up to the grid |
| between two pieces | **2 cells** |
| a place that is one sheet (Runtime, the Remote) | to a cell from the window's right edge, at most 50 cells |
| Home's slip | 14 cells |
| a row's first sheet (§6): Git's own, Server's | **8 cells**: a whole screen then shows it and two pieces whole (48 + 192 + 48 + 576 + 48 + 576 + 12 = 1500 ≤ 1536; 9 cells is the most that does) |
| Inbox's first sheet | 12 cells: one piece follows it, and it holds a name and what was last said on a line |
| a window narrower than a piece and its shadow | a piece is `24 · max(10, ⌊(W − 48 − 12) / 24⌋)` px: as many whole cells as there is room for |

A window half a screen wide (768) shows one piece and the edge of the next; a whole screen (1536) shows two and the
edge of a third; a phone (390) shows one. These are not three layouts: they are the one rule at three widths.

---

## 4. The frame

The rail's column and the band's row: **two cells each**, at the window's left and top. The world starts at their
corner, **(48, 48)**, and its first dot is at (60, 60).

**One square for both.** A place of the rail and the band's bar are **36 px** tall with an **18 px** mark,
**6 px** from the window: 6 + 36 + 6 = 48.

### The rail

- A place is a 36 px square about a corner of the grid: the first has its middle at (24, 24), the next 48 px down,
  and so every one, at one pitch from first to last. So four dots stand round every icon alike. Its icon is 18 px,
  drawn with a 2 px stroke of its 24 px box.
- The place one is in has the slot colour under it; a place under the pointer or the keyboard, paper and a 2 px ink
  ring. At a place's far side its place is the one lit. A place's name stands out beside it while the keyboard is on
  it; a pointer over it brings nothing out (§7).
- **An icon stands on the rail only for what the day goes to from anywhere.** In order, nearest the person first:

  | | Icon | What it is |
  |---|---|---|
  | mine | Home | who one is, what is one's own to do |
  | the work | Forge | a repo written and run |
  | people | Server | where many talk |
  | the machine | Runtime | this device |
  | not places | File, the plug, + | File and the plug are called up in front of whatever place is shown; + makes a repo |

  At the rail's foot, the person's own menu.
- **What is gone to from one place has no icon: it is that place's far side, and its door is there.**

  | Far side | Of | Why it is its far side |
  |---|---|---|
  | Git | Forge | the repo written, then the repo recorded and reviewed |
  | the Remote | Home | what is mine here, then where it is kept |
  | Inbox | Server | where many talk, then what was said to one |

  What is to be seen at a far side is said on its place's icon, the place's own name first: a red dot on Home while
  the Remote does not answer; an ink dot on Server while something in Inbox is unread.
- A window too short for the rail (under 560 px) closes the places up, and they scroll inside the rail.

### The door

The way from a place to its far side, and **in the same spot** the way back: there and back is two presses with the
hand where it was.

- One key of the band's own make: x = 48 to 96, y = 6 to 42 (two cells wide, as tall as a place of the rail),
  ground under an 18 px mark, 1 px of ink round it. Its mark is the icon of where it leads. It is the window's,
  fixed, and there on a far side that has no band of its own.
- It is the first key of the band: nearest the rail, where the hand was when it came to the place. Where the page
  has a band, the band goes on from the door and the two are one bar as wide as a piece (the door has no edge of its
  own on that side).
- What waits where it leads is a dot on it, as on a place of the rail.
- Going through it the world goes **along** (§8), the far side coming in from the right; back, from the left.
- Only these six pages have a door. Runtime, File, the plug and + lead nowhere further.

### The band

On a desk (Home, New repo, Forge, Git). **One bar** from the desk's edge: x = 48, y = 6, 36 tall, as wide as a
piece (§3). Ground under it, a 1 px ink outline, corner 4. Its keys are parts of it **two cells wide**, edge to
edge, a 1 px line between them; the search is the rest, its words 13 px. Every edge of the bar is on a line of the
grid, so no dot is cut by it.

- Home and Forge: the door, the terminal's key, the files' key, the search. Git: the door, the terminal's key, the
  search. New repo: the terminal's key, the files' key, the search (it has no far side).
- On Forge and Git the name of what is in the hand stands at the band's right end, in the display face, its
  capitals a cell tall about the row's middle.
- What the search finds comes in front: sheets in a row from the desk's edge, their tops a cell under the band
  (y = 72), to a cell from the window's right edge.

---

## 5. Pieces and the hand

A **piece** is a thing with something in it that lies on a desk: a file's sheet, the terminal, Home's note, a slip,
an issue's card.

**One piece is in the hand.** It is the one being worked in (pressed last, or holding the keyboard). The hand's piece
and no other:

| | In the hand | Not in the hand |
|---|---|---|
| Fill | paper (the terminal: ink; the note: its yellow) | the ground's own colour |
| Edge | 1 px ink | 1 px `edge` |
| Shadow | 12 px right and down | none |
| Words | ink (the terminal: green, and its colours) | `sub`; the terminal's colours all `sub` |
| What can be done with it (its close) | shown | not shown |

So fill, shadow and colour say one thing, *this is in your hand*, and the heaviest thing on a desk is the thing
being worked in.

**Where the eye goes, measured.** A pixel's ink is how far its colour is from the ground's:
`ink = min(1, ΔE / 50)`, ΔE the distance in CIE Lab. Then:

- On a desk, what is not words (fill, shadow, edge) weighs **at least 8 times** as much in the hand's piece as in
  any other piece whole in sight, whichever piece is in the hand.
- The words of a piece not in the hand are a step quieter than ink, and still read: a file beside the one written
  in is looked at. (Making them quieter still would reach 8 times for the words too, and nobody could read them.)
- Home's note weighs at least 8 times what waits beside it.
- A whole screen has **one** body of ink holding 5 % or more of the screen's ink. (Measured in cells of 24 px,
  bodies being joined cells with more than .15 ink. Screens that hold the eye have one body many times the next;
  screens that scatter it have two or three near equal.)

**A piece's proportions on a desk.**

- Its top is at y = 72, a cell under the band. Its name stands in the cell over its top-left corner: 13 px mono 700
  on a line of a cell, its folder quiet before it.
- It is as tall as its lines, never lower than a cell over the window's foot; what is under that is scrolled to
  inside it. A sheet has half a line of paper over and under its lines. The terminal is 18 lines and a cell over and
  under them.
- A file's numbers are 11 px, quiet, in a margin a cell and a half wide; its words start there.
- Nothing on a desk changes size, and nothing lies askew.

**A place that is one sheet** (Runtime, the Remote) is that sheet in the hand: paper from the desk's corner
(48, 48), a cell of paper round what is on it, its shadow, its name in the display face.

---

## 6. The row

Pieces are set as words are in a line: along from the desk's edge, and **a piece that does not fit beside the last
goes under it, at the desk's edge again, two cells down.**

- **A desk of short pieces (Home) is set so and nothing more:** nothing of it is ever out of sight sideways. A whole
  screen has its pieces side by side; half a screen and a phone, one under the other.
- **A desk whose pieces are as tall as the window has one line only**, and is looked along: Forge's files, Server's
  boards, Inbox's conversation, and Git's issues (which are as tall as what is on them, and are looked along all the
  same: there may be many). The rest of this section is that line (`ui/row.ts`, `ui/row-desk.ts`).

Decided by the window's width and nothing else (never by what the device is), and when pieces do not fit side by side
one is shown whole and the rest are a step along, in order: what the split views of the systems people know do when
a window narrows.

**Where a piece is.** The pieces are in the order they were opened (on Forge the terminal first; on Server the
boards' own order). All are one width `W` (§3), `G = 48` apart. The n-th (from 0) starts at

    x(n) = n · (W + G)

from the desk's edge. A piece's place is its number and nothing else.

**The row's first sheet.** A row that has things of one kind to choose among (Server's boards, the people who wrote
to one) starts with a sheet that is its index: narrower than a piece (§3), not in the hand, at the desk's edge. Its
lines are the frame's square tall across it; the one whose piece is in the hand is in ink; a line pressed goes to its
piece. So any piece is one press away while the sheet is in sight (a whole screen), and two from anywhere (to the
sheet, then to the piece). The pieces then start `F + G` along, `F` the sheet's width.

**Where the desk rests.** Only with some piece's left edge at the desk's edge: the desk is turned by one of the
`x(n)`, never between. Scrolled by hand and let go, it comes to rest at the nearest (the browser's own snapping, so
with the hand's speed).

**Going to a piece** (pressing it, or the keyboard). With the desk turned by `now`, the face `F` wide, the piece at
`x`, the shadow `S = 12`:

    far = x + W + S − F
    if far ≤ now ≤ x      stay at now                 (it is whole in sight: nothing moves)
    if now > x            turn to x                   (it was before the edge: bring it to the edge)
    otherwise             turn to the least x(n) ≥ far (the nearest rest that shows it whole)

The first line is a rule of its own: **what is pressed never goes from under the hand that pressed it.**

**The ground goes with the row.** Turned by `t`, the dots are drawn `t mod 24` to the left; at every rest that is 0.

**The row's end.** The desk turns as far as brings its last piece to the edge and no further. It is never turned
down: what is under a piece's foot is inside the piece.

**The row's map.** While some of a row is out of sight, its map stands at the window's foot from the desk's edge, in
the lower half of the foot's cell (under a piece's shadow): the row twelve times smaller (a piece of 24 cells is a
bar 48 px long, two cells between are 4 px), each piece a bar 4 px thick, the one in the hand in ink and the rest in
the quiet line's colour, and a 2 px line of ink under the part that is in sight. A row longer than the window's
width times twelve is drawn smaller, to fit. It answers what the window cannot show: how many pieces, which way, how
far. **A bar pressed goes to its piece**, so nothing on a row is reached by scrolling alone. With the whole row in
sight there is no map.

---

## 7. What one does

Five things, each done one way, the same with a finger, a mouse and the keyboard.

| What | How | The keyboard's way to the same thing |
|---|---|---|
| **Go** to a place or a piece | press it | along the rail: ↑ ↓, Home, End. On a desk, out of any text: ← → or Tab to the next piece, Enter or a letter to go into it |
| **Write** | type where the caret is. What is written is kept as it is written: nothing to save, nothing to confirm | — |
| **Put away** | the hand's piece's close; for what was called up in front: press outside it, press what called it, or Escape | Escape (from a text it first leaves the text for the desk) |
| **Do to it** (new, rename, delete) | the thing's own menu | the menu key, Shift+F10 |
| **Look along** | scroll, as anything is scrolled | — |

Rules that follow, each of them absolute:

- **Nothing waits on a pointer.** What can be done with a thing is on the thing in the hand, or always there and
  quiet (a repo's gear, a note's item's ×, a row's menu), inked while the thing is used. A pointer over a thing
  never brings anything out and never puts anything away.
- **A press means one thing.** Pressing a thing goes to it. Pressing twice chooses a word in a text and is otherwise
  a press.
- **What is called up comes by a press and by nothing else** (File's tree, the search's finds, a menu), and stays
  until it is put away.
- **A key is a quicker way to something that can be pressed,** never the only way to it.
- **The pointer and the caret are the OS's own,** ink on a paper edge.

**Read in the person's favour.** What a hand does is a little off what it meant, and the OS takes what was meant.
(The makers of a hard game that feels fair say how: "everything is fudged a tiny bit in the player's favor"; a jump
pressed a moment early or late, or two pixels from the wall, counts.) Here:

- What can be pressed is at least a cell either way, however small it is drawn: a 16 px mark in a 36 px square, a
  4 px bar of the row's map in the whole of the foot's cell.
- What is pressed never goes from under the hand that pressed it (§6); a piece pressed while the desk is on its way
  is gone to from where the desk now is, not from where it was.
- A press goes down, not up: a thing sounds and answers as it is pressed (§9), a tenth of a second before a click
  would say so.
- What follows the hand is moved by the window itself (a row is scrolled, and comes to rest by the browser's own
  snapping). A finger sees a lag of a hundredth of a second in what it drags; code that reads the finger and then
  moves the thing is later than that.

**Friction is kept where it says what a place is, and nowhere else.** The same is found by those who make such
things: moving papers about a desk can be the thing itself, not a cost to it; a screen that is harder to use may
still be the right one, when ease was not its aim. Three are kept on purpose:

- **In a board and a conversation Enter is a new line, and sending is a key of its own** (Ctrl+Enter, or the key that
  comes with the words). What is said there is a whole thought that will be read later, not a line in a chat.
- **One piece is in the hand.** To work in another it is taken up; nothing is done to a piece from a distance.
- **A far side is a step away** (the door), not a pane beside its place: Git is where the work is judged, not where
  it is done.

And one kind is not friction but noise: **being asked "are you sure".** Asked every time, it is answered without
being read. A deed that can be put back is done at once and can be put back; only what cannot be put back is asked,
and then by something that cannot be answered by habit (§11).

**While something takes time, what is being done is said**, in words, where its result will be: a wait that shows
its work is trusted more than a short one that shows nothing.

---

## 8. Motion

**Three moves, and only these.**

1. **The world up or down, or along:** to another page. Down or up to another place; along to a place's far side,
   and back along from it. The page left stays in sight as it was and goes out the way the world went by; the page
   come to follows it at one distance; the dots go with them. The way is the window's height in whole cells,
   `24 · round(H / 24)`, or along, its width, `24 · round(W / 24)`. The frame stays.
2. **The desk along its row:** to another piece (§6).
3. **In front and back:** what is called up comes in front and the world behind it goes out of focus; put away, it
   goes and the world is in focus again.

**One law for every move** (`ui/law.ts`). A thing moved goes as a hand moves it and stops it: off at once, most of
the way in the first third of its time, then settling, with no bounce. At `u` (0 to 1) of its time it is

    eased(u) = (1 − (1 + 8u) · e^(−8u)) / (1 − 9 · e^(−8))

of the way: a critically damped spring in closed form. (At u = 1/3 it is .75 of the way.) Its time, for a way of
`d` px where a whole way is `whole` px:

    T(d) = 250 + 170 · min(1, |d| / whole)   ms

The sheets have the same law as three times and one curve:

| Token | Value | For |
|---|---|---|
| `--motion` | 90 ms | what answers the hand: a hover's light, a press, a colour. Not a move |
| `--leave` | 130 ms | a thing put away |
| `--move` | 250 ms | a thing that comes or goes where it is |
| `--slide` | 420 ms | a whole way |
| `--spring` | the curve above, sampled every twentieth of its time (`linear(…)`); where a browser knows no such curve, `cubic-bezier(.2, 0, 0, 1)` | every move |

- No sheet and no code moves a thing by another curve, or in a time written out. (What goes round for as long as it
  is there, a caret's blink, is not a move; nor is a mark that lingers a second and more.)
- **A move never holds the hand.** The place come to is there to be used from the first frame; a move under way is
  taken over by the next from where it is.
- Asked for less motion, nothing moves: each thing is where it ends at once.
- Nothing overshoots, nothing grows into place, nothing fades in over what it replaces.

**One world, one move.** Going to another place, the place left, the place come to and the ground set off at the same
instant, in the frame after the place come to is built: each is made held where it starts and all are let go
together (`ui/glide.ts travel`). Set off as each is made, the ground ran ahead of the sheets on it whenever the place
come to was long in the building.

---

## 9. Sound

A key's sound, recorded, for two things the hand does: **a control pressed** and **a key typed**.

- A control pressed with a mouse or a pen sounds as it goes down and again, quieter, as it is let go; pressed with a
  finger or from the keyboard, once at its click.
- A key typed in a field, a text or the terminal's line sounds as it is struck. Every key that writes is one key and
  one sound: a letter, a figure, Tab, Delete, **Backspace and Enter as any other**. Only Space is the space bar. (A
  control pressed has Enter's own, heavier sound: that is a press, not typing.) A key held sounds once. A key struck
  with Ctrl, Alt or the command key is a command, not typing, and is silent. Enter that presses a form's button is
  one stroke, not two.
- No two strokes are alike (each a little higher or lower, softer or harder). Silent while the window is out of
  sight. Sound that cannot be had never holds up what the key or the control does.

---

## 10. Each place

What each place is for in one sentence (its character), and where its things lie. All of it is §2–§9 applied; what
is written here is only what a place adds.

### Home: mine

*Who one is and what is one's own to do: the one place with a voice.* The person's name is the one large thing in
the OS.

A desk of two short pieces (§6):

1. **The person's own.** A cell of desk; the name, capitals two cells tall, from y = 72 to 120 (one cell tall if it
   is longer than the piece at two; longer than that, it breaks over lines); a cell; the counts, 13 px mono, on the
   cell from 144; then the handle and the line about the person, a cell each, while there are any; a cell; **the
   note**, from y = 192 with only the counts. The note is Home's piece in the hand: its yellow, as wide as the piece.
   Its rows are the frame's square: an item's mark is a 16 px box with a 2 px line in a 36 px square at the note's
   edge, its words 15 px 700 on a 36 px line. It is as tall as what is written on it and the line of what the keys
   do, brought up to the next line of the grid, never under four cells.
2. **The repos and what waits.** "repos" on the cell under the band (y = 48); a name every two cells, capitals a
   cell tall, **the first standing on the line the person's name stands on** (y = 120); a cell; "+ new repo" in the
   words' own size; a cell; what waits, a slip 14 cells wide drawn in line on the ground (it is not in the hand).

### Forge: the work, written and run

*A repo open on the desk: the terminal and its files, side by side, to write in and run.* Its one large thing is
the name of what is in the hand, at the band's end.

A desk. Its row: the terminal first, then the files in the order they were opened. The terminal in the hand is ink
with its words green; not in the hand it is line on the ground, as any piece. A program that takes the whole screen
has its 80 columns while it runs.

### Git: Forge's far side, the work recorded and reviewed

*What a repo is to become, what it became, and what is asked to be taken into it.* Its one large thing is the title
of the issue in the hand.

A desk. At the desk's edge main's own sheet, eight cells wide (ink: it is where the repo's work is switched); two
cells on, the issues, a row (§6): one width, the one in the hand at the row's edge in full, those after it beside it
by their number and title, nothing showing of those before it (they are on the row's map). An issue's title is its
name: the display face, capitals a cell tall on lines of a cell and a half, at every width. Its number and kind are
said once, small, in the cell over the sheet's corner (and the number at the band's end). In a sheet with room (30
cells) its words and its work lie side by side; in a narrower one the work is under the words: by the sheet's width,
never the window's. Which repo is a choice on this desk, not one of the window's instruments: it stands on the cell
under the band. With no issue yet, the one thing to do stands where the first piece would. On a window with no room
for main's sheet and an issue side by side, the row goes under the sheet, two cells down (§6).

### Server: where many talk

*A room: boards of talk, each with a shared list, and the people in it.* Its one large thing is the name of the board
in the hand.

A desk with a row (§6). First, the room's own sheet, eight cells: its boards by name (the one in the hand in ink, a
dot on one with something not seen), who is in it, the repos they show. Then its boards, pieces as wide as any; last,
dashed on the ground, the board that is not made yet. The board in the hand is a sheet: its name in the display
face on its second line, its two parts after the name (its talk, its list; they go under the name where they do not
fit beside it), the part chosen under a quiet rule, and at its foot the box one writes in, part of the sheet. Its
servers are chips on the band's row after the door; the chip of the server on screen, pressed, turns the desk to the
row's start.

### Inbox: Server's far side, what was said to one

*Letters: who wrote, and the conversation with them.* Its one large thing is the name of who the conversation is
with.

The same instrument as Server (so it is learnt once). First, the sheet of who wrote, twelve cells: one's own name
(pressed, it is copied; its gear at its end), the field that writes to someone new, then each conversation on two
lines of a cell, the name with the address quiet after it and under it the last thing said; the one open in ink.
Then the conversation open, a piece in the hand. One is found by one's name: there is no number beside it. With no
conversation open the first sheet stands alone. Signed out, or with no name yet, it is a sheet with the one thing
to do, as the Remote's is.

### What is said: a transcript

A board's talk and a conversation are set the same way, as a transcript is, not as bubbles on two sides:

- **One left edge.** Everyone's words start at the sheet's own margin, a cell in. Who said them is said, not shown by
  a side: the speaker's line (their mark a cell wide, their name in bold, the time small after it), then the words
  under it. In a conversation one's own name is a step quieter than the other's.
- **On the grid.** Words are 15 px on lines of a cell. A run of one person's posts a few minutes apart says who once;
  between two posts of a run, half a line; before another speaker, a line. A day's name is a small line of its own at
  the same edge.
- **The measure.** A line is the sheet's width less a cell each side: 528 px on a piece of 24 cells, about 72
  letters; 264 px on a phone's piece of 13, about 36. Both are inside what is read without slowing (35 to 72). A
  column for faces beside the words would leave a phone 216 px, 30 letters: that is why who speaks is over the
  words, not beside them.
- **Standing on its foot.** The latest is just over the box one answers in; a talk longer than its sheet scrolls
  inside it, and the box stays in sight.
- **The box one writes in** is one thing in both places: a field at the sheet's foot under a quiet rule; its key
  (Post, Send) comes with the words, and Ctrl+Enter does the same.
- **What can be done with a post** (its time in a run, taking it down) is on the post in the hand: pressed, or with
  the keyboard in it.

### Runtime: this device

*The machine one is at: what it holds, what runs on it, how it is set.* A sheet. A place of figures: the figures
are the one thing with weight (20 px 700), everything else is said in 13 and 15.

### The Remote: Home's far side, where the repos are kept

*The other machine: an account, its devices, what it keeps.* A sheet.

### New repo (+)

*One question: what is it called.* On Home's ground: one piece at the desk's edge.

### File

*Everything there is, as a tree.* Not a place: it is called up in front of whatever place is shown, from the rail,
by a press and by nothing else, and it stands whole in the window beside what called it; the place behind it goes out of focus. Each row's menu is always there, quiet.

---

## 11. What is not yet so

The design above is what the code does, except here. Each is a rule of this document that a part of the OS still
breaks; none is a decision to leave it.

| Where | What it still does | The rule it breaks |
|---|---|---|
| Git | its row is slid by code of its own (a finger's swipe is read by it), not turned as a desk is, so it does not follow the hand; under the issue in the hand the page is scrolled down to its history and review | §6, a row is looked along as anything is scrolled, and is never turned down |
| Git | under an issue: a day in its history is two cells tall | §3, seven sizes |
| Server | a board not in the hand is its name only: what it holds is read when it is taken up | §5, a piece not in the hand is read, a step quieter |
| Server | behind its gear and a repo shown: a page of the old make (its title 24 px, its parts on a sliding line) | §3, §5 |
| Server's chips, a sheet's parts | a line of them longer than its room slides, its end faded into the ground, a › over the fade | §1, no transparency as decoration; §6, what does not fit goes under |
| the search's finds | the find beside the one read lights under a pointer | §7, nothing waits on a pointer |
| the band | Home, Forge and Git each build their own (the door alone is the window's); Runtime, the Remote, Server and Inbox have no search | §2, the frame is the window's |
| Forge | the desk still turns by itself to where the Agent is working | §8, the world moves only for what was asked |
| moves in code | their lengths are still written where they are made (their curve is the law's) | §8 |
| the sheets (Runtime, the Remote) | what is in them is laid by the window's width in places (27 rules that ask the window how wide it is remain in the sheets, most of them here) | §1, a narrow window has the same rules |
| signing in, a Remote not answering | the same deed has two looks (Try again in ink on Server, in line on the Remote) | §1, one hand |
| deeds that ask first | some twenty deeds ask before they are done (remove a dotfile, take a repo off, sign a device out, a server left), each in its place with Cancel beside it, whether or not they can be put back | §7, what can be put back is done and can be put back |
| Forge, the first time | the desk is long in the building (the Prompt starts with it), and the move to it waits for that | §8, off at once |
| a board's box | nothing on it says Enter is a new line and which key sends (a conversation's says so under it) | §7, friction kept on purpose is said |
| `PLACES.md` | speaks of the look as it was | — |

**Which icons the rail needs.** Counted in presses, for a rail of n icons. An icon costs the screen a square for
ever and saves one press each time its page is gone to from somewhere that is not its place. Git is gone to from
Forge, the Remote from Home, Inbox from Server (and from what waits on Home, which leads into a conversation
itself); from anywhere else each is seldom the next thing. So taking their three icons off costs one press on a
seldom road and nothing on the daily one, and the daily one (Forge and Git, there and back) costs no travel of the
hand at all, where it was the length of two icons. The rail is not what should go: a place gone to from anywhere
needs its one press from anywhere. What is still open is the plug, whose press does different things in different
places, and File, which is called up as the band's things are and stands on the rail.

---

## 12. How it is checked

Nothing here rests on how a screen looks to someone. Each rule is held by a test that measures.

| Rule | Held by |
|---|---|
| The law of motion: its shape, its time; the sheets' curve is the code's; no sheet moves by another curve or a written-out time (§8) | `why/app/ui/law.test.ts` |
| A piece's place is its number; where the desk rests; going to a piece, every case; a phone by the same rule (§6) | `why/app/pages/forge/desk-layout.test.ts` |
| A piece's width at every window; a row whose first sheet is narrower than its pieces (§3, §6) | `why/app/ui/row.test.ts` |
| The rail's order; which pages are a place's far side, where each door leads and that it leads back (§4) | `why/app/host/purposes.test.ts` |
| What a typed key sounds as (§9) | `why/app/ui/touch.test.ts`, `tests/app/sound.spec.ts` |
| Every page starts at the frame's corner, a desk's band from the desk's edge, a sheet from the desk's corner, the door where there is one, at four widths down to a phone; the dots under every page; nothing wider than the window (§2, §4) | `tests/app/skeleton.spec.ts` |
| Server's and Inbox's rows: the first sheet at the desk's edge, the piece in the hand whole in the window, a cell under the band to a cell over the foot, paper with its shadow, at four widths (§5, §6) | `tests/app/skeleton.spec.ts` |
| Git's row: the one in the hand at its edge, the next beside it, the one before on the map; a bar of the map goes to its piece (§6) | `tests/app/git.spec.ts` |
| A board's box: its key comes with the words at every width; it stays in sight under a long talk (§10) | `tests/app/server.spec.ts` |
| Home's row, the name, the note, the repos, the slip; half a screen, a whole one, a phone (§10) | `tests/app/home.spec.ts` |
| Forge's row; the hand's piece alone filled; nothing changes size; what is pressed does not move; the desk rests at a piece (§5, §6) | `tests/app/forge-work.spec.ts` |
| Where the ink is: 8 times, on Forge whichever piece is in the hand, and on Home (§5) | `tests/app/focus.spec.ts` |
| Going to another place: the two pages and the dots move as one in every frame (set off at one instant), one way, off at once, at rest within 420 ms (§8) | `tests/app/motion.spec.ts` |
| File comes by a press and by nothing else (§7) | `tests/app/file.spec.ts` |
| A phone has the same rules (§1) | `tests/app/narrow.spec.ts` |

`npm test` runs the first five; `npm run selftest` the rest, in a browser against a real Remote.

To add a rule: write it here as a number or a sentence that can be false, then write the test that would find it
false, then make it true. To change one: change it here first.
