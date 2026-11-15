# Design

How why\* looks, where its things lie, how they move and how they sound: written so that someone who has never seen
it could make it again and arrive at the same one. Every rule here is a number, a formula or a sentence that can be
checked, and §12 names the check. A rule with no check is a wish; a value that is not here is not part of the design.

What the OS is under its places is `OS.md`; what each place does is `PLACES.md`.

Contents: 1 the stance · 2 the world · 3 measures · 4 the frame · 5 pieces and the hand · 6 the row · 7 what one
does · 8 motion · 9 sound · 10 each place · 11 what is not yet so · 12 how it is checked · 13 its words, and what
only a person gives · 14 touch, and what it is for.

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
- blur or transparency as decoration (blur is depth: what is behind what was called up in front, what a change is
  seen against in Git's work, and a talk read back where it passes under the box one writes in, 2 px over half a
  cell; nothing else);
- a picture of a material (paper's grain, leather). A material is shown by how it behaves, not by how it looks;
- a second way to do a thing for a narrow window or a finger. A phone has the same rules with a smaller number.
- two things equally raised: two fills, two shadows, two large names, a sound and a flash for one deed (master and
  servant, below);
- a movement that is not one of the three moves or the hand's own: nothing glides in, grows, folds, pops, bounces or
  fades over what it replaces (§8: the cut, and the mind completes the way between);
- anything that passes the removal test (below): a thing kept though nothing is lost without it;
- an explanation of itself: a tooltip, a tour, a word that says what a name would.

What it comes from, item by item, and where it does more than its sources ask, is `CANON.md`.

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

**Not a likeness.** It would be easy to look like the things it comes from: squared paper, a heavy grotesque, a
hard shadow. What those things were made by is harder, and is what is kept here. Each is a question asked of every
part, and each has already changed something:

| Whose | What they say | What it asks here | What it changed |
|---|---|---|---|
| Gerstner, *Designing Programmes* | "Squared paper is a grid, but not a programme." A programme is a scale of proportions "that makes the bad difficult and the good easy"; "to describe the problem is part of the solution" | are the measures a regulator, or only lines to snap to? | the widths are one programme (§3): a sheet is 24 or 48 cells because its inside and one gutter are then 24 or 48, which divide by 2, 3, 4 and 6 |
| Vignelli, *Canon* | appropriateness is "the search for the specific of any given problem"; design is "a discipline", not a style; "we love complexities but hate complications" | what does this thing want to be, here? | a far side is a step away, not an icon; a board is a sheet with its box at its foot, not a chat with a side pane |
| Rams, 1976 | the designer is a "gestaltingenieur"; order is there so that what a thing does is told; what is made "to impress, to polish things up" is packaging; users are "intelligent and responsible" | does this tell what the thing does, or dress it? | nothing explains itself in a tooltip that a name would say; a place with nothing in it says the one thing to do |
| Morrison and Fukasawa, *Super Normal* | special things "demand attention for the wrong reasons"; "a certain lack of noticeability has become a requirement"; a thing earns its worth in daily use | inside a sheet, is anything asking to be looked at? | one voice a screen (a name) and the rest quiet: the hand's piece is the only fill |
| Hara, for MUJI | not "this is what I want" but "this will do": acceptance, not appetite; emptiness is "a possibility of being filled" | is the desk a vessel for the work, or a show of itself? | the ground is empty and the same everywhere; a place with nothing in it says the one thing to do and nothing else |
| Giampietro, *Default Systems* | "the center is a default position"; "the system makes assumptions that, unchallenged, become truths" | which shapes are here because every interface has them? | the pill went (a key is a key, §3); a person's mark is their seal, not a tinted face; nothing is centred |
| Alexander, *Notes on the Synthesis of Form* | good fit cannot be described, but each misfit can be named, and fit is their absence | can what is wrong be named and counted? | §11 is a list of named misfits, each with the rule it breaks, and §12 the tests that find them |
| Chimero, *The Web's Grain* | a material has a grain; the web's is edgeless; build up from parts, then frame | does it fit a window, or go on past it? | rows run past the window's edge and the window looks along them; there is no layout for a size, only pieces that are set as words are |
| Playdate's own guide | "measure cap height, not total font height"; hold it against a printed book | is a size a number, or what the eye gets? | a name is sized by its capitals (and a kanji's face, §3); the words written are sized by the angle they subtend |
| the OP-1's tape | lift, drop, split, join: the verbs of the thing it stands for, and no others | are the verbs the material's own? | take up, put away, put back, go; a thing is never "selected" or "activated" |

**Master and servant.** At every rest one thing is the master and everything else is its servant, and the master
alone holds the top of every channel a thing can be raised by: the fill, the ink edge, the shadow, the largest words
of the place's work, the keyboard, what is written, the sound of what is done. A channel has one top (never two
things equally raised in it), and the same thing holds every channel's top (never the fill on one and the shadow on
another); each servant is a step under the master in every channel at once. So what can be done is exclusive too:
the master's act, or taking another thing up (which makes it the master and the last one a servant), or going
elsewhere; nothing is done to a servant where it lies. The canon says it in each art: in a picture, "one center of
interest. Two or more equally dominant figures ... compete with each other ... and weaken the picture's
effectiveness" (Mascelli, *The Five C's of Cinematography*); between eye and ear, "give preponderance either to the
sound, or to the image. If equal, they damage or kill each other" (Bresson); on a page, "stick to one or two type
sizes at the most" (Vignelli). Here: §2's one subject in focus and one voice, §5's one piece in the hand, §7's
nothing done from a distance, are this law in its channels; `master.spec.ts` holds it whole.

**The removal test.** Anything that can be taken away without the shot losing what it says is taken away: "any
element in the frame not required for story-telling purposes attracts unwarranted audience attention" (Mascelli);
"one does not create by adding, but by taking away" (Bresson); "as little design as possible" (Rams). A thing stays
only by answering one of the three questions (above) or doing the place's act (§14).

**A rule yields to a composition.** The rules here are general answers. Where a place already has a composition
that is the specific answer to what it is for, the composition stands and the rule is not laid over it: Git's sheet
(a number two cells tall at its top right, its title at the left, its work a column running to the sheet's right
edge, the sum of the work large at its foot) and Runtime's ruled account are such. Twice they were flattened by
rules that were true in general ("a number is said once", "one left edge", "no frame in a sheet"), and twice what
made the place its own went with them. A rule is laid on what has no answer of its own yet; what is specific is kept
("appropriateness is the search for the specific of any given problem").

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

### The window is a camera

The window is a camera over the desk, and every rest of it is a shot. A film of the OS in use is one take (§1); this
says what each frame of that take is, as a cinematographer would hold a film to one look. What film knows about a
frame, kept as rules here:

| The film-maker says | Here |
|---|---|
| One lens and one camera height for a whole film (Ozu kept his camera low and level in every shot), so that a cut is a graphic match | **One lens, straight down.** The world is drawn at one scale: a cell is 24 px in every place and at every width. Nothing at rest is drawn at a size the programme does not have (§3): a name with no room at its size breaks over lines, takes the programme's next size down, or is not shown; it is never fitted to its room. Nothing is turned or seen in perspective but a mark that points. The window looks straight down at a desk, as a flat lay is shot: what lies there is square to the frame, on its grid, at one spacing. |
| A horizon kept at one height from shot to shot | **One horizon.** Every place hangs from the frame's lines: the world's first row at y = 48 (a sheet's top, a piece's name), a piece's top at 72, every edge on a line of the grid (§3). So going down the rail the frame's architecture does not move; only what is on it changes. |
| Separation: one subject, picked out from what is behind it by light and focus, everything else graded down (Barr's "gradation of emphasis", written of CinemaScope) | **One subject in focus.** At every rest one thing casts the shadow and is in focus: the hand's piece, a place's sheet, or what was called up in front, behind which the world is out of focus, its shadow with it. The shadow is the one light's: 12 px right and down (§3). The rest is graded by fill, ink and size (§5). |
| The frame belongs to the camera, not to the scene | **The frame is never in the scene.** The rail and the band are the camera's instruments: never out of focus, never under what is called up, never moved (§2). |
| Eye-trace (Murch): at a cut, the new shot puts what is to be looked at where the eye already is | **The eye lands on what the place is.** After a move the eye is where the hand was: on the rail, or at the door, at the frame's top left. So what stands just past the frame's corner (a cell and a half right of the rail, two cells under the band) is what the place is: its subject, its name, or the index of what is in it. It is never ground, and never a control of something else. |
| Title-safe: a title stands whole, inside the frame; what is in the scene may be cut by the frame's edge, which says the world goes on past it (off-screen space) | **A title is whole; a thing may be cut.** The frame's own words (a place's name, the band's name of what is in hand) are whole at their size, inside the window and clear of its 6 px. A thing on the desk may be cut by the window's edge (the next piece of a row: the row goes on), except the subject, which is whole with its shadow. |
| One title to a shot, set at a few sizes | **One voice.** The display face is at its two sizes only (33 and 66), and what it says it says once in a frame: no two of its words alike, no number twice. |
| Look room: the space ahead of a subject is on the side it faces or moves towards | **The row is ahead.** The desk rests with a piece at its left edge, and the subject is that piece unless it was pressed where it lay: so it has the row's next before it, to the right, the way the row runs and the way a far side comes in (§6, §8). The line being written has the sheet's paper before it (§10, Forge at work). |
| Negative space is part of the composition (a lone figure against an empty sky) | **The ground is the negative space.** A short piece is as tall as what is on it and is not stretched to fill the frame; the desk under it is the desk, one field with nothing set in it, as a flat lay leaves its surface bare. A frame round nothing is no way to fill one (§5). |
| The camera moves only when something motivates it, and a move ends on a composed frame | **A move is asked, and lands on a shot.** The world moves only for what the hand asked (§8), and every move ends at a rest where each rule here holds. |
| The 180° line: screen direction is kept from shot to shot | **Directions never reverse.** Down is further down the rail; along is a far side, or the row's next; the world never goes the other way for the same thing (§2, §8). |

Each is measured at every rest of every place, at four widths (§12).

### A shot, computed

Film has been measured: where the eye goes across a cut, where the figures of fourteen thousand frames stand, how
little a change must be to read as a jump. So each rule above is computed from what a rest is made of, its boxes and
its colours, and none needs the shot to be looked at. A layout is found by working these out; a screenshot only
checks the sum.

**The terms.** The window `W × H`; the frame `F = 48` (§4); the world, the rest of the window,
`Ω = [F, W] × [F, H]`, and its thirds down it, `y₁ = F + (H − F)/3` and `y₂ = F + 2(H − F)/3`; a degree, 47 px (§4);
a pixel's ink (§5), and a region's weight, the sum of its ink (the ground's dots are the ground); the **subject** `S`,
the one thing with the shadow; and `h`, **where the eye is** as a rest begins: the middle of what the hand pressed (a
place's square, the door, a piece), or, when a key or a find moved the world, where the subject stood before it.

| Law | What film found | Computed | Bound |
|---|---|---|---|
| **Eye-trace** | Murch counts where the eye is among a cut's six criteria. Smith's attentional theory of continuity (2012): a cut goes unseen when the eye enters the new shot where it left the last. Miller and Seale centred *Fury Road* so that in a shot of 1.8 s the eye need not move to find its subject | the distance from `h` to the nearest point of what the place is (its subject, its name or its index) | **≤ 5°** (235 px): inside the parafovea (5° either side of where the eye rests, Rayner 1998), found without a search. So a piece gone to by a key, a find, or by coming to its place comes to the desk's edge, where the last subject stood: the distance is nothing |
| **Look room** | Thompson and Bowen's look room. Palmer, Gardner and Wickens (2008): a figure facing one way is liked off the centre with the room on the side it faces; in the same lab's later work, the way a figure moves counts over the way it faces. Short-sided, a figure reads as trapped | a piece of a row faces the row's way (artists leave 8 to 10% of the width more in front of a figure than behind it: Bertamini et al. 2011): ahead `W − (S.right + 12)`, behind `S.left − F`. The line being written faces the way it is written: down the sheet, and along the line | **ahead ≥ behind.** The line written is **never in the third of `Ω` it goes towards**: its foot ≤ `y₂` as it is written on, its top ≥ `y₁` going back while there is more above. Along a line that runs past the sheet, **its next 15 letters in sight** ahead of the caret (as many as it has) and 4 behind (McConkie and Rayner 1975: what is taken in at a glance is 3–4 letters before the eye and 14–15 after it) |
| **Size is importance** | Hitchcock: the size of a thing in the frame is its importance at that moment. Galvane, Ronfard, Lino and Christie (2015) score a shot by how far its sizes depart from its importances | the order of things by weight, and of words by size | by weight the subject first, **8 times** any other piece (§5); by size the place's one large thing first (§10); the frame least of all (§4) |
| **Weight off the middle** | Arnheim: weight away from the centre, with the room it faces, is a directed tension; at the centre it is at rest (Palmer's viewers put a thing that faces them in the middle) | `Tₓ = (Cₓ − (F + W)/2) / ((W − F)/2)`, `C` the centre of the world's weight | on a desk whose subject is at its edge, on a desk screen: **`Tₓ < 0`**, the weight left and the room ahead right. Not on a phone (its piece fills its world), nor in a place that is one sheet (the sheet is its world: a close-up, with nothing ahead of it) |
| **No jump** | the 30° rule: a cut that changes the angle less than 30°, or the size too little, is a jump cut; Galvane's cost of a jump is greatest when neither changes | for each thing in two successive rests (a piece, its name, the band's keys, the rail): how far each of its edges went | **0, or a cell (24) or more.** A line written grows its piece by a line; a line turned turns a line |
| **Order kept** | the 180° line: Galvane's cost of the left-to-right order is 1 whenever two figures change sides across a cut | for two things in two successive rests: which is left of the other, which over | **the same** |
| **Thirds bound, they do not place** | Cutting (2015), 14,000 frames of 48 films from 1935 to 2010: a lone figure's eyes are within 11% of a third's crossing in 19% of shots. Palmer's viewers did not prefer the crossings either | — | nothing is set on a crossing; the thirds bound look room and nothing else |
| **One light** | the eye takes light to come from above and a little left: 20–30° (Mamassian and Goutcher 2001); 77% of 225 paintings are lit from the left (Sun and Perona 1998) | every shadow's offset | **12 right, 12 down**: the light from the upper left (§3) |
| **A move is caused** | Michotte: a second motion is seen as caused by the first when it starts within 50 ms of it (now and then, 100) | the time from a press going down to the first frame of the move it asks | **≤ 50 ms** (§8) |

**When two cannot both hold.** Murch weighs a cut's six criteria (emotion 51%, story 23%, rhythm 10%, eye-trace 7%,
the screen's plane 5%, the space of the action 4%) and gives up from the bottom. The same order here: what the place
is for (§10), over the three questions of §1 (where am I, what is in my hand, what can I do next), over the times of
§8, over eye-trace, over the plane (look room, weight, the thirds, the horizon), over the space (order, depth). So:

- a piece pressed stays under the hand, though the room behind it be the larger (eye-trace over the plane);
- a row's first sheet stands before the piece in hand where both fit, though the weight then lie right of the middle
  (what can be done next over the plane: Server at 1024 px, `Tₓ` = +.02);
- a place's own composition stands over a general rule (§1: emotion over all).

### Negative space, and the lean

What is not drawn is half the shot. Print has said so for a century ("the relationship between the printed and the
unprinted area must be one of tension", Ruder, *Typographie*, 1967; "an unpainted space should not be seen as an
information-free area", Hara, *White*), and has numbers for it. Here they are rendered: the world in cells of 24 px,
each **bare ground** (its colour and its dot only), **bare paper**, or **marked**.

| Law | What print and perception found | Computed | Bound |
|---|---|---|---|
| **One field** | Trapped white, space "not allowed to connect to other space", is space wasted (Bradley); a small enclosed gap is seen as a figure, a hole, where a large field reaching the edge is seen as ground (figure-ground cues: smallness, enclosure, convexity; Wagemans et al. 2012) | the bare ground's fields, joined cells of it | the largest holds **≥ 95%** of the bare ground; it reaches the window's **right or foot**; what is shut in between things **< 1%** (a counter inside one sheet is that sheet's) |
| **How much is marked** | The book's canon sets its type area at 4/9 of the page (Van de Graaf, Tschichold); a type area of about half reads quiet and fine (上品・落ち着き), of four fifths busy (にぎやか); white space is read as prestige, quality and trust (Pracejus, Olsen and O'Guinn 2006). Its amount alone predicts little (r = −.15 with judged beauty; figure-ground contrast, +.51: Miniukovich and De Angeli 2015): where it lies matters more than how much | the share of the world's cells marked | on a desk, **at most a third** (measured: 9 to 27%) |
| **The lean** | Margins of one size "create an impression of indecision and dullness"; a type area set high floats, set low falls (Müller-Brockmann). The reading order weighs the upper left first and the lower right last (Ngo, Teo and Byrne's sequence) | the weight's centre, `Tₓ` (above); and how empty each quarter of the world is | `Tₓ < 0`, and the **lower right at least as empty as the upper left**: the weight with the frame, the room with the open sides (§4) |

**The lean, and how well it is known.** The left of a frame is where a left-to-right reader's eye goes first and
where a subject is put; how strongly is measured, and mostly small:

| Found | How strong |
|---|---|
| The first look at a picture goes left: 62% of first fixations (Ossandón et al. 2014), replicated (Foulsham et al. 2018) | firm |
| Who acts is drawn on the left, the action going right: 78 to 79% in 14 left-to-right languages (Suitner et al. 2021); weaker, not reversed, in right-to-left readers | firm, and learnt from writing |
| The same film sequence going left to right is felt as more positive and more active (Egizii et al. 2018, η² = .07) | small |
| Artists leave 8 to 10% of the width more room in front of a figure than behind it (Bertamini, Bennett and Bode 2011) | firm |
| Art photographs' weight is off their centre by .044 of the frame on average, and viewers do not prefer it centred (McManus, Stöver and Kim 2011) | firm |
| Salient things are better liked on the right (Levy 1976); a "glance curve" from lower left to upper right (Gaffron) | not borne out by eye-tracking; not used here |
| The eye's rest is the centre, with no shift up or down (Tatler 2007; Clarke and Tatler 2014) | firm: the lean up is print's (Müller-Brockmann), not the eye's |

So the subject stands where the eye goes first, at the left, with the room it faces to its right; the lean down and
right of the empty part is the sequence's, and Ngo's other measure, equilibrium, which counts any lean against a
layout, is not a goal here (an asymmetric balance is: Arnheim's "an unbalanced composition looks accidental"; here
the field ahead balances the subject). The lean is a poster's, not a photograph's: `Tₓ` from −.03 to −.59 on the
desks, where the photographs' .044 of a frame is −.09 in these units.

So the negative space of a shot is one thing: the ground ahead of the subject, open to where the world goes on. It is
never between things. Measured in every place at 1536 and 1024: the largest field holds 97 to 100% of the bare
ground; nothing is trapped but a counter in Inbox's first sheet; the lower right is the emptier quarter wherever the
subject is at the desk's edge. A place that is one sheet is a close-up and has its white inside it (Runtime 30%, the
Remote 47% bare ground at 1536).

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

- A line is 1 px. A piece's edge is an outline of 1 px inside its box, whole along its length: nothing on a sheet is
  painted over its edge or its shadow (a key at a row's end stands inside it).
- Corners: a key 4, a field 8, a sheet 10. Nothing else. **What is pressed is a key**, in the band and in a sheet
  alike (a button, a chosen part, a chip). Round is a person's mark, which is their seal (a ring of ink round their
  initial), and a dot. There is no pill: it is the shape a button has everywhere else, and it said nothing here.
- **A shadow is hard, ink (the terminal's: green), 12 px right and 12 px down (u/2), and only the piece in the hand
  has one.** One light, the same on every desk.

### Widths

| Thing | Width |
|---|---|
| a piece on a desk (a file, the terminal, Home's pieces, the band's bar) | **24 cells** = 576: fifty letters of 17 px mono (50 × 17 × .602), a margin of a cell and a half for the numbers before them and half a cell after, up to the grid |
| between two pieces | **2 cells** |
| a place that is one sheet (Runtime, the Remote) | to a cell from the window's right edge, at most **48 cells** (two pieces' insides and what is between them) |
| Home's slip | 12 cells |
| a row's first sheet (§6): Git's own, Server's | **8 cells**: a whole screen then shows it and two pieces whole (48 + 192 + 48 + 576 + 48 + 576 + 12 = 1500 ≤ 1536; 9 cells is the most that does) |
| Inbox's first sheet | 12 cells: one piece follows it, and it holds a name and what was last said on a line |
| a window narrower than a piece and its shadow | a piece is `24 · max(10, ⌊(W − 48 − 12) / 24⌋)` px: as many whole cells as there is room for |

**The widths are one programme.** A sheet has a cell of paper each side, and what is set in it in columns has two
cells between them. So `n` columns of `c` cells fill an inside of `n·c + 2·(n − 1)`, which is to say
**inside + 2 = n · (c + 2)**. A piece is 24 cells, its inside 22, and 22 + 2 = 24 = 2³·3: it divides into
1, 2, 3, 4 and 6 columns of 22, 10, 6, 4 and 2 cells with nothing over. That is why a piece is 24 and not 25 or 20.
The other widths are those columns with their own cell of paper put back: a first sheet of 12 cells holds a half
(10), one of 8 a third (6). A place that is one sheet is 48 cells, its inside 46 = 22 + 2 + 22, two pieces' insides,
and 46 + 2 = 48 divides into 1, 2, 3, 4, 6, 8 and 12. Nothing on a desk has a width outside this: a width is chosen
from it, never drawn. (Squared paper only gives lines to stand on; this says which widths there are.)

A window half a screen wide (768) shows one piece and the edge of the next; a whole screen (1536) shows two and the
edge of a third; a phone (390) shows one. These are not three layouts: they are the one rule at three widths.

---

## 4. The frame

The rail's column and the band's row: **two cells each**, at the window's left and top. The world starts at their
corner, **(48, 48)**, and its first dot is at (60, 60).

**One square for both.** A place of the rail and the band's bar are **36 px** tall with an **18 px** mark,
**6 px** from the window: 6 + 36 + 6 = 48.

### Its measure, derived

The frame is on every screen of every place, so its measure is the one most often seen, and it is not taken from
taste. A CSS pixel is an angle: the W3C defines the reference pixel as one pixel of a 96 dpi screen at arm's length,
**0.0213°** (CSS Values 4). So every length here is how large a thing is in the eye, and the frame can be measured
against what film and the hand ask of a frame in the same terms.

| Constant | px | In the eye | From |
|---|---|---|---|
| a desk screen | 1366 to 1920 wide | 29° to 41° | a cinema seat: SMPTE EG-18 puts the least a screen should fill at 30° across (smaller, "the image will appear small"), THX its back row at 36°. A laptop or a desk screen at arm's length is a good seat, so a frame of film's is the right model for it, at its own size |
| the cell, `u` | 24 | 0.51° | the line of what is read (§3) |
| **the frame, `F = 2u`** | **48** | **1.02°** | twice over. Film: the margin kept clear of action is 3.5% of each side (SMPTE ST 2046-1, safe action 93%); on the least screen a cinema allows, 30° = 1408 px, that is 49 px. The hand: the least target both platforms call sure is 48 (Material) and 44 (Apple; WCAG's AAA, 44). The grid's nearest is two cells: 48. On a 1366 screen it is the safe-action margin to the pixel |
| a square of the frame | 36 | 0.77° | the frame less a quarter cell each side; those 6 px, to the window's edge, are the square's too (§7): an edge cannot be overshot (Fitts), so a square at the edge is as deep as the hand's throw |
| its mark | 18, drawn at 2 | 0.38° | Material's square keyline in its 24 grid (18), half the square, one stroke weight |
| a piece | 576 | 12.3° | fifty letters of what is written (§3); two side by side, 25.6°, fill a cinema's least screen |

**The frame is held as an angle, not as a share of the screen.** Film's margins are shares because a television
crops a share; a window crops nothing, and what the eye and the hand need at the edge is an angle. So on a larger
screen the frame stays one degree and gives the rest to the world.

| Screen | Across | The frame's share | Against film's margins |
|---|---|---|---|
| 1920 × 1080 | 40.9° | 6.8% | inside safe action's (13.5%) |
| 1536 × 864 | 32.7° | 8.5% | inside |
| 1366 × 768 | 29.1° | 9.5% | inside; the rail is the safe-action margin exactly |
| 1024 × 768 | 21.8° | 10.6% | inside |
| 390 × 844 | 8.3° | 17.3% | the finger rules: inside title safe's (19%) |
| 320 × 568 | 6.8° | 22.2% | the finger rules: a little over |

### Its laws

The frame is the camera's own (§2): it is how the window is held, not something in the shot.

- **One degree, every way.** The rail's column and the band's row are both `F` on every screen (Eisenstein's
  *Dynamic Square*: the vertical has the horizontal's power). So the world's corner stands on the window's diagonal
  from its corner whatever the screen's proportion: the frame is the one part of a composition that does not change
  with the aspect.
- **Receding.** On every desk screen the frame takes less of the screen than film's safe-action margin does
  (13.5%); on a phone the finger's target rules it, and it takes at most a little over title safe's (22% at 320 px).
- **Two sides only.** The frame stands at the top and the left, where the eye starts and where the world goes out
  when it moves; the right and the foot are the world's open sides (off-screen space, the row's way and the page's
  way, §2). Nothing of the world is seen in the frame's strips, and nothing of the frame is set in the world.
- **One square.** Every place of the rail is a 36 px square at a 48 px pitch from (6, 6), its mark 18 px drawn at
  2 px; the door and the band's keys are the same square two cells wide.
- **The same in every place**, to the pixel. A camera's frame does not change from scene to scene.
- **Quiet.** What is always on the screen is kept faint: broadcasters keep their station's mark grey and dim, screens
  dim a still mark of their own accord against burn-in, and the navigation rails and tab bars of both platforms set
  the places one is not in quieter than the one one is in. So at rest the frame's marks and words are the frame's
  quiet colour (`sub`) and its lines the quiet line (`edge`); nothing in it is filled with ink. Ink is for the place
  one is in (on the slot colour), what is chosen in it (a server on the band: the slot colour under it), and what
  the hand is on: a place under the pointer or the keyboard, and the band while its search is written in, as a piece
  is ink only in the hand (§5). Measured, the frame's ink is a median 3% of the world's, at most 13% on a desk with
  only short files on it.

### The rail

- A place is a 36 px square about a corner of the grid: the first has its middle at (24, 24), the next 48 px down,
  and so every one, at one pitch from first to last. So four dots stand round every icon alike. Its icon is 18 px,
  drawn with a 2 px stroke of its 24 px box.
- Its marks are the frame's quiet colour; the place one is in has the slot colour under it and its mark in ink; a
  place under the pointer or the keyboard, paper, a 2 px ink ring and its mark in ink. At a place's far side its place is the one lit. A place's name stands out beside it while the keyboard is on
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
  ground under an 18 px mark, 1 px of the quiet line round it (ink under the hand). Its mark is the icon of where it leads. It is the window's,
  fixed, and there on a far side that has no band of its own.
- It is the first key of the band: nearest the rail, where the hand was when it came to the place. Where the page
  has a band, the band goes on from the door and the two are one bar as wide as a piece (the door has no edge of its
  own on that side).
- What waits where it leads is a dot on it, as on a place of the rail.
- Going through it the world goes **along** (§8), the far side coming in from the right; back, from the left.
- Only these six pages have a door. Runtime, File, the plug and + lead nowhere further.

### The band

On a desk (Home, New repo, Forge, Git). **One bar** from the desk's edge: x = 48, y = 6, 36 tall, as wide as a
piece (§3). Ground under it, a 1 px outline of the quiet line (ink while its search is written in), corner 4. Its keys are parts of it **two cells wide**, edge to
edge, a 1 px line between them; the search is the rest, its words 13 px. Every edge of the bar is on a line of the
grid, so no dot is cut by it.

- Home and Forge: the door, the terminal's key, the files' key, the search. Git: the door, the terminal's key, the
  search. New repo: the terminal's key, the files' key, the search (it has no far side).
- At the band's right end, against the window's edge by its ink, in the display face with its capitals a cell tall
  about the row's middle: on Forge the name of what is in the hand; on Git the repo the desk is of (an issue's number
  is its own sheet's large thing, and is said once, §2). Where the band has no room for it whole at that size it is
  not there at all: it is never made smaller to fit, and never cut.
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
  inside it. A sheet has half a line of paper over and under its lines. **A file whose lines pass the world's lower
  third stands to the foot**, its paper going on under its last line as far as brings that line up to the lower third:
  the room ahead of what is written last (§2, look room). The terminal is 18 lines and a cell over and under them, or
  as many as keep its last line, where its work is, out of the lower third.
- A file's numbers are 11 px, quiet, in a margin a cell and a half wide; its words start there.
- Nothing on a desk changes size, and nothing lies askew.

**What makes a sheet a composition** (said of Git's, without looking at it; it is what a sheet with something to
read on it is given):

1. **An axis that is not the sheet's left edge.** Things hang on both sides of it: right-aligned against it at the
   left, left-aligned from it at the right. One line inside the sheet, not two margins.
2. **A division that is not into equal parts.** Never halves; a third and two thirds, or less and more than that.
3. **White that is part of it.** The smaller side is mostly paper, and is one unbroken column of it.
4. **One side where the margin is broken.** What is on the larger side runs out to the sheet's edge; the other side
   keeps its margin.
5. **Sizes that jump.** Each at least twice the one under it (13, 33, 66), with none between.
6. **Large things at corners, across from one another,** and the middle left to the paper.

A sheet where everything starts at the left edge, runs the whole measure and keeps the same margin both sides has
none of these, however correct each of its parts is.

**What is ruled on a sheet.** A sheet may be ruled, as a form or a ledger is: lines of the quiet `rule`, 1 px, with
no fill and no shadow, and never of ink (ink is words, and the edge of what is in the hand). An account that is read
across (Runtime's: what is here, what is on the Remote, what can be freed) is one frame of columns of one height,
its figures at each column's right edge: the frame and the height are what make three lists one account. This is not
a sheet in a sheet. A sheet in a sheet has a fill or a shadow of its own, and there are none.

**What a sheet not in the hand stands as.** As tall as what is on it. Only the piece in the hand reaches the window's
foot; a board beside it is its name, the row's first sheet its lines, and neither is a frame round nothing.

**Nothing read or pressed has the ground's dots under it.** Words set on the ground stand on a patch of the ground's
colour exactly their own size, as a name on a map stands clear of its grid; a key on the ground has the ground's
fill. A dot in a line of small words reads as a full stop nobody wrote.

**A thing's menu is called by one mark,** a chevron pointing down, everywhere (a file's row, a repo, one's own name,
a server); out, it points back up. A mark is a few strokes of one weight, as the rail's are. There is no gear: it is
a picture of a machine's part, too fine to be drawn at a mark's size, and it says "settings" where what opens is what
can be done with the thing.

**A place that is one sheet** (Runtime, the Remote) is that sheet in the hand: paper from the desk's corner
(48, 48), a cell of paper round what is on it, its shadow, its name in the display face.

---

## 6. The row

Pieces are set as words are in a line: along from the desk's edge, and **a piece that does not fit beside the last
goes under it, at the desk's edge again, two cells down.**

- **A desk of short pieces (Home) is set so and nothing more:** nothing of it is ever out of sight sideways. A whole
  screen has its pieces side by side; half a screen and a phone, one under the other.
- **A desk whose pieces are as tall as the window has one line only**, and is looked along: Forge's files, Server's
  boards, Inbox's conversation. The rest of this section is that line (`ui/row.ts`, `ui/row-desk.ts`). (Git's issues
  are a row of their own make, §10.)

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

**Going to a piece by pressing it.** With the desk turned by `now`, the face `F` wide, the piece at `x`, the shadow
`S = 12`:

    far = x + W + S − F
    if far ≤ now ≤ x      stay at now                 (it is whole in sight: nothing moves)
    if now > x            turn to x                   (it was before the edge: bring it to the edge)
    otherwise             turn to the least x(n) ≥ far (the nearest rest that shows it whole)

The first line is a rule of its own: **what is pressed never goes from under the hand that pressed it.** (A desk
turned by hand and let go is as one pressed: the eye is where it looked.)

**Going to a piece any other way** (a key along the row, a find, a file opened, the place come to): **turn to `x`**,
the piece at the desk's edge. The eye is where the last subject stood, at the edge, and the new one comes there, with
the row ahead of it (§2: eye-trace and look room agree). Gone to by the least move instead, it stood a piece along,
13° from the eye, with more of the row behind it than ahead.

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
- **The window's edges are the frame's.** The 6 px between a square of the frame and the window, or the square next
  to it, are that square's to be pressed in (a quarter of a cell: the same game's own code gives a jump four pixels
  of grace on tiles of eight, a tenth of a second after the ledge is left). So a pointer thrown against the window's
  left edge is on the rail, against its top on the band or the door, and in its bottom left corner on the person's
  menu: an edge cannot be overshot, and between two places there is no room that is nobody's.
- **A press that just misses a menu is the menu's.** 16 px round what was called up neither put it away nor land on
  what is under it; its shadow lies in them. (The margin a toolkit that copies the phones' manners keeps round a
  popup, "inside which we do not consider a tap to dismiss".)
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

**Everything else is a cut.** What is neither one of the three moves nor the hand's own (a press's give and home, a
no's nudge, the caret) does not move at all: what comes is there, what goes is gone, at once, and the mind completes
the way between. Film found it first: "there's no reason to pan continuously from me to the lamp because you know
what's in between. Your mind cut the scene" (Huston, in Murch, *In the Blink of an Eye*); "the only punctuation which
Ozu allows himself is the simple cut" (Richie); in a comic's gutter "nothing is seen between the two panels, but
experience tells you something must be there", and that completing is closure (McCloud); "straight cuts are always
faster than moving shots, because they come to the point immediately" (Mascelli); "one does not create by adding,
but by taking away" (Bresson). What was so taken away: things gliding in, growing from nothing, folding up and out,
popping, crossfading, sliding off, the rail's ink sliding between places, and the ink's lights fading (`ui/glide.ts
cut`; every page's own). A light that says something was done is held for its read time and goes off at once. The
mind is not left to complete what it cannot: a cut keeps where things are (§2, eye-trace and order) and changes
wholly or not at all (no jump, §2: "neither subtle nor total" is Murch's jump).

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
- **A move starts within 50 ms of the press that asks it** (§2: past that it is not seen as the press's doing).
- **Words are read at rest.** Sight is sharp on a thing moving up to 2.5° a second (Westheimer and McKee 1975); a move
  here goes tens of degrees a second, so nothing is to be read while it moves, and every move ends at a rest within
  420 ms. Letters never move against one another or change their shape: what is written moves only with its sheet or
  the world, as a scroll does (Brownie's "global" motion; her "fluid" letters "cease to be legible").
- **Words shown for a moment stay long enough to be read once**: `max(500 ms, wide/4 + narrow/17 s)`, a full-width
  letter a quarter of a second (Japanese subtitling's four a second; up to six are read without strain, Toyokura and
  Yamada 2017), a Latin letter a seventeenth (Netflix's slower English rate), half a second at the least (the
  shortest a subtitle stands). `ui/law.ts readTime`. ("Copied" stood 1.2 s, and コピーしました needs 1.75.)
- **A line turned under the caret is turned at once**, a whole line, as a typewriter's platen turns a line under the
  hand: it answers the key, as the letter written does, and is not a move.
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

1. **The person's own.** A cell of desk; **the name**, Home's title: its capitals two cells tall, the first line's
   from y = 72 to 120, at any length. A name longer than the piece breaks over lines at that size, balanced, a line
   every three cells, so every line's capitals stand on the grid; only a word longer than the piece at two cells takes
   one cell (the programme's next size down, §2). A cell; the counts, 13 px mono, a cell under the last line's feet
   (from 144 with a name of one line); then the handle and the line about the person, a cell each, while there are
   any; a cell; **the note**. The note is Home's piece in the hand: its yellow, as wide as the piece.
   Its rows are the frame's square: an item's mark is a 16 px box with a 2 px line in a 36 px square at the note's
   edge, its words 15 px 700 on a 36 px line. It is as tall as what is written on it and the line of what the keys
   do, brought up to the next line of the grid, never under four cells.
2. **The repos and what waits.** "repos" on the cell under the band (y = 48); a name every two cells, capitals a
   cell tall, **the first standing on the line the person's name's first line stands on** (y = 120); a cell; "+ new repo" in the
   words' own size; a cell; what waits, a slip 12 cells wide drawn in line on the ground (it is not in the hand), its
   lines in the words' sizes (what waits is read; the display face is for names, §2).

**Home as a shot.** Home is a portrait, and each of its parts has a part in the shot (§2):

| In a shot | On Home | So |
|---|---|---|
| the title, read first and above all that qualifies it | the person's name, at the frame's corner where the eye lands | it keeps its scale at any length: a long name is more lines, never a smaller name; under it, small, what qualifies it (the counts, the handle) |
| the subject | the note, the piece in the hand: its fill, its ink edge, its shadow | the heaviest body (§5), its silhouette whole: nothing on it breaks its edge |
| the eyeline across the frame | the line the name's first line stands on (y = 120), continued by the first repo's name beside it | the two pieces read as one frame, not two lists |
| the supporting cast, graded down | the repos, a cell's capitals each (half the name's), what waits a slip in line on the ground | never larger than the title, never filled, never shadowed |
| the space ahead | the ground to the right of the two pieces and under them | one field, nothing set in it: the lead room of a portrait that faces the way the row runs |

### Forge: the work, written and run

*A repo open on the desk: the terminal and its files, side by side, to write in and run.* Its one large thing is
the name of what is in the hand, at the band's end.

A desk. Its row: the terminal first, then the files in the order they were opened. The terminal in the hand is ink
with its words green; not in the hand it is line on the ground, as any piece. A program that takes the whole screen
has its 80 columns while it runs.

**At work, the shot holds** (§2, computed). Working is writing, going through a file, taking the next piece and
running; none of it is a reason for the shot to change:

| Doing | What moves | So |
|---|---|---|
| coming to Forge | the piece in hand is at the desk's edge | the eye, on the rail, finds it at the frame's corner |
| a file taken by a key, a find, a link | it comes to the edge | where the last subject stood (eye-trace), the row ahead of it (look room) |
| a piece pressed | nothing | it stays under the hand |
| a line written | the piece grows a line from where its top stood; nothing else | no jump, nothing reversed |
| written past the lower third | the piece stands to the foot once; then the sheet turns a line at once per line written, the line written held at the lower third with paper under it | the line written never in the third it goes towards: the room ahead is paper to write on |
| gone back through it by the keys | the sheet turns a line at once per line gone past the upper third | the same room the other way |
| along a line that runs past the sheet's edge | the text turns along to keep the line's next fifteen letters in sight | what is read at a glance is ahead of the eye |
| the terminal running | its words, inside it | its last line, where its work is, out of the lower third |
| a press in a file | the caret, to where it was pressed; nothing turns | eye-trace over the plane |

### Git: Forge's far side, the work recorded and reviewed

*What a repo is to become, what it became, and what is asked to be taken into it.* It has a composition of its own,
and it is kept (§1).

A desk. At the desk's edge main's own sheet, eight cells wide (ink: it is where the repo's work is switched); two
cells on, the issues. The issue in the hand is a wide sheet, set as a poster is:

- its **number** at its top right, two cells tall in the display face: the place's large thing;
- its **title** at its top left, capitals a cell tall on lines of a cell and a half;
- under them, at the left, what is said of it (its summary, whose it is), set against the work's edge; at the right
  **the work**, a column that runs to the sheet's right edge: each file's name and count, the lines that changed on
  a band of the change's colour across the column, the lines beside them out of focus (they are what the change is
  seen against, behind it);
- at its foot, left, **the sum of the work**, large;
- its number and kind, small, in the cell over its corner.

The issues before and after it show a cell or three of themselves at the row's two ends, with their numbers; an end
pressed goes to that issue. Under the sheet in the hand, its history runs down a dotted line. Which repo is a choice
on this desk, not one of the window's instruments: it stands on the cell under the band. On a window with no room for
main's sheet and an issue side by side, the issues go under the sheet, two cells down.

**What is written here is written where it stands** (§7: nothing to open first, nothing to confirm):

- **A new issue** is its first line, written on a line that is always there, a cell under main's sheet, the repo it
  goes in said quietly in the cell over it (chosen in the row of repos). Enter makes it, and the keyboard goes on into
  its summary in the issue in full, written there and kept as it is left. With no issue yet the line is at the desk's
  edge, where the first piece would be, and what is so is said quietly where the issues would be. Asked for from
  Forge, the line has the keyboard; Escape with nothing written goes back there.
- **A commit on main** is main's card's line, always there under its files: Enter commits it, as Commit beside it
  does. There is no Cancel: nothing was opened.
- **An issue's title** is written over where it is read: pressed, it is a line of its own words, its kind kept and
  its title chosen; Enter or leaving keeps what is written, Escape puts it back.

What is half written in any of them stays, going along the row or to another page and back.

### Server: where many talk

*A room: boards of talk, each with a shared list, and the people in it.* Its one large thing is the name of the board
in the hand.

A desk with a row (§6). First, the room's own sheet, eight cells, packed as Inbox's first sheet is (nothing round
its lines but the sheet's edge, a line a cell tall, half a cell in): its boards by name (the one in the hand in ink,
a dot on one with something not seen), the way to a new one, who is in it, the repos they show. Then its boards in
their order: the one in the hand a sheet as wide as any piece; **one not in the hand is its name on the ground and
nothing round it**, as wide as the name, as a repo's is on Home; pressed, it is taken up. Last, so too, the board
not made yet. The board in the hand is a sheet: its name in the display
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

### What is said: a transcript on an axis

A board's talk and a conversation are set the same way, as a transcript is, on the sheet's axis (§5); not as bubbles
on two sides.

- **The axis.** The sheet's inside is 22 cells, set **6 | 2 | 14**. The first six are the margin: who speaks (their
  name in bold) and when, right-aligned against the axis, and paper. The words start at the axis and have 14 cells.
  This is a letter's sheet as the *Canon* sets one: three columns, "leaving the left one blank", the text "flush
  left from the second column toward the right margin".
- **The measure.** 14 cells are 336 px, about 46 letters to a line: in the middle of what is read with ease (45 to
  72), where the whole inside (72 letters) was at its far end.
- **The sheet's name stands at the axis** too, with what is said of it small in the margin beside it (a board's #,
  how a conversation reaches the other). The sheet's line under its name starts at the axis
  and runs out to the sheet's right edge: the margin is one column of paper from the sheet's top to its foot. Between
  the talk and the box one writes in there is no line: the box is in front of the talk, and what passes under its
  edge as the talk is read back goes a little out of focus (2 px, over the half cell the talk keeps empty at its
  foot, so at rest on the latest nothing is).
- **The box one writes in** stands in the words' column, under them. Its key (Post, Send) comes with the words, and
  says its keys on itself; Enter is a new line.
- **On the grid.** Words are 15 px on lines of a cell. A run of one person's posts a few minutes apart says who
  once, and the margin beside the rest of the run is paper; half a line between two posts of a run, a line before
  another speaker. A day's name is a small line of its own in the margin.
- **A sheet with no room for 6 | 2 | 14** (a phone's piece is 13 cells, 264 px inside, 36 letters) has who speaks
  over the words, as what does not fit beside goes under (§6). By the sheet's own width, never the window's.
- **Standing on its foot.** The latest is just over the box one answers in; a talk longer than its sheet scrolls
  inside it, and the box stays in sight.
- **What can be done with a post** (its time in a run, taking it down) is on the post in the hand: pressed, or with
  the keyboard in it.

### Runtime: this device

*The machine one is at: what it holds, what runs on it, how it is set.* A sheet. A place of figures: the figures
are the one thing with weight (20 px 700), everything else is said in 13 and 15.

### The Remote: Home's far side, where the repos are kept

*The other machine: an account, its devices, what it keeps.* A sheet.

### New repo (+)

*One question: what is it called.* On Home's ground: one piece at the desk's edge, and it is the hand's (paper, its
ink edge, its shadow: the one on the desk). Its place in the cell over its corner, as a piece's name is, on one line
and on a patch of the ground its own size: `~/` and the name as written, a letter no name can have marked where it
is; then New repo, quiet, which gives way where the line has no room for it whole. In it, a cell of paper each side:

1. the name on its first line in the display face, its capitals a cell tall as every name's (a name longer than the
   line goes on past it as a field's words do: never made smaller for its room); nothing written, the word for what
   goes there, quiet;
2. a cell; why the name cannot be, where there is a reason, in the small size on lines of a cell (what is under it
   comes down by the cells it takes; the sheet's top never moves);
3. what the repo is for, on lines of a cell;
4. a cell; a rule; half a cell; **what will be made in it**, a line a cell tall each, folders first, a folder's depth a
   cell in; New file and New folder their last line; half a cell;
5. a cell; Create, a key the frame's square tall.

As wide as a piece, as tall as what is in it to the grid's next line, every line of it on a half cell.

The repo itself is the sheet, its name the sheet's title: said once, large, and not drawn again as a row of the
list under it (it was, filled with ink as File fills the repo in hand: a second fill on the sheet, and the name said
twice). A row's name pressed is written over in its place; what else can be done to it (Rename, Leave out) is its one
mark's menu, the chevron at its right end, always there and quiet (§5). Nothing on it is coloured by the pointer.
Three sizes on it, as on any sheet: the name's, the words' (15), the small (13); and the key's own name.

### File

*Everything there is, as a tree.* Not a place: it is called up in front of whatever place is shown, from the rail,
by a press and by nothing else, and it stands whole in the window beside what called it; the place behind it goes out of focus. Each row's menu is always there, quiet.

---

## 11. What is not yet so

The design above is what the code does, except here. Each is a rule of this document that a part of the OS still
breaks; none is a decision to leave it.

| Where | What it still does | The rule it breaks |
|---|---|---|
| Git | its row is slid by code of its own (a finger's swipe is read by it), not turned as a desk is, so it does not follow the hand; the issue beside lights under a pointer | §6, a row is looked along as anything is scrolled; §7, nothing waits on a pointer |
| Git | under 1100 px wide the sheet's work goes under its words and its number into its title's line: by the window's width | §1, a narrow window has the same rules |
| Server | a board not in the hand is its name only: what it holds is read when it is taken up | §5, a piece not in the hand is read, a step quieter |
| Server | behind its gear and a repo shown: a page of the old make (its title 24 px, its parts on a sliding line) | §3, §5 |
| Server's chips, a sheet's parts | a line of them longer than its room slides, its end faded into the ground, a › over the fade | §1, no transparency as decoration; §6, what does not fit goes under |
| the search's finds | the find beside the one read lights under a pointer | §7, nothing waits on a pointer |
| the band | Home, Forge and Git each build their own (the door alone is the window's); Runtime, the Remote, Server and Inbox have no search, so the band's row is not the same in every place: Server's is a round +, its servers as pills and a chevron at the row's far end; Inbox's and the Remote's the door alone; Runtime's nothing | §2, the frame is the window's; §4, the frame the same in every place (held of the rail, not yet of the band's row) |
| Forge | the desk still turns by itself to where the Agent is working | §8, the world moves only for what was asked |
| moves in code | their lengths are still written where they are made (their curve is the law's) | §8 |
| the sheets (Runtime, the Remote) | what is in them is laid by the window's width in places (27 rules that ask the window how wide it is remain in the sheets, most of them here) | §1, a narrow window has the same rules |
| the Remote's repos | a repo on or off the Remote is a switch drawn as a phone's is (a knob in a slot) | §1, no shape taken unasked |
| inside the sheets | what is set in columns in Runtime and the Remote is not yet set by the programme's columns (14, 10, 6) | §3, the widths are one programme |
| signing in, a Remote not answering | the same deed has two looks (Try again in ink on Server, in line on the Remote) | §1, one hand |
| deeds that ask first | some twenty deeds ask before they are done (remove a dotfile, take a repo off, sign a device out, a server left), each in its place with Cancel beside it, whether or not they can be put back | §7, what can be put back is done and can be put back |
| Forge, the first time | the desk is long in the building (the Prompt starts with it), and the move to it waits for that: 60 to 90 ms from the press, where every other place is off within 50 | §8, a move starts within 50 ms of its press |
| Git's issue in full | its width is the row's of its own make (the window less two neighbours' peeks), not one of the programme's | §3, the widths are one programme |
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
| The law of motion: its shape, its time; the sheets' curve is the code's; no sheet moves by another curve or a written-out time; how long words shown for a moment stay (§8) | `why/app/ui/law.test.ts` |
| What a colour may say: the greys from ink to paper each lighter than the last and none a hue; each hue a kind of its own (§13) | `why/app/ui/tokens.test.ts` |
| A piece's place is its number; where the desk rests; going to a piece, every case; a phone by the same rule (§6) | `why/app/pages/forge/desk-layout.test.ts` |
| A piece's width at every window; a row whose first sheet is narrower than its pieces (§3, §6) | `why/app/ui/row.test.ts` |
| The rail's order; which pages are a place's far side, where each door leads and that it leads back (§4) | `why/app/host/purposes.test.ts` |
| What a typed key sounds as (§9) | `why/app/ui/touch.test.ts`, `why/test/app/sound.spec.ts` |
| Every page starts at the frame's corner, a desk's band from the desk's edge, a sheet from the desk's corner, the door where there is one, at four widths down to a phone; the dots under every page; nothing wider than the window (§2, §4) | `why/test/app/skeleton.spec.ts` |
| Every rest is a shot, in every place at four widths: one lens (nothing scaled, zoomed or in perspective), one horizon (the subject on the grid), one subject in focus with the one light's shadow, the frame in focus under what is called up, the eye landing on what the place is within 5° of where the hand was, the weight left of the world's middle on a desk, the lean (the lower right at least as empty as the upper left), the bare ground one open field with nothing trapped and at most a third of the world marked, the band's title whole at its size, one voice (§2) | `why/test/app/composition.spec.ts` |
| Touch, with motion on: under the pointer a thing takes paper or nothing; a press answers in its own frame, sounds as it goes down, gives at most 8% and comes home never past; every place's subject holds its act (§14) | `why/test/app/touch.spec.ts` |
| Master and servant: on a desk one piece holds the fill, the ink edge, the shadow and the keyboard, and what is typed goes to it alone (§1) | `why/test/app/master.spec.ts` |
| Writing in Git is direct: a new issue's line and main's commit line always there, Enter making or committing, nothing to open, confirm or put back; an issue's title written over in place; what is half written kept (§7, §10) | `why/test/app/git.spec.ts` |
| Forge at work, frame by frame at two screens: the piece in hand at the edge or under the hand; the line written never in the third it goes towards, a long file standing to the foot; the terminal's last line out of the lower third; nothing jumping, nothing reversed; the weight left (§2, §6, §10) | `why/test/app/at-work.spec.ts` |
| Where the line written may stand, the terminal's lines, and where the desk turns for a piece pressed and for one gone to (§2, §5, §6) | `why/app/pages/forge/desk-layout.test.ts` |
| New repo is one piece at the desk's edge, the hand's: on the grid, a piece wide, its name at a name's size on its first line, what will be made inside it under a rule, every line of it on a half cell, three sizes, nothing filled but its key, its place over its corner on a patch of the ground, each row's deeds one chevron; why a name cannot be said under it with the sheet's top still (§10) | `why/test/app/new-repo.spec.ts` |
| Server's and Inbox's rows: the first sheet at the desk's edge, the piece in the hand whole in the window, a cell under the band to a cell over the foot, paper with its shadow, at four widths (§5, §6) | `why/test/app/skeleton.spec.ts` |
| A board's box: its key comes with the words at every width; it stays in sight under a long talk (§10) | `why/test/app/server.spec.ts` |
| Home's row, the name, the note, the repos, the slip; half a screen, a whole one, a phone; Home as a shot: a long name keeps its size over lines on the grid with the eyeline at its first, and the note's edge is whole (§10) | `why/test/app/home.spec.ts` |
| Forge's row; the hand's piece alone filled; nothing changes size; what is pressed does not move; the desk rests at a piece (§5, §6) | `why/test/app/forge-work.spec.ts` |
| Where the ink is: 8 times, on Forge whichever piece is in the hand, and on Home (§5) | `why/test/app/focus.spec.ts` |
| The window's edges are the frame's; a press just off a menu is the menu's (§7) | `why/test/app/favour.spec.ts` |
| The frame, in every place at six screens: one degree every way, receding inside film's safe-action margin on a desk screen, one square, the same in every place, on two sides only, quiet at rest and ink only under the hand (§4) | `why/test/app/frame.spec.ts` |
| Going to another place: the two pages and the dots move as one in every frame (set off at one instant), one way, off within 50 ms of the press, at rest within 420 ms; the rail's place inked at once, no ink going between (§8) | `why/test/app/motion.spec.ts` |
| What comes is there at once: an arrival and a band changed are cuts, motion asked for or not (§8) | `why/app/ui/glide.test.ts` |
| File comes by a press and by nothing else (§7) | `why/test/app/file.spec.ts` |
| A phone has the same rules (§1) | `why/test/app/narrow.spec.ts` |

`npm test` runs the `.test.ts` files; `npm run selftest` the `.spec.ts` files, in a browser against a real Remote.

To add a rule: write it here as a number or a sentence that can be false, then write the test that would find it
false, then make it true. To change one: change it here first.

---

## 13. Its words

The words this design is made of, as it uses them, each said so that a test can find the thing. Each is known one of
four ways:

- **given**: decided by a person and written here. Nothing computes it, and the rest is computed from it;
- **measured**: computed from the page's boxes and times;
- **rendered**: computed from the pixels as drawn, with no eye (a screenshot and §5's ink);
- **looked**: known only by looking. Each is a misfit not yet named (§1, Alexander), and the list under the table is
  all there is of them.

| Word | What it is | From | Known |
|---|---|---|---|
| **world** | the plane under the frame, `[48, W] × [48, H]`: the desk, the places down it, their far sides along | film's field | measured |
| **ground** | the world's colour with a dot a cell: what is not anything | squared paper | rendered |
| **frame** | the rail's column and the band's row, 48 each, the camera's own: quiet, fixed, never in the scene | film's frame line; safe action | measured |
| **place**, **far side** | what the rail goes to, down; its other page, along through the door | — | given |
| **piece**, **sheet** | a thing with something in it lying on a desk, its edges on the grid; a piece of paper (paper, corner 10) | stationery | measured |
| **row** | pieces along from the desk's edge, `x(n) = n(W + G)`; a piece's place is its number | a line of words | measured |
| **rest** | the world still, a piece at the desk's edge: a shot | film's composed frame | measured |
| **move** | one of three (the world down or along, the desk along, in front and back), by one law | the camera move | measured |
| **cut** | the subject changing with nothing moving (a piece taken where it lies; the band's name another) | the cut | measured |
| **take**, **in hand** | the act that makes a piece the subject (a press, a key, a find); the one piece being worked in | picking up | measured |
| **subject** | the one thing with the shadow at a rest, eight times any other's weight | film's subject in focus | rendered |
| **in front**, **out of focus** | what is called up by a press comes over the world; the world behind is blurred | depth of field | measured |
| **ink**, **weight** | a pixel's distance from the ground, `ΔE/50`; a region's sum of it | Arnheim's weight | rendered |
| **quiet** | the step under ink (`sub`, `edge`): at rest, not in hand, the frame | the broadcaster's dim mark | rendered |
| **value**, **hue** | what is ranked is said by value, the greys from ink to paper; a hue says a kind (the machine, one's own, done, refused) and ranks nothing | Bertin's visual variables (1967): value is ordered, hue is not | measured (tokens) |
| **voice**, **the large thing** | the display face at its two sizes, one thing said large in a shot; which thing it is | the poster | measured; which, given |
| **title** | the frame's words: whole at their size, or not there | title safe | measured |
| **horizon**, **eyeline** | the line every place's first row stands on (48, 72); the line a place's first name stands on, carried across | the horizon line; the portrait's eyeline | measured |
| **lens** | one scale: nothing scaled, zoomed or seen in perspective; a name too long breaks or steps down a size | Ozu's one lens | measured |
| **eye-trace** | where the eye is as a rest begins; what the place is lies within 5° of it | Murch; Smith | measured |
| **look room**, **lead**, **platen** | the room on the side a subject faces or goes; the line written kept out of the third it goes towards; a line turned at once under the caret | Thompson and Bowen; the camera leading a mover; the typewriter | measured |
| **jump**, **order** | a change of 1 to 23 px, forbidden; which is left of which, never reversed | the 30° rule; the 180° line | measured |
| **one light** | every shadow 12 right and 12 down: the light from the upper left | the light-from-above prior | measured |
| **field**, **trapped** | the bare ground as one body, open to the right or the foot; ground shut in between things | Ruder; Bradley; figure and ground | rendered |
| **lean** | the weight up and left with the frame, the room down and right with the open sides | Müller-Brockmann; the reading order | rendered |
| **read time** | how long words shown for a moment stay: `max(500 ms, wide/4 + narrow/17 s)` | subtitling | measured |
| **cell**, **programme** | 24 px, the line, every gap a cell or half; the widths 8, 12, 24 and 48 cells (`inside + 2 = n(c + 2)`) | Vignelli's grid from the leading; Gerstner | measured |
| **character** | what a place is for, in one sentence (§10); its one large thing | Murch's emotion | given |
| **importance** | which thing in a place matters most, then next: the subject's kind, the large thing, the cast | Hitchcock's rule | given |
| **friction** | a cost kept because it says what a place is (§7) | — | given |
| **misfit** | a named place where a rule is broken (§11) | Alexander | given, then measured |

### What only a person gives

Everything above that is measured or rendered is computed from four things a person gives, and from nothing else
(and over the four, one more: why a person would be moved to do what a place is for, §14):

1. **What each place is for** (§10, one sentence each): its character. Murch's first criterion, "emotion", weighs more
   than the other five together, and no measure reaches it: a title "sets mood ... in some metaphorical way" (Saul
   Bass), and motion "cannot normally replace or override strong emotive content intrinsic to the meaning" (Lee,
   Forlizzi and Hudson 2002).
2. **What matters most in it, and next** (the subject's kind, the one large thing, the cast). Hitchcock's rule scores
   size against importance, and the importance is the author's: in the systems that compute it, how to evaluate it
   "remains largely unresolved" and it is written in by hand (Galvane and Ronfard 2017); a layout system takes the
   designer's "desired importance" as given, "not estimated" (O'Donovan, Agarwala and Hertzmann 2014). Where the eye
   goes in a scene follows its meaning more than its brightness and edges (meaning explains 53% of where people look,
   salience 38%, and alone 19% against 4%: Henderson and Hayes 2017), and meaning is mapped by people, not by
   pixels.
3. **The words**: what a thing is called, what a place says. How long they take to read is computed (§8); whether
   they say the thing is not.
4. **What is kept as friction** (§7).

And one thing only looking finds: **that something is wrong**. Measures of a screen predict what a crowd will judge
of it on average, about half of it (Reinecke et al. 2013; Miniukovich and De Angeli 2015), and one person's judgment
far less (r ≈ .3 to .5); what a measure does not know of (a grouping by meaning, a word cut short, an empty field that
reads as missing) shows only to an eye. So the eye is used for one thing: to find a misfit. Found, it is named in §11,
given a number here and a test in §12, and only then fixed. Looking finds; numbers hold.

---

## 14. Touch, and what it is for

### Over everything: the motive

Over the givens of §13 there is one more, and it comes first: **why a person would be moved to do what a place is
for**. A place is not a set of things to look at; it is an act a person comes to do, and the act, done, gives
something. Games are made in this order: the experience wanted first, then what makes it (Hunicke, LeBlanc and
Zubek's MDA, 2004: mechanics serve dynamics serve the aesthetic; Nintendo tested how a big jumping Mario would feel,
"どんな手ごたえになるのか", before the written specification). So each place names its motive, "one does X, and Y comes
of it", and the rest is derived from it:

- the subject is where X is done: **a screen is for its act**, and every place's subject holds it (something to
  write in or to do), at every rest (§12, `touch.spec.ts`);
- what matters most is ranked by its part in X;
- the words name X's things and deeds;
- friction is kept only where it makes Y.

### The givens, as they were left implicit

Read from §1, §7, §10 and `PLACES.md`, where each was said in passing; the person who gives them changes them here.

| Place | One does … and … comes of it | Its kind of pleasure (MDA) | What matters most: subject › large thing › the rest | Its words | Friction kept |
|---|---|---|---|---|---|
| Home | writes what is one's own to do, and the day is one's own | expression | the note › one's name › the repos, what waits | a TODO, Next TODO, repos | none |
| New repo | names a thing, and it is there | expression | the sheet › the name being written › what will be made | name, what it is for, Create | none: Create makes it at once |
| Forge | writes and runs, and sees it work | challenge, mastered | the piece in hand › its name on the band › the row | a file's name, the Prompt, Run | one piece in hand at a time (§7) |
| Git | judges the work and records it, and it is done | narrative: written, started, handed in, merged | the issue in hand › its number › main's sheet, the neighbours | issue, Start, Commit, Merge | a far side is a step away (§7) |
| Server | talks with many, and is among them | fellowship | the board in hand › its name › the room's index | board, post, TODO | Enter is a new line; sending is its own key (§7) |
| Inbox | writes to one, and is answered | fellowship | the conversation › who › who wrote | conversation, Send | the same |
| Runtime | sees what the machine holds, and frees it | care | the sheet › its figures | what is here, on the Remote, can be freed | a deed that cannot be put back asks (§11) |
| The Remote | keeps one's things elsewhere, and they are safe | trust | the sheet › its repos › devices | on, off, devices | turning a repo off asks for its name |
| File | looks for anything, and finds it | discovery | the tree › `/` › its rows | its rows, their menus | it comes by a press only (§7) |

### One winning principle a kind of touch

Touch is not one law. Each kind of touch has its own principle, the one that wins there, said as a number where the
research has one, measured on every control of every place from the top right, hovered and pressed with motion on
(216 presses):

| Touch | The principle | Its number | From | Measured |
|---|---|---|---|---|
| **Hover** | quiet to ink, or paper under it; nothing comes, nothing goes | no other fill | §3, §7 | 26 controls took a raised fill, two an ink one, the ink key a lighter ink: all now paper or nothing |
| **Press** | answers at the thing pressed in the frame it goes down; sounds as it goes down; gives a few pixels and comes **home, never past**; what it does, it does on the let-go | its answer ≤ 50 ms, its sound ≤ 1 frame, its give ≥ .92 of itself, never over 1 | a highlight on touching down and nothing confirmed until the touch goes up (Apple, *Designing Fluid Interfaces*, 2018); 50 ms is felt as instant, 200 ms as sluggish (Swink, *Game Feel*); a press's visual answer feels one with it within 30 to 85 ms, its sound within 20 to 70 (Kaaresoja 2016); no overshoot without momentum (Apple) | its own answer 16 ms (one frame), at most 24; its sound 0 to 1 ms after; its give .92; it sprang 2.3% past itself on 52 presses: now it comes home |
| **Key typed** | the letter drawn in the frame it is struck, its sound as it is struck, the caret going with it (§9) | one frame | a slow keyboard (200 ms) costs effort and correcting, not copying speed (Schmid et al. 2023); "the lower, the better" (Fatin) | `sound.spec.ts`, `motion.spec.ts` |
| **Carry** (a drag, the desk by hand) | it stays under the hand, moved by the window's own scrolling or the drag's own frame; no easing laid on what the hand moves | lag ≤ 1 frame | "not imposed upon objects when they are being explicitly moved by the user" (Chang and Ungar 1993); a drag's lag is noticed at 11 ms on a screen, 55 ms through a pad (Deber et al. 2015) | §7 |
| **Called up** (a menu, the finds, File) | by a press, laid where it was asked (its first deed under the press), away at once by a press outside or Escape | in the press's frame; its first deed within 5° of the press (§2) | a panel opened by the hand opens quickly and closes fast (Lewis); things leave the way they came (Chang and Ungar; Apple) | §7, `favour.spec.ts` |
| **Comes, goes** | there at once and explained after, never grown from nothing or faded over what it replaces (§8) | — | an animated transition makes one wait; show the result, then an afterglow where it changed (Baudisch et al., *Phosphor*, 2006) | a dozen still grow or fade (§11) |
| **Refused** | said once the field is left, where it is put right, and in words; the thing nudged the way that means no, short | the nudge ≤ a cell, ≤ 300 ms | inline validation after leaving a field: 22% more success, 22% fewer errors (Wroblewski 2009); a shake in a meaningful direction, not a random one (Pichlmair and Johansen) | New repo, Git's lines |
| **Done** | **the one strong answer**: what was done lands, lit, where its result is (a line under Committed, a step's mark), and nowhere else | lit ≥ its read time (§8) | amplified feedback on success raised competence and enjoyment; on mere action it lowered them (Kao et al. 2024, n = 1,699); Sakurai: the stop that marks a hit is for what counts | Git's Committed and steps |
| **Waits** | nothing said under a second; past it, what is being done in words where its result will be; past ten, how far, and a way to stop | 1 s, 10 s | Nielsen's three limits; showing the work raises its worth (Buell and Norton 2011) | §7 |

### Its repertoire, and what it never does

What the OS touches with is a short list, each its own: **the give** and **home** of a press; **the sound** of a key
and of a press going down; **ink** and **paper** under the hand; **the move** by one law and **the turn** of the
desk; **the platen** and **the lead** of the line written; **the landing** of what was done, lit; **the nudge** of a
no; **read time**; and **grace**, the hand read in its favour (§7: a cell either way, the window's edges, 16 px round
a menu).

What it never does, on purpose: shake (but the nudge of a no), particles, a bounce, anything past where it goes,
anything that grows into place or fades over what it replaces, a sound under the pointer, and **a flourish on a mere
press**. More is not better: of four levels of "juice" in one game, none and the most both made play worse than the
middle two (Kao 2020, n = 3,018); juice that hides what caused what, or makes every result look alike, is "too much of
a good thing" (Kao et al. 2024).

### Ordinary parts, more than expected

A touch that feels better than expected is not one large effect. It is ordinary parts that agree, every time, with
one material: a press is a key's (it answers going down, sounds going down, gives, comes home); writing is a
typewriter's (the strike, the caret, the platen turning a line); going is a camera's (one law, the dots with the
world). Each part is ordinary; that they agree with each other and with the thing they are is what is felt (Swink
counts "metaphor" among the six parts of game feel; Miyamoto: the D-pad is the same hardware in every game, and how
a press feels differs, "そこの部分が大事"). So a new interaction is made from the repertoire, its material named, and
nothing is added to it that its material would not do.

