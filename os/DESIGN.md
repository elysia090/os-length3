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
  square. An action you press or a choice you make (button, repo
  chip, +) is round. A field
  you type into is slightly rounded and filled `raised`.
- **States.** Hover is a `raised` fill. The current or chosen thing is an
  `ink` fill with `ground` text: the rail item (File while its tree is
  out), the repo chip, the open repo in the tree, the primary button. A large place
  (a card, an issue row) is too big to fill with ink: it is current by an
  `ink` edge over `raised`, as a lit repo card is. Where one is inside
  the current thing (the file Forge is reading, under the open repo in
  File) is quieter than the thing it is in: a short straight `ink` line at
  its row's left and its name 600, kept while the pointer is elsewhere and
  apart from hover. Focus is a 2 px `ink` ring. Nothing else marks state
  (no underline, no bold-only). Pressed, a thing's fill goes a step darker
  at once (40 ms; an `ink` one, a step lighter) and, let go, eases back
  (260 ms) as it gives under the finger; hover comes in quick (90 ms) and
  goes slow. Only the fill and the edge ease: words and icons turn at once,
  never half way between ink and ground.
- **Selection** is the current-thing state too: `ink` with `ground` text,
  for selected text. What the search found is not selected but marked: the
  `marker`'s stroke over its words, as a highlighter would (the line landed
  on from it is selected in the marker too, for that moment).
- **Sheets and the ground.** Two surfaces only. A sheet (`paper`) is what
  is worked on; everything else stands on the ground. Lighter is nearer:
  nothing lighter than the ground is ever put under something darker. The
  sheet in hand, or with the keyboard, has its edge in `ink`.
- **Lines.** 1 px. `rule` around places; `edge` around things you press or
  type into. A dashed `rule` means one thing: room for something that is not
  here yet. Headings never get a rule. Two lines are the exception, and the
  same as each other: the rail's and the right pane's, 2 px in `ink` from the
  top line to the foot. They frame the work, so the center reads at once as
  the thing between them; put away, the pane takes its line with it.
- **Words over symbols.** What a thing is reads off the screen as it is
  written: a TODO kind shows as "Fix：", a link in `/bin` shows as the
  command's name only, with no arrows. The kind's colon is seen as the
  face's own colon against the word, a space's room after it ("Fix: The
  title"), whatever font holds the full-width one (each sets it elsewhere in
  its box); the written "：" stays in the text, heard and copied as written.
  After a Japanese kind (買う：種) the full-width colon is what Japanese sets
  there, and is seen as written. A line of a diff that starts with a Latin
  kind (an issue's file: Idea：…, Closed：…, on main's card in Git) reads the
  same in the code face, Idea: …; any other full-width colon in a file is
  seen as written, and Forge's editor, where the file is written character
  by character, shows it as it is.
  What is chosen in a menu has a tick in `ink` at its end, not its weight
  alone. A fact beside a name (Used 4 min ago, This device, a size) is in
  the body's face with even figures, not the code face: only what is
  written in code is mono.
- **Room outside.** Everything, the rail and its icons included, sits a
  little inward from the window's edges: about 3% of the width at the
  sides (24–64 px), against the instinct to run to the edges. There is
  less room above (1.5% of the height, 8–16 px) than below (5%, 24–56 px),
  so the weight of the whole sits a little high.
- **One top line.** Every page starts on the same top line: a page's
  header, Home's profile, Forge's band and search box. The rail starts one
  place below it, so Home is not first off the mark, and + stands a clear
  step (40 px) under the places, a little below the middle.
- **Motion, with a reason.** Every move says where something went, never
  only that it changed, and every one lands the same way (fast off the
  mark, the last pixels slow: `--land`). The moves are unhurried: each
  length named in this document is the move's own, and the OS plays them
  all at one pace, twice that (`--pace`), so the eye follows each the whole
  way and they keep with one another. Sideways the camera goes slower still,
  as a long pan does (`--slide`, 450 ms of its own: the band's repos, the
  row of boxes, the issues, the boards, the pane). A hover's light and a
  colour go at the same unhurried pace, a little quicker than a move; only
  what answers the hand at once (a press, the caret) is not paced, and the
  Prompt keeps its own lengths. What is put away goes in a fraction of its
  coming (`--leave`, 130 ms of its own: the pane put away is gone in about a
  quarter of a second), moving from the press: what is no longer wanted is
  not watched going, and the hand that put it away is not kept waiting on
  it. The moves are few and each means one thing wherever it
  is seen:
  - *The ink travels.* The current thing's ink goes from the one it was on
    to the one it is on (the rail's places, the band's pills), under their
    words, 220 ms, so the eye follows the choice. The words of each it goes
    over are light while half of it or more lies on the ink and in ink
    otherwise, the one it leaves and those it passes too: an icon never
    goes ink on ink as the ink goes by. The one it lands on has no fill of
    its own until it has landed (never a second box showing past the ink's
    edge), and another pressed before it lands takes the ink on from where
    it is: one ink, never two, never back to where it set off.
  - *The camera pans along the rail.* The pages stand one above another
    down the rail, as floors do: going to another place, the camera goes the
    whole way to it, the page left going up and out of the window whole as
    the next comes up into it from below (down the rail; up it, the other way
    round), the two as one sheet, the rail and the window's edges standing
    still, a floor passed in a lift (330 ms, fast off the mark and landing).
    Nothing fades: there is never an empty frame between them and never the
    two seen in one place, their words over each other; it comes as one, not
    staged. A floor is what the window shows of its page, from its top line
    to the window's foot, cut there, whatever the page's own height (Home
    runs past the foot, Git's stops short of it): the one come to adjoins
    the one left and both go the same length, never the one over the other,
    never a band of nothing between. Only the page left is taken as a picture to move (cut at the
    window's edges); the page come to comes itself, and the rest of the
    window goes on being drawn as it is, so a press made while it pans (the
    rail pressed again, the pane's button as the page comes up) lands on
    what is under the hand, never lost on a picture still on its way. The
    rail pressed again before the pan has moved (a double press, its keys
    held) goes straight to the place pressed last, from where it began, and
    pressed back to where it began it simply stays; once moving, the page
    coming is taken as it stands and the next adjoins it there, never first
    put in its place. Along the
    band: the repos stand side by side in the band's order, and another repo
    come to comes in whole from its pill's side over the one left, which
    steps back a little the other way and fades under it (400 ms): never a
    strip travelling a whole width with two half pages and the ground
    between them, never two pages' words over each other (the picture of
    the one left is cut where the one coming has reached, which takes a
    press as it comes). Come to from another page (a
    repo made, opened from File or Home), Forge arrives with it in its box:
    the camera is already on its way to Forge, and does not pan sideways as
    well (the box beside passing through on the way).
  - *The OS opens.* From its first frame: the frame's line is drawn down the
    rail's edge from the top (620 ms) as the rail's places come in one after
    another down it from the window's edge, 34 ms apart, the person last at
    its foot; then the first page comes up, its parts a beat apart, rising
    from below, its right pane's words from the right as when it is brought
    out. Nothing is drawn before its turn (not Home for a moment while the
    place it opens on is still being chosen, as when a provider sends the
    person back to Remote), and nothing is drawn whole and then again.
  - *What comes in, comes from its side, a beat at a time.* Down the rail
    the next page comes up from below, up the rail from above; along the
    band the next repo comes from the right, back along it from the left.
    Where the window cannot pan, a page come to is staged instead: its parts (the
    heading, each section's head, each card, box, pill and file) come in one
    after another in reading order, 45 ms apart (16 px and a fade, 360 ms
    each), so the eye is led through it heading first and the arrival lasts
    long enough to be followed; what is read a moment later takes its turn
    where it stands. Its figures count up from nothing, its bars fill.
  - *The caret is a thing that moves.* The OS draws it (a 2 px stroke of
    `ink`): it glides from where it was to where it is (a letter typed, a
    line gone down, a press elsewhere, 70 ms), so what is written is seen
    being written and Enter sweeps it to the next line's start; solid while
    it moves, blinking once it rests. It keeps to its field whatever moves
    it: carried at once with a field that moves (a page still coming in), and
    gliding back to the start of one the page empties (a message sent). A
    selection is the browser's own, as is the caret of a file too long to
    measure at every key.
  - *What ends goes as it came, never at once.* A menu put away (Escape,
    a press outside, the deed done) goes a few pixels back toward what
    opened it, a touch smaller, fading, quicker than it came (150 ms of the
    pace to its 280), inert on its way; a folder closed folds up and one
    opened unfolds, what stands under it making way; an ask answered, an
    offer put off, the issue being written put back with Not now fold or
    fade away before what they stood over comes back; the paths Tab listed
    under the box go as the next key is pressed; a file's unsaved dot goes
    as it is saved; a place's name on the rail slides back into its edge as
    the pointer leaves. Shown again on its way out, it stays: it comes back
    from where it had got to, the way it was going (a menu half faded fades
    back in, a folder half folded opens again from there), never whole at
    once.
  - *What is about to come leans in.* The pointer on a box's edge in
    Forge's row, the row leans toward it before it is pressed, as far as
    the pointer is into it (none for the first few px, then up to a step),
    its words coming up with it; left, it settles back. It follows the hand
    rather than switching at a line, measured from where the boxes stand
    unleaned, and a hand at rest (a few px of tremor) does not move it: on
    the edge itself nothing goes back and forth.
  - *What is saved stays where it was written.* A file saved says so
    in its own head (Unsaved goes from it); nothing flies off it to the
    rail, which the eye would have to follow away from the work.
  - *What is done is rewarded, once.* A TODO done: its mark pops past its
    size and settles. A TODO's kind, read off its line as it is typed
    (Fix:), takes its form with a small pop; a new TODO unfolds from the
    line it was started from, the lines under it making way from where they
    stood. What the search found is drawn on as it is typed,
    each line's highlighter stroke left to right, one line after the next;
    come in place of Searching…, its groups come down the page a beat apart
    as the strokes go, not the whole sheet in one frame. Under it, what was
    searched or read stands on a strip of ground of its own over the shade,
    as Issue, diff and Output do, so nothing of the page under it reads
    through its words; a line found keeps a kind's full-width colon tucked
    against its Latin word ("Fix："), as everywhere else.
    What a run prints comes in at the foot a line after another. A step
    of an issue done here (Commit, Push) has its done mark land, in from
    small past its size and settling, its tick drawn after it; a deed
    pressed and done gives a small pop where it was pressed, and so does a
    name or code copied; a message sent comes up out of the box it was
    written in, one come in from the other's side. One joining a run gives
    the one before it its time: that one narrows to its words from its
    side, its corner tightening, never its edge leaping across; the note
    that the last went as a request stays on its line while the next goes,
    and the ask answered by writing back folds away, what was said over it
    coming down into its room. A commit on main: its
    card slides off sideways as it fades, the room it took closing after it,
    and the line that says so lands lit under the issues, in Committed.
    A TODO line that becomes an item has its day stamped in at its end, and
    the box's "n of n left" beats as it changes. A name taken in Inbox goes
    up into its place as itself, its code and gear coming in beside it as
    it lands. A menu (a row's in File, a gear's, Share) comes out of what
    opened it, a few pixels from that side, as the person's menu rises.
  - *Every deed answers where it was done.* What a press changes never changes
    silently. The ink goes from one to the other between a page's
    parts (Runtime's, Remote's), Git's repos and the search's kinds as it
    does along the rail and the band, and a part's count that changes
    while seen gives a beat; another repo chosen in Git brings its issue
    in. A repo brought back to the band comes out of the ⊕. An issue
    closed goes down out of its box, toward Closed under the page, where
    its line lands lit a moment, and the count of issues beats; a Prompt stopped has
    its card's line lit. A profile saved has its name come down into place
    and its picture pop; Edit profile brings the form down. A TODO marked
    not done gives its mark a small pop; a line taken away, the lines under
    it come up into its place, as the rows under a file or folder deleted
    in File do; a row made or renamed there lands lit. A name refused
    (taken, or one it cannot be) shakes its field, a small no, the reason
    under it; so does anything sent with nothing in it (an issue, a TODO,
    a post, a message, a commit with no title, Fix： with no title after
    it): the box shakes, the keyboard stays, and why is said under it in
    ink with an off dot before it (never the quiet grey of a hint, never
    silence), going as the box is written in again. The servers a rest on Server brings out come in from the
    rail's side as they fade in, and go back the same way; Server's sheet changed (the gear, Done) comes in; the
    person's menu rises into place; the plugin area comes down into the
    pane's head and, put away, the Prompt rises into its place.
  - *A move is never cut.* What is drawn again just as it was is left as
    it is, so a move under way goes on (the band's ink between two pills
    when one deed draws the band twice). What is drawn while a page arrives
    is where its turn in the arrival is by then, from before it is first
    seen: still to come, it comes; under way, it goes on from there (a part
    drawn again as it came in goes on as it was); over, it simply stands,
    never shown and then taken away to come in. A page come to before the
    last has landed ends the last's arrival, so two never stage one part. A part in a row that clips it (Git's repos, the band)
    fades in where it stands rather than rising out of the row's edge. A
    press on the page being left is let go before the camera pans, so the
    page leaves at rest, not sunk. What a deed brings unfolds after it:
    the steps Start brings, a TODO's detail line and the empty line made as
    the last is written, the first post in an empty board as any post
    comes. The light on a file landed on goes when it has faded, not a
    frame before. motion.spec.ts holds the band and the arrival to it.
  - *Room is given and taken.* A box opened beside the others grows from
    nothing as they make room (never passing through no width at all, so
    no frame stands empty), and closing gives its room back; the right
    pane opens and closes as a wipe, what it holds cut at the moving edge,
    never squeezed (280 ms). Brought out (Forge, Git, Home alike) its edge
    lands a touch past where it stops and settles back (420 ms), its words
    come in after it from the right a line at a time, and its switch's
    mark fills from the right as it does, with a beat once it is out; put
    away, the fill drains back and it goes the way it came, gathering speed
    to the right (260 ms), its line going with it and gone as it gets to the
    window's edge, never left standing there. What it holds is as wide on
    the way as it is out, on Home as in Forge, never squeezed; its search on
    the top line goes as a thing put away does (a few pixels toward the
    pane's side, fading, quicker than the pane, never gone at the press) and
    comes back first of its words, a badge with its line; the switch stays
    where it stood. Brought back before it had gone, what it holds stays;
    put away before what it holds had come in, that goes with it as it is.
  - *What opens comes out of what opened it.* What the search finds comes
    down out of its box; the terminal flies between the pane and the box.
  - *What is made goes where it lives.* A sheet goes from what it was
    written in or shown as to what it became: a repo's card or File row to
    its box in Forge, New repo's summary to the new card, the name taken
    to the Inbox's stub (340–420 ms). It is the box's own paper and line,
    and the box it becomes waits out of sight until it lands, then shows
    as the sheet gives way to it: one box the whole way, never two.
  - *What is pressed gives.* Under the pointer (or Enter, Space) anything
    pressable sinks by the same few pixels whatever its size, so a pill
    gives more than a card, and comes back past where it was by a third,
    then home, as a key does (70 ms down, 300 ms back).
  - *Where one lands is lit for a moment.* A file landed on (from the
    search, File, Git) has its head lit with the marker, fading in about a
    second; nothing stays lit.
  - *Focus is the light.* While the search is out with the keyboard the
    whole window steps back under one shade (`ink` at 14%) and only the
    search is lit; it fades in and out, and a press anywhere else closes
    what was found. What is read there, or a list held out from the right
    pane, stays as the keyboard goes back to the file, and the shade lifts:
    it draws in to the pane's own width, over the pane and never over the
    file, which is written beside it whole and at full strength; pressed, it
    opens out over the center again to be read, under the shade.
  120 ms fades for everything else. Reduced motion turns all of it off:
  each thing is where it ends at once.
- No shadows, blur, glow or gradients; the one shade is the search's (above). The one exception is a
  place, not an emphasis: the Prompt up as a screen (§ Forge), a terminal's, which has them all and
  shares them with nothing. The pointer, standing over the window rather than in it, has the one small
  soft shadow it needs to be seen there.
- **The OS's own pointers.** Arrow, hand, I-beam, grab and grabbing, copy, wait, not allowed and the
  resizers, drawn as the window is: `ink`, a `paper` edge round it with round joins, that small shadow
  under it; sharp at 1x, 4/3 and 2x. Where nothing is to be pressed or written it is the arrow, over
  read-only text too, as a desktop's is; the film draws these same pictures.
- **One scrollbar.** Everything that scrolls, the page with it, has the
  same bar: thin, its thumb `edge` (a thing one drags), its track the
  ground under it, never the browser's own; forced colours draw the
  system's.
- **The ink at the edge, not the box.** An icon is drawn inset in its
  square (two to four pixels, each its own), so a page head's icon stands
  that much left of its box, its ink on the edge the page's words and
  boxes start at, and gives it back on its right: the title is where every
  page's title is.
- **Words, one way.** One word for one thing on every page: repo (never
  リポジトリ), サーバー, 板. A button is a verb in its plain form (作る,
  保存する, 外す), never a noun (作成); a time on a line is a noun (3分前に
  更新, に接続, に使用). A line that is one statement in an empty box or a
  card's note has no full stop; two or more sentences each end with one.
  "Not yet" is written one way: X はまだありません. A day is written as the
  language writes one (Oct 17, 2031 / 2031年10月17日), never another
  country's (10/17/2031).
- **Japanese beside Latin and numbers.** A Latin word is a half-width
  space apart from Japanese (新しい repo, この OS, 次の TODO). A number and
  its counter are one (30日, 5年, 3件, 第2版). A colon after Japanese is
  full width (：). A name filled in (`{server}`, `{repo}`) is written
  against the Japanese in the catalog and `t()` sets it apart only when it
  is Latin (旅行の人たちへ, trip の人たちへ). `i18n.test.ts` holds all four;
  l3 and core write their Japanese the same way; the language changed in
  the app is the core's at once too (what it says next, Runtime's lines, an
  error), not only after the page is loaded again.
- **What one was doing stays where it belongs.** Going to another page
  and back, or to another repo and back, is going back to it: the same
  repo, where it was read (a page that scrolls the window is where it was
  read to; the page between starts at its top), the conversation that was
  open, what was searched, what was half written. What
  is written belongs to what it was written for (the prompt box to its
  repo, an issue's words to the issue) and is swapped with it, never
  carried to another; it goes only when it is sent, saved, or put back
  with Not now. Escape puts away what is being written as Not now does
  but keeps its words, folded: an issue's comes back as it was with
  Write an issue, a commit's line with Commit, a server's or a board's
  name being made when Server is come back to. The repo worked on is one on every page: chosen anywhere
  (a pill, File, a Git chip, an issue gone to or started, one just
  written), it is the one the next page opens; only looking at a page
  chooses nothing. A thing made or chosen is landed on: a new issue is the
  one shown, with the keyboard on it; a file chosen in File has the caret.
  Going along a row keeps the keyboard on the same part of the box, and an
  error that the name causes sends the keyboard back to the name. When what
  had the keyboard goes (a card committed), the place around it takes it
  without a ring round it, so the page is not framed in ink for a card
  gone; a key pressed there rings it, as it is then in use.
- **What exists is the same everywhere.** A repo only on the Remote is a
  repo on every page: counted on Home, a card on Home and Remote that
  reads the same lines in the same order (size · when it changed, then
  where it is), a quiet row in File, brought out by Forge's ⊕, offered to
  fetch in Git. Opening it anywhere fetches it.

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
  The rail stays the rail there (File's tree and Server's servers come out
  of it as anywhere; a bar along the foot was mocked and left), its places
  a size smaller and closer and the window's gutter narrower, so a page
  has a fifth more of the width. A place's name comes out beside it only
  where a pointer rests (a finger's press would leave it over the page).
  Parts slide inside the page's width (never past the window's edge), the
  one chosen kept in view, and fade at their end while there is more to
  slide to, so one cut there reads as more; slid to the end, nothing fades.
  Forge's band gives its repo pill the width before the search.

## 2. Tokens

| Role | Value | Use |
| --- | --- | --- |
| `ground` | `#DADAD5` | every surface: a touch lighter than the first `#D2D2CD`, still grey, so long hours stay easy |
| `ink` | `#292B2A` | text, icons, the current thing, primary action (10.2:1 on ground) |
| `rule` | `#989B96` | dividers, outlines of places; decorative only (2.0:1, kept as before) |
| `sub` | `#56595A` | secondary text (5.0:1) |
| `edge` | `#6B6E6B` | outlines of fields and controls, which must be seen (3.7:1) |
| `raised` | `#E4E4E0` | field fill, hover (the same small step above ground as before) |
| `paper` | `#F8F8F5` | the sheet: what is worked on, and only that (a file's box, the TODO, the issue or board in hand, Inbox's box, what the search found); never a card that leads somewhere, a pane or a page (Runtime's box, which is read rather than worked in, stays on the ground) |
| `done` | `#0F8C69` | done and on: a step of an issue's work done, a switch on (its knob), a box ticked (its circle, and a TODO done's tick), a line added (its bar), the Prompt's dot while its shell waits; a fresh emerald leaning to blue, so it sits with the greys and does not tire, light enough not to read heavy as a filled circle (white on it 4.2:1, it on the ground 3:1) |
| `add` | `#157357` | the words of an addition, a step darker than `done` to read small: +n and its squares, a line's + (4.9:1 on its tint) |
| `add-tint` | `#D8F2E6` | the ground of a line added in a diff: a mint of its own, not `done` thinned |
| `marker` | `#FFE066` | what is marked, as with a highlighter: a line marked in a diff (a review, Forge's diff), over its words only (not its indent or number, which turns ink), each wrapped line its own stroke with softened ends; the words the search found, in its lines; the head of a file just landed on, for a moment. A warm, clear lemon, neither cream nor dense: `ink` on it 10.9:1 |
| `marker-soft` | `#FFF2B8` | the pointer on a line it can mark: the stroke, paler; a line just landed on (merged, committed, closed), lit a moment on the ground, solid (a thinned marker on the grey goes olive) |
| `off` | `#A8324F` | a repo turned off: its switch; a removal held, its button red (`ground` words on it 4.6:1); a line removed (its bar); a rosy crimson leaning to blue, not a brick |
| `del` | `#B23452` | the words of a removal: −n and its squares, a line's − (4.8:1 on its tint) |
| `del-tint` | `#FCE0E7` | the ground of a line removed in a diff |
| `sky-tint` | `#DBE9FB` | a fourth soft tint, beside the three marks' (`marker-soft`, `add-tint`, `del-tint`), only to tell people apart by their round initial (Lately, the pane's word) |

No other colours; the three families (`done`, `marker`, `off`, each with
the words and the ground drawn from it) each mean their one thing only; the
round initials of people borrow their soft grounds and the sky's, which mean
nothing there but who. The one
shade is `ink` at 14% over the window while the search is out with the keyboard. The Prompt up
over the center is a screen made of these colours, not new ones: its glass
`ink` a step deeper (`ink` 66% with black), lit words `add-tint` glowing in
`done`, the prompt lines `done` lifted toward `add-tint` for the dark, its
lamp `done` while its shell runs and `off` once it has ended.

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

- **Words on a control's middle.** In a button, a chip, a pill or a key the
  words stand on its middle by their capitals, not by their line: a face
  keeps more room over its capitals than under its baseline (or the other
  way, and each size rounds it its own way here), so words set by their line
  sit a pixel or two off, high in one face and low in another. Where the
  line can be trimmed to its capitals and baseline (`text-box`), it is; the
  box's own line, whose words are partly a field's, comes down by the same
  measure taken once in the face as it is here (optical.ts), the pill's
  words and what is written beside them together. A pill's words that end
  in a space (a prompt line) have the room after them less by that letter.

- **The page head.** Icon, title (24/700) and one short role line in
  `sub`, on the top line, and one line at every width: the role is cut
  short where it runs out of room, and a phone has the name alone, so what
  stands under the head (a sign-in card, a page's parts) starts at the same
  place on every page. Home's head is the profile. An overlay (File's
  tree, Server's servers) has no page head: it is laid over the page whose
  head is there; Server's page, as Forge's, has its band on the top line.
  A step within a page that stands in the page's place (Server's gear, a
  repo shown in Server) has the same head: its title, a line in `sub`, and
  its way back at the right (a repo shown: Back); behind Server's gear,
  Done is the sheet's answer, at its bottom right, under what scrolls.
- **The band.** What is out to work on, on the top line: each thing as a
  round chip, the current one an `ink` fill, then + after them (round, an
  `edge` outline, `sub`), as a browser's new tab comes after its tabs.
  Forge's repos, Server's servers.
- **Parts.** A page whose parts are unrelated shows them as a switch of
  round headings, each with a bare count, the chosen one `ink`; only its
  part is shown, so a page never becomes one long scroll. On a narrow
  window the switch slides sideways and keeps the chosen one in view;
  while there is more along than fits, a small round › stands at its end
  over a fade into the ground (said whether a part is cut there or the
  edge falls between two, where a fade alone shows nothing), and pressed,
  slides on to the next. Remote's page, Runtime's, Server's gear.
- **Cards.** A place you go to or a thing you act on: a rounded square
  with a `rule` edge, its title (20/600) on top, a line or two in `sub`,
  what can be done at its foot (the main deed at the right). Home and
  Remote have large cards, about three across; Runtime and Server's gear
  small ones (15/600 title), about four across. Cards lie on the ground,
  never inside another box.
- **The dashed card.** Room for something that is not here yet, and the
  way to make it: a card with a dashed `rule` edge and a quiet word in its
  middle (New repo; Add someone you know, among the people's cards, each
  with its person's face before their name, has a dashed + in a face's
  place and starts where their names start). Pressed, it becomes the card it
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
  on at the right, the green circle (`done`), off at the left, as every
  switch people know. It moves the
  moment it is pressed: turning on then asks in the card (no puts it
  back), turning off is at once; hovered, its edge is `ink`. Off as the
  usual state is quiet (`plain`); off as a repo turned off is `off` red. Its label is a
  word or two beside it; what turning it on will do is said in the ask.
  Things that reach past their owner have the same pair wherever they are:
  to the server's people, and to everyone (a repo shown in a server; a
  board, always its people's, has the second and guests). Nothing that
  starts by being used has a switch to start it (a Prompt starts when one
  writes to it, and says so in its place when it has ended).
- **The meter.** How much of an allowance is used: a round track a
  step high (8 px), `raised` inside an `edge` line, filled `ink` as far as
  the use goes, in a row of its own with what it measures at the left and
  its figures at the right end (2 of 3, 25.0 MB of 100 MB) in `sub`. Over
  the allowance it is full and its figures are `ink` 600; it never takes a
  colour of its own (`done`, `marker` and `off` each mean their one thing).
  With no limit (repos on a paid tier), the row has its figure alone and no
  track. Its share is set through the style object, never a style
  attribute (the desktop app's policy takes none). Remote's Plan.
- **Paid, said in place.** Where the Remote refuses something for the
  plan's sake (a repo or a change past what the free plan or the account's
  tier keeps, making a server, a name on one's own domain), the place says
  it in its own words, by the tier when it is one (Go keeps no more on the
  Remote), where its error goes, with See the plan beside them: what was written
  stays, the work stays on the device, and the deed is never greyed out or
  hidden without a word. Where it is known before anything is written (a
  free account making a server, or adding a domain), the same line stands
  under the form, quiet. A repo the Remote holds back says it where it
  stands (この端末に保存 · Remote に空きができるのを待っています), with See the
  plan beside it on its card.
- **Where a deed sits.** By what the box is for and what follows a press,
  never by the word alone. The box's own deed is at the right: at the top
  right what the box is for (Write an issue, Edit profile, Add a passkey),
  at the bottom right its answer (Create, Save, Push, Merge, Use). What goes
  against what the box is for, or leaves it for another page, is at the
  bottom left (Not now, Back to main, Reject, Forge on Remote's card, a
  person taken out of a server); a card that is for leaving or removing
  (Leave this server) has that deed at its right. A deed that asks first
  goes on where it was pressed, so the next step is under the pointer and
  Not now on the other side: Remote's switch at the right asks at the
  right; 廃棄 at the left asks at the left (Set the code, then 廃棄, there;
  Not now at the right); Let it go likewise. An answer under the pointer
  holds still a moment, so a double click does not answer it (common.ts
  `askFoot`, `SETTLE`). A place a switch changes keeps its place (Forge
  becomes 空ける); the same deed is in the same place everywhere (空ける at
  the bottom left, on Remote's off card and a Prompt's card; what turns a
  thing off at the right: the switch, Stop). What comes out of a button
  comes out into the free space, so nothing moves under the pointer
  (Share's list over the card, from its left edge up). The band's + comes first, at its left
  end, before what it brings out: the chips come and go to its right, so
  they never move it, and the band reads + → what is out; what else the
  band holds (a search box) keeps its right end; Server's gear stands at
  the top line's right end, in the pane switch's place. A layer keeps its
  columns whatever is chosen, so nothing anchored to their
  edges moves when something is pressed (Server's side stays, empty, while
  a server is made; its gear keeps its place, unpressable). A list's row keeps its deeds at its right end.
- **Popovers.** As the person's menu: one box on the ground, a head over
  each group, a row per item, no divider (`.pop`). A row that is pressed to
  write or to ask becomes the field or the ask in its own place.
- **Buttons.** Round, 15/400 on an `edge` outline; the primary one an
  `ink` fill. Small buttons (32 high) in cards and rows. Never a bare
  underlined word.
- **Fields.** Slightly rounded (8), filled `raised`, an `edge` outline,
  a placeholder that says what goes in it.
- **The box at the foot.** One field near the bottom of a work page,
  saying where what is written goes (notes で実行, 旅行 の人たちへ): Enter
  is a new line, Ctrl+Enter (⌘+Enter) sends, as in every box one writes in
  (Inbox too). Forge and Git run in it; Server posts. Forge's also edits the
  file in front, the box holding a line of it written as in the file (§8, Edit). Empty and
  not in use, it steps back while the page is read (Forge, §8).
- **The right pane.** Beside the center, past its one `rule`: on top what
  the center refers to (Forge's reference, Server's people and repos),
  headings 15/600 in `ink` as Prompt's, a list under each; with nothing to
  show, nothing (no line saying what will appear once a repo is open), or
  with a repo, one quiet line of what is not there (no box: a box is
  for the center, where things are made), and under it, where there is a
  first one to make (an issue), the small button that makes it in the center. It only shows; what changes it
  lives with the thing it changes, and what leads from it into the center
  (a file's name, a line's number) opens the center there.
- **Boxes side by side.** One thing at a time in full, its neighbours'
  edges showing with their mark only (# a board, + a new one), never a
  name cut short, each running on into the ground at the column's edge;
  ← → or an edge is the way to them. The current one has
  an `ink` edge, over `raised` when it holds no `raised` box of its own
  (Git's issues), on the ground when it does (Server's boards, which hold
  the TODO box). Git's issues, Server's boards.
- **One box in two panes.** A list at the left and what is chosen at the
  right, one `rule` between them, in a single box: Inbox, a repo shown in
  Server.
- **The TODO box.** Home's TODO and each Server board's, the same box:
  items written as "Kind：title" (the kind a Latin word, Fix：, or a
  Japanese one, 買う：), Enter for the detail, ○ when done, the
  date at the right whether a line has a kind or not. An item goes by the
  quiet × at its line's end, there on the item under the pointer or with the
  keyboard in it (always, on a touch screen), the lines under it closing up
  and the keyboard going on to the × that came up into its place (a double
  press takes one); Delete or Backspace on its emptied line takes it too.
  While anything is done, Clear done stands beside what is left at the box's
  head and takes the done ones together. The empty line at the foot is room
  for the next, not an item: its ○ dashed and faint, neither pressed nor a
  stop for Tab (a press there gives the caret to the line), and the first
  one's placeholder the form, short enough for a phone (Fix: what to do);
  written in, its ○ is drawn whole as its day comes in. On Home it is tall;
  in a board, tall as it is on Home whatever its items (it scrolls in itself).
  Under the pointer its edge takes a step toward ink (the edge a field
  has), so it says it is there to write in before it is pressed.
- **Overlays.** File is an operation, not a page: its small tree laid over
  the page that is showing, brought out by resting on the icon (300 ms; it
  stays a while after the pointer leaves, but goes as soon as the pointer
  rests on another place on the rail (200 ms; crossing the icons on the way
  into the tree is not a rest), so reading the rail's names never leaves
  one over the page) or by a press (it stays), put away by Escape (whatever
  has the keyboard; the topmost one only), a press outside, or a second
  press. Server is a page, gone to by a press as Inbox is. A rest on its
  icon (300 ms) brings out one's servers beside the rail, as a column of
  servers is in a chat app: a card of rows, each a server's mark (the first
  letters of its first two words, a rounded square), its name, and a dot
  while something in it is not read, then Make a server; one pressed is
  Server's page at it, Make a server its page with one being made (Escape
  goes back to where one was). It is a way to a server, never the server
  over the page: nothing in it is seen by being there, nothing is written
  in it. It goes as File's tree does (a moment after the pointer leaves, a
  little longer once it was gone into; at once on another place on the
  rail; Escape; a press outside); → on the icon goes into it from the
  keyboard, ↑ ↓ along it.
- **The Remote away.** When this device's Remote does not answer (not
  reached, not in time, a gateway's 502, 503 or 504, or a page or words
  that are not its reply), it is said in one place: a small `off` dot on Remote's icon in the rail, whose
  name then reads Remote に届きません, and one line under Remote's parts
  (what changes here is sent once it answers). Everything else goes on as
  it was: work is kept here and sent when the Remote answers; what only
  the Remote can do (its switches, a repo only there) waits, quiet.
  Signed out, the sign-in card says which of these it was, never that the
  Remote offers no way in, with Try again (it is also asked again by
  itself). When
  the Remote no longer knows this device (its session was ended from
  another, or ran out), the device is signed out at once, every page drawn
  again as signed out, and nothing here is lost.
- **Something came in.** What came and has not been seen yet is said the
  way the Remote away is: a small dot, the same size and place, but in the
  colour of what it is on (`ink`, or `ground` on what is current), never a
  colour of its own and never a count. On the rail: Inbox while a message
  is not read (it goes when the conversation is opened), Server while a
  board has a post by someone else past what one has had on screen; the
  place's name then says so (Inbox に未読のメッセージがあります). In Server
  the same dot follows its server's chip and its board's # (a neighbour's
  too, at the edge that shows), and goes once that board's talk is read to
  its foot. The Remote keeps how far each person has read each board, so it
  is the same on every device (`/v1/news`, `/v1/boards/ID/seen`).

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
| + at the far end from what it adds to | + right after the last of them, as a browser's new tab |
| A small grey heading on one page, a 15/600 one on another | 15/600 `ink`, everywhere |
| An empty state as a plain line of text in the center | The dashed box with a quiet line, where the thing would be; the right pane, which only refers, has one quiet line or nothing |
| A dashed box as wide as the page around one line | As wide as its words |
| Every pane saying what will appear once something is done (repoを開くと出ます, 帯にrepoを出すと動きます) | Said once, where it is done (the center); the other panes are empty |
| A paragraph explaining the screen | The word on the thing; what will happen, in the ask |
| A button that says where a thing is shared (旅行に共有) and opens a form | Share, and the servers beside it to press in or out |
| A rule under a lone row (Runtime's Remote column) | Space between rows; a line only where regions meet |
| A sentence beside a way in (what the Remote is, a lost passkey, "sign in faster") | The buttons alone: Continue with…, Sign in with a passkey, Add a passkey |
| A button that cannot act, or ends what one is standing on from a list (外す on the last provider; Sign out on this device's own row) | The last way in stays with nothing to press; this device signs out from the person's menu; another device signs out from its row, asked in the row |
| A sentence broken where the card ends (名前 / は出ません) | Short lines, each broken where the sentence breaks |
| Answers right under the question, high in a card that shrank to ask (やめる, 見せる) | The card keeps its size; the answers sit at its foot, where its own buttons were |
| The browser's own colour (a blue checkbox), or a tick in `ink` | The green circle, as a switch on: one green for on, everywhere |
| A switch that waits for the answer before it moves | It moves on the press; what it turns on is asked after, and no puts it back |
| A switch on with its knob at the left | On is at the right, green, as every switch people know |
| A removal that cannot be taken back where one could be held (a board's) | Held 30 days: the card goes quiet, its button red, and pressed again it is back at once |
| Words of two sizes centred in one row (sora and オーナー a pixel or two apart) | They share a baseline; a face or an icon beside them is centred |
| A hidden label beside a line taller than the line (a run's posts spaced 32, 37, 37) | Nothing beside a line is taller than it: one rhythm down a run |
| A button not centred on its row's title (Done below 旅行's middle) | The title and its line share a baseline; the row centres the button on them |
| One thing reaching past its owner in two different ways (a repo's lone "everyone" switch, a board's pair) | The same pair everywhere: to the server's people, to everyone |
| Enter sending in one box and making a line in another | Enter is a new line, Ctrl+Enter sends, in every box, the prompt box too: Enter is what confirms a Japanese conversion, so it never sends |
| Keys said in a sentence under a box (Enter for the detail, Enter on an empty line for the next TODO) | The keys as keys (a small cap with the key's name) and one word beside each, said only while the box is written in |
| A switch to start what starts by being used (the Prompt's) | None: using it starts it; an ended one says so in its place |
| Changing a shared piece to fit one place (the TODO box made boxless in a board) | The piece as it is; the place makes room for it |
| A colour, gradient, shadow or glow for emphasis | None: `ink`, `raised`, the edge, and size do it |
| A new piece made up for one page | The piece from §3; if none fits, add one to §3 first |
| Made-up names with random letters in examples and screenshots (sora4fdw) | Plain names (sora, trip, notes): names are first come and codes are unique, so nothing needs masking |
| Two words for one thing (repo on one page, リポジトリ on the next; 1 server under サーバー) | One word, from §1, on every page |
| Japanese and Latin run together on one page and spaced on the next (新しいrepo, Remote にある) | A space between them, always; a number and its counter together (30日, not 30 日) |
| A name glued to a space before a particle (旅行 に共有) | Written against the particle; `t()` puts the space in only for a Latin name |
| What was being written carried to another repo (a prompt draft under another repo's name), or dropped by going to another page | Kept with what it was written for and swapped with it; gone only when sent, saved or put back |
| A page that forgets, when one comes back, where it was read and what was searched | It comes back where it was, each repo at its own place |
| The repo worked on put back by another page (a Git chip, then Forge on the old one) | One repo worked on, chosen anywhere, opened next on every page |
| The keyboard dropped after a step (an arrow along the row, an issue just made) | It stays on the same part of the box, or lands on what was made |
| A file's box shrunk to its text, short files stacked to fit one screen | Each file a tall box of its own (about three quarters of the window), read by scrolling down |
| The empty box at the foot standing over what one reads | It steps back while one reads, and comes back to the keyboard, a press on the Prompt or the pointer resting at the foot |
| A choice that leaves its overlay to be closed by hand (a file chosen in File) | Choosing the thing to work on puts the overlay away and the caret in it |
| The only way to something folded away with its pane (search, narrow) | The way stays where it was; only what it shows folds |
| A day in another country's order (10/17/2031 まで in Japanese) | `day()`: the language's own (2031年10月17日まで) |
| The same card saying its lines in another order (Remote にあります · 8 B, then when) | One order on every card: size · when it changed, then where it is |
| A count that leaves out what the page shows (0 repo over a card for notes) | The count is of what is shown |
| A repo on the Remote that a page says is not there (File: repo はまだありません; ⊕ greyed) | It is listed, quiet, and fetched when opened |
| A noun on a button beside verbs (作成, 編集 beside 見る) | A verb (作る, 編集する) |
| A full stop on one lone line and none on the next (投稿はここまでです。 / repo はまだありません) | None on one statement; one on each when there are two |
| A field with only a placeholder for its name, beside a form with labels | A label over the field, what it means under it, as New repo's |
| Signed out, a sentence and a button on one page and a card on another | The sign-in card, where the page's parts will be, on every page that needs it |
| A card alone in the middle of an empty page, what it opens then coming in somewhere else | The card where what it opens will stand, under the page's head, at the same place on every page |
| The Remote away as an error on two pages and as nothing (stale cards with live switches) on the rest; a dead session kept, each page failing on it | The rail's dot and Remote's one line; a dead session signs the device out |
| Something new said by a count, a badge or a colour of its own, or not said at all until the page is opened | The dot of the place's own colour, on the rail and on the chip and board it is on, gone once seen |
| A box drawn again every little while, taking what was being written and the keyboard with it (Inbox's field to write to someone, every 10 s) | Only what came is drawn: the rows under the field, the messages at the conversation's foot |
| Items in one row of a band a few pixels off another's (a 40 px gear in a 32 px band) | Everything on the band is 32 px |
| A divider left where a pane would start when there is none | No pane, no line |
| A hairline as the only sign of which side is the work and which refers to it; a pane given a tone of its own | The work is a sheet (`paper`) framed by two lines of one weight, the rail's and the pane's (2 px, `ink`, top line to foot); the rail, the band, heads and the pane stand on the ground itself |
| What is worked on drawn one way on one page and another on the next (a raised box, a framed card, a bordered box on the ground) | One sheet everywhere: `paper`, a 1 px `rule` edge, a place's corners; the one in hand (or with the keyboard) has its edge in `ink`, nothing drawn round it |
| Something painted over a focus ring (the ground under the box over its foot) | The ring is whole: what lies under the box lies behind it |
| A field with a ring drawn round its own border, a box in a box (a file's name in File's menu) | One line: the field's own border turns `ink` while it has the keyboard, as the search box's does |
| A box one writes in framed by a ring a little outside its own edge (the Prompt, Server's box to its people) | Its own edge turns `ink`, two lines' weight, nothing drawn round it |
| A neighbour cut off square at the column's edge, as if broken | It runs on into the ground there, fading over the last few pixels |
| A deed that leaves no trace where it was done (a commit on main: its card simply gone) | What it made lands where the card was: its line, lit a moment |
| A word that flickers with each key (未保存 while typing) | A quiet dot, once the writing pauses; the word for a screen reader |
| Two places drawn alike when one is a name and the other a field (Inbox's stub and the field under it) | The name on the ground with a place's line; the field raised, its edge seen |
| A square ring round a name left in a row after a deed (renamed, made) | The row is lit for the deed and has the keyboard without a ring; a key pressed there rings the row, round as the row is |
| Two boxes at once: an outline flying to a box that is already drawn under it | One sheet: the box waits out of sight until the sheet lands, then shows as the sheet gives way |
| A diff all one tint, its counts grey (+6 −2) | Each changed line its colour as a bar at its left on a light ground; +n green and −n red, then five small squares shared out as the lines are, in the figures' own colours, on their line and their capitals' middle; a dashed break with "…" between the parts of a file |
| Text, not a field, sitting at the top of a row its mark is centred in (a read-only TODO) | Centred on the mark's line, as the field is |
| A paid thing greyed out, hidden, or refused with the Remote's bare error; work dropped because the Remote would not keep it | Said in place with See the plan beside; the work stays on the device and waits |
| A use against an allowance said by a colour (a red bar when over) | The meter: `ink` as far as the use goes, full and its figures 600 when over |
| One Subscribe for one paid plan, and its price said only once one is sent to pay | Free and each tier side by side as cards, each its price and what it keeps, the account's own current |
| Signed in from one page and landed on another (Inbox, then Remote's Repos) | Back on the page one began on |
| How Stripe went said twice, or not at all (back from the portal with nothing said) | Once, in one line above the plan, against how the plan was when the page left for Stripe |
| A refusal said at the foot of the part, away from what was pressed | Where it was pressed: under the tier's card, in the ask, under Manage |

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

A repo's environment is one overlay of its upper layer over the root, and
all the repo's Prompts on that root share it: the first to start mounts it,
and each started while one runs (another terminal, an SSH session, `l3
prompt REPO -- CMD`, `.setup`) joins that one's, the same mount cloned into
its own tree, so what one installs the others see at once. It stays mounted
until the last of them ends; one ending, being stopped, or stopped for a
network change, leaves the others' as it was. Two overlays on one upper
layer are never mounted (the second clears the first's scratch directory,
and the first can then make no new directory over the root: #55), so a
Prompt that cannot join the one running is not started, and says why.

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
   without the provider, and a turn-off or a new device asks for it. A
   device holds a lease on the person, never the person.
3. **The Remote** keeps what is theirs and gives them a name, `ren`: first
   come, theirs for five years at a time, renewed by them (a Renew near the
   end of the term; not renewed, it is held for them 30 days, then anyone's).
   It is a name on this Remote, not a domain anyone holds: it is kept as
   `ren@length3.com` only because that is where it is kept, and is shown
   alone, everywhere, as Home shows one's handle: taken, it is written alone
   too (no @ part after the field), and nothing after an @ is the person's to
   think of; a name on a domain of one's own waits behind the gear of the name
   once it is taken. With it comes a **code**, six digits (`204816`), to be found by
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
| a server | its people (its owner removes it) | its Remote | removed, or its last person leaves: 30 days, then gone (a day when its maker leaves it with nobody else in it) |
| a repo shown in a server | its owner, lent to the server | its Remote | taken off, or its owner leaves the server: at once |
| a repo's public name (`face:name`) | its owner, under a face | the face (the server, or the owner's address) | taken down, or the face goes: 30 days no one else's repo answers to it |
| a board, its talk and TODO | its server | its Remote | removed by its owner: 30 days, back at once until then, then gone; or with its server |
| a copy on a device | the device | the digests | taken back whenever room is wanted (owned.rs) |
| a session, a code | the person | sign-in | a lease: days for a session, minutes for a code |
| a guest's invitation | the one of its people who made it, lent to whoever they hand it | its Remote, and its digest | used, revoked, its maker leaves the server, or a week (at most 30 days) |
| a guest | the board, by an invitation | its token's digest | a lease of 30 days; removed (their posts with them), or the board stops taking guests: at once |

What goes, goes in one place, once a day (`service/sweep.ts`): nothing a
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
(`ren@ren.dev`); the name on the Remote stays theirs while they renew it.

### l3: the one base

Everything a Prompt runs comes from one artifact, **l3**, and nothing else
is a dependency: not a BusyBox, a userland or a toolchain of its own. It is
the same thing for the desktop app and for the web.

- **Name and version.** `l3 X.Y.Z` is the release `os-length3-linux-vX.Y.Z`
  (the version in `RELEASE`).
- **Digest.** Its identity is the sha256 of its root,
  `os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst`. One entry of
  `core/src/root.rs` RELEASES pins it, for both ways in: `sha256` and
  `bytes`, the root; `web`, the sha256 of the index the browser reads the
  same root by. The release writes that entry (`scripts/pin-root.mjs`) and
  it is committed; nothing else pins l3.
- **What it holds.** The whole distribution root, the development-standard
  profile laid out for Prompts (`scripts/root-release.sh`): BusyBox (sh and
  its applets), the C toolchain, git, curl, openssl, nano, apk and the rest,
  `/etc`, and `/usr/bin/l3`. For the web it also holds the translator
  (xlat, as WebAssembly) and the translations of the hot programs made
  ahead of time.
- **On a device**, the app and `l3` install the root by its digest: from the
  device's Remote, then the publisher's (each deploy mirrors every pinned
  root to its bucket), then the release itself.
- **In a browser**, the same root is read through xlat (`public/l3`, made
  from the root itself by `scripts/l3.mjs`, never from anything built
  beside it): `l3.json` (which l3: its version and the root's digest), an
  index of every path (type, mode, link target; where each file's bytes
  are), a pack per package of the root, each file a zstd frame, and blobs
  for the translator and the hot programs (BusyBox and l3) with their
  translations. Everything but `l3.json` is named by its digest. A Prompt
  fetches the index, the translator and BusyBox with its translation; every
  other file comes from its pack when a program first opens it, and every
  other program is translated when it first runs (l3's translation follows
  quietly once the first Prompt is up, for the Prompts after). What was
  fetched is kept by digest (Cache Storage; the packs in the browser's HTTP
  cache), checked whenever it is read, and only within a quarter of what
  the browser says this origin may hold, the least recently used going
  first; what the current l3 does not name goes. Runtime lists it under
  この端末 and frees it like anything derived.
- **The same content.** The web's tree is the root's: every path, type,
  mode, link target and sha256 the same as the root l3 installs
  (directories at least 0700, files without set-id bits, as the installer
  makes them). `scripts/l3-parity.mjs` proves it on every release and in CI;
  a program that xlat cannot run yet still ships, and
  `scripts/l3-runnable.mjs` says which, against the same root run natively.
- **One release, one pin.** The release makes the root, then l3 for the
  browser from it (checked by the parity), pins both in one entry, and only
  then builds the web app and the desktop app, which both trust that entry.
  A web build that has only Node (Cloudflare's) takes l3 from the release
  (`os-length3-linux-X.Y.Z-l3-web.tar`) only at the pinned index.

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
nouns and order are the rail's: Home (`todo`, `profile`, `lang`), Forge
(`repo`, `band`, `prompt`), File (`file`), Git (`git`, `issue`, `start`,
`main`, `commit`, `push`, `reset`, `diff`, `log`, `review`, `reply`,
`merge`, `reject`), Runtime (`runtime`, `free`, `root`, `network`, `dotfile`,
`address`, `app`), Remote (`remote`, `login`, `logout`), Server (`server`), Inbox
(`inbox`, `name`); `l3 help` lists them in this order. `l3 address` is where
this device is reached over SSH, as `ip addr` answers with an address: one
`ssh -p PORT REPO@HOST` a line, the SSH user being the repo, and on
standard error who may connect, the keys let in and the host key (Runtime's
SSH, below); the names people find you by (name@domain, and your code) are `l3
name`. A path is written as File shows it (`/root/<repo>/…`). A line is
named the same way everywhere ("Fix：件名"), an issue is called by its
number in both (#3), and Home's state is the same files, so anything done in one shows in
the other. The Prompt's shell works on the repo itself: what it changes is
written back, and what is saved elsewhere comes in.

The one way from the command line to the GUI is `l3 app`: it opens the
desktop app, or brings forward the one open (one on a device at a time,
never a second), or, on a device without it, says where the Remote hands
it out for this release (exit 4). A start is said as one only once the app
answers; one that ends, or cannot show a window, is said as such. `l3 app
close` closes it as its window's close button does, and nothing else: what
it saved stays, and what l3 runs (SSH, a Prompt in a terminal) goes on.
Opening it turns nothing on: no network listening, no SSH, no Remote. It is
reached through a socket in its own owner-only folder of the data
directory (`core/src/desktop.rs`).

### The command line without learning it first

The GUI asks nobody to learn it before using it: the rail shows the
purposes, a press shows the page, and the next deed is on the page. `l3`
at a terminal is used the same way, and stays a command line:

- **`l3` alone is the rail.** The purposes in the rail's order and words
  (Home, Forge, File, Git, Runtime, Remote, Server, Inbox, +), each with its
  role and what is there now (TODO open, repos, issues open, the root, where
  the Remote stands, servers, what is not read). It is a few lines under
  what is already in the terminal, never a screen taken over: it works over
  SSH and inside a Prompt, and the scrollback stays readable.
- **A purpose picked prints its page** as its commands print it, each said
  first as the command it is (`→ l3 git`), then **its things with their
  deeds**: each issue, TODO item, repo, conversation, board or thing by size
  is a row, and the focused row's deeds are under it, what the thing is for
  first, what goes against it or leaves it last (§3, Where a deed sits); the
  page's own deeds (Write an issue, Add a TODO, Sign in) are rows of their
  own. The deeds are where the thing stands: an issue not started offers
  Start; changed, Commit; committed, Push; handed in, Approve and Merge (Merge
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
  Esc or Ctrl-C leave l3 and Backspace goes back to the rail; in a field
  Enter keeps, Esc is Not now (back to the rows, nothing done) and Ctrl-C
  leaves l3 as a program Ctrl-C ends does (130), with nothing half made; in
  a Prompt opened from the menu Ctrl-C is the program's, as at any shell,
  and `exit` comes back to the menu on the repo it was opened on (said as
  it opens). Whether Ctrl-C in a field should go back rather than leave is
  the person's to decide; it leaves, as it did.
- **Narrow terminals**: a row too wide is cut with … except the focused
  one, which is said whole over as many lines as it takes; the keys line
  wraps by whole phrases, the ways back or out (Backspace, q, Esc) first, so
  at 50 columns nothing that leaves is cut off. Past nine rows each keeps its
  number to be read by (1–9 still jump).
- **Every deed says the command it is** before it runs (`→ l3 start
  notes#1`), so the words are learned by seeing them and never needed. Its
  answer is l3's own, and then the page's rows again, read anew, with the
  focus on what was just done or made (§1, What one was doing stays).
- **After a command typed by hand**, its next deeds are said in one line
  (`Next for notes#1  Push · Open · Back to main`), and asked nothing: l3
  reads no key, so all the person types next is the shell's (a row that
  waited for a key took the first character of the next command, which l3
  cannot give back without replaying input). What a command just made comes
  first (the 13th TODO's Done, not the first twelve's), and what is left
  out past twelve is said. A page that listed its next deeds itself (an
  issue's card in full) is not followed by the same words again: only the
  quiet line that `l3 next` chooses one with the keys. `l3 next` opens them: the same row walked with
  ←→ and Enter, Enter alone or Esc going on, each deed done as its command
  and those after it offered again.
- **One table drives both.** A deed is a form of `cli/src/spec.rs` with what
  the menu needs beside it: its word in both languages, what it is pressed
  on, the facts it is offered under, the words it gives itself, what it
  asks, its weight. Each page notes its things and their facts while it is
  made (the issue's from the same reading that writes its card's `next:`
  line), so the menu, the help, the completion and the card cannot drift;
  the tests read every deed back through the parser as the form it is. An
  issue opened in full (`l3 issue notes#1`) ends with the same deeds as a
  list under Next, each the button's word beside the line that does it
  (`Approve  l3 review notes#1 approve`), what it is for first and what
  leaves it last, each said once: its Review and Merge say where they stand,
  not the commands again.
- **Keys** as a list has them: ↑↓ (Tab) to choose a row, ←→ a deed, Enter to
  do it, 1–9 or a letter to jump (again for the next with that letter),
  Backspace to the rail, q or Esc to leave. The focus is a › and brackets,
  so nothing depends on colour (NO_COLOR is honoured); the lines are drawn
  again only when a key is pressed, and what is left when a choice is made
  is plain text: the choice, the command, its answer.
- **Still a plain command.** With words after it (`l3 git`), l3 does and
  answers what it did, the short row only following at a terminal; through
  a pipe or a file (standard input or output not a terminal), with
  `--json`, with `TERM=dumb`, or with `L3_PLAIN=1` (the one switch that keeps
  a terminal plain too, for a screen reader that prefers it or a recorded
  session), nothing is offered or asked, and what l3 writes and how it exits
  are byte for byte what they were (`cli/tests/plain.rs` keeps the
  transcripts; `cli/tests/menu.rs` drives the menu through a real pty).

### What l3 writes

The same few rules for every answer, so a line is read the same way
wherever it comes from:

- **`l3 help` starts with the work.** First the lines that take an issue
  from written to merged, in their order, as one would type them in a repo
  called notes (`l3 issue new notes "Fix：title"`, `l3 git`, `l3 start
  notes#1`, `l3 commit notes`, `l3 push notes`, `l3 review notes#1 approve`,
  `l3 merge notes#1`); then every command by the rail; then the flags, the
  exit codes (0–5) and how names are written, each a line under its word.
  Every line fits 80 columns, Japanese counted two a character.
- **A name and its facts in two columns.** A listing (`l3 repo`, `l3
  remote`, `l3 file`, `l3 prompt ls`) writes each name, then its facts
  starting in one column, as wide as the widest name up to 24 (a longer one
  keeps two spaces after it alone); a folder with nothing to say is its name
  alone. Never a tab: a terminal puts what follows a tab at its next stop,
  out of line after a long name. A script reads `--json`.
- **A step is ○ until it is ✓**, on a card as in the TODO: `○ Commit`, `✓
  Push`. Started and nothing changed, Commit says where the work is done, as
  the app's card does (edit in notes, with `l3 prompt notes` or `l3 file
  write`; what changes shows here).
- **What comes next runs as it is pasted.** A card's `next:` line is a
  command with every word in it and no brackets (`next: l3 commit notes`);
  a word only the person can write is the help's own (`l3 reply notes#1
  "text"`). When all that is left is leaving the work, the line says so as
  `back: l3 main notes`, never as what comes next. Starting an issue says
  both the way on (edit, then `l3 commit notes`) and the way back.
- **A log is two lines a commit**: its line, then id, when, the files and
  their lines, its issue, whether a merge; which folders it touched is
  `--json`'s.
- **A mistake says what to write, and with what.** Its form with the word
  that was missing in it, and what there is to put there (`Name a repo (l3
  commit REPO [-m note]), or run it in one: notes, c1`); an issue is named as
  it is called (`notes#2`, never its work's line name `002`); something
  done already says where to see it (`notes#1 is merged already (l3 log
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
file. One representation everywhere, for the app's native sync (core), l3
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
  what cannot be sent (`l3 repo`'s `unsendable`), and **the last copy that
  has one is never freed**: Free asks the Remote's modes to be this copy's.
  Owner, ACLs and extended attributes are not carried.

So a device's copy is never the only copy, and history stays deliberate.
Every change made here (in Forge, by l3, by a Prompt) is sent as a diff
within half a second; the Remote's changes are seen within five seconds
and whenever the window comes back. Taking in is file by file against the
version last agreed: a file only changed there is written here, one only
changed here is sent, and one changed on both sides keeps, at its name,
the version that reached the Remote first, and puts this device's beside it
named after this device ("README (ren-laptop).md", "README (Chrome
Linux).md"), so neither is lost and the name says whose it is on every
device.
Files that cannot travel (a link, a file over 16 MB, a repo's own `.git`)
are named and never sent; a repo holding them is never let go. Home's
settings (profile, TODO, dotfiles) are kept there too, by the app and l3
alike (src/remote/sync.ts, core/src/home.rs: one protocol, one record of what was
agreed), each changed only from the version it was read at: unchanged
here, the Remote's is taken; changed on both sides, two TODO lists are
joined item by item, and any other setting is the Remote's. The band, the
language and the network grant are the device's own.

What each host keeps, and when (lifecycle.ts):

|             | comes by itself | goes by itself |
|-------------|-----------------|----------------|
| OS          | web: l3, fetched each visit; app: the root, when installed | web: with the tab |
| repo        | the Remote's changes, as they happen; one only on the Remote, when opened | each change, to the Remote at once; web: the copy, with the tab, once the Remote has all of it |
| Home        | at start and when the window comes back; l3: before a command that reads it | each change, at once; l3: after the command |
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
of its own. What a passkey or a provider does is the browser's for the
same reason, yet the app does all of it too, the same page in the same
place: Remote's Sign-in lists and removes passkeys and unlinks providers
in the app itself, and adding a passkey, linking a provider and setting
the code (Add, Link, Set in the browser) open the Remote's own page there
at Sign-in; a repo's switch and Discard ask in its card as on the web, and
Continue in the browser opens that repo's card there with its ask already
open (`core/src/account.rs` app_page names only that page, of the Remote's
own app, the way a sign-in's page is checked). Done there, the page says
to go back; the app reads again what changed when its window comes back.
Every device is a session, listed on the Remote page and ended
from any other. Sessions are bearer tokens, kept on the device (in the app
with its settings, 0600).

What leaves this system is kept to what is said here:

- **Network.** The Prompt's guests have no sockets: every socket call answers
  "not implemented", so a program in it can reach nothing. The page itself
  may reach its own origin and the Remote, nothing else: the web build
  carries that Content-Security-Policy, and the desktop's (Tauri's) says the
  same. The Remote answers only the app's origins. From the host (the app
  and l3: the Remote, a release, a distribution's root) it goes one way
  (core/src/net.rs), taking of the host only what the machine already
  decided: its proxy (HTTPS_PROXY, minus NO_PROXY, never for the machine
  itself) and the certificates it trusts (its store or SSL_CERT_FILE,
  beside the bundled ones).
- **The root.** In the app a Prompt is the distribution's root, run by this
  machine's kernel without privilege (`l3 prompt`, core/src/launch.rs): a user
  namespace makes the user root inside it only; its own mount, pid, ipc,
  uts and network namespaces (no network unless granted); the root
  read-only, the repo the only writable place of the person's, fresh
  `/tmp`, `/run` and a minimal `/dev` with terminals of its own (a devpts
  made for each Prompt, holding only the ptys opened in it, none of the
  host's sessions); an environment set, not inherited (no
  host home, keys, agent or variables); and a seccomp filter
  (core/src/seccomp.rs) over all of it, so the kernel answers none of what a
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
  its deploys fills with every root pinned in `core/src/root.rs`
  (`service/mirror.ts`), and last from the GitHub release, which answers
  only while the repository is public; when none has it, the error says
  what each said.
- **Host.** The app starts no host program for a repo: history is the
  Remote's, and a repo's own tools (git among them) run inside the root.
- **Files.** The data directory and its settings are the user's alone (0700,
  0600). Writes go to a new temporary next to the file and are renamed over
  it; `.git` is refused in every spelling and through any symlink, from the
  webview, from `l3` and from the Prompt's write-back.

### The Remote

However the OS is reached, in a browser, the desktop app or l3, some of it
is the Remote's and stays so: who someone is (a provider's identity, then
passkeys; the app and l3 come in by a code a browser approves, each device a
session any other can end), the canonical copy of each repo and its
history, Home's settings, names, the Inbox and servers, and which devices
listen for SSH (that they do, and to whom; never where). Running natively moves the OS onto the device, not these:
they are what every device agrees through. Its rows and its files are
apart: Postgres holds everything said here, the bucket only file contents,
and a Remote without a bucket does all the rest and says plainly that it
cannot hold files now, so a device keeps its work until it can. Each part,
its routes and tables, and what the app and l3 need of it that a page does
not: `service/README.md`.

### The plan: the Remote decides what an account may do

Billing lives on the Remote. The Remote alone decides what an account may
do (`service/plan.ts`); every client, the web app, the desktop app and l3,
only shows what it says (Remote → Plan, `l3 remote plan`) and asks. No
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
the rule, the tier it is about and the way to the plan, and the app and l3
keep the work on the device and say it waits (it is asked again every few
minutes, and goes the moment there is room or the plan is paid, or goes up
a tier). A change that does not make a draft larger (an edit of the same
size, a removal, a commit) is always taken, however much is kept.

**When a subscription ends, or goes down a tier**, nothing is taken away
and nothing is made read-only: servers go on with their people, boards and
talk; names on a domain go on answering while its DNS says so, and names on
the Remote are renewed as before; every repo the Remote holds stays, read
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

**Stripe's stand-in** (`service/devbilling.ts`), on a Remote of one's own
asked for the plan (`LENGTH3_PLAN=1`) and the selftest's, looks and does as
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
on. The development sign-in provider (`service/devoauth.ts`) asks as a real
one does: a name, then what length3 asks of it (your name and email), Allow
or Cancel; Cancel comes back with the error a provider sends then.

# Part III. Each place in turn

## 7. The rail

- Icons only, top to bottom, the order of one's own work: **Home** (who
  you are, what you are doing) → **Forge** (where you work; a terminal
  icon) → **File** (the tree of "/") → **Git** (what happened outside) →
  **Runtime** (the environment) → **Remote** (where your repos are kept) →
  **Server** (the people you know, on the Remote: the one purpose whose
  subject is people, not a repo; under the cloud, as it lives there) →
  **Inbox** (what was sent to you) → the **plug** (an operation, as File
  is: it opens the plugin area at the top of the center). **+** (a new repo)
  comes right under them, a step apart, and is round because it starts
  something rather than opening a place (§1, shapes).
- A name appears beside an icon on hover or keyboard focus. Choosing an
  icon replaces the whole page; nothing pushes in beside the rail. File is
  the operation: its tree is laid over the page instead; a rest on Server
  brings out one's servers beside the rail, to go to one (below).
- The rail is 78 px wide: the icons keep 18 px to its line and 12 px to the
  window's side, so they do not crowd the line.
- Inbox and Server carry the dot of §3's Something came in; Remote the
  dot of the Remote away. Nothing else on the rail is marked.
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke; + is a 40 px
  round button with an `edge` outline. States as everywhere (§1).
- The person's own icon sits at the foot of the rail, on the line of the
  prompt box at the center's foot (its middle the box's middle: one line
  across the window's foot, rail to center), a 44 px circle a
  little larger than the items: their initials, or a head and shoulders
  (30 px, filling most of it) before there is a name. Touching it brings
  out what is the person's own, in groups under a small heading and with
  no rules between them: Profile (Edit profile; the profile itself is read
  on Home), Account (Sign in; once signed in, Sign-in, Devices, Sign out),
  Language (the one in use, with a mark below it; pressed, it opens into
  the list in its place, and choosing one closes it). Each entry is a word
  or two, the group saying what it is about. The places of the OS are the
  rail's, sorted there by purpose, so the menu does not gather them again
  (no View for Home, no Room or Environment for Runtime) and carries no
  page icons: an icon there would only repeat the rail's, and two entries
  under one icon could not say how they differ. An entry opens the part it
  is about. It goes on leaving, a press outside or Escape.
- Sign out asks in its row first (a row pressed to ask, §3 Popovers), since
  what stays is not seen from the menu: the repos, the TODO and the profile
  stay in this browser, to go on with signed out; on a computer others use,
  take them off as you go, the Remote keeping them for the next sign-in. Take
  them off at the left, Sign out at the right. Taking off stops the Prompts,
  then every repo goes as 空ける takes it (sent first, and gone only once the
  Remote has all of it) and the profile, TODO and dotfiles, sent first, go
  once they are what the Remote has, the record of them with them; then it
  signs out. Nothing the Remote lacks goes: what stays is said in the ask,
  each with why, and that it is there to whoever uses this browser next, Not
  now and Sign out under it. The menu stays out while it works, and says
  there what the Remote refused (a repo that could not be sent first keeps
  the device signed in).

## 8. Pages

Each page below says only what is its own; the rest is Part I.

### Home

A profile, between a Twitter and a GitHub profile, that reads the same for
its owner and for anyone else; only the owner gets "edit". In order:
identity (avatar, name, @handle, bio, counts of repos and servers; no name
written yet, it is the one signed in with, as Remote and the Me menu say
it: one person, one name, never "No name yet" beside "Signed in as Sora") →
**TODO** → repos → servers (each one is in, a chip that opens Server on it;
after them each board this browser writes in as a guest, #board with its
server and guest beside it, opening Server at that board alone, so a guest
come back, signed in or not, is led back to it).
TODO is the person's single list; repos do not carry their own inbox or
TODO files. An item is a first line named like an issue ("Fix：件名",
"買う：種"), then detail lines (starting on the first line's column, with a
kind or without); Enter on an empty line starts the next item. An input
method's Enter (the one that takes a Japanese word) is the method's, never a
new line or the next item, and a kind is read off the line only once the
method has given its word. An item goes by its × (§3, the TODO box), the done
ones together by Clear done. Done strikes through and fades the first line, the line drawn
across its words from the kind's start as the mark pops (taken back, it goes
back the way it came), and its detail goes quiet with it, still there to read.
A detail opened or put away moves the items under it down or up to make room,
never jumping them. The repos are large cards, three across at a
laptop's width (two, then one, as it narrows); each is a repo in a list as
Runtime says it: its body the repo itself, opened in Forge, its gear what
is done to the repo (its card on the Remote, Rename, Free, Delete).

What a hand goes to without being told answers it, here and on every page:
each count is the way to its section further down (a raised fill under the
pointer; pressed, the page goes there and its heading lights as it lands);
the face, pressed, opens the profile to be written, as Edit profile does;
the TODO's paper pressed under its items gives the caret to the line at its
foot, as a page written on does. In Forge a file's head, pressed (not to
choose its words), is the file in File with what can be done to it (rename,
move, delete), its name underlined under the pointer; pressed under the
last file, on nothing, the caret goes to its end. A pill on the band is one
thing to press: on its edge, round its name, it goes as on the name (its ×
aside). Server's people are each a
conversation: someone else pressed opens the Inbox to them, an arrow at the
row's end under the pointer. Lately's rows, pressed twice, go straight
there (what their card's own button does). Every pressable thing answers
the pointer coming, a primary button too (its ink a step toward the ground)
and the box's pill (its glass catching a little more light). The keyboard
is never left on nothing: letters typed with it on the rail or the page in
Forge or Git go into the box; a pill taken off the band hands it to the
pill worked on next; the box's four put away with Escape give it back to
the box. The arrow keys go along any list of things pressed (Lately's and
Inbox's rows, the band's pills, the repo cards), to the nearest one that way
on the screen, as they go along the rail; → on File brings its tree out
with the keyboard on its first row, as a menu's ↓ does; and what scrolls inside the page
keeps its own turning: past its end, the page behind it does not go on.

The profile is edited where it is read, not in a form put in its place:
written in, the top is a sheet of its own as the TODO is when written in
(`paper`, an `ink` edge, grown out around the face and the lines so nothing
on it moves). The name becomes the line it is written on, where it stands
and as large, holding the name shown (none written yet, the one signed in
with, to be changed, never an empty line beside it); @ and the handle, and
the line about the person, come in under
it a line after another, with room between them; each is written on, not
boxed (a rule under it, ink under the one with the keyboard), and the
counts, which are not written, step aside. The face follows what is written,
its initials as the name (or the handle) goes in, so the change is seen as
it is made. Edit profile gives way to Cancel and Save where it stood. The
top grows and shrinks to what it holds (320 ms), one move at a time: the
sheet's edge and what is under it go together, never up and then down (its
margins and its height are one move), the lines that were not there coming
into the room it makes; saved with new initials, once it has folded, the
face turns round to show them. Opened from the person's menu, it is drawn
open as Home comes in: the arrival is its beat. Enter on the name or the handle
saves; Escape leaves it as it was. The rail's face is the new one at once.

Home's right pane (the same pane and switch as Forge's and Git's) has
their top line: the search box where theirs is, beside the switch, in the
repo last worked in (or, none yet, the one changed last), named in it
since Home has no band to say which ("Search garden"); Ctrl+K, Ctrl+P and
Ctrl+B as there; what is found opens in Forge, a line at that line,
selected. While it is out the window steps back under the one shade. Its
first line, the name and Edit profile, stands on that top line too. Under
it the pane holds
Lately: what waits since the person was last here, a row each on the
ground (no box round each, a raised fill under the pointer; between rows a
hairline from where their words start, so rows of many lines are each seen
whole), under a quiet head (a pane's own heads, Lately, the Prompt, People,
are small and in the quiet colour, on the line a file's head is on): where they left
off (the file last read in Forge, its mark, its repo quiet at the right, and
under it the line it was left at, as written), the conversations with
something not read (who wrote, their initial on one of four soft tints, the
marker's, a step done's, a removal's, the sky's, the same for the same name;
what it is and its words: Review：…), the boards with posts not seen (#),
and the boards this browser writes in as a guest (#, Trip · where you write
as a guest: a way back always there, signed in or not, the one written in
last first, pressed to that board); at each row's end one slot, the unread
dot, a chevron under the pointer (it goes there). A row is two lines at
most: its name, going on under itself where it must (its badge, its place
and its slot on its first line), and one line of what came, cut where it
runs out of room. The pane keeps its width. In
the Prompt's lines there, a line run that goes past the pane's width goes on
under itself beside its prompt line's pill, never back under it; a line
sent before the shell first waits at its prompt line waits for it. The same round initial
heads a conversation in Inbox, a person in a server's People and their posts
on its board (larger there, a guest's no tint, only a dashed ring). With
nothing new it says so, quietly: the pane out is never a line with nothing
beside it. The plugin area comes down over it when the rail's plug opens it.

A row in a pane (Lately's here, the word at the foot of Forge's and Git's,
a line the box wrote in the Prompt) is the same row wherever it is, and it
tells, it does not hold: it says what came in two lines at most (its name,
and one line of it cut where it runs out of room), and pressed it goes to
where the thing is done: the conversation in Inbox, the board in Server,
the line one left off at in Forge (that line a third of the way down, the
caret where it was), the issue in Git, the TODO on Home. Nothing is
answered, posted or written in the pane: a pane that tried to be each of
those places, in a card the size of a row, was none of them well. Under the
pointer, a chevron at the row's end says it goes there.

### Forge

Where you work. The repos out to work on run as pills in a band on the top
line; the search box sits on the same line over the right pane, and at the
line's right end the round switch that puts the right pane away and brings
it back. Put away, the pane closes as a wipe, the center takes the whole
width and the search goes with the pane; the switch stays where it was, the
way back, and what the pane showed, what was chosen there and where it was
read come back with it. The files button stands first, at the band's left
end: pressed, the deeds for the file read now (New file and New folder
beside it, Rename, which moves it given a path, Delete; the repo's own with
none read) come out under it, in Forge, done there with the field or the
ask in its place as File's are, never carrying one off to File; a new file
is opened to write in, one renamed or moved is shown where it went. The
pills follow it and scroll, and ⊕ comes right after the last
pill. One press brings every repo not on the band out at once; this is not
adding tabs one at a time.
Each pill comes off the band with its × (the repo itself is untouched);
alone on a band too narrow for it (a phone), its name ends in … rather than
its × being cut at the band's edge.
A repo whose copy is an issue's (Start in Git) says so on its pill, after
its name, quietly (garden #1): what is written in Forge is for that issue.
A file opened beside from its head is the one worked on and has the
keyboard; the box worked on closed, the next slides in as it goes.
A pill is dragged along the band to where it is let go; the middle button
takes it off, as it closes a tab. Up to three repos stand side by side in
the center, tiled: Ctrl+click on a pill opens it beside the one worked on
(as a link opens in a new tab), a pill dragged into the center stands where
it is let go (over a box's side third, beside it; over its middle, in its
place: a dashed outline shows where before it is let go), and Ctrl+\
opens the next on the band. Each is its own page with its own scroll; the
one worked on (the prompt, the search and File follow it) is the last one
pressed into, the sheet in it with the keyboard in `ink` (a file beside, one
sheet, in `ink` whole while it is worked on; never two sheets in `ink` at
once), the others' in `rule`, its pill
`ink`, theirs outlined in `ink`. Side by side the row is a strip that runs
on past the center's edges: every box as wide as the one worked on, which
stands in it whole (the first and the last at the page's margin, where one
alone stands), and the ones along from it show only their edge (64 px, more
at the row's ends), their words dimmed (the box itself still `paper` with
its `rule` edge, as a neighbour issue's is, never a grey slab) and cut by
the frame's line, the rail's at the
left and the pane's at the right: there is more that way, not a narrow box
beside; only their edge shows, not words cut off by the line (not a file's
head either), and there it goes into the ground (a fade at the frame's
line, as Git's issues and Server's boards have), not cut off square. One to the
left says its name at its right end, the end that shows. With the pane put
away the row is for reading across: every box stands whole, side by side,
as wide as the others, at full strength, each name at its left; brought
back, the one worked on fills the row again and the others step to its
edges. The pane's switch is the switch between the two, working on one with
the others to hand or reading them together, and the row moves on the
pane's own curve, the last box's edge a step inside the pane's the whole
way, as if pushed by it. The prompt box stands under the box worked on, its
edges a step (12 px) outside that box's, and goes where the box goes, at its
pace; side by side, each box is as tall as the row, down to a step over the
prompt box. A file's head is its box's lid: it carries the box's top edge
and corners and stays where it stands as the file scrolls under it (a file
gone to, from File or a search, comes to where its head stops, inside the
page's top padding, never past it with its box's sides showing over the
lid), so the
heads of boxes side by side, one scrolled and one not, stand on one line,
and the right pane's Prompt has its head's words on that line too. Pressing one, swiping
sideways over the row (one box a swipe) or Alt+[ / Alt+] brings it in, and
the whole row slides with it, the one left going out to its edge; a box
opened beside comes in at its own width where it stands, fading in as the
row brings it (drawn first where the row is, so it goes with the others
and never over them), and one closed fades where it stands before the row
closes over its place, the boxes that stay going on from where they are
seen: never a box squeezed from or to no width, its words crushed. Another file of
the same repo opens beside too: each file's head has, at its right end, the
window cut in two (quiet until the file is pointed at; Ctrl+click on the head
does the same), and the file comes in as a box of its own, its repo said
quietly before its name in the box's head; a place asked for in another file
(the search, File) is read in the repo's page, which comes in where that box
stood. In the repo's page a file open beside is only its head (quiet, its
window-cut mark in `ink`): the page reads on past it, so the row never shows
one text twice, and side by side the file beside stands next to the rest of
its repo; pressed, the row goes to its box, and with that box closed it
unfolds again. Each box has a small head
(its name, and × to close it; dragged, it moves along the row); Alt+[ and
Alt+] go along the row. The keys an editor's hands already know work
wherever the bench is, unsaid on the screen: Ctrl+K or Ctrl+P (Ctrl+Shift+F
too) to the search, Ctrl+` to
the prompt box, Ctrl+B to put the pane away and back (⌘ on a Mac). The row is remembered on this device; a narrow
window shows the one worked on. Files dragged in from the desktop go into the
repo whose box they are let go over (into the folder of the file under the
pointer, else its top; the dashed outline says where), never over a file
already there (the new one is "name (2)"), and the first is opened.
Opened from its card on Home or its row in File, a repo grows from there
into its box: an `ink` outline goes from the card to the box and fades as
it lands.
With nothing left to bring out, ⊕ steps back. Opening a repo from File,
Home or a new repo puts it on the band. With every pill off, the
center says how to bring one out. The band is remembered on this device. Below the band the center is the open repo's files one after another,
an endless page scrolled like a browser and opened at the file chosen in
File. There are no tabs, no title, no index of links and no headings for
directories. The center is where editing happens: each file is a plain
text editor in its own tall box (a short file too reaches down to the
foot of the rail's last place, Inbox, so the first box and the rail end on
one line, and it is read by scrolling down, never packed to fit a screen;
never so tall that, read from its top, its foot meets the prompt box,
which floats a clear 40 px above it rather than seeming fixed to the
file), a little heavier
line than the rest; a header with its place in "/" (`/root/<repo>/` quiet, the
rest plain), then line numbers in a quiet gutter beside the text, which is
itself the field (no box; the caret is the only sign). Typing saves on its
own a moment later, on leaving the file, or with Ctrl+S; the header says
something only when the file is not simply saved: a quiet dot once the
writing pauses before it is (未保存 to a screen reader), or why it could not
be. Forge's files run on past the last far enough for it to come up to the
column's top (a file just made, opened at the end), not the empty foot of
the one before filling the column over it. A text saved elsewhere (another device, the Prompt, Git)
comes into an open file at once, unless something written here is not saved
yet: then it is asked in the file's box, under its head and over the text,
which stays to be read and written on. The header says 外で変更されました;
the ask says ここで書いている間に、外で保存されました。 / 選ぶまで、こちらはここに残ります。
and at its foot, あちらを使う at the left (it goes against what was written
here), 違いを見る and こちらで上書きする at the right. 違いを見る opens, under
the answers so nothing moves under the pointer, the diff of what saving here
would do to the other text (theirs struck, yours added, as Forge's diff
reads). Nothing is saved on its own until it is answered; writing on until
the two are the same ends it. A file read only in part (over 256 KB) or binary is never
written back, and says so. That is Forge's own measure, of a text edited in a
page (the Remote keeps a file up to 16 MB): a text written past it is not
saved on its own, and nothing of it is lost without a word. The head says
so (未保存 · the measure it is over), and under it, over the text, as the ask
of a text changed elsewhere is, how large it is and the way on: made smaller,
it saves as before and the ask folds away; まるごと保存する keeps it as
written, and from then it is a file read in part, its start to read, the
Prompt editing it whole. While it waits, closing the tab asks first (the
browser's own ask). Tab types a tab; with lines selected it moves
each of them in by one, the selection kept, and one Undo takes it back. A
press on a line's number selects that line. Escape leaves the text for the
page. Undo reaches back across going to another repo or page and back: a
repo's page is never taken out of the document, only hidden. In each directory README comes first, then the other
files, then the directories. The only line in Forge is the one between the
center and the right pane.

A prompt box, like the one for an LLM, sits at the foot of the center. What
is written there goes to the open repo's `sh` (Enter is a new line,
Ctrl+Enter sends). At rest the box is the box (raised, its edge), its line a
terminal's: at its left a pill of the screen's glass, round as the band's pill
for the repo is, with the shell's lamp (lit while it runs, dim before it starts,
off once it has ended) and the prompt line it last waited at; the line in the
terminal's letters with an empty cell where the caret will be (with no repo
to run in, no cell: it says so there, Open a repo to run in it, as the search
box says No repo to search); the keys that
bring it up from anywhere (Ctrl `, only where they bring up what the box does:
Run's, and Edit's Ctrl G), and while it is written in, in their place, the
keys that send what is in it (Ctrl Enter, beside Run, Create or Add; none for
Edit): Enter is a new line there as in every box, so the hand that presses
Enter as in a terminal finds the keys that run it beside Run, and on a line of
one, Enter pressed, they give one after the other as keys pressed together;
Run. While the prompt is in use the box
becomes a screen and the terminal comes up in it over the center, the one thing
in the app that is a thing of its own: a terminal's screen, dark glass in the
app's ink with its words lit in the app's green (§3), the page behind it only a
blur in its top where glass catches the light, a fine raster and a falloff to
its edges, its corner a card's (16). It is the box at the foot, lit, not a layer
over the page: no shadow under it, no shade over the window. The pill's glass
runs along the box's line, slowing into its end, the box's light going from
under it, then rises into the screen (460 ms, about two fifths of it along,
landing a touch past); the line's words and Run stay where they are and take the
glass's light as its edge comes over them, the prompt line goes from the pill to
the line's start. Put back, it sinks to the line, moving from the first
frame and gathering, and runs on into the pill at that speed, braking hard
there (420 ms, two fifths sinking), the box's light coming back under it, the
words taking their ink again as the glass leaves them; the pill gives under the
glass it catches (flattened and wider, back past round, settled) and its lamp
lights with a glow, and the terminal comes into the pane from the center's
side. Put back on its way up, or brought up on its way down, it turns where it
is and goes back the way it came, the line's parts with it, from that frame on:
never first up whole, or back in the pill, and then on. Its lines are a
terminal's: the box's line is the line after the output, starting with the
prompt line the shell waits at (`garden $`, the output's own last line then not
shown), the words written in the terminal's letters and a cell for a caret, the
letter under it drawn dark in it. A line sent moves up a line as it is (it does
not come in again); what it prints comes in a line after another, the screen's
top rising with it, and the prompt line comes back with the caret as its last
line does; while it runs, what it is doing (Running 2s, Interrupt) is said on the
line itself, so nothing above the line comes and goes, and once the run is
done that goes out to its right rather than at once. `clear` clears the
screen, and Ctrl+C says ^C where the run was cut, the screen's words jolting
sideways and flaring as they are cut (at once: it answers the hand), what the
run was doing going as it is cut. Ended (exit, stopped), its switch comes in
going over from on to off and its output flares and dims as a tube switched
off does, staying dim to be read; switched on again, the old screen goes down
to a bright line across its middle, the box takes the new one's height, and
the new one opens out of the line. The prompt lines before are in
the green, so what was run stands out from what it printed. A lamp at its head is
lit while its shell runs; the terminal, put back, comes into the pane where it
lives, and the reference grows down into the room it leaves. In the pane it is
read as a line of what was done in the repo, in the page's own colours, as a
history is drawn: a dot for each thing done, all on one thin thread from the
first to the prompt line the shell waits at (it scrolls with them, and ends at
the last dot). A line run is a ring on the thread, the prompt line it was written at
in the pill the box wore for it (the screen's glass, its words in the green),
and the line in ink, bold; what it printed is under it, quieter. The pills sit
on their line's middle, beside the words they head. The prompt line the shell waits at is last, its dot lit in the green
and glowing as the lamp is (off once it has ended). Up as the screen, it is the
terminal again, its lines as a terminal's. The terminal's box
is labelled Prompt, after what one does there (the shell is BusyBox sh, so
it is not called Bash); leaving the prompt
(or Escape, or the × at the right end of its head, beside the lamp, there
only while it is up) sends it back; Escape and the × give the keyboard back
to what had it before the box (the file, the page). The Prompt has no switch: writing
to it starts it (its first letter in the box, so its shell comes up while
the line is still being written; a line sent before it is up waits for its
first prompt line), and one that ended says so in its place, with Start
again; stopping one is Runtime's. A repo shown, read or written in Forge
starts nothing: its Prompt, never written to, runs nothing and holds the
repo nowhere (Runtime counts it with none running, and Free does not wait
for it); only what it runs on, l3 in a browser, is read ahead as the repo is
shown, so the first line is not kept waiting for it. What is written in the box and not sent
is the repo's: another repo shows its own, and coming back finds it.

The box does more than run. Its pill says what it does and, pressed (or
Alt+↓ in the box, up as the screen too, out of the line's start where the
pill went), brings out the four it can, out of the pill, each with
the pill it gives (as wide as its words) and its keys, the words in one column: Run in the Prompt (the shell's prompt line,
`garden $`), Write an issue (the repo's next issue, `garden #4`, in ink as an
issue's number), Add to TODO (TODO's circle, on paper as Home's TODO box),
Edit the file in front (a pencil, the file and the caret's line,
`main.c :4`, on paper ringed in ink: the yellow is the file's, where the
work is, never the pill's); Alt+1 to 4 in the box choose one at
once, Ctrl ` is the Prompt's again and Ctrl G Edit's. Turning, the pill goes from the old words' width to the new, the old
words going up out of it as the new come up into it, its colours crossing,
with a small beat as it lands; the box's own button says the deed (Run,
Create, Add; Edit has none) and the empty box where it goes. Only Run brings the screen up.
An issue or a TODO is written as everywhere, its first line Kind: title and
the lines under it its detail; sent, the box empties and where it went is said
to be heard (Written as #4 in garden). What the box made
comes into the right pane as the Prompt's own lines do, one stream of what
was done in the repo in the order it was done: a line of its own in the
Prompt's flow, before the prompt line the shell waits at, on a dot of its own
(in ink, an issue or a TODO alike: the green is the live prompt line's), its head in the pill
the box wore for it (`#4` in ink, `TODO` on paper with its circle) and its
words in the letters people write in, not the shell's (`#4 Fix：…`), beside
the pill (a second line goes on under them, never back under the pill), its
kind in bold as everywhere. Sent, its first line goes on a
slip of paper out of the box, on to the right as a sheet slid off, then up
and on into that line, coming down to its size; the slip gives up its paper
as it lands on the line's words, and the line is lit a moment as a file
landed on is. Issue and TODO go the same way; the pill's number turns to the
next as a counter's figure does. With the pane put away (or narrow), the
slip slides on and rises out of sight, and the line is there when the pane
comes back. Pressed, the line goes to it (the issue in Git, the TODO on Home). What
is half written is kept for the repo and for what the box does.

Edit makes the box a line of the file in front, written there as the line is
in the file: nothing to learn, no words that ask for things, no line first
written and then applied. It need not be chosen: while one works in a file of
the center with the box empty and running, the box is that line's by itself,
its pill saying the file and the caret's line (main.c:5) and its keys Ctrl G,
so what the box does is what one is doing, and pressed into it holds that
line; Run is a key away (Ctrl `, Alt+1, or its pill). Once neither the file
nor the box has the keyboard, it is the mode one chose again; something
written in it for Run keeps it Run. The box holds the line the file's caret is on, lit
in the marker's yellow where it stands (under its words, from its start: not
across the file, so it reads as the words held), and what is typed in the box
is in the file as it is typed (saved as typing in the file is, a moment after
the typing stops; the keyboard stays in the box). Where the box's caret is, an
ink caret stands in the file too, going with it; what the box has chosen is in
the marker's full yellow there. Pointing chooses what it holds: while the box
has the keyboard, the hand over a file says a line can be taken and the line
under it is ringed (the ring going along from line to line with the hand,
never gone from one and there on the next at once, nor going back and forth
for a hand at rest on the border of two); pressed, that line comes into the
box, the caret where it was pressed; drawn across words on a line (as a marker
is drawn), the line comes in with those words chosen, so what is typed writes
over them (one way of holding: Enter and the rest work as on any line). The keys are a text's own: Enter breaks the line where the caret is and
the box goes on to the new line, which keeps the indent; Backspace at the start
joins the line to the one above and Delete at the end the one below to it; ↑
and ↓ go to the line above or below, at the same column, and ← at the start or
→ at the end round onto them; Tab types the file's own indent and Shift+Tab
takes the line out by one; Ctrl+Z takes back what the box wrote (all that was
typed on one line is one step), Ctrl+Shift+Z puts it back. Escape gives the
keyboard back to the file, at the same place. The file in front is the one last
written in or pressed, else the one read (a third down the center); its box
keeps the `ink` edge of a file written in while the box is on it, and the pill
says the file and the line. Edit has no button: what is typed is in the file
already. Holding an empty line, the box says so (An empty line: write it here).
The box knows the repo's earlier lines, as a terminal does: ↑ with the
caret on its first line goes back one line run in the repo's Prompt, ↓ on
its last line forward again, down to what was being written (so a line of
several lines is still edited with the arrows); writing in the box ends
the walk. Tab completes the path before the caret from the repo's files
(`src/ma` to `src/main.rs `, a directory with its `/`); several matches
are written to what they share and listed in one quiet line under the box
(monospace, as paths are), gone at the next key. With no path to complete
Tab moves on, as everywhere.
On Git, a page read and pressed rather than written in, it stands back
from the start and again once the Prompt is done with (Escape), never over
an issue's buttons; Ctrl+` or the pointer resting at the foot brings it.
While one reads (the center turned by the wheel, a touch or the keys) and
the box is empty and not being written in, it steps back (a 120 ms fade)
and lets the text under it be pressed; the keyboard reaching it, a press on
the Prompt, or the pointer resting on its place a moment (220 ms) brings it
back where it was; the pointer only crossing its place, on its way to
something low on the page, or resting on a button there, leaves it back, so
it never comes up over what was about to be pressed. Something written in it, or a word under it, keeps
it out.

Forge is kept as it was while another page is shown, and each repo on the
band keeps its place: where it was read, what was searched in it. A pill
taken off lets its place go.

The center takes three quarters of the width; the right pane takes one
quarter (at least 280 px) so it never gets in the way. It is the Prompt's
home: with the plugin area shut the Prompt holds the pane from its top, its
head level with the file box's, so the pane reads at once as open and as what
it is (an empty top read as nothing, or as put away). The plugin area opened
comes down into the pane's head and the Prompt moves down, level with the
foot of the rail's Inbox. What the search finds opens over it, under the
box, so a diff reads there. Narrower than 760 px the right pane
folds away and the search box stays on the top line, at its right; the
switch lays the pane over the center, and Escape or a press outside puts it
away. The search box is the way to everything the center refers to: plain,
case-insensitive, line by line in the repo's files (a file whose name holds
the query first), and its open issues and its runs too; what is found
opens under the box over the center while the box has the keyboard (↓ goes
into it, Enter takes the first, Escape back to the box; with the box empty,
Escape gives the keyboard back to what had it before), and follows what is
saved. The first is the first line found, or before it a file whose name
holds the query: it is lit, its Enter on a key at its end, while the box has
the keyboard. Each file found is headed by its name, how many of its lines
were found beside it, quiet (3 lines), and, changed since the last commit,
at the head's other end its diff as a diff is said everywhere (diff +5 and
its squares), pressed to read it there; a name found by its lines alone and
the diff are pressed, not gone along with ↓ (only a name that holds the
query is). A file found by its name opens with the caret in it, a line with the
line selected (where it is now, if it moved), a third of the way down, or
with its file's head at the top when it is near it (never the empty foot of
the file before over it); an issue, a changed file's
diff or a run is read in the right pane. Under the top line, the plugin
area: nothing until the rail's plug opens it, then up to seven plugins side
by side, one at a time (none yet). With none it stays plain, nothing put
there to fill it (issue #45): opened, the pane's top is that empty area and
the Prompt moves down under it, level with the foot of the rail's Inbox, as
it does under plugins; the plug, which says it is out, is the way back.
The right pane has no switch of its own. At rest it says, on the Prompt's
head line at its right end and as quiet as that head, Issue, diff (with how
many files are changed since the last commit, diff 2) and 実行結果, the three
the search box switches between, so a pane that holds only a prompt line
still shows what else is there: a head pressed opens its view under the
search box, as its pill there does, and the view stays out beside the file as
the keyboard goes back to it, until it is put away. Beside the file it stands in
the pane's own width, a step in from the pane's line, over the pane and never
over the file, which keeps its whole width (one box or several side by side),
the shade lifted; pressed, or the search box in use, it opens out over the
center to be read and draws in again as the keyboard goes back to the file
(its left edge sliding, `--move` on `--land`). It is put away by
Escape in the box, the × at the end of the strip under the view, or its pill
pressed again; while it is drawn in, its switch (Issue, diff, Output) waits
for it to open out. The views: Issue (the repo's open issues, as Git shows them: one merged or
closed is not among them; one line each as #3 Fix：件名, pressed to read one in full), diff (the changes not yet
cut, file by file: added lines in ink with no fill, the lines kept quiet,
removed lines quiet and struck, following every save; a file's name opens
it in the center, a line's number opens it at that line, selected, to
write in, and a removed line's the line that took its place; pressing a
line elsewhere marks it with the `marker`, as a review does, to come back
to, and again unmarks it, the mark staying on its line while the app is
open; at the right end of a file's head, Put back, which asks in the head
first (Not now, Put back under the pointer) what will happen, its lines
still under it, then makes the file what the last commit held: its text
again, a removed one written back, one added since gone; a binary file only
by going. A part of a file is not put back on its own) and 実行結果 (each line sent
from the prompt box, newest first: the line, how long it took or that it
is still running, and what came out until the prompt returned; the Prompt
itself scrolls on, this keeps the record). A line pressed there is back in
the prompt box, the caret at its end, to be changed or sent again; it is
not run. The Prompt's own status line is
empty while it simply runs; it speaks only when something is missing (large
files and binaries not copied in, what could not be written back). Once it
has ended, how (Exited (0), Stopped) and Start again, its power switch off,
are the last thing under its output, the end of its thread (in the pane a
dot of its own, off), never a row of their own over the box's Run; the
output dims, they do not. The pane tells, it does not hold: each line run is
its line alone (what it printed is the screen's), and a title the box made is
its first three lines; a line run pressed there brings the Prompt up with
what it printed, at that line. Put back into the box, what the Prompt
printed is folded away, so up again it starts at the prompt line it waits
at, one quiet line over it (Earlier (2)) that opens what came before where
it stood: a Prompt opened again is never yesterday's screen. Moved between
the pane and the screen, it reads from its foot. Up
over the center it is as tall as what it holds, up to 40% of the window, so
before the first run it does not cover what one reads. The prompt box has
Run at its right with its keys (Ctrl+Enter), and reaches a step left of the
files' boxes, so it never reads as the foot of the file behind it. Whether
the right pane is put away is remembered on this device.

The Prompt never goes silent while something takes time:

- **Coming up.** The first Prompt of a visit fetches l3 (2.7 MB) and says how far it
  is (`l3 を読み込み中 1.5 MB / 2.7 MB`). When the line goes quiet it counts
  the seconds (`応答待ち 4秒`); at ten it counts as broken and is taken up
  again from the byte it reached (`回線が止まりました。続きから読み込みます`),
  the same after a cut or a server error, a few times with growing waits.
  What came stays for もう一度起動, and later Prompts in the page use it at
  once. Nothing of it stays on the device: it is the OS, and its copy is
  the release's (the app has it beside itself). The app's first Prompt on
  a device with no root yet fetches the release root the same way, its
  status saying how far it is, rather than sending the person to Runtime
  (which fetches it ahead, or chooses another).
- **Running.** A line done within two seconds says nothing. Past that, under
  the output: `実行中 N秒` with 中断 (Ctrl-C in the prompt box, when nothing
  is selected, does the same); `入力待ち` with 中断 only when what runs reads
  input (whatever is typed in the box goes to it); a sleep (`sleep 4`) is
  not waiting for anyone: it reads `実行中 N秒` with 中断, which reaches it,
  and its quiet is not counted (the worker says which it waits for: input,
  or a time); `出力なし` after five
  quiet seconds; and after ten, 止めてやり直す, because a worker busy in a
  loop cannot hear 中断, and only a new shell is sure. 中断 ends what runs
  in front of the shell as SIGINT would, and the shell goes on (`$?` is
  130).

### Runtime

In **parts** (§3), as Remote's page is: この端末 (what it holds, what can go
from it and come to it), what is running (offered while a Prompt runs, or one
stopped here says what it gave back), the environments (SSH, the environment
actually in effect, what runs, not what was asked for, and on the web the
desktop app, side by side), and the dotfiles. A part not shown goes on: a
Prompt runs, what holds a repo is read again, a dotfile half written stays.
There is no table of policies: what the device holds is shown as things, and
each thing says what can be done with it.

**A repo in a list** is the same in every list of repos (Home's cards, the
three columns here, New repo's list): its body (a card's, a row's name) is the
repo itself, opened in Forge, where all of it is (one only on the Remote is
brought here first, its card saying so meanwhile), signed in or out, as a
repo in a profile opens the repo. Near it (the pointer on it, the keyboard in
it, always on a touch screen) a small round gear shows at its edge; pressed,
a popover offers what is done to the repo itself from a list, each chosen on
its own: signed in, Show on the Remote (its card there, shown and lit: its
switch, who sees it); Rename; Free from this device (空ける: the same Free as
below, its conditions unchanged); Delete. A deed that cannot be done now is
there, not pressable, with why under it: the reason that holds, said as it
is (signed out, Free says there is no Remote to free it to, never that a
Prompt has it when a Prompt is not why). A Prompt waiting at its prompt line
holds nothing back: the deed's ask says it is stopped first, and it is; one
running something holds all three, and says so. Pressed, each becomes its
field or its ask in its row. Free asks what it does ({repo} leaves this
device; it stays on the Remote and comes back when opened), Free under the
pointer, Not now beside it. Rename is the name written in its row (Enter or
Rename gives it, a name that cannot be, or one here or on the Remote
already, said under it): only a repo no Remote has, since the Remote knows an
account's repos by their names and every device keeps each in step by it
(one there says so under Rename, which stays greyed); its copy, its works'
copies, its environment and caches go to the new name (`repo_rename`), and
so does everything that holds it by name: its pill keeps its place on Forge's
band (the one worked on is still the one worked on, its boxes where they
stood beside), Git's chip chosen stays chosen, and what was half written in
the box for it, its search, what was searched and read, where one left off
(Lately) and its Prompts' network grant are its new name's. Delete
of a repo no Remote has asks in its row as File's Delete does ({repo} goes
from this device, with everything in it; nothing keeps it elsewhere, so it
cannot be brought back), Not now and 消す at its foot; it goes from this
device with everything kept of it there (`repo_delete`). Delete of one on the
Remote asks in the list as turning it off asks on its card (the account's
name, the repo's, the code, a passkey: it guards the repo's history against
another hand), saying what it does: it goes from this device and from the
Remote, which keeps it off 30 days, where turning it on brings it back; what
is here not sent yet is sent first. Off on the Remote already, Delete is its
廃棄, asked the same. Showing the gear or its list does nothing; Escape or a
press outside puts it away. On a card the list comes down from the gear as
wide as the card, over what is under it; in a column that scrolls, under the
row, in its own place. Done, the place says what it came to where it is (the
row's result over the box; the card becomes the Remote's, takes its new name,
or goes).

- **この端末**: one bar of the host's whole, with this OS's share darker
  (not an ink fill, which means current), and three figures: this OS, free,
  total. This OS is counted from allocated blocks, so a sparse file counts
  what it holds and a file with several hard links counts once; the host's
  free and total are marked 推定, because other programs change them too.
- Under it, one box in three columns, as tall as the longest (not a tall
  empty box when there is little): what is **in this browser**
  (on this device) at the left, what is **only on the Remote** (fetched with a
  press; all of it here too, it says so) in the middle, and what **can be
  freed** at the right (nothing, it says the reason is on each row that
  stays: not on the Remote yet, a Prompt running in it). In each, **one list, largest first**, of everything this OS holds: each
  repo, each root of the distribution, each leftover, Home. A row is the
  thing, its size, and at its end what can be done:
  - **空ける**: it is not needed here. A repo whose copy is what the Remote
    has (it comes back when opened), a root that is neither the current one
    nor one a Prompt runs on (the Remote has the release), a temporary this
    OS left half-written
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
  - Otherwise, quietly, why it stays: a Prompt has it open, a Prompt being
    prepared uses it, it holds what cannot be sent (a link, a file over 16 MB,
    a `.git`), there is no Remote yet, it is the root Prompts run on, a
    Prompt running uses it (a root no longer current, until that Prompt
    ends), it is Home's settings; of two, the one a Prompt stopped would not
    lift (no Remote) is the one said. Why (and what
    freeing does) is a line of its own under the row's facts, read whole,
    never cut short; a Prompt stopped or started reads it again at once.
  Under the list, 空けられるもの with its total and 全部空ける. Freeing stays
  to say what happened, as two things that are not one: what this device
  had allocated and let go (counted from the files' blocks before removal:
  Verified), and the host's free space as it was observed to change and how
  long it took to show (a file still linked from elsewhere or held open is
  given back only when its last link or holder goes, and other programs
  write meanwhile, so the second can be less); then anything kept, with the
  reason.
- **What is checked is what goes.** A repo's copy is freed only as it was
  when the Remote was seen to hold it, up to the moment it goes: each copy,
  checked, is moved aside in one rename (beside it, `.<name>.freeing-<pid>`,
  a name nothing lists, syncs or reclaims), so nothing can open its files by
  name any more; then no process may still hold anything in it (a file or
  folder open or mapped, or as its current folder or root, read from
  `/proc`: what it holds it could write on into); then what was moved is
  read again whole, every byte, no kept digest taken, and must be exactly
  the Remote's draft, asked once more; only then is it removed. Anything
  short of that puts every copy back where it was and Free is refused, so
  late bytes are on the Remote or here, never freed and nowhere (a file
  written by name after the move fails, and its writer is told). A final
  rehash alone would only narrow the window, and the sync's lock does not
  stop an ordinary write; this holds to the delete.
- **動いている Prompt** is shown while one runs, a small card each (the
  size of Home's cards, smaller, so a few do not stretch across the page):
  where it runs (root, with its process count, and 用意中 while its
  `.packages` and `.setup` run, or l3), the memory its
  processes hold (Pss, from the host's /proc), and 止める at its bottom right. On the root, stopping ends everything in the
  Prompt's pid namespace and is called done only once the host shows none
  left; the row then says what was given back and how long it took
  (止めました · 2.5 MB を返しました · 11 ms), or how many are still there.
  A Prompt on the root has no network unless its repo is given one: a
  plain switch with the word Network in its card. A namespace cannot be
  given a network once made, so turning it on asks in the card, then stops
  the Prompt, which has the network from its next start; turning it off
  stops it at once. The grant is this device's (never sent), and `l3
  prompt` reads the same one (`--network` gives it to one Prompt); `l3
  network on|off REPO` is the switch, taking it stopping the repo's Prompts
  as here. In a browser there is no switch: a Prompt's programs have no
  sockets at all.
  Every Prompt on the root is an `l3 prompt` process that records
  itself (core/src/prompt.rs) from the moment it starts being prepared
  (`.packages`, `.setup`) until it ends, with its repo and the root it runs
  on, so `l3 prompt ls` lists the app's and a terminal's alike (one being
  prepared says 用意中, as its card here does), `l3 prompt stop REPO` stops
  them as 止める does, prepared or running (what prepares it ends with it),
  and neither 空ける here nor `l3 free` (one by one or all) lets go of what
  one holds: its repo, the repo's environment, caches and what is derived
  in it, and its root, whichever root is current now, so making another
  current takes nothing from under a Prompt that runs. The core reads the
  records itself, for the app, l3 and a direct call alike. Each thing is
  looked at again just before it goes, under the one lock a Prompt records
  itself under (only while its root is still whole) and the current root is
  changed under (only to one still whole), so neither can come between the
  look and the removal. A record whose process is gone holds nothing.
- **有効な環境**: the environments a Prompt can run on, in one small card
  (a Prompt's card's size), beside the desktop app's (SSH, then it, then the
  desktop app, in one row; on the web SSH's one line is a card wide; where
  the row has no room, each goes under). The one in
  effect is the card's head: l3, with its version (in the mono face, as a
  version is), what it is here (in the app, the root installed, on this
  device's kernel; in a browser, the same root through xlat) and its
  digest: the same version and digest in both, the root's (l3: the one
  base). Under it the others, a row each, quiet:
  Ubuntu, Debian, Custom (a root of one's own, known by its digest), what
  each is, and at its right what can be done. In the app each other one has Use at its
  right: fetched if it is not here (Ubuntu's base and Debian's official
  root, from their makers or the Remote, taken only at the digest pinned
  in core/src/root.rs), then the one Prompts run on, each with its own
  environment per repo. In a browser they say In the app only: their
  programs are linked as they run, which xlat does not do. Custom is not
  yet.
- **Packages and runtimes are dotfiles**, so nothing is kept twice: the
  OS has no package list or runtime manager of its own. `.packages` names
  what to install with the root's own package manager (apt on Ubuntu and
  Debian; l3's root has no archive yet), `.setup` is run with sh after it
  (the place for a runtime's own installer: rustup, nvm, uv, mise…). Both
  run before a Prompt, with the network, over the repo's environment, so
  what they install is the repo's and stays; and again only when the root
  or either file changes. While they run the Prompt is one already: listed
  as being prepared, what it holds kept, stopped by 止める. One that fails
  or is cut short (Ctrl-C) leaves the Prompt to start with what is there,
  and is tried again at the next start.
- **SSH** into a repo's Prompt, per device, and the desktop app's alone
  (the web offers none): an ordinary OpenSSH client, with the repo as its
  user, lands in that repo's Prompt, the same shell `l3 prompt REPO` gives
  (a command runs there and its exit code comes back). It is built to show
  as little as it can, and to say plainly what it shows:
  - **Who may connect** is chosen as it is turned on, in the same press:
    *この端末だけ* (this device only, first and the default: 127.0.0.1 and
    ::1, so another PC finds the port closed, with no handshake and no
    banner), or *同じネットワークにも* (the same network too: each LAN
    address of the host besides, RFC 1918 or link-local, and an address in
    100.64/10 only on a recognised VPN interface (`tailscale*`, `wg*`,
    `zt*`, `nebula*`, NetBird's `wt*`, `CloudflareWARP`), since elsewhere
    100.64/10 is a carrier's shared NAT, its other customers beside you;
    one socket each, never 0.0.0.0, a public address, or a bridge's or a
    container's (`docker*`, `br-*`, `virbr*`, `veth*`…: containers and VMs
    are not the network a person means), looked at again every few
    seconds). `l3 address` and the card name each interface taken
    (`wlan0 192.168.1.5, tailscale0 100.101.102.103`). Kept on the device,
    never on the Remote.
  - **From the network it came in on.** Linux takes a packet for any of its
    addresses on any interface, so a socket on the LAN address alone would
    answer a sender on the public side who routes to that address through
    the device. A connection is taken only from inside the subnet of the
    address it came in on, from the device itself (its own addresses, so
    `ssh` to its own LAN address works), or, on a VPN's interface, from a
    non-public address the kernel routes by that interface (Tailscale's own
    address is a /32 and its peers are in its table 52, so the kernel is
    asked, over netlink); anything else is closed at accept, before the
    banner. (Binding each socket to its device, SO_BINDTODEVICE, works
    unprivileged here but takes anything that arrives on that interface,
    a router's port forward from the Internet included, and needs a second
    socket on lo for the device's own `ssh`; the subnet check refuses both.)
  - **No IPv6 but ::1, deliberately for now**: a global IPv6 address is
    reached from the Internet unless a firewall says otherwise, and a LAN's
    is not yet told apart from it (a unit test holds this).
  - **Nothing of where leaves the device.** The Remote keeps only that a
    device listens, its scope's word, since when and when last heard;
    destinations are worked out and shown on the device itself.
  - **What it says of itself** is `SSH-2.0-length3`: keys only (Ed25519,
    ECDSA), no forwarding, no sftp.

  | Who | この端末だけ | 同じネットワークにも |
  |---|---|---|
  | this device | the port on loopback; its card shows the destinations, the host key, the keys let in | the same, and the LAN addresses |
  | another PC on the LAN/VPN | nothing: the port is closed | `SSH-2.0-length3` and the host key; only a listed key gets in |
  | a sender on another segment routing to the LAN address through this device | nothing: the port is closed | the handshake, then closed at accept before the banner |
  | the carrier's other customers (100.64/10 on an ordinary interface) | nothing | nothing: no socket there; at a VPN address, closed at accept |
  | containers and VMs behind a bridge (`docker0`, `virbr0`, …) | nothing | nothing: no socket on a bridge's address |
  | the internet | nothing | nothing: no socket on a public address |
  | the Remote | listens, `device` | listens, `network` |

  In the app, This device's card says, plainly and in this order: each
  repo's destination (`ssh -p 23000 notes@127.0.0.1`, copied by a press,
  as Inbox's stub is), from where (この端末からだけ / 同じネットワークの PC
  からも, with the addresses), how many keys `.authorized_keys` lets in, and
  the host key's SHA256 fingerprint to check at the first `ssh`; at its
  foot, the other scope at the left and the power switch at the right. Off,
  the switch pressed asks from where in the card first (This device only
  first, as the network grant asks), with Not now. Every other device that
  listens is a small card of its name and to whom ("Listens for SSH from
  that device only"), how long it has been on (or that it has not been
  heard from lately), and the switch, on; pressed, that device stops taking
  connections and ends its sessions within seconds. SSH is turned on only
  at the device itself (`l3 address` asks whether, then from where; `l3
  address ssh on [device|network]`; or the app's card): a page can only
  turn a device's SSH off, so the switch on another device's card only goes
  one way. On the web one short line over those cards says SSH is the
  desktop app's. The listener is l3's, in the background, recorded under
  the data directory as a Prompt is, and asks the Remote every 30 s or so,
  stopping once it was turned off or the device signed out. Keys are the
  `.authorized_keys` dotfile (below), public keys only, so a key added on
  one device counts on every one. With none there, turning on says to add
  one first, and how. Shown only while signed in.
- **Dotfiles**: one box, a row each (its name in the mono face, its size at
  the right), and New dotfile at its foot. A row pressed is lit and opens its
  text under it, in the box (not under all of them, away from the row
  pressed), `/root/` and its name above it, Remove at the left, Close and
  Save at the right; pressed again, or Close, it folds. A long name is cut
  at the row's end, never wrapped over three lines. Every Prompt
  starts with them in `/root` (the app's root and the browser's alike), and
  the Remote keeps them in step across devices, as it does Home's settings.
  A Prompt already running keeps what it started with: its shell has read
  them, and its `/root` is its own (in the app a tmpfs in its namespace),
  so nothing is put into it behind its back. Saved while Prompts run, one
  line under the box says so (The Prompt in notes gets it when it starts
  again) with Start again, which starts each of them anew; under the box,
  so Save does not move. Remove asks in the box, where its deeds were (it
  goes from every device; Prompts running keep it until they start again),
  Remove under the pointer and Not now at the right.

- **デスクトップアプリ**, on the web only (the app does not offer itself):
  after the environments, on one row (what this device runs on, and can be
  reached by or become), its card the SSH card's size, the cards ending
  level; where the row has no room, it goes under. Few words: its title,
  Length³, and the version `RELEASE` names apart from it in the mono face (a
  name and a number are two things); quietly, x86-64 Linux, which file and
  its size (what it is goes without saying). At its bottom left, Download
  (ダウンロード), the one download: a primary button a size smaller than a
  small one (its word 13, its mark 12, still 32 high to press) with the
  download mark (an arrow into a tray, `icons.ts`) and the word. It is at
  the left because it leaves the page for this computer, as Forge does on
  Remote's card. It gives the .deb, which Debian and Ubuntu install, or the
  AppImage when the Remote has no .deb (the release still has both). They are
  the files `shared/desktop-releases.json` pins for that version, served by
  the Remote (`/v1/desktop/<file>`, to anyone, by range), where each deploy
  puts them from the release (`service/mirror.ts`). It is offered only once
  the Remote says it has it; with neither there, the section is not shown,
  never a button that cannot act.

In a browser the same list is the browser's copy of the repos (このブラウザ,
its share an estimate), and the same three answers apply. What the browser
counts for this OS beyond what is listed (its own keeping of them) is a row of
its own, Other (その他), last and marked estimated, so the rows always add up
to the total over them and beside the bar: never 2.8 KB over a lone Home of
0 B.

### Git

With no repo at all (a first run), Forge's center and Git's issues are one
dashed card, Make your first repo, the whole card the deed (it is New repo,
as Home's card is), saying under it what a repo is here (a folder of your
own, kept as git keeps it, that Forge, Git and the Prompt work in) or, in
Git, No repos yet: not a way to bring a repo out when there is none.

What happens between a repo and the outside, in the mental model of the
issues: an issue hides its branch and worktree, and the operations are
Commit, Push, Change (with Reset), Review, Merge, and Close for one that
will not be done. It uses the same workbench
as Forge, in Forge's frame: its band on the top line is the repo chips
(one repo or all), where Forge's pills are, beside the search box and the
right pane's switch; under it the center, from the rail's first place, its
boxes on the band's edges as Forge's are, the prompt box at its foot a step
outside them, and the narrow right pane with the reference and the Prompt.
There is no page header: the rail says where one is (a heading only a
screen reader hears). The chips are one row that slides sideways however
many there are (with no repo yet there are none: All of nothing is no
choice); choosing a repo also points the right pane and the Prompt at it, and
makes it the repo worked on (§1): Forge opens there next. So does going to
an issue (an edge, ← →) and starting or continuing one; coming to Git
opens at the issue last looked at in the repo worked on, and with none
looked at yet (the app just opened), at the issue that repo's work is on,
so a reload finds the work where it was left. An issue written
is the one shown, its repo's chip chosen if another was, with the keyboard
on its words; one half written (new, or its words half changed) is still
half written after reading its neighbours or another page.

- **Issues**: every issue still open: not merged, not closed. An issue is its number and its
  words ("#3 Fix：件名", then the detail); that is all a person meets. Any
  repo takes one, and it takes the repo's next number. How it is kept is the
  OS's business: one plain file in the repo's `issue/`, named by its number,
  so l3 and a Prompt see the same thing and nothing is kept twice; a file
  there with no number (written by hand, or two devices' issues that met
  under one number) is given the next free one. An issue is main's, whatever
  work its repo shows (the issues are read from main's copy): written, its
  words changed, closed or reopened, its file is committed on main by
  itself as it happens, its own line saying what was done ("Issue #3:
  Fix：件名", "Close #3: Fix：件名", "Reopen #3: …"), so main's history says
  when each was written and closed, main's card holds only what a person
  changed themselves, the issues beside one never go when a work starts,
  and a work's change never carries an issue. In a repo with no commit yet,
  what it holds is committed first (Start), so its history begins with the
  repo and not with an issue. Written signed out (no Remote, so no history
  yet), the file waits in main's copy and is committed the same way, each
  by itself, the first time Git reads where the repo stands with the
  Remote. Its file is never what a
  person is shown: wherever a file is named (Forge's heads and the boxes
  beside, File, Lately, the look, Git's diffs, the search, Edit's pill), the
  file an issue is kept in is the issue, `#3` (in a diff, followed by what
  it is about, "#3 Fix：件名", its fold shut: its words are read in its box);
  only the Prompt, which is the repo as it is kept, says `issue/`. Under the
  heading (its count, and 「Issue を書く」 on the heading's own line at its
  right, one place however tall the box in full is; with none to show, the
  dashed card is the way instead) the issues are large boxes side by side,
  oldest first:
  one in full, its neighbours' edges showing at the sides. The current box
  is a large place, an `ink` edge over `raised`. An edge is a clear button
  over the neighbour, which lifts (`raised`, its number a step toward the
  box it would become) while hovered, a chevron in it saying which way;
  pressing it, ← →, or a finger's swipe along the row, slides the track
  there (280 ms, the one movement). The box left keeps
  what it holds as it slides away (never an empty sheet going by), fading
  only as it reaches the edge, and becomes its number there. The first box
  starts at the column's edge and the last ends at it. A neighbour shows its
  number alone at the edge that shows (the one before at its right), never a
  title cut short. The column keeps the room a scrollbar takes, so an
  issue's edge stays put as its words are read and changed. On a phone the
  box in full takes the row, its neighbours a sliver at its edges (their
  numbers would not fit), and nothing in it is wider than it: what stands
  beside a step's button where there is room (a diff) goes over it, the
  foot's line wraps, a switch goes under its line.
- **Drawn again after a deed** (Start, Back to main, Commit, Push, Close…),
  the row does not slide as if gone along: the box in full stays the one it
  was, its edges easing to where they now are (its neighbours gone, it
  widens to the column's); main's part over it folds away where it stood,
  unfolds or goes to its new height, the box going with it; and the box
  goes from the height it was to the one it is. Nothing jumps. Closed, the
  box goes down out of the row and the row goes on to the box beside it (the
  one after, else the one before) before the page is drawn again, never a
  hole where it was; reopened, the row goes to it; written, the box written
  in folds away and the row goes to the new issue at its end.
- **A deed under way** (Start, Commit, Push, Merge, Close, Create, Commit on
  main, Reopen): its button keeps its look and its word, never greyed as one
  that cannot be pressed, and a short line runs under the word until it is
  done; Approve's ○ turns, its arc in the green it lands as.
- **A new issue** is written in a box over the issues: its first line, the
  repo it goes in said quietly before it (as a card says its repo), then a
  detail tall from the start, with the room a second row of repos would
  take. Where it goes is chosen in the one row of repos above, never in the
  box: a repo chosen there while writing is the one written in; All widens
  what is shown and leaves it as it was. This box ends with its deed first:
  Create at the left, Not now at the right, so which one is wanted reads
  first (every other box keeps Not now at the left). Opened, the whole box
  comes into sight as it unfolds, Create with it; Enter on the first line
  goes on to the detail, and Ctrl+Enter (⌘ on a Mac) in either creates it, as
  it sends a comment (and saves an issue's words being changed). An Issue view with
  none open in Forge's reference has Issue を書く under its line: Git opens
  with the box for that repo, its first line ready, and Not now goes back to
  Forge as it was.
- **The box**: the issue's number and name ("#1 Fix：件名") and its detail,
  changed where they are read (pressed, they become the fields they were
  written in, Save and Not now under them), as tall as its words (a line at
  least), so no empty room stands between them and what comes under, one
  quiet line of its repo, who started it and when ("hello · sora · started
  2 min ago"), and Start (Continue here, if it was started)
  or, while it is worked on here, Back to main. Start gives the issue its own
  copy of the repo, which File, Forge and the Prompt show; the layout says
  this, no sentence explains it. A merged work is done: the repo shows main
  again on its own, and the copy goes.
- **Each issue is a column**: its card, and once it is pushed, its Review and
  Merge under it, so they slide with it; the neighbours show only their
  cards' heads. The card's weight sits a little high (less room above than
  below).
- **Inside the card**, right under its title once it is worked on here:
  **Commit** and **Push**, one row each: where it stands at the left, the
  button at the right, down the one edge Start was pressed on (as Merge is
  under the Review), so the pointer goes down the box, never across it;
  done, the button's place shows the same word with
  the done mark (a circle with a check, `done`), and the green says it is
  done. In Commit's row, what is not committed, its files folded as main's
  card has them, on the card itself. Pushing hands the work to
  main as its change, again as the next version; while it is undecided, a
  switch at the foot's right, its word before it (Handed in), is on, and
  switched off (Reset) takes it back: it goes off at once under the hand,
  and back on if it could not; taken back (or rejected), Push's row says
  so (Change · version 1 · Taken back) until it is pushed anew. A change received from
  someone else shows Commit and Push done.
- **The card's foot**: its repo and who started it and when; Start or
  Continue here at the right. Back to main stands under the card at its
  left, out of it, as what leaves the work always is. No file name
  is shown anywhere an issue is. One not worked on here, with no undecided
  change, has Close at the left instead (whatever work the repo shows, its
  file is main's, so Close is offered from inside a work too): it will
  not be done. It goes at once (Reopen brings it back, so nothing is
  asked) and is listed under Closed. Being closed is the issue's own: its
  file says so on its last line, after the detail (`Closed：2031-10-17
  sora`, the day and who), so l3 (`l3 issue close REPO#N`, `l3 issue
  reopen REPO#N`) and a Prompt see the same, and it is committed on main by
  itself (Close #3: …, Reopen #3: …), with nothing kept twice.
- **A diff**, wherever it shows: each file a fold, its name (which opens it)
  and what was added and removed (+56 −2); each line with which line it is.
  The first three files are open, the rest wait closed, so a large change
  reads file by file; it scrolls inside its box.
- **Review**, shown once there is a change to review: a box of its own
  under the card, a sheet as the card is (`paper`, a `rule` edge, `ink`
  while it is in hand: a line being marked, a comment written): the change's diff,
  where a reviewer marks lines as with a highlighter (`marker`), each file a
  fold as everywhere (its lines from the box's own edge, not set off to the
  right of its name); what was
  said, in order (an approval without words is not shown there); then a
  comment more, in a field on the sheet (an edge only, no grey over the
  paper), room for three lines and as tall as its words beyond (Ctrl+Enter
  or Comment sends
  it with the marks), and beside Comment, Ask for changes, which sends the
  same with its verdict (it says something: with nothing written or marked,
  the field is where to say it), shown in what was said as Asked for
  changes, as `l3 review REPO#N changes` is; at the left, Approve as a ○
  that turns green when pressed.
- **Merge**, under the Review and not in it: Reject at the left, who
  approved it, and Merge at the right, primary once the version is
  approved.

Before Git has read where each repo stands (several of the core's answers
for each, one after another: a second or more with a dozen repos), Reading…
stands where the issues will be, not a heading over nothing; come back to,
what it read last is drawn at once while it is read again, and drawn again
only if something moved.

Around the issues, each its own section, shown only when it has something:
main over them (what is in hand comes before what is planned); under them
what is done with, Committed (on main, from here), Merged and Closed.

- **main**: a card for each repo that shows main and has something not
  committed there (an edit in Forge, a file added in File: what a person
  changed themselves; an issue written or closed is committed by itself and
  never waits here), a
  sheet on `paper` as an issue's box is, never melting into the ground,
  standing in the issues' column with the same edges as the issue in full
  under it and going with it as the row slides, and laid out as an issue's
  box is: its repo at the top where an issue's name is (a label at the
  size of the file named under it, not a title: main is said over it, and
  a word alone at an issue's size looms over the diff), the files under it
  straight on the card (never a box inside it), and at its foot how many
  files wait (2 files to commit on main) at the left and Commit at the
  right, where an issue's next step is. Each file folds at its head (a small triangle, its name, +n
  −n and the five squares), the first three open and the rest a line each;
  an issue's own file, where one is shown (a work's Commit row, written by
  hand there), is its line ("#1 Fix：件名 +3"), shut until opened, so an
  issue does not stand over the issues as its words again;
  a long one shows its first 30 lines with "n more lines" under them,
  pressed to show the rest, so a large change reads file by file and
  never as a wall. What is opened or shut by hand stays so while the page
  is drawn again (only by hand: a fold drawn open before it was known to be
  an issue's is not held open). The issue's Commit row shows its files the same way. With
  more than three repos waiting in All, each is a row instead (its name
  at the left, how many files and Commit at the right), so the issues are
  not a long way down; its name, with a small triangle, opens its files
  under it in the row and shuts them again (read only then), and one repo
  shown is its card as above. Commit
  asks in the card for the line the commit goes by ("Fix：title"), as
  `l3 commit REPO "Fix：title"` takes it, Not now at the left and Commit
  under the pointer; Enter commits the one line, and the card's height goes
  from its files to the ask and back (280 ms) rather than held at the
  taller. What is typed is kept with its repo until it is committed or put
  back. Committed, the card slides off sideways as it fades (340 ms), the
  room it took closing after it so what is under it comes up, and a line
  opens under the issues, in Committed: the commit's line, +n −n and its
  squares, Committed just now at its right, lit as it lands; the last few committed from here stay so, newest first. This is Commit, not an
  issue made of the changes: an issue hides a branch that starts from
  main's last commit, and moving main's draft onto one would be a new
  operation the Remote does not have; a commit on main is already one
  (`l3 commit` on main), so the app offers the same.
- **Merged**: the issues whose change main took, newest first, a row each:
  "#1 Fix：件名", who handed it in and when it was merged; pressed (its
  small triangle says so, as every fold's does), the row opens to the
  change's diff. It is history, so it is only read.
  Merged from here, the issue's box goes down into its row (460 ms), which
  lands lit, and the count of issues beats: the issue is done, and seen to
  go where done things are kept.
- **Closed**: the issues closed without being done, a row each: "#2
  Feat：件名", who closed it and the day; Reopen at the row's right end
  (wherever the Remote is reached, whatever work the repo shows) puts it
  back among the issues at once.

Every change is already on the Remote (the draft, §6); Commit makes it
history there, the same from the app, a browser and `l3 commit`. Without a
Remote the issues are shown and one line says that history is kept there.

### Remote

Signed out, the page is the header and, where its parts will be, one card,
the first thing a person meets: an `ink` edge over `paper` as the current
issue card is, at most 440 px wide, at the page's left. In it: Sign in, then
two quiet lines, what signing in opens on this page (Remote: your repos kept
in step across your devices, and shown to whom you choose; Inbox: a name
people write to you by; Server: servers, boards and the repos shown in them)
and that everything else works without it (your repos stay in this browser,
or on this device in the app), so signed out is not a page of nothing; then
the ways in one under another as wide as the card (the first provider
filled), and no words around the buttons: they say it. Nothing stands under
it: this device's repos are Home's to show, and a list of what is not on the
Remote yet, under the way onto it, only made the page untidy. The Inbox,
signed out, shows the same card in the same place. A
device's code opens the card on a page of its own, in its middle, for each
step: the code, signing in, letting the device in. Signed in through a
provider, the person is back on the page they began on (Remote's, or
Inbox's); cancelled or refused at the provider, back on the same card, which
says so by the provider's name (Signing in with GitHub was cancelled;
nothing was shared), with the ways in there to try again.

Nothing else is under the card: what paying is (the tiers, what each keeps
and costs) is the Plan's, once signed in, not a page of prices put before
the way in.

Signed in: the header, then the page's parts as a switch (the one
place a page is switched, because its parts are unrelated; a part chosen
comes in from its heading's side as the ink goes to it, as Runtime's and
the gear's do, never swapped in one frame):

- **Repos**: every repo the Remote holds, as cards the size of Home's: name
  (as Home's card sets it), what it is (its README's first line, once a copy
  here is read), size and when it last changed, where it stands. On: Forge at the bottom
  left with Share beside it, the power switch at the bottom right; the switch's knob
  is green at the right, and turning it off asks, in the card, for the
  account's name, the repo's name and the five-letter code, then a passkey.
  The name is the account's as its provider gave it (what `l3 remote`
  shows), which no page shows otherwise, so the ask says it: To confirm,
  type Sora, notes and your code (the profile's name is the person's to
  change at will, so it is not what is checked). With no code yet, the
  same card sets it first (New code, Set the code; a passkey is made for
  this device if the account has none, then confirms it is you) and goes
  straight on to the names; the passkey just used still counts, so turning
  off does not ask for another (the Remote takes one for five minutes).
  Delete in a repo's gear, in any list, asks the same in the list, and
  turns it off with its copy here gone (§ Runtime, A repo in a list). l3
  does what the gear does for a repo only this device has (`l3 repo mv
  NAME NEW`, `l3 repo rm NAME`), and for one on the Remote says that the
  Remote guards it and where it is turned off: the passkey is the app's.
  Off, the knob is at the left on `off` red and the card is quiet (dashed):
  the Remote keeps the repo 30 days, answering only that it is off, and
  pressing the switch again brings it back at once. Off, at the bottom left:
  空ける, which frees the copy on this device (it stays until then; refused
  while it holds changes the Remote lacks, since nothing is sent to a repo
  that is off), and 廃棄, quiet until the pointer is on it and then filled
  `ink`, which asks as turning off does and then takes the repo from the
  Remote at once, with its history, for good (the copy here first, refused
  the same way). The Remote remembers a repo discarded, so a device that
  still holds a copy does not quietly bring it back.
  Share (with the mark below it, as the language has) opens as the
  language does in the person's menu: a list over the card from Share's
  left edge, under the head 見せる先, a row per server one is in, the ones
  the repo is shown in bold; pressing one shows it there or takes it off
  at once, and the list stays for the next. A press outside, Escape or
  Share again closes it. In no server yet, the list says so and leads on:
  Make a server…, which goes to Server where the first is made; or, on
  the free plan, where making one is paid, that it is and See the plan.
  Going public is the server's, in its gear (seen
  as the server's, so nothing ties it to you).
- **Sign-in**: passkeys, the code to turn a repo off (five letters or
  digits, set with a passkey; only its digest is kept), then the providers
  (the last way in stays, with nothing to press beside it).
- **Devices**: each session signed in now and when it was last used, this
  one marked. Every other row has Sign out at its right end, the same
  Remote call as `l3 remote devices rm N`; pressed, the row asks in its
  place (its own line on top, then what will happen: it is signed out at
  once, and what is on it stays there), Not now at the left and Sign out
  under the pointer. That device finds out at its next word with the
  Remote and is signed out there (§3, the Remote away). This device has
  nothing to press in its row: it signs out from the person's menu at the
  foot of the rail, which also forgets the session here. At the list's foot,
  room for the next and the way to it: Connect a device, a row with a dashed
  edge and its words in its middle (§3, the dashed card). Pressed, the row is
  the steps a device's code takes on its own page (`?device`): the code the
  device shows, typed, then which device asks with its code to check, Refuse
  and Connect; Not now puts the row back until then, and Done after. Let in,
  the device comes into the list once it has taken its session.

- **Plan**: Plans first, at the part's top: free and the three tiers side by
  side as small **cards** (§3), four across the part (two, then one, as it
  narrows), and at the heading's right the tier the account is on with the
  one date that matters in `sub` (renews, ends, how long a failed payment
  stays paid; free: what free keeps). Under them On the Remote, three
  **meters** (§3): repos on the Remote, what is kept there and names here,
  each against what that tier keeps (repos as many as fit: the figure alone),
  and, when over, one quiet line that what is there stays and what is new
  waits on the device. (A Remote showing no tiers says the tier in a figure's
  size instead, over the meters.) Each tier's card has its price as Stripe
  says it, what it keeps, and its one deed at the right of its foot; the
  account's own is current (an `ink` edge over `raised`) with nothing to
  press, and one that keeps less than is kept now says that what is there
  stays. Free, each tier's deed is Subscribe, which never steps into payment
  at once: what is bought opens under the cards, in plain words a line each
  (the tier and its price; Renews automatically until you cancel; Cancel any
  time from Manage the plan, the tier staying until the paid period ends;
  Nothing you made is lost if it ends; then, small, that one pays on
  Stripe's page and comes back here), Not now at the left and Continue to
  payment at the right (Stripe's Checkout). Paying, the other tiers' deed is
  Upgrade or Downgrade, which opens Stripe's portal at the step that changes
  the tier (Stripe says what it costs now, and asks); none while a payment
  that failed is put right. Then what paid adds, in three plain lines (keep
  more on the Remote; make servers; names on your own domain), and, paid,
  Manage the plan at the bottom right (the portal: the card, the invoices,
  cancelling); with nothing sold, a quiet line saying so. Back from Stripe,
  how it went is said once, in one line above the plan: paid, and to what,
  once the Remote has heard it from Stripe (Payment went through: you are on
  Pro now); cancelled, nothing charged (a card declined in Checkout is said
  there, under the card, and Back comes to this); from the portal, what
  changed against the plan as it was when the page left for it (You are on
  Max now; Cancelled: Pro stays until Nov 22, 2026), or nothing. What the
  Remote refused is said where it was pressed: under the tier's card, in
  the ask, under Manage. The window coming back reads the Remote again.
  Shown only when the Remote has a plan. A repo card the Remote holds back
  says it waits, with See the plan: its edge dashed (in one place only, as
  one only on the Remote is) and where it stands said in ink, on Home's
  card too, not one quiet line among the others'; its switch stays, to say
  it should not wait. New repo says it before Create is pressed, at its
  left, when the plan's repos are all on the Remote already: this one is
  made all the same and stays on this device until there is room, with
  See the plan.

Under the parts, while there is no passkey, Add a passkey: the button alone,
below what the page is about rather than over it, shown once the repos are
drawn so it lands under them, not drawn first and pushed down.

### Inbox

Your name as a stub: a field-sized place about as wide as a name, the name
in it, shown alone (§5), and your code beside it (pressing either copies
it, and it says Copied for a moment in the same place; there is no Copy
button), its gear at the right end; a name, not a field, so it stands on
the ground with a place's line (`rule`), each part lifting under the pointer,
and the field under it is the one that reads as a field. Before there is one,
the stub is the name to claim, in the sign-in card's place; Enter claims,
and the field goes up into the stub it becomes, its name in it (no empty
outline flown in its place), turning from a field into a name; as it lands
its code and gear come in beside it and what the Inbox holds comes in under
it. No sheet stands at the right until there is a conversation to show
(not one drawn empty and taken away). The gear opens, over what is under it (Escape or a press
outside closes it), a popover: your names with their terms (Renew near the
end), then Add a domain; its first head starts at the box's own room, with no
group's step before it. Letting a name go is not offered here (the Remote
still lets a name go, `l3`'s way). Add a domain becomes, in its
row, one field where the name is written whole, `name@domain` with the @
too (no second box to go to; a name on one's own domain is paid, and a free
account is told so under the field, with See the plan), then the one DNS record that proves it (`_length3.<domain>` TXT
`v=length3; remote=<host>; proof=<…>`, each part copied by pressing it;
the host is the one name the Remote this OS ships with has everywhere,
`os.length3.com`: its app, its Remote, its records and its passkeys).
The proof is the Remote's keyed digest of the account and the domain, so
only the domain's holder can publish it and no other account can reuse it;
it is looked for while the gear is open, and the address is claimed the
moment it is found. The same record says which Remote holds the domain's
addresses, as MX does for mail. SSH is Runtime's, by device, not by name. The page stands on the
three columns Home's repos and New repo stand on: in the first the stub,
under it the field to write to someone new, of the stub's width, height and
shape (Write its end, as the gear is the stub's), and under that the
conversations (requests apart; their words start where the field's do);
over the other two, from the stub's top to the page's foot, the conversation
open, as a sheet. It stands on its foot: oldest above, the last thing said
just over the field it is answered in, never a sheet's height of nothing
between them. A message's time is a small figure at the foot of its last
line, not a line of its own; messages from one side a few minutes apart are
one run, close together, their joining corners tight, the time said once at
its end (not just now under every line). Someone who wrote first is answered
over the field: who, that they wrote first, what Accept and Block do and
that writing back accepts them too (as the Remote takes it), Block and
Accept at its right; not two words in the head with nothing said of them.
While no conversation is open there is no sheet, not a sheet of nothing
(before anyone has written, No messages yet stands under the field): the
one chosen brings its sheet in from that side, and another chosen while it
is out comes into the sheet as it stands, faded in, not swapped at once;
written to first, its row comes into the list at once; one with nothing
said in it yet has the dashed box, No messages yet, in the middle of its
sheet, gone with the first words. One's own name or code is refused under
the field (That is you), as a name not found is: a conversation with no one
else in it is not one. Sent, the keyboard stays in the field, for the next.
The Remote out of reach, the page is the sign-in card's place with the
card saying so (what comes back once it answers, and Try again): drawn
again on its own the moment it answers; Try again pressed and still away,
the card shakes. Server's page says it the same way, where its boards
would be. Writing is one line that grows as it is written: a message is named
the way an issue is ("Review：…", "Question：…"), and a `/root/…` path in it
says what it is about, so there is nothing else to choose. Enter is a new
line, Ctrl+Enter sends. A message about a server (being asked into it)
shows the server's name over it, once one is in it, and pressed, Server's
page opens at it. Added to one at once by someone one knows, the Remote
leaves a notice in the conversation with them (Ada added you to Books; to
Ada, You added Bo to Books): a quiet line across it, centred as a day's
name is, never a bubble in anyone's voice (no client can send one), its
words the reader's own language, the line itself the way to the server.

What comes while one works elsewhere is said where one is: in Forge and Git,
the conversations not read whose last word is not one's own (the two newest,
picked as Home's Lately picks them) come into the right pane's foot, its foot
on the prompt box's line, as Lately's rows (who, and what it is and its first
line: Review：…), sliding in from the window's edge as they come; pressed,
one opens the conversation in Inbox; read, it goes.

What comes is looked for every little while (10 s) while the page is shown:
the conversations' rows are drawn again under the field to write to someone
new, which is never drawn again (what is half written in it, and the
keyboard, stay), and what came to the open conversation is put at its foot,
through the Remote, whether or not a direct line is open. What is half
written to someone stays with that conversation (§1): opening another and
coming back, or another page and back, it is there; it goes when it is sent.

### Server

Every other purpose is about a repo: one edits it, walks it, decides on it,
keeps it, sends it. Server is the one whose subject is people: the people
you know, to talk with and get things done together. Inbox is one
person to one person, about something that asks for an answer; a server is
a group, and nobody in it is asked for anything. A repo belongs to a person,
who may show it in a server: there it is only seen, as it was last pushed
(§5, Names); nothing pushed yet, its line says so and no sheet stands under
it. A server's own repos are what comes next.

A server is a name and its people. Someone already in it adds people from
their own Inbox contacts, so a server is people who know each other; or by
a name or a code, in the card that adds: someone one knows both ways is in
at once, and told so by the Remote itself, however they were added: a
notice in their Inbox, in the conversation with whoever added them (Ada
added you to Trip), a quiet line across it in no one's voice that opens
Server at it; anyone else is asked in
the Inbox (a message about the server, a
request until they accept) and is in the moment they accept the one who
asked, so long as that one is still in it (within 30 days); the card says
they were asked. A message about a server shows its name as a way to it
once the reader is in it. Anyone
may leave, the owner may remove someone, and the last to leave takes it
with them. Its boards are what its people talk about, each one thing (a
trip, a release, a reading group), and each holds two things:

- **the talk**: short posts, read as a conversation. Deciding what to do
  is talk too; there is no document to write together.
- **its TODO**: the same list as Home's (not boxed again: the board is its
  box), written the same way (Kind：title, Enter for the detail, ○ when done), kept by its people
  together. It goes to the Remote item by item and field by field, a moment
  after the writing stops, so two people writing different items, or one
  ticking what another is detailing, never undo each other; only the very
  same field written twice keeps the last. A new item takes a place between
  its neighbours'. What others change comes in every little while, and
  waits while one is writing in the box.

How far a board goes is chosen board by board, and only ever wider by
choice: its server's people always; if opened, anyone reads it (signed in
or not); and if it takes guests, an outsider may write in it once one of
its people has invited them. Everything is kept
on the Remote, and any board can be taken home as one text (its TODO, its
talk, or both), in the app or with `l3 server get`.

**Guests** come by invitation, never by email: the Remote sends nothing to
anyone, keeps no address, and so cannot be made to send mail for a
stranger, costs nothing per guest, and has no address to lose. Any of a
board's people makes an invitation behind the gear: a link
(`https://os.length3.com/#guest=BOARD.INVITE`, 128 random bits after the
board) shown only then, which they pass on themselves, by whatever way
they already reach that person. It lets one person in, once, within a week;
the Remote can let in up to 20 by one and keep it up to 30 days, and holds
a board to 20 invitations out at once. The link's part after `#` never
reaches a server's log; the Remote keeps only its digest, so its own copy
opens nothing, and an invitation wrong, used up, revoked or run out is
refused with the same words. Whoever opens it chooses the name they write
as, at most 32 characters, no `@` (so it is never written as an address
is), nothing invisible, never the name of one of the server's people or of
the server, and not another guest's on that board; it is always shown with
**guest** beside it and a dashed face, and their posts never run on from
one of its people's. A guest holds a token for that board alone, for 30
days, kept by the browser they came in on. A guest writes 20 posts an hour,
and a board's guests together 100, so a link passed around cannot fill a
board. Every one of its people sees the invitations out (whose, until when)
and the guests in (who invited them); each revokes their own invitations
and removes whom they invited, its owner any; a guest removed writes no
more and what they wrote there is taken down with them. A board that stops
taking guests (or stops being open) ends every invitation and guest at
once, so opening it again lets nobody back by an old link; someone who
leaves the server takes the invitations they made with them.

Server is a page (§3), on the bench's shape, gone to by a press on its
icon, or by a server pressed among those a rest on it brings out (§3,
Overlays). It opens at the server one was at last (or the one pressed),
the servers drawn from the list this session was given last (Home names
them as it opens), so only what the board holds is read as it comes, the
list read again under it. Its pieces, from §3:

- **The band**: + first at the top line's left end, to make a server, then
  the servers one is in, one row however many there are, sliding sideways
  as Git's repos do (never more rows pushing the boards down), its ends
  fading where there is more along it and the one chosen, or being named,
  slid into view; another chip pressed, the ink goes along the band to
  it and the boards pan in from its side, as Git's repos do along its band
  (what was there going off the other way), the pane's people coming in
  over a moment with them; the gear at the right end (kept in its place,
  unpressable, while none is chosen), in ink while one is behind it, as a
  chip chosen is, turning a tooth's step as it is pressed either way. A server is made where it will
  stand, not in a form: its chip is the field, in the band after the
  others (dashed until it has a name; empty, it says a name none of one's
  servers has, Trip, else Book club, Family or Band, so it is not read as
  a second of one already there), saying one name: its name on this
  Remote follows the name unseen (Trip is trip), and the quiet @ at the
  chip's end shows it to be written otherwise, the @ staying where it was
  as its first letter; a name someone else has shows it by itself. Make
  beside it; under it the server it will be stands faint, its first board
  dashed on the ground, of the parts a made one is, each where it will
  stand (#general, its TODO's first line, No posts yet at its talk's foot),
  under it the box that will write to its people, saying them by the name
  as it is written, and at the right its first person, oneself as owner.
  Made (Enter or Make), the same shapes stand there whole and its chip
  takes it with a pop. The box at the foot is as wide as the board on
  screen and stands under it, sliding with it board to board. What the name
  on this Remote is (first come, five years) is said when the @ is
  pointed at; what the Remote says no to (the plan: making a server is
  paid, §6; a name taken; one's own name to claim first) is said on a line
  of its own under the band, where the row cannot slide it out of sight,
  when it says it, with the way on (See the plan, Go to Inbox). Escape
  while one is named, come to from a server, goes back to that server
  (what was written is kept); the page stays.
  Being asked into a server, and writing, are free.
- **Boxes side by side**: its boards, the last box making a new one, as a
  server is, where it will stand: the board it will be, dashed on the
  ground, its name written in its head in a board name's letters with Make
  beside it (on a phone's width in the body's, so what it asks for is read
  whole), what a board is said quietly at the top of where its talk will
  be, its TODO's first line and No posts yet faint where they will stand;
  come to by a press, its name takes the keyboard (by ← →, the keyboard
  stays on the row to go on along it); made, the same shapes stand there
  whole, and the edge of the next new one, dashed with its +, beside it (a
  name another board in the server has, whatever its case, is refused under
  its field, there and on the Remote, made, renamed or brought back). An
  edge under the pointer lights the box it goes to as a thing under the
  pointer is (raised, edged in ink), over a moment each way, so a hand
  resting on the line does not make it flicker. The
  board slid away from goes as it was, its posts and TODO with it, and is
  only its edge once the row has stopped; the one slid to is drawn as the
  row starts, what it reads coming up where it stands. A hand resting on an
  edge (120 ms), or pressing along, has the box it goes to read ahead,
  unseen (it looks as an edge does, and nothing in it counts as seen), so
  it slides in with all it holds. A
  board on screen is one sheet, never a box in a box: its name across it
  over a quiet rule, and after the name its two parts, **Talk** and
  **TODO**, as Remote's and Runtime's parts are (the one chosen in ink, the
  ink going along to the other, what it holds coming in from that side),
  as a chat app's channel has its messages and its canvas side by side on
  its head. Under them, the part chosen is the whole sheet: its talk (the
  latest at its foot, what was said before above, the board open at its
  foot while there is more below, so the eye goes on down), or its TODO, as
  wide as its lines are read, scrolling in itself when long, how many are
  left said on its part (TODO 3). The box at the foot is the talk's: the
  TODO in front, it fades and the board takes its room. The part not
  chosen stays where it is, unseen, so the talk is where it was read to
  when it comes back (what came while the TODO was in front is seen then,
  not before); each board keeps the part it was left at. On a phone's
  width the parts stand on a line of their own under the name, which keeps
  its room to be read whole; the keys the TODO is written with, a desk's,
  keep no room there, and the talk and its faces are a step tighter.
  Outside the server an open board's TODO is shown, not written, and not at
  all while empty: only the talk then, and no parts to choose.
- **The box at the foot** writes in the talk of the board on screen (旅行 の人たちへ),
  Post at its bottom right as Forge's box has Run and Inbox's Send (its
  keys, Ctrl+Enter, in its title; Enter is a new line), the keyboard
  staying in the box once it is pressed; on a phone's width, where the box
  is narrow, Post comes with the words, and the empty box says whom it
  writes to whole.
  What is half written in it is that board's (§1): going to another board,
  or to another page, keeps it, and it is there when the board is on
  screen again; gone once sent.
- **The right pane**: who is in it (face, name, owner), then the repos
  they show in it (name and whose), looked at again every little while
  (15 s) while it is on screen, so someone asked in who accepts on their own
  device comes in there then, standing as Forge's pane does: its
  line at its edge from the top line to the foot, its first heading on the
  line Forge's Prompt is on, and at the top line's right end, where
  Forge's pane switch is, the gear (the same quiet circle), over the people
  and repos it changes. The board's top is where Forge's first box's is.
  A repo pressed takes the boards' place
  with the page head (its name, whose, Forge when one's own, Back) and one
  box in two panes: its files, the one chosen (its README first), as it
  was last pushed; its row in the pane stays lit while it is shown.
- **Behind the gear**, in the boards' place: the page head (the server's
  name, its name on the Remote and code; Done at the sheet's bottom right),
  then **parts** (their counts as the pane last drew them, at once, so the
  parts' names do not step sideways when the reading comes; its cards come
  in one after another as they are read, as a page's do, and back to the
  boards, the box at the foot comes in with them) of **small
  cards**: People (a dashed card to add someone one knows, pressed the card
  that adds: one's contacts not in it, each a button, then a field for a
  name or a code and 入れる; its owner removes someone; looked at again
  every little while, as the pane is, so someone who accepts comes in
  there), Repos (each of one's own with **the pair of
  switches**, to its people and to everyone, seen by everyone as the
  server's; others' shown here, whose, its owner may take them off),
  Boards (to everyone and guests, its owner's, taking guests saying first
  that anyone then reads it, where it is not open yet; turning either off
  at once, unless guests are in or invitations out: that ends them, an old
  link letting nobody back, so it asks in the card first, saying how many
  and that what they wrote stays (Not now / Turn off); Take home, anyone's;
  Remove, its owner's: the board is held 30 days, off the boards, its card
  quiet with its 外す red, and pressed again it is back at once; beside a
  board that takes guests, its Guests card: the guests in, each with who
  invited them and Remove, asked in the card; the invitations out, each with
  whose and until when and Revoke, at once (each a name over a quiet line of
  what more, so a narrow card does not break a name mid-word); and Invite a guest at its foot,
  which shows the link once, copied by a press), This server (its name, code and term, Renew near its
  end; Leave; its owner's Delete). Leave and Delete say what they come to,
  as the Remote does it: who owns it next (the first of the others to have
  come in), or that it goes with the last one out, and how long it can be
  brought back (30 days; a day when its maker is alone in it). Whatever reaches past its people or
  cannot be taken back at once is **asked in the card**.

Escape from behind the gear, or from a repo shown, goes back to the boards
first. No Prompt is in Server: Server is for people, the Prompt for a
repo. Signed out, it shows the open boards (and no right pane, since whose
they are is not told). Where a board takes guests the box at the foot says
that its people invite them; opened by an invitation's link, Server comes
out at that board (signed in or not), and the box asks only the name to
write as, then is the guest's box (ゲストの…として). Signed in, the boards one
writes in as a guest are chips after one's servers (#board ゲスト), each
shown alone. A guest removed, or whose lease ran out, is told so in the box.

The talk reads as a conversation: oldest above and newest at the foot. No
rules: a run of one address's posts within five minutes shows the face
(the address's first letters in a circle), the name, the domain (or guest)
and the time once, then each text under it, and the day's name, quiet and
centred, marks where a day starts. A post's writer, and the server's owner,
may take it down: it comes out at its top right on hover, round, inside
the post (not over the one above, which a hand going up the talk would
then pass over still lighting the one below), and asks once more in its
own place for a moment. Nothing is counted.

The talk has no end to reach and nothing to press. With no post yet, it
says so at its foot, by the box one writes in, where the first will come.
While it goes on below what is shown, the board's box is open at its foot
(no line under it, the posts running past the edge), so there is plainly
more to scroll to; at the foot it closes. It opens at the newest;
scrolled near its top, the next older posts are read in above without
moving what is on screen, and at the very top it says it is every post
(not where every post is on the board at once: that is plain to see).
Reading is said only when it takes a while (a quarter of a second), so a
page read at once comes without a word flashing before it.
What comes meanwhile is put at the foot: followed when the foot is in view
(and always after one's own post), otherwise with a small ink pill (↓ 3 new
posts), which goes down to them. The foot in view is what reading the board
is: the dots of §3's Something came in go then. And it lets go by itself: posts far out of
view are folded into an empty box of the height they had, so nothing on
screen moves, and further still they let go of their text too, read again
by their range of ids when they come back near.

### New repo (+)

A name alone on the first line (the same field as the search box). Under
it, two columns: on the left, filling it, what the repo is for (概要), a
raised box written straight into as a TODO's detail is, whose words go into the repo's README.md under
its title; on the right, level with it, under 作成されるもの, the one
scaffold every repo starts from (nothing to choose: shared/templates.json's
`standard`, as `l3 repo new` makes it: README.md with docs/ and issue/, no
language of its own; C's files are `l3 repo new -t c`'s), shown as File will show it: File's
own card, only as tall as its rows, /root (repo) and in it the repos already
there, shut and quiet, and among them, where its name puts it (moving as the
name is written: past another's name, the rows go to their new places on
their curve), the new one filled in ink as File fills the repo worked
on, its folders shut, README.md's size at the row's end as File gives it, of
what it will say (it follows the name and what it is for). The field holds no
example (one there reads as a name given, and its row as the repo to be
made): with nothing written, the new row is a quiet dashed place saying name,
and 作成 pressed says, under the field, to write a name first. A name that
cannot be is said as it is written, not once 作成 is pressed: the reason
under the field (its edge in the off colour), the new row not filled but
dashed, each letter no name has underlined where it is in it (a space as
␣, a dot first), and a repo of the same name ringed where it stands. Nothing is named
or laid out in the card: a repo's files are named, made and moved in File,
every repo's alike, once it is made. Then 作成, the one primary action, under both. What is written stays
while other pages are seen, until the repo is made. The two columns stand
side by side only while what is written keeps a reading width beside the
card; narrower, they stack: name, what it is for, the files.

Under the form is the list of repos, the same cards as on Home. Once made,
it is gone into at once: no page saying it was made, no form left greyed
out. The summary's sheet grows into the README's box in Forge (one sheet
from the one to the other, the box shown only as it lands), the repo goes on the band, and the caret is at
the end of its README, after what was written under the title, to go on
writing; the form is
fresh for the next one (+ on the rail). Only a file that could not be
written keeps the page, to say so. A name not
allowed, or one already taken, is said right under the name, where it is
to be put right, and the keyboard goes back to the name as it was
written; typing in it again clears what was said.

### File

An operation, not a page. Hovering the File icon (or pressing it) lays the
tree of "/" over whatever page is showing as a card right beside the rail:
its corner concentric with its rows (a row's 8 px plus the 8 px between
them: 16 px), only as tall as what is in it, its first row level with the
File icon. It has no "/" label of its own: the rows are what is in "/", the
person's first: /root on top with the repos open in it, and the rest of /
(the kernel's, the distribution's, what is empty here), wanted now and then,
put away under one quiet row at its foot, System (its first names beside it),
shut until it is opened and kept open once it is. While it is out, File is the one filled icon in
the rail; the page's own icon steps back until it goes, the ink going from
the one to the other as it does between places (the servers a rest on Server brings out and the plug's
area take it the same way). It comes out of the rail as a drawer does, a few
pixels from the left, drawn out from its edge, whole the while: never faded
over the page with the page's words through its own; it goes back the same
way. Nothing under it moves. The pointer resting on File a moment (300 ms) brings it out, never
the pointer passing down the rail; brushed past on the icon alone, it goes
half a second after the pointer does, and from the tree itself a little
after (1.2 s), so a reach back finds it but the page is never left under a
tree nobody asked to stay. Pressed, File brings it out to stay until a
press elsewhere, Escape or File again. A press outside or Escape closes it
at once. Each time it comes out it is read afresh.

"/" is the root of the whole system, the same tree the Terminal's shell
sees, and the tree shows where each part comes from: `/bin` is the fetched
distribution (配布), `/dev` and `/proc` are made by the kernel, `/root`
holds the person's repos, `/etc` and `/tmp` start empty. What the system
is made of (those, and what is in them) is in `sub`, so `/root` and its
repos are what the eye finds first; under the pointer or the keyboard a row
is in ink again. `/root` is open at first. A folder's triangle comes before its name, ▷ closed and ▽ open (one
outlined shape, turned). Inside a repo a name opens that place in Forge
(in place when Forge is showing; a folder keeps the tree out, to go on
down); a file is the one to work on, so choosing it puts the tree away and
the caret at the file's start. Elsewhere a name opens and closes the
folder. The file Forge is reading is marked as where one is (§1). Escape
puts the tree away whatever has the keyboard: what was being written keeps
its caret, and only from inside the tree does the keyboard go back to File.
Open folders are remembered while the app runs.

Inside a repo a row is also where a file or folder is made, renamed,
moved and deleted. At its right end, shown on the row under the pointer or the
keyboard, a small round button (the down mark, more to choose from) brings
out the row's menu; a right press on the row, or the menu key (Shift+F10)
on its name, does the same. The menu is the person's menu (`.pop`): beside
the tree at the row's height, out in the free space so nothing moves, its
head the row's name, a row per deed. A folder, the repo's own row too, has
New file and New folder, made in it; a file has them too, made beside it in
its folder (the same deeds Forge's files button brings out under itself for
the file read now); a file or folder has Rename and Delete (a
repo is not renamed or deleted here: its gear is where that is, § Runtime, A
repo in a list). A deed pressed becomes the field or the ask in its own
place: a name written and Enter makes it (a new one's name is one plain part,
with no "/" and not starting with "."; one already there is said under the
field and the keyboard stays in it). Rename's field holds the row's path in
the repo (`notes/plan.md`), its name chosen to be written over, so a name
written renames it where it is and a path written moves it there, from the
repo's top, the folders on its way made (each part plain; never into
itself). A row taken by the pointer and carried onto a folder of its repo,
or onto the repo's own row, moves into it: it stays where it was, faded,
while it is carried; the folder under it is raised and ringed in ink, and
one shut opens after a moment held there, to be gone into; let go anywhere
else, nothing moves. Moved, it lands lit where it went, with the keyboard on
it, its folders open down to it; what could not be done is said at the
tree's foot. Delete asks there, `{name}を消します`
or `{name}を中身ごと消します`, Not now and 消す at its foot as every ask is
(`askFoot`, held still a moment, `SETTLE`). A new file is the one to work on:
the tree goes and Forge opens on it with the caret in it. A new folder, a
renamed or moved row or what holds a deleted one is read again, open, with the
keyboard on it. Escape puts the menu away first, back to its row; a second
Escape puts the tree away. A rename or a move reaches everything that keeps a copy as
the old path gone and the new one made (the Prompt's copy, Forge, and the
Remote, which other devices then take in), on either host (the app renames
or moves on disk, `repo_move`).
