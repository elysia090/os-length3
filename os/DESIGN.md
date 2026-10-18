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
  `ink` edge over `raised`, as a lit repo card is. Where one is inside
  the current thing (the file Forge is reading, under the open repo in
  File) is quieter than the thing it is in: a short straight `ink` line at
  its row's left and its name 600, kept while the pointer is elsewhere and
  apart from hover. Focus is a 2 px `ink` ring. Nothing else marks state
  (no underline, no bold-only).
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
  l3 and core write their Japanese the same way.
- **What one was doing stays where it belongs.** Going to another page
  and back, or to another repo and back, is going back to it: the same
  repo, where it was read, what was searched, what was half written. What
  is written belongs to what it was written for (the prompt box to its
  repo, an issue's words to the issue) and is swapped with it, never
  carried to another; it goes only when it is sent, saved, or put back
  with Not now. The repo worked on is one on every page: chosen anywhere
  (a pill, File, a Git chip, an issue gone to or started, one just
  written), it is the one the next page opens; only looking at a page
  chooses nothing. A thing made or chosen is landed on: a new issue is the
  one shown, with the keyboard on it; a file chosen in File has the caret.
  Going along a row keeps the keyboard on the same part of the box, and an
  error that the name causes sends the keyboard back to the name.
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

## 2. Tokens

| Role | Value | Use |
| --- | --- | --- |
| `ground` | `#DADAD5` | every surface: a touch lighter than the first `#D2D2CD`, still grey, so long hours stay easy |
| `ink` | `#292B2A` | text, icons, the current thing, primary action (10.2:1 on ground) |
| `rule` | `#989B96` | dividers, outlines of places; decorative only (2.0:1, kept as before) |
| `sub` | `#56595A` | secondary text (5.0:1) |
| `edge` | `#6B6E6B` | outlines of fields and controls, which must be seen (3.7:1) |
| `raised` | `#E4E4E0` | field fill, hover (the same small step above ground as before) |
| `done` | `#2F7D4F` | done and on: a step of an issue's work done, a switch on (its knob), a box ticked (its circle) |
| `marker` | `#F3E27A` | a line marked in a diff (a review, Forge's diff), as with a highlighter: over its words only (not its indent or number, which turns ink), each wrapped line its own stroke with softened ends; the pointer on a line shows the stroke paler |
| `off` | `#A63C2C` | a repo turned off: its switch; a removal held, its button red (`ground` words on it 4.5:1) |

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
- **The band.** What is out to work on, on the top line: each thing as a
  round chip, the current one an `ink` fill, then + after them (round, an
  `edge` outline, `sub`), as a browser's new tab comes after its tabs.
  Forge's repos, Server's servers.
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
  band holds (a search box, a gear) keeps its right end. A layer keeps its
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
  (Inbox too). Forge and Git run in it; Server posts. Empty and not in use,
  it steps back while the page is read (Forge, §8).
- **The right pane.** Beside the center, past its one `rule`: on top what
  the center refers to (Forge's reference, Server's people and repos),
  headings 15/600 in `ink` as Prompt's, a list under each; with nothing to
  show, nothing (no line saying what will appear once a repo is open), or
  with a repo, one quiet line of what is not there (no box: a box is
  for the center, where things are made). It only shows; what changes it
  lives with the thing it changes, and what leads from it into the center
  (a file's name, a line's number) opens the center there.
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
  in a board, tall as it is on Home whatever its items (it scrolls in itself).
- **Overlays.** File and Server are operations, not pages: laid over the
  page that is showing, brought out by resting on the icon (it stays a
  while after the pointer leaves) or by a press (it stays), put away by
  Escape (whatever has the keyboard; the topmost one only), a press
  outside, or a second press. A press outside leaves out one whose box
  holds words (Server's, §8), so what is written is not put away under it.
- **The Remote away.** When this device's Remote does not answer, it is
  said in one place: a small `off` dot on Remote's icon in the rail, whose
  name then reads Remote に届きません, and one line under Remote's parts
  (what changes here is sent once it answers). Everything else goes on as
  it was: work is kept here and sent when the Remote answers; what only
  the Remote can do (its switches, a repo only there) waits, quiet. When
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
| + after what it adds to | + first, as the band has it |
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
| Enter sending in one box and making a line in another | Enter is a new line, Ctrl+Enter sends, in every box |
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
| The empty box at the foot standing over what one reads | It steps back while one reads, and comes back to the keyboard, a press on the Prompt or the pointer at the foot |
| A choice that leaves its overlay to be closed by hand (a file chosen in File) | Choosing the thing to work on puts the overlay away and the caret in it |
| The only way to something folded away with its pane (search, narrow) | The way stays where it was; only what it shows folds |
| A day in another country's order (10/17/2031 まで in Japanese) | `day()`: the language's own (2031年10月17日まで) |
| The same card saying its lines in another order (Remote にあります · 8 B, then when) | One order on every card: size · when it changed, then where it is |
| A count that leaves out what the page shows (0 repo over a card for notes) | The count is of what is shown |
| A repo on the Remote that a page says is not there (File: repo はまだありません; ⊕ greyed) | It is listed, quiet, and fetched when opened |
| A noun on a button beside verbs (作成, 編集 beside 見る) | A verb (作る, 編集する) |
| A full stop on one lone line and none on the next (投稿はここまでです。 / repo はまだありません) | None on one statement; one on each when there are two |
| A field with only a placeholder for its name, beside a form with labels | A label over the field, what it means under it, as New repo's |
| Signed out, a sentence and a button on one page and a card on another | The sign-in card, in the middle, on every page that needs it |
| The Remote away as an error on two pages and as nothing (stale cards with live switches) on the rest; a dead session kept, each page failing on it | The rail's dot and Remote's one line; a dead session signs the device out |
| Something new said by a count, a badge or a colour of its own, or not said at all until the page is opened | The dot of the place's own colour, on the rail and on the chip and board it is on, gone once seen |
| A box drawn again every little while, taking what was being written and the keyboard with it (Inbox's field to write to someone, every 10 s) | Only what came is drawn: the rows under the field, the messages at the conversation's foot |
| Items in one row of a band a few pixels off another's (a 40 px gear in a 32 px band) | Everything on the band is 32 px |
| A divider left where a pane would start when there is none | No pane, no line |
| Something painted over a focus ring (the ground under the box over its foot) | The ring is whole: what lies under the box lies behind it |
| Text, not a field, sitting at the top of a row its mark is centred in (a read-only TODO) | Centred on the mark's line, as the field is |

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
| `prompts/<pid>.json` | each Prompt running, while it runs | its process's |
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
| a server | its people (its owner removes it) | its Remote | removed, or its last person leaves: 30 days, then gone (a day when its maker leaves it with nobody else in it) |
| a repo shown in a server | its owner, lent to the server | its Remote | taken off, or its owner leaves the server: at once |
| a repo's public name (`face:name`) | its owner, under a face | the face (the server, or the owner's address) | taken down, or the face goes: 30 days no one else's repo answers to it |
| a board, its talk and TODO | its server | its Remote | removed by its owner: 30 days, back at once until then, then gone; or with its server |
| a copy on a device | the device | the digests | taken back whenever room is wanted (owned.rs) |
| a session, a code, a guest | the person, the address it was sent to | sign-in, mail | a lease: days for a session, minutes for a code, 30 days for a guest |

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
`address`), Remote (`remote`, `login`, `logout`), Server (`server`), Inbox
(`inbox`, `name`); `l3 help` lists them in this order. `l3 address` is where
this device is reached over SSH, as `ip addr` answers with an address: one
`ssh -p PORT REPO@HOST` a line, the SSH user being the repo (Runtime's SSH,
below); the names people find you by (name@domain, and your code) are `l3
name`. A path is written as File shows it (`/root/<repo>/…`). A line is
named the same way everywhere ("Fix：件名"), an issue is called by its
number in both (#3), and Home's state is the same files, so anything done in one shows in
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
changed here is sent, and one changed on both sides keeps, at its name,
the version that reached the Remote first, and puts this device's beside it
named after this device ("README (ren-laptop).md", "README (Chrome
Linux).md"), so neither is lost and the name says whose it is on every
device.
Files that cannot travel (a link, a file over 16 MB, a repo's own `.git`)
are named and never sent; a repo holding them is never let go. Home's
settings (profile, TODO, dotfiles) are kept there too, by the app and l3
alike (src/draft.ts, core/src/home.rs: one protocol, one record of what was
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
of its own. Every device is a session, listed on the Remote page and ended
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
  **Runtime** (the environment) → **Remote** (where your repos are kept) →
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
- Inbox and Server carry the dot of §3's Something came in; Remote the
  dot of the Remote away. Nothing else on the rail is marked.
- Item 48×48, radius 12, icon 24 px with a 1.6 px stroke; + is a 40 px
  round button with an `edge` outline. States as everywhere (§1).
- The person's own icon sits at the foot of the rail, a little above the
  line of the prompt box at the center's foot (its middle 8 px over the
  box's), a 44 px circle a
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

## 8. Pages

Each page below says only what is its own; the rest is Part I.

### Home

A profile, between a Twitter and a GitHub profile, that reads the same for
its owner and for anyone else; only the owner gets "edit". In order:
identity (avatar, name, @handle, bio, counts of repos and servers) →
**TODO** → repos → servers (each one is in, a chip that opens Server on it).
TODO is the person's single list; repos do not carry their own inbox or
TODO files. An item is a first line named like an issue ("Fix：件名"),
then detail lines; Enter on an empty line starts the next item. Done
strikes through and fades the first line only.

### Forge

Where you work. The repos out to work on run as pills in a band on the top
line; the search box on the right sits on the
same line, with the reference's chips under it. ⊕ stands first, at the band's left end, and the pills
follow it and scroll. One press brings every repo not on the band out at once; this is not adding tabs one at a
time, and ⊕ stays where it was pressed however many come out.
Each pill comes off the band with its × (the repo itself is untouched).
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
something only when the file is not simply saved (未保存, or why it could
not be saved). A text saved elsewhere (another device, the Prompt, Git)
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
again; stopping one is Runtime's. What is written in the box and not sent
is the repo's: another repo shows its own, and coming back finds it.
The box knows the repo's earlier lines, as a terminal does: ↑ with the
caret on its first line goes back one line run in the repo's Prompt, ↓ on
its last line forward again, down to what was being written (so a line of
several lines is still edited with the arrows); writing in the box ends
the walk. Tab completes the path before the caret from the repo's files
(`src/ma` to `src/main.rs `, a directory with its `/`); several matches
are written to what they share and listed in one quiet line under the box
(monospace, as paths are), gone at the next key. With no path to complete
Tab moves on, as everywhere.
While one reads (the center turned by the wheel, a touch or the keys) and
the box is empty and not being written in, it steps back (a 120 ms fade)
and lets the text under it be pressed; the keyboard reaching it, a press on
the Prompt, or the pointer coming down to the center's foot brings it back
where it was. Something written in it, or a word under it, keeps it out.

Forge is kept as it was while another page is shown, and each repo on the
band keeps its place: where it was read, what was searched in it. A pill
taken off lets its place go.

The center takes three quarters of the width; the right pane takes one
quarter (at least 280 px) so it never gets in the way. Its bottom is the
terminal's home, and once the repo's Prompt has run something it starts
above the middle (the reference takes 2 parts, the Prompt 3): the reference
scrolls and the Prompt does not, so the eye should not have to drop low to
find it. Until then the Prompt is only its prompt line, and the reference
takes the room, so a diff reads in it. Narrower than 760 px the right pane
folds away and the search box stays where it was, on the band's line at
the right; its results open under it over the center. On the band's line sits the search box for the open
repo: plain, case-insensitive, line by line; results are grouped by file,
and a line pressed opens the center there with the line selected. Below,
on the band line, one reference at a time, switched freely with chips: Issue (the repo's open issues, as Git shows them: one merged or
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

この端末 first, then what can go from it, then what is running, then the
environment actually in effect (what runs, not what was asked for). There
is no table of policies: what the device holds is shown as things, and
each thing says what can be done with it.

- **この端末**: one bar of the host's whole, with this OS's share darker
  (not an ink fill, which means current), and three figures: this OS, free,
  total. This OS is counted from allocated blocks, so a sparse file counts
  what it holds and a file with several hard links counts once; the host's
  free and total are marked 推定, because other programs change them too.
- Under it, one tall box in three columns: what is **in this browser**
  (on this device) at the left, what is **on the Remote** (fetched with a
  press) in the middle, and what **can be freed** at the right. In each, **one list, largest first**, of everything this OS holds: each
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
  A Prompt on the root has no network unless its repo is given one: a
  plain switch with the word Network in its card. A namespace cannot be
  given a network once made, so turning it on asks in the card, then stops
  the Prompt, which has the network from its next start; turning it off
  stops it at once. The grant is this device's (never sent), and `l3
  prompt` reads the same one (`--network` gives it to one Prompt); `l3
  network on|off REPO` is the switch, taking it stopping the repo's Prompts
  as here. Every Prompt on the root is an `l3 prompt` process that records
  itself while it runs (core/src/prompt.rs), so `l3 prompt ls` lists the
  app's and a terminal's alike, `l3 prompt stop REPO` stops them as 止める
  does, and neither 空ける here nor `l3 free` lets a repo go while one has
  it open. In a browser there is no switch: a Prompt's programs have no
  sockets at all.
- **有効な環境**: the environments a Prompt can run on, a row each: l3,
  Ubuntu, Debian, Custom (a root of one's own, known by its digest). The
  one in effect is the place (an `ink` edge over `raised`): l3, with its
  version, what it is here (in the app, the root installed, on this
  device's kernel; in a browser, the whole root through xlat, or l3 and
  its BusyBox) and its digest. In the app each other one has Use at its
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
  or either file changes.
- **SSH** into a repo's Prompt, per device: an ordinary OpenSSH client,
  with the repo as its user, lands in that repo's Prompt, the same shell
  `l3 prompt REPO` gives (a command runs there and its exit code comes
  back). A small card for each of the account's devices that listens: what
  it is (This device in the app), its destinations, one a repo (`ssh -p
  23000 notes@192.168.1.5`, each copied by a press, as Inbox's stub is),
  how long it has been on (or that it has not been heard from lately), and
  the power switch at its bottom right, on; pressed, that device stops
  taking connections and ends its sessions within seconds. Off is the
  first state, and SSH is turned on only at the device itself (`l3
  address` asks, `l3 address ssh on`, or, in the app, This device's card,
  there off with its switch): a page can only turn a device's SSH off, so
  the switch on another device's card only goes one way. The listener is
  l3's, in the background, recorded under the data directory as a Prompt
  is; which devices listen is kept on the Remote by device (a session),
  and the listener asks it every 5 s, stopping once it was turned off or
  the device signed out. Keys are the `.authorized_keys` dotfile (below),
  public keys only, so a key added on one device counts on every one.
  With none there, turning on says to add one first, and how. Shown only
  while signed in; with no device listening, one line says where it is
  turned on.
- **Dotfiles**: a small card each (its name, its size), and a dashed one to
  make another. A card opens its text under the cards, `/root/` and its name
  above it, Remove at the left, Close and Save at the right. Every Prompt
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

In a browser the same list is the browser's copy of the repos (このブラウザ,
its share an estimate), and the same three answers apply.

### Git

What happens between a repo and the outside, in the mental model of the
issues: an issue hides its branch and worktree, and the operations are
Commit, Push, Change (with Reset), Review, Merge, and Close for one that
will not be done. It uses the same workbench
as Forge: the center (one centred column, 760 px at most) with the prompt
box at its foot, and the narrow right pane with the search box, the
reference and the Prompt. The page header, then the repo chips (one repo or
all); choosing a repo also points the right pane and the Prompt at it, and
makes it the repo worked on (§1): Forge opens there next. So does going to
an issue (an edge, ← →) and starting or continuing one; coming to Git
opens at the issue last looked at in the repo worked on. An issue written
is the one shown, its repo's chip chosen if another was, with the keyboard
on its words; one half written (new, or its words half changed) is still
half written after reading its neighbours or another page.

- **Issues**: every issue still open: not merged, not closed. An issue is its number and its
  words ("#3 Fix：件名", then the detail); that is all a person meets. Any
  repo takes one, and it takes the repo's next number. How it is kept is the
  OS's business: one plain file in the repo's `issue/`, named by its number,
  so l3 and a Prompt see the same thing and nothing is kept twice; a file
  there with no number (written by hand, or two devices' issues that met
  under one number) is given the next free one. Under the heading (its count, and
  「Issue を書く」) the issues are large boxes side by side, oldest first:
  one in full, its neighbours' edges showing at the sides. The current box
  is a large place, an `ink` edge over `raised`. An edge is a clear button
  over the neighbour, which lifts (`raised`) while hovered; pressing it, or
  ← →, slides the track there (280 ms, the one movement). The first box
  starts at the column's edge and the last ends at it.
- **The box**: the issue's number and name ("#1 Fix：件名") and its detail,
  changed where they are read (pressed, they become the fields they were
  written in, Save and Not now under them), one quiet line of its repo and
  who started it and when, and Start (Continue here, if it was started)
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
  button at the right; done, the button's place shows the same word with
  the done mark (a circle with a check, `done`), and the green says it is
  done. In Commit's row, what is not committed (▸ 5 files); its diff opens
  over what is under it, so neither button moves. Pushing hands the work to
  main as its change, again as the next version; Reset, at the Push row's
  left end, takes it back while it is undecided. A change received from
  someone else shows Commit and Push done.
- **The card's foot**: Back to main at its left (it leaves the work), then
  its repo and who started it and when; Start or Continue here at the
  right. No file name
  is shown anywhere an issue is. One not worked on here, with no undecided
  change, while the repo shows main, has Close at the left instead: it will
  not be done. It goes at once (Reopen brings it back, so nothing is
  asked) and is listed under Closed. Being closed is the issue's own: its
  file says so on its last line, after the detail (`Closed：2031-10-17
  sora`, the day and who), so l3 (`l3 issue close REPO#N`, `l3 issue
  reopen REPO#N`) and a Prompt see the same, and it reaches the Remote as
  every change does, with nothing kept twice.
- **A diff**, wherever it shows: each file a fold, its name (which opens it)
  and what was added and removed (+56 −2); each line with which line it is.
  The first three files are open, the rest wait closed, so a large change
  reads file by file; it scrolls inside its box.
- **Review**, shown once there is a change to review: a box of its own
  under the card, the same `raised` with an `ink` edge: the change's diff,
  where a reviewer marks lines as with a highlighter (`marker`); what was
  said, in order (an approval without words is not shown there); then a
  comment more, in a field tall from the start (Ctrl+Enter or Comment sends
  it with the marks), and beside Comment, Ask for changes, which sends the
  same with its verdict (it says something: with nothing written or marked,
  the field is where to say it), shown in what was said as Asked for
  changes, as `l3 review REPO#N changes` is; at the left, Approve as a ○
  that turns green when pressed.
- **Merge**, under the Review and not in it: Reject at the left, who
  approved it, and Merge at the right, primary once the version is
  approved.

Under the issues, each its own section, shown only when it has something:

- **main**: a card for each repo that shows main and has something not
  committed there (an edit in Forge, an issue written, one closed): its
  repo, what is not committed (▸ 2 files, whose diff opens over what is
  under it, as in an issue's Commit row) and Commit at the right. Commit
  asks in the card for the line the commit goes by ("Fix：title"), as
  `l3 commit REPO "Fix：title"` takes it, Not now at the left and Commit
  under the pointer; Enter commits the one line. What is typed is kept
  with its repo until it is committed or put back. This is Commit, not an
  issue made of the changes: an issue hides a branch that starts from
  main's last commit, and moving main's draft onto one would be a new
  operation the Remote does not have; a commit on main is already one
  (`l3 commit` on main), so the app offers the same.
- **Merged**: the issues whose change main took, newest first, a row each:
  "#1 Fix：件名", who handed it in and when it was merged; pressed, the
  row opens to the change's diff. It is history, so it is only read.
- **Closed**: the issues closed without being done, a row each: "#2
  Feat：件名", who closed it and the day; Reopen at the row's right end
  (while the repo shows main) puts it back among the issues at once.

Every change is already on the Remote (the draft, §6); Commit makes it
history there, the same from the app, a browser and `l3 commit`. Without a
Remote the issues are shown and one line says that history is kept there.

### Remote

Signed out, the page is the header and one place in the middle of what is
left, the first thing a person meets: an `ink` edge over `raised` as the
current issue card is, its weight a little high, at most 440 px wide. In
it: Sign in, then the ways in one under another as wide as the place (the
first provider filled), and no words around them: the buttons say it. The
Inbox, signed out, shows the same place. A device's code opens the same place on a page of its own, for
each step: the code, signing in, letting the device in.

Signed in: the header, then the page's parts as a switch (the one
place a page is switched, because its parts are unrelated):

- **Repos**: every repo the Remote holds, as cards the size of Home's: name,
  size and when it last changed, where it stands. On: Forge at the bottom
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
  Share again closes it. Going public is the server's, in its gear (seen
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
  foot of the rail, which also forgets the session here.

Under the parts, while there is no passkey, Add a passkey: the button alone,
below what the page is about rather than over it.

### Inbox

Your name as a stub: a field-sized place about as wide as a name, the name
in it, shown alone (§5), and your code beside it (pressing either copies
it, and it says Copied for a moment in the same place; there is no Copy
button), its gear at the right end. Before there is one, the stub is the
name to claim; Enter claims. The gear opens, over what is under it (Escape or a press
outside closes it), a popover: your names with their terms (Renew near the
end), Add a domain, and Let a name go last. Add a domain becomes, in its
row, one field where the name is written whole, `name@domain` with the @
too (no second box to go to), then the one DNS record that proves it (`_length3.<domain>` TXT
`v=length3; remote=<host>; proof=<…>`, each part copied by pressing it).
The proof is the Remote's keyed digest of the account and the domain, so
only the domain's holder can publish it and no other account can reuse it;
it is looked for while the gear is open, and the address is claimed the
moment it is found. The same record says which Remote holds the domain's
addresses, as MX does for mail. SSH is Runtime's, by device, not by name. Then one tall box: conversations on
the left (requests apart, with Accept and Block), the chosen one on the
right. Writing is one line that grows as it is written: a message is named
the way an issue is ("Review：…", "Question：…"), and a `/root/…` path in it
says what it is about, so there is nothing else to choose. Enter is a new
line, Ctrl+Enter sends.

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
(§5, Names). A server's own repos are what comes next.

A server is a name and its people. Someone already in it adds people from
their own Inbox contacts, so a server is people who know each other; or by
a name or a code, in the card that adds: someone one knows both ways is in
at once, anyone else is asked in the Inbox (a message about the server, a
request until they accept) and is in the moment they accept the one who
asked, so long as that one is still in it (within 30 days); the card says
they were asked. Anyone
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

- **The band**: + first at the top line's left end, to make a server, then
  the servers one is in; the gear at the right end (kept in its place,
  unpressable, while none is chosen).
- **Boxes side by side**: its boards, the last box making a new one. A
  board holds **the TODO box** at its top and its talk under it, with
  nothing switched to see one or the other. Outside the server an open
  board's TODO is shown, not written, and not at all while empty.
- **The box at the foot** writes in the board on screen (旅行 の人たちへ).
  What is half written in it is that board's (§1): going to another board,
  or putting Server away, keeps it, and it is there when the board is on
  screen again; gone once sent. While it holds words, a press outside does
  not put Server away (Escape and a second press on its icon still do).
- **The right pane**: who is in it (face, name, owner), then the repos
  they show in it (name and whose). A repo pressed takes the boards' place
  with the page head (its name, whose, Forge when one's own, Back) and one
  box in two panes: its files, the one chosen (its README first), as it
  was last pushed.
- **Behind the gear**, in the boards' place: the page head (the server's
  name, its name on the Remote and code, Done), then **parts** of **small
  cards**: People (a dashed card to add someone one knows, pressed the card
  that adds: one's contacts not in it, each a button, then a field for a
  name or a code and 入れる; its owner removes someone), Repos (each of one's own with **the pair of
  switches**, to its people and to everyone, seen by everyone as the
  server's; others' shown here, whose, its owner may take them off),
  Boards (to everyone and guests, its owner's; Take home, anyone's;
  Remove, its owner's: the board is held 30 days, off the boards, its card
  quiet with its 外す red, and pressed again it is back at once), This server (its name, code and term, Renew near its
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
posts), which goes down to them. The foot in view is what reading the board
is: the dots of §3's Something came in go then. And it lets go by itself: posts far out of
view are folded into an empty box of the height they had, so nothing on
screen moves, and further still they let go of their text too, read again
by their range of ids when they come back near.

### New repo (+)

A name alone on the first line (the same field as the search box). Under
it, two columns: on the left, filling it, what the repo is for (概要), a
raised box written straight into as a TODO's detail is, reaching down as
far as the column beside it, whose words go into the repo's README.md under
its title; on the right, level with it, the template as chips like the
reference's (one chosen, ink) with no label over them, standing where the
summary's label stands, and under the chips what will be made,
shown exactly as File will show it: a card of tree rows under `root`, the
new repo's name bold, its folders open. Then 作成, the one primary action,
under both. Narrow, they stack: name, what it is for, template, the files.

Under the form is the list of repos, the same cards as on Home. Once made,
the page stays where it is: the new repo's card joins the list and lights
for a moment, the preview card says it is in File under `/root/<name>`, and
where 作成 was there is "<name> を作りました" with the ways on: Forge で開く
(primary; it goes on the band) and 続けて作る (a fresh form). A name not
allowed, or one already taken, is said right under the name, where it is
to be put right, and the keyboard goes back to the name as it was
written; typing in it again clears what was said.

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
(in place when Forge is showing; a folder keeps the tree out, to go on
down); a file is the one to work on, so choosing it puts the tree away and
the caret at the file's start. Elsewhere a name opens and closes the
folder. The file Forge is reading is marked as where one is (§1). Escape
puts the tree away whatever has the keyboard: what was being written keeps
its caret, and only from inside the tree does the keyboard go back to File.
Open folders are remembered while the app runs.

Inside a repo a row is also where a file or folder is made, renamed and
deleted. At its right end, shown on the row under the pointer or the
keyboard, a small round button (the down mark, more to choose from) brings
out the row's menu; a right press on the row, or the menu key (Shift+F10)
on its name, does the same. The menu is the person's menu (`.pop`): beside
the tree at the row's height, out in the free space so nothing moves, its
head the row's name, a row per deed. A folder, the repo's own row too, has
New file and New folder; a file or folder has Rename and Delete (a repo is
not renamed or deleted here). A deed pressed becomes the field or the ask in
its own place: a name written and Enter makes it (a name is one plain part,
with no "/" and not starting with "."; one already there is said under the
field and the keyboard stays in it); Delete asks there, `{name}を消します`
or `{name}を中身ごと消します`, Not now and 消す at its foot as every ask is
(`askFoot`, held still a moment, `SETTLE`). A new file is the one to work on:
the tree goes and Forge opens on it with the caret in it. A new folder, a
renamed row or what holds a deleted one is read again, open, with the
keyboard on it. Escape puts the menu away first, back to its row; a second
Escape puts the tree away. A rename reaches everything that keeps a copy as
the old path gone and the new one made (the Prompt's copy, Forge, and the
Remote, which other devices then take in), on either host (the app renames
on disk, `repo_rename`).
